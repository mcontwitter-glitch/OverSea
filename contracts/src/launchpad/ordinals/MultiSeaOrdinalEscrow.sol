// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * ============================================================================
 *  MultiSeaOrdinalEscrow — MultiSea cross-chain Ordinal escrow (UNAUDITED)
 *  !!! UNAUDITED SKETCH. NOT FOR PRODUCTION. DO NOT DEPLOY WITH REAL FUNDS. !!!
 * ============================================================================
 *  Buyer pays an ERC-20 (e.g. USDC) on an EVM chain (Base first, native USDC),
 *  an off-chain inscriber delivers a Bitcoin Ordinal to the buyer's taproot
 *  address, M-of-N EIP-712 attesters confirm delivery (btc txid + inscription
 *  id), then funds are released to artist + launchpad. Buyer can refund after
 *  deadline if nothing was attested. An optional SPV verifier hook is stubbed.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Optional SPV verifier (e.g. a Bitcoin light-client relay). Not implemented here.
interface IBtcSpvVerifier {
    function verifyTx(bytes32 btcTxid, bytes calldata proof, uint256 minConfs) external view returns (bool);
}

contract MultiSeaOrdinalEscrow is ReentrancyGuard, Pausable, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    enum Status { None, Pending, Attested, Released, Refunded, Disputed }

    struct CollectionConfig {
        address artist;          // payout recipient on this chain (or bridge adapter)
        uint96  feeBps;          // launchpad fee in bps (<= 2000)
        uint32  maxSupply;       // e.g. 444
        uint32  sold;            // orders created (incl. pending)
        uint32  deliveryWindow;  // seconds until refund allowed
        bool    active;
        uint64  payoutChainId;   // artist's preferred chain (0 = same chain)
    }

    struct Order {
        address buyer;
        address token;
        uint128 amount;
        uint64  deadline;
        Status  status;
        bytes32 collectionId;
        string  btcAddress;      // bc1p... taproot
        bytes32 btcTxid;
        string  inscriptionId;   // "<txid>i<n>"
    }

    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(uint256 orderId,bytes32 btcTxid,bytes32 inscriptionIdHash,uint256 deadline)"
    );

    address public feeRecipient;
    uint256 public threshold;
    mapping(address => bool) public isAttester;
    IBtcSpvVerifier public spvVerifier; // optional, address(0) = disabled
    uint256 public minBtcConfs = 3;
    /// 0 = mainnet (bc1p), 1 = testnet/signet (tb1p), 2 = regtest (bcrt1p). Default mainnet.
    uint8 public btcNetwork;

    mapping(bytes32 => CollectionConfig) public collections;
    mapping(bytes32 => mapping(address => uint256)) public priceOf; // collection => token => price (0 = not accepted)
    mapping(uint256 => Order) public orders;
    mapping(bytes32 => bool) public inscriptionUsed; // prevents one inscription satisfying two orders
    uint256 public nextOrderId = 1;

    /// Per-wallet order limit (launchpad M4): 0 = default 50, otherwise 1..100.
    uint256 public constant DEFAULT_MAX_PER_WALLET = 50;
    uint256 public constant MAX_PER_WALLET_CAP = 100;
    mapping(bytes32 => uint256) public maxPerWalletOf;                  // collection => configured limit (0 = default)
    mapping(bytes32 => mapping(address => uint256)) public ordersBy;    // collection => buyer => live orders (refunds free a slot)

    event CollectionConfigured(bytes32 indexed collectionId, address artist, uint96 feeBps, uint32 maxSupply);
    event TokenPriceSet(bytes32 indexed collectionId, address indexed token, uint256 price);
    event OrderCreated(uint256 indexed orderId, bytes32 indexed collectionId, address indexed buyer,
                       address token, uint256 amount, string btcAddress, uint64 deadline);
    event DeliveryAttested(uint256 indexed orderId, bytes32 btcTxid, string inscriptionId);
    event Released(uint256 indexed orderId, address artist, uint256 artistAmount, uint256 feeAmount, uint64 payoutChainId);
    event Refunded(uint256 indexed orderId, address buyer, uint256 amount);
    event Disputed(uint256 indexed orderId, address by);
    event DisputeResolved(uint256 indexed orderId, bool releasedToArtist);
    event AttesterSet(address attester, bool allowed);
    event ThresholdSet(uint256 threshold);
    event MaxPerWalletSet(bytes32 indexed collectionId, uint256 maxPerWallet, uint256 effective);

    error BadConfig(); error NotAccepted(); error SoldOut(); error BadStatus();
    error TooEarly(); error TooLate(); error BadSigs(); error InscriptionReused(); error NotAuthorized(); error WalletLimit();

    constructor(address owner_, address feeRecipient_, address[] memory attesters, uint256 threshold_)
        Ownable(owner_) EIP712("MultiSeaOrdinalEscrow", "1")
    {
        feeRecipient = feeRecipient_;
        for (uint256 i; i < attesters.length; i++) { isAttester[attesters[i]] = true; emit AttesterSet(attesters[i], true); }
        if (threshold_ == 0 || threshold_ > attesters.length) revert BadConfig();
        threshold = threshold_;
    }

    // ---------------- admin ----------------
    function configureCollection(bytes32 id, CollectionConfig calldata c) external onlyOwner {
        if (c.artist == address(0) || c.feeBps > 2000 || c.deliveryWindow < 1 hours) revert BadConfig();
        CollectionConfig storage s = collections[id];
        uint32 sold = s.sold;
        collections[id] = c;
        collections[id].sold = sold;
        emit CollectionConfigured(id, c.artist, c.feeBps, c.maxSupply);
    }
    function setTokenPrice(bytes32 id, address token, uint256 price) external onlyOwner {
        priceOf[id][token] = price; emit TokenPriceSet(id, token, price);
    }
    function setAttester(address a, bool ok) external onlyOwner { isAttester[a] = ok; emit AttesterSet(a, ok); }
    function setMaxPerWallet(bytes32 id, uint256 n) external onlyOwner {
        if (n > MAX_PER_WALLET_CAP) revert BadConfig();
        maxPerWalletOf[id] = n; emit MaxPerWalletSet(id, n, walletLimit(id));
    }
    function walletLimit(bytes32 id) public view returns (uint256) {
        uint256 n = maxPerWalletOf[id]; return n == 0 ? DEFAULT_MAX_PER_WALLET : n;
    }
    function setThreshold(uint256 t) external onlyOwner { if (t == 0) revert BadConfig(); threshold = t; emit ThresholdSet(t); }
    function setSpvVerifier(IBtcSpvVerifier v, uint256 confs) external onlyOwner { spvVerifier = v; minBtcConfs = confs; }
    function setBtcNetwork(uint8 n) external onlyOwner { if (n > 2) revert BadConfig(); btcNetwork = n; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ---------------- buyer ----------------
    function createOrder(bytes32 collectionId, address token, string calldata btcAddress)
        external nonReentrant whenNotPaused returns (uint256 orderId)
    {
        CollectionConfig storage c = collections[collectionId];
        if (!c.active) revert BadConfig();
        uint256 price = priceOf[collectionId][token];
        if (price == 0) revert NotAccepted();
        if (c.sold >= c.maxSupply) revert SoldOut();
        bytes memory a = bytes(btcAddress);
        if (!_looksTaproot(a)) revert BadConfig(); // naive prefix/length check only (no bech32m checksum)
        if (ordersBy[collectionId][msg.sender] >= walletLimit(collectionId)) revert WalletLimit();
        ordersBy[collectionId][msg.sender]++;
        c.sold++;

        orderId = nextOrderId++;
        uint64 deadline = uint64(block.timestamp + c.deliveryWindow);
        orders[orderId] = Order(msg.sender, token, uint128(price), deadline, Status.Pending,
                                collectionId, btcAddress, bytes32(0), "");
        // pull exact price; fee-on-transfer tokens unsupported (check balance delta in prod)
        IERC20(token).safeTransferFrom(msg.sender, address(this), price);
        emit OrderCreated(orderId, collectionId, msg.sender, token, price, btcAddress, deadline);
    }

    // ---------------- attestation ----------------
    function attestDelivery(uint256 orderId, bytes32 btcTxid, string calldata inscriptionId,
                            uint256 sigDeadline, bytes[] calldata sigs) external whenNotPaused
    {
        Order storage o = orders[orderId];
        if (o.status != Status.Pending) revert BadStatus();
        if (block.timestamp > sigDeadline) revert TooLate();
        bytes32 insHash = keccak256(bytes(inscriptionId));
        if (inscriptionUsed[insHash]) revert InscriptionReused();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ATTEST_TYPEHASH, orderId, btcTxid, insHash, sigDeadline)));
        address last; uint256 valid;
        for (uint256 i; i < sigs.length; i++) {
            address s = ECDSA.recover(digest, sigs[i]);
            if (s <= last) revert BadSigs(); // strictly ascending => no duplicates
            last = s;
            if (isAttester[s]) valid++;
        }
        if (valid < threshold) revert BadSigs();
        _markDelivered(o, orderId, btcTxid, inscriptionId, insHash);
    }

    /// Optional trust-minimised path: SPV proof that btcTxid is buried >= minBtcConfs.
    /// NOTE: proving the tx pays the inscription to o.btcAddress requires output parsing in the verifier.
    function attestDeliverySpv(uint256 orderId, bytes32 btcTxid, string calldata inscriptionId, bytes calldata proof)
        external whenNotPaused
    {
        Order storage o = orders[orderId];
        if (address(spvVerifier) == address(0)) revert NotAuthorized();
        if (o.status != Status.Pending) revert BadStatus();
        bytes32 insHash = keccak256(bytes(inscriptionId));
        if (inscriptionUsed[insHash]) revert InscriptionReused();
        if (!spvVerifier.verifyTx(btcTxid, proof, minBtcConfs)) revert BadSigs();
        _markDelivered(o, orderId, btcTxid, inscriptionId, insHash);
    }

    function _markDelivered(Order storage o, uint256 id, bytes32 txid, string calldata ins, bytes32 insHash) internal {
        inscriptionUsed[insHash] = true;
        o.status = Status.Attested; o.btcTxid = txid; o.inscriptionId = ins;
        emit DeliveryAttested(id, txid, ins);
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
        IERC20(o.token).safeTransfer(feeRecipient, fee);
        // If c.payoutChainId != 0, c.artist would be a bridge adapter (CCTP / LayerZero / Across) — see design doc.
        IERC20(o.token).safeTransfer(c.artist, toArtist);
        emit Released(orderId, c.artist, toArtist, fee, c.payoutChainId);
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
        ordersBy[o.collectionId][o.buyer]--; // refunded order frees the wallet slot
        IERC20(o.token).safeTransfer(o.buyer, o.amount);
        emit Refunded(orderId, o.buyer, o.amount);
    }

    // ---------------- disputes ----------------
    function dispute(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (msg.sender != o.buyer && msg.sender != owner()) revert NotAuthorized();
        if (o.status != Status.Pending && o.status != Status.Attested) revert BadStatus();
        o.status = Status.Disputed;
        emit Disputed(orderId, msg.sender);
    }

    /// Owner (should be a timelocked multisig) resolves.
    function resolveDispute(uint256 orderId, bool releaseToArtist) external onlyOwner nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != Status.Disputed) revert BadStatus();
        emit DisputeResolved(orderId, releaseToArtist);
        if (releaseToArtist) _payout(o, orderId); else _refund(o, orderId);
    }

    function _looksTaproot(bytes memory a) internal view returns (bool) {
        bytes memory p = btcNetwork == 0 ? bytes("bc1p") : btcNetwork == 1 ? bytes("tb1p") : bytes("bcrt1p");
        if (a.length != p.length + 58) return false; // P2TR = hrp + "1" + 59 data chars ("p" + 58)
        for (uint256 i; i < p.length; i++) if (a[i] != p[i]) return false;
        return true;
    }

    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }
}
