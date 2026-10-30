// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ============================================================================
 *  MultiSeaOrdinalEscrow — MultiSea cross-chain Ordinal escrow (UNAUDITED)
 *  No paid audit (spec Q4). Free-tool security pass: docs/SECURITY-ORDINALS.md.
 * ============================================================================
 *  Buyer pays an allow-listed ERC-20 (Base native USDC) = price + inscriptionFee.
 *  The delivery service inscribes a Bitcoin Ordinal to the buyer's taproot address.
 *  Delivery is accepted only when BOTH hold (spec §7.9, B2):
 *    1) threshold-of-N EIP-712 attester signatures (1-of-1 per BIG's decision), and
 *    2) an on-chain SPV proof: the reveal tx's output 0 pays the order's taproot
 *       program, the tx is merkle-included in a header with valid PoW at or above the
 *       difficulty floor, followed by (minBtcConfs-1) chained headers, mined no earlier
 *       than 2h before the order was created.
 *  Release: price -> artist (minus feeBps to feeRecipient), inscriptionFee -> btcOpsRecipient.
 *  Refund (after deadline, never pausable): price + inscriptionFee back to the buyer.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Bech32m} from "./Bech32m.sol";
import {BtcSpv} from "./BtcSpv.sol";

contract MultiSeaOrdinalEscrow is ReentrancyGuard, Pausable, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    enum Status { None, Pending, Attested, Released, Refunded, Disputed }

    struct CollectionConfig {
        address artist;          // payout recipient on this chain
        uint96  feeBps;          // launchpad fee in bps (<= 2000)
        uint32  maxSupply;
        uint32  sold;            // live orders (refunds decrement)
        uint32  deliveryWindow;  // seconds until refund allowed
        bool    active;
        uint64  payoutChainId;   // 0 = same chain (Q6)
    }

    struct Order {
        address buyer;
        address token;
        uint128 amount;          // price (artist + platform fee)
        uint128 inscriptionFee;  // BTC network fee pass-through (B13)
        uint64  createdAt;
        uint64  deadline;
        Status  status;
        bytes32 collectionId;
        bytes32 btcProgram;      // 32-byte taproot witness program decoded from btcAddress (B3)
        string  btcAddress;
        bytes32 btcTxid;         // display (explorer) byte order
        string  inscriptionId;   // "<txid>i0"
    }

    /// Raw BTC data for the SPV check. rawTx is the NON-witness serialization (its hash256 is the txid).
    struct SpvProof {
        bytes rawTx;
        uint256 index;           // tx position in block
        bytes siblings;          // merkle branch, 32-byte internal-order hashes, leaf upward
        bytes headers;           // minBtcConfs * 80 bytes: inclusion block, then the following blocks
    }

    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(uint256 orderId,bytes32 btcTxid,bytes32 inscriptionIdHash,uint256 deadline)"
    );
    uint256 public constant MAX_FEE_BPS = 2000;
    uint256 public constant DEFAULT_MAX_PER_WALLET = 50;
    uint256 public constant MAX_PER_WALLET_CAP = 100;
    uint256 public constant MAX_CONFS = 24;
    uint256 public constant BTC_TIME_TOLERANCE = 2 hours; // Bitcoin header timestamps may lag/lead wall time

    /// Default difficulty floors (max accepted target) per network. Mainnet: 4x the target of block 973775
    /// (nBits 0x1701e5ac, Oct 2026) = 1/4 of that difficulty. Owner can tighten/loosen with setPowFloor.
    uint256 public constant MAINNET_DEFAULT_MAX_TARGET = 0x796b00000000000000000000000000000000000000000;
    uint256 public constant SIGNET_DEFAULT_MAX_TARGET  = 0x377ae000000000000000000000000000000000000000000000000000000; // nBits 0x1e0377ae
    uint256 public constant REGTEST_MAX_TARGET         = 0x7fffff0000000000000000000000000000000000000000000000000000000000; // 0x207fffff

    address public feeRecipient;
    address public btcOpsRecipient;
    uint256 public threshold;
    mapping(address => bool) public isAttester;
    uint256 public attesterCount;
    uint256 public minBtcConfs = 3;
    uint256 public powMaxTarget = MAINNET_DEFAULT_MAX_TARGET;
    /// 0 = mainnet (bc1p), 1 = testnet/signet (tb1p), 2 = regtest (bcrt1p).
    uint8 public btcNetwork;

    mapping(address => bool) public isAllowedToken;                     // B12
    mapping(bytes32 => CollectionConfig) public collections;
    mapping(bytes32 => mapping(address => uint256)) public priceOf;
    mapping(bytes32 => uint256) public inscriptionFeeCapOf;             // B13 cap, token units
    mapping(uint256 => Order) internal orders;
    mapping(bytes32 => bool) public inscriptionUsed;
    uint256 public nextOrderId = 1;
    mapping(bytes32 => uint256) public maxPerWalletOf;
    mapping(bytes32 => mapping(address => uint256)) public ordersBy;

    event CollectionConfigured(bytes32 indexed collectionId, address artist, uint96 feeBps, uint32 maxSupply);
    event TokenPriceSet(bytes32 indexed collectionId, address indexed token, uint256 price);
    event TokenAllowed(address indexed token, bool allowed);
    event InscriptionFeeCapSet(bytes32 indexed collectionId, uint256 cap);
    event OrderCreated(uint256 indexed orderId, bytes32 indexed collectionId, address indexed buyer,
                       address token, uint256 amount, string btcAddress, uint64 deadline);
    event InscriptionFeePaid(uint256 indexed orderId, uint256 inscriptionFee);
    event DeliveryAttested(uint256 indexed orderId, bytes32 btcTxid, string inscriptionId);
    event Released(uint256 indexed orderId, address artist, uint256 artistAmount, uint256 feeAmount, uint64 payoutChainId);
    event BtcOpsPaid(uint256 indexed orderId, address recipient, uint256 amount);
    event Refunded(uint256 indexed orderId, address buyer, uint256 amount);
    event Disputed(uint256 indexed orderId, address by);
    event DisputeResolved(uint256 indexed orderId, bool releasedToArtist);
    event AttesterSet(address attester, bool allowed);
    event ThresholdSet(uint256 threshold);
    event MaxPerWalletSet(bytes32 indexed collectionId, uint256 maxPerWallet, uint256 effective);
    event FeeRecipientSet(address recipient);
    event BtcOpsRecipientSet(address recipient);
    event BtcNetworkSet(uint8 network, uint256 powMaxTarget);
    event PowFloorSet(uint256 powMaxTarget);
    event MinBtcConfsSet(uint256 confs);

    error BadConfig(); error NotAccepted(); error SoldOut(); error BadStatus();
    error TooEarly(); error TooLate(); error BadSigs(); error InscriptionReused(); error NotAuthorized(); error WalletLimit();
    error ZeroAddress(); error FeeOnTransfer(); error InscriptionFeeTooHigh();
    error SpvWrongRecipient(); error SpvBadInclusion(); error SpvTooOld();

    constructor(address owner_, address feeRecipient_, address[] memory attesters, uint256 threshold_)
        Ownable(owner_) EIP712("MultiSeaOrdinalEscrow", "1")
    {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        btcOpsRecipient = feeRecipient_; // B13 default: the fee wallet
        emit FeeRecipientSet(feeRecipient_);
        emit BtcOpsRecipientSet(feeRecipient_);
        for (uint256 i; i < attesters.length; i++) _setAttester(attesters[i], true);
        if (threshold_ == 0 || threshold_ > attesterCount) revert BadConfig();
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    // ---------------- admin (owner = admin wallet / timelock) ----------------
    function configureCollection(bytes32 id, CollectionConfig calldata c) external onlyOwner {
        if (c.artist == address(0) || c.feeBps > MAX_FEE_BPS || c.deliveryWindow < 1 hours) revert BadConfig();
        uint32 sold = collections[id].sold;
        collections[id] = c;
        collections[id].sold = sold;
        emit CollectionConfigured(id, c.artist, c.feeBps, c.maxSupply);
    }
    function setAllowedToken(address token, bool ok) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isAllowedToken[token] = ok; emit TokenAllowed(token, ok);
    }
    function setTokenPrice(bytes32 id, address token, uint256 price) external onlyOwner {
        if (price != 0 && !isAllowedToken[token]) revert NotAccepted();
        if (price > type(uint128).max) revert BadConfig();
        priceOf[id][token] = price; emit TokenPriceSet(id, token, price);
    }
    function setInscriptionFeeCap(bytes32 id, uint256 cap) external onlyOwner {
        if (cap > type(uint128).max) revert BadConfig();
        inscriptionFeeCapOf[id] = cap; emit InscriptionFeeCapSet(id, cap);
    }
    function setFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        feeRecipient = r; emit FeeRecipientSet(r);
    }
    function setBtcOpsRecipient(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        btcOpsRecipient = r; emit BtcOpsRecipientSet(r);
    }
    function setAttester(address a, bool ok) external onlyOwner {
        _setAttester(a, ok);
        if (threshold > attesterCount) revert BadConfig(); // can't remove below threshold
    }
    function _setAttester(address a, bool ok) internal {
        if (a == address(0)) revert ZeroAddress();
        if (isAttester[a] == ok) return;
        isAttester[a] = ok;
        if (ok) attesterCount++; else attesterCount--;
        emit AttesterSet(a, ok);
    }
    function setThreshold(uint256 t) external onlyOwner {
        if (t == 0 || t > attesterCount) revert BadConfig();
        threshold = t; emit ThresholdSet(t);
    }
    function setMaxPerWallet(bytes32 id, uint256 n) external onlyOwner {
        if (n > MAX_PER_WALLET_CAP) revert BadConfig();
        maxPerWalletOf[id] = n; emit MaxPerWalletSet(id, n, walletLimit(id));
    }
    function walletLimit(bytes32 id) public view returns (uint256) {
        uint256 n = maxPerWalletOf[id]; return n == 0 ? DEFAULT_MAX_PER_WALLET : n;
    }
    function setMinBtcConfs(uint256 confs) external onlyOwner {
        if (confs == 0 || confs > MAX_CONFS) revert BadConfig();
        minBtcConfs = confs; emit MinBtcConfsSet(confs);
    }
    /// Also resets the PoW floor to that network's default.
    function setBtcNetwork(uint8 n) external onlyOwner {
        if (n > 2) revert BadConfig();
        btcNetwork = n;
        powMaxTarget = n == 0 ? MAINNET_DEFAULT_MAX_TARGET : n == 1 ? SIGNET_DEFAULT_MAX_TARGET : REGTEST_MAX_TARGET;
        emit BtcNetworkSet(n, powMaxTarget);
    }
    function setPowFloor(uint256 maxTarget) external onlyOwner {
        if (maxTarget == 0 || maxTarget > REGTEST_MAX_TARGET || (btcNetwork != 2 && maxTarget > SIGNET_DEFAULT_MAX_TARGET)) revert BadConfig();
        powMaxTarget = maxTarget; emit PowFloorSet(maxTarget);
    }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function btcHrp() public view returns (bytes memory) {
        return btcNetwork == 0 ? bytes("bc") : btcNetwork == 1 ? bytes("tb") : bytes("bcrt");
    }

    // ---------------- buyer ----------------
    /// @param inscriptionFee BTC fee pass-through in `token` units, as quoted by the delivery service (<= cap).
    function createOrder(bytes32 collectionId, address token, string calldata btcAddress, uint256 inscriptionFee)
        external nonReentrant whenNotPaused returns (uint256 orderId)
    {
        CollectionConfig storage c = collections[collectionId];
        if (!c.active) revert BadConfig();
        if (!isAllowedToken[token]) revert NotAccepted();
        uint256 price = priceOf[collectionId][token];
        if (price == 0) revert NotAccepted();
        if (inscriptionFee > inscriptionFeeCapOf[collectionId]) revert InscriptionFeeTooHigh();
        if (c.sold >= c.maxSupply) revert SoldOut();
        bytes32 program = Bech32m.decodeTaproot(btcAddress, btcHrp()); // reverts InvalidSegwit
        if (ordersBy[collectionId][msg.sender] >= walletLimit(collectionId)) revert WalletLimit();
        ordersBy[collectionId][msg.sender]++;
        c.sold++;

        orderId = nextOrderId++;
        uint64 deadline = uint64(block.timestamp) + c.deliveryWindow;
        orders[orderId] = Order(msg.sender, token, uint128(price), uint128(inscriptionFee), uint64(block.timestamp),
                                deadline, Status.Pending, collectionId, program, btcAddress, bytes32(0), "");
        emit OrderCreated(orderId, collectionId, msg.sender, token, price, btcAddress, deadline);
        if (inscriptionFee != 0) emit InscriptionFeePaid(orderId, inscriptionFee);

        uint256 total = price + inscriptionFee;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), total);
        if (IERC20(token).balanceOf(address(this)) - before != total) revert FeeOnTransfer(); // B12
    }

    // ---------------- attestation: attester signature(s) AND SPV proof ----------------
    function attestDelivery(uint256 orderId, SpvProof calldata proof, uint256 sigDeadline, bytes[] calldata sigs)
        external whenNotPaused
    {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending) revert BadStatus();
        if (block.timestamp > sigDeadline) revert TooLate();

        (bytes32 txidDisplay, uint256 btcTime) = _verifySpv(o.btcProgram, proof);
        if (btcTime + BTC_TIME_TOLERANCE < o.createdAt) revert SpvTooOld();
        string memory ins = string.concat(_hex32(txidDisplay), "i0");
        bytes32 insHash = keccak256(bytes(ins));
        if (inscriptionUsed[insHash]) revert InscriptionReused();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ATTEST_TYPEHASH, orderId, txidDisplay, insHash, sigDeadline)));
        address last; uint256 valid = 0;
        for (uint256 i; i < sigs.length; i++) {
            address s = ECDSA.recover(digest, sigs[i]);
            if (s <= last) revert BadSigs(); // strictly ascending => no duplicates
            last = s;
            if (isAttester[s]) valid++;
        }
        if (valid < threshold) revert BadSigs();

        inscriptionUsed[insHash] = true;
        o.status = Status.Attested; o.btcTxid = txidDisplay; o.inscriptionId = ins;
        emit DeliveryAttested(orderId, txidDisplay, ins);
    }

    /// @notice View helper: what attestDelivery's SPV half would accept (txid display order, inclusion block time).
    function verifySpv(uint256 orderId, SpvProof calldata proof) external view returns (bytes32, uint256) {
        return _verifySpv(orders[orderId].btcProgram, proof);
    }

    function _verifySpv(bytes32 program, SpvProof calldata p) internal view returns (bytes32 txidDisplay, uint256 time) {
        if (BtcSpv.output0Taproot(p.rawTx) != program || program == bytes32(0)) revert SpvWrongRecipient();
        bytes32 txid = BtcSpv.hash256(p.rawTx);
        (bytes32 root, uint256 t) = BtcSpv.verifyHeaders(p.headers, minBtcConfs, powMaxTarget);
        if (BtcSpv.merkleRoot(txid, p.siblings, p.index) != root) revert SpvBadInclusion();
        return (BtcSpv.reverse32(txid), t);
    }

    function _hex32(bytes32 x) internal pure returns (string memory) {
        bytes memory s = new bytes(64);
        bytes16 HEX = "0123456789abcdef";
        for (uint256 i; i < 32; i++) {
            s[2 * i] = HEX[uint8(x[i]) >> 4];
            s[2 * i + 1] = HEX[uint8(x[i]) & 15];
        }
        return string(s);
    }

    // ---------------- settlement ----------------
    function release(uint256 orderId) external nonReentrant whenNotPaused {
        Order storage o = orders[orderId];
        if (o.status != Status.Attested) revert BadStatus();
        _payout(o, orderId);
    }

    function _payout(Order storage o, uint256 orderId) internal {
        o.status = Status.Released;
        CollectionConfig storage c = collections[o.collectionId];
        uint256 fee = uint256(o.amount) * c.feeBps / 10_000;
        uint256 toArtist = uint256(o.amount) - fee;
        uint256 ops = o.inscriptionFee;
        address artist = c.artist; address feeTo = feeRecipient; address opsTo = btcOpsRecipient;
        emit Released(orderId, artist, toArtist, fee, c.payoutChainId);
        if (ops != 0) emit BtcOpsPaid(orderId, opsTo, ops);
        IERC20 t = IERC20(o.token);
        if (fee != 0) t.safeTransfer(feeTo, fee);
        if (toArtist != 0) t.safeTransfer(artist, toArtist);
        if (ops != 0) t.safeTransfer(opsTo, ops);
    }

    /// Refund only if still Pending after deadline. Deliberately NOT pausable so funds can't be frozen.
    function refund(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending) revert BadStatus();
        if (block.timestamp <= o.deadline) revert TooEarly();
        _refund(o, orderId);
    }

    function _refund(Order storage o, uint256 orderId) internal {
        o.status = Status.Refunded;
        collections[o.collectionId].sold--;
        ordersBy[o.collectionId][o.buyer]--;
        uint256 total = uint256(o.amount) + o.inscriptionFee; // B13: inscription fee refunded in full
        emit Refunded(orderId, o.buyer, total);
        IERC20(o.token).safeTransfer(o.buyer, total);
    }

    // ---------------- disputes ----------------
    function dispute(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer && msg.sender != owner()) revert NotAuthorized();
        if (o.status != Status.Pending && o.status != Status.Attested) revert BadStatus();
        o.status = Status.Disputed;
        emit Disputed(orderId, msg.sender);
    }

    function resolveDispute(uint256 orderId, bool releaseToArtist) external onlyOwner nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Disputed) revert BadStatus();
        emit DisputeResolved(orderId, releaseToArtist);
        if (releaseToArtist) _payout(o, orderId); else _refund(o, orderId);
    }

    function getOrder(uint256 orderId) external view returns (Order memory) { return orders[orderId]; }
    function orderStatus(uint256 orderId) external view returns (Status) { return orders[orderId].status; }

    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }
}
