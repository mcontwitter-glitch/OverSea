// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { MultiSeaDrop } from "./MultiSeaDrop.sol";

interface IOmniEscrow {
    function localEid() external view returns (uint32);
    function quoteFanout(bytes32 cid, uint32 originEid, uint256 qty) external view returns (uint256);
    function quoteRequest(bytes32 cid, uint256 qty, address to, uint128 hubValue) external view returns (uint256);
    function fanoutCopies(bytes32 cid, uint256 start, uint256 qty, address refund) external payable;
    function sendRequest(bytes32 cid, uint256 rid, address to, uint256 qty, uint256 phaseId, uint128 hubValue, address refund) external payable;
    function sendMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to, address refund) external payable;
}

/// @title MultiSeaOmniDrop
/// @notice Multichain (escrow) launchpad drop. The same clone config is deployed on every chain of the drop.
///         - When token id X is minted on the chain the minter picked (where it is ACTIVE), the same id X is minted into
///           MultiSeaOmniEscrow on every other chain of the drop, by LayerZero COPY messages. Escrow copies are locked,
///           never burned.
///         - One shared supply. Ids are assigned ONLY on the hub chain (Base): a hub-chain mint assigns locally and is
///           instant; a mint on any other chain is a REQUEST (payment held here) that the hub confirms with ids or
///           rejects (sold out / wallet limit) -> refund. The hub processes requests one at a time, so concurrent mints
///           on different chains can never get the same id or exceed maxSupply.
///         - Moving: moveTo() locks the token in the local escrow and LayerZero releases it on the destination.
/// @dev    PREVIEW / UNAUDITED. Not deployed anywhere. OZ ERC721 (not 721A): ids arrive out of order on non-hub chains.
contract MultiSeaOmniDrop is ERC721Upgradeable, ERC2981, ReentrancyGuard {
    using Strings for uint256;

    struct OmniInit {
        string name;
        string symbol;
        address owner;
        address payout;
        address feeWallet;       // set by factory
        uint16 platformFeeBps;   // set by factory
        uint32 maxSupply;        // shared across ALL chains, enforced on the hub
        address royaltyReceiver;
        uint96 royaltyBps;
        string baseURI;
        string preRevealURI;
        MultiSeaDrop.Phase[] phases; // timing / per-wallet cap / Merkle root shared; `price` ignored (see prices)
        uint32[] eids;               // LayerZero EIDs of the drop's chains
        uint32 hubEid;               // the chain that assigns ids and enforces the cap (Base); must be in eids
        uint128[] prices;            // per chain per phase, native token: prices[i * phases.length + phaseId]
    }

    enum Req { None, Pending, Confirmed, Refunded }
    struct Request { address to; address payer; uint32 qty; uint32 start; Req status; uint128 paid; }

    uint16 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MAX_QTY = 20; // per mint tx (bounds destination gas)
    uint8 public constant R_SOLD_OUT = 1;
    uint8 public constant R_WALLET_LIMIT = 2;
    uint8 public constant R_PAUSED = 3;

    IOmniEscrow public escrow;
    bytes32 public collectionId;
    uint32 public localEid;
    uint32 public hubEid;
    uint32 public maxSupply;
    uint32 public nextId;        // hub only: next id to assign (starts at 1)
    uint32 public mintedHere;    // ids whose mint chose this chain (Active here at mint)
    uint32 public pendingQty;    // non-hub: requested, not yet confirmed or refunded
    uint16 public platformFeeBps;
    uint16 private _chainIdx;
    address public owner;
    address public pendingOwner;
    address public payout;
    address public feeWallet;
    bool public paused;
    bool public revealed;
    bool public metadataFrozen;
    string private _base;
    string public preRevealURI;
    MultiSeaDrop.Phase[] private _phases;
    uint32[] private _eids;
    uint128[] private _prices;
    uint256 public held;         // payments of pending requests + unclaimed refunds: never withdrawable
    uint256 public nextRid;
    mapping(uint256 => Request) public requests;
    mapping(address => uint256) public refundOf;
    mapping(uint256 => mapping(address => uint256)) public mintedInPhase; // hub: GLOBAL per-wallet count (all chains)

    event Minted(address indexed to, uint256 indexed phaseId, uint256 firstId, uint256 qty, uint256 paid);
    event MintRequested(uint256 indexed rid, address indexed to, uint256 qty, uint256 paid);
    event MintConfirmed(uint256 indexed rid, uint256 firstId, uint256 qty);
    event MintRejected(uint256 indexed rid, uint8 reason, uint256 refunded);
    event Assigned(uint32 indexed originEid, address indexed to, uint256 firstId, uint256 qty);
    event EscrowCopies(uint256 firstId, uint256 qty, uint256 created);
    event MoveStarted(uint256 indexed tokenId, address indexed from, uint32 dstEid, address to);
    event Released(uint256 indexed tokenId, address indexed to, bool materialised);
    event Withdrawn(uint256 toCreator, uint256 toPlatform);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotEscrow();
    error IsPaused();
    error PhaseNotActive();
    error NotAllowlisted();
    error WalletLimit();
    error SoldOut(uint256 left);
    error WrongPayment(uint256 required);
    error BadParams();
    error NotMovable();
    error NotPending();
    error Frozen();
    error PayFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyEscrow() { if (msg.sender != address(escrow)) revert NotEscrow(); _; }

    constructor() { _disableInitializers(); }

    function initialize(OmniInit calldata p, address escrow_, bytes32 cid) external initializer {
        uint256 n = p.eids.length; uint256 np = p.phases.length;
        if (p.owner == address(0) || p.payout == address(0) || p.maxSupply == 0 || p.royaltyBps > MAX_ROYALTY_BPS) revert BadParams();
        if (n < 2 || n > 8 || np == 0 || np > 8 || p.prices.length != n * np) revert BadParams();
        __ERC721_init(p.name, p.symbol);
        escrow = IOmniEscrow(escrow_); collectionId = cid; localEid = escrow.localEid(); hubEid = p.hubEid;
        owner = p.owner; payout = p.payout; feeWallet = p.feeWallet; platformFeeBps = p.platformFeeBps;
        maxSupply = p.maxSupply; nextId = 1; _base = p.baseURI; preRevealURI = p.preRevealURI; revealed = bytes(p.preRevealURI).length == 0;
        if (p.royaltyBps > 0) _setDefaultRoyalty(p.royaltyReceiver == address(0) ? p.payout : p.royaltyReceiver, p.royaltyBps);
        bool found; bool hubIn;
        for (uint256 i; i < n; ++i) {
            for (uint256 j; j < i; ++j) if (p.eids[j] == p.eids[i]) revert BadParams();
            if (p.eids[i] == localEid) { found = true; _chainIdx = uint16(i); }
            if (p.eids[i] == p.hubEid) hubIn = true;
            _eids.push(p.eids[i]);
        }
        if (!found || !hubIn) revert BadParams();
        for (uint256 i; i < np; ++i) { if (p.phases[i].end != 0 && p.phases[i].end <= p.phases[i].start) revert BadParams(); _phases.push(p.phases[i]); }
        for (uint256 i; i < p.prices.length; ++i) _prices.push(p.prices[i]);
        emit OwnershipTransferred(address(0), p.owner);
    }

    // ------------------------------------------------------------------ mint
    function priceOf(uint256 phaseId) public view returns (uint256) { return _prices[uint256(_chainIdx) * _phases.length + phaseId]; }
    function isHub() public view returns (bool) { return localEid == hubEid; }
    /// @notice Hub view: ids assigned so far across all chains (the shared supply counter).
    function totalAssigned() external view returns (uint256) { return nextId - 1; }

    /// @notice Total the minter sends: price * qty + LayerZero. On the hub `hubValue` is ignored; elsewhere it is the
    ///         hub-native amount (from escrow.quoteFanout on the hub chain, plus a small buffer) dropped on the hub.
    function quoteMint(uint256 phaseId, uint256 qty, address to, uint128 hubValue) external view returns (uint256 price, uint256 lz) {
        price = priceOf(phaseId) * qty;
        lz = isHub() ? escrow.quoteFanout(collectionId, localEid, qty) : escrow.quoteRequest(collectionId, qty, to, hubValue);
    }

    /// @notice Mint on THIS chain (the token will be Active here). Hub chain: instant, ids assigned now, escrow copies sent to
    ///         every other chain. Other chains: a request to the hub (2-step); payment is held until CONFIRM or REJECT.
    function mint(address to, uint256 phaseId, uint256 qty, bytes32[] calldata proof, uint128 hubValue) external payable nonReentrant {
        if (paused) revert IsPaused();
        if (qty == 0 || qty > MAX_QTY || phaseId >= _phases.length || to == address(0)) revert BadParams();
        MultiSeaDrop.Phase memory ph = _phases[phaseId];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) revert PhaseNotActive();
        if (ph.merkleRoot != bytes32(0) && !MerkleProof.verifyCalldata(proof, ph.merkleRoot, keccak256(bytes.concat(keccak256(abi.encode(to)))))) revert NotAllowlisted();
        uint256 cost = priceOf(phaseId) * qty;
        if (msg.value < cost) revert WrongPayment(cost);
        if (isHub()) {
            (uint256 start, uint8 reason) = _assign(localEid, to, qty, phaseId);
            if (reason == R_SOLD_OUT) revert SoldOut(maxSupply + 1 - nextId);
            if (reason == R_WALLET_LIMIT) revert WalletLimit();
            for (uint256 k; k < qty; ++k) _mint(to, start + k); // Active here, no receiver callback
            mintedHere += uint32(qty);
            escrow.fanoutCopies{ value: msg.value - cost }(collectionId, start, qty, msg.sender); // reverts if underpaid
            emit Minted(to, phaseId, start, qty, cost);
        } else {
            uint256 rid = ++nextRid;
            requests[rid] = Request(to, msg.sender, uint32(qty), 0, Req.Pending, uint128(cost));
            held += cost; pendingQty += uint32(qty);
            escrow.sendRequest{ value: msg.value - cost }(collectionId, rid, to, qty, phaseId, hubValue, msg.sender);
            emit MintRequested(rid, to, qty, cost);
        }
    }

    /// @dev Hub only. The ONE place ids are assigned and the shared cap + global per-wallet limit are enforced.
    function _assign(uint32 originEid, address to, uint256 qty, uint256 phaseId) internal returns (uint256 start, uint8 reason) {
        if (uint256(nextId) + qty > uint256(maxSupply) + 1) return (0, R_SOLD_OUT);
        MultiSeaDrop.Phase memory ph = _phases[phaseId];
        uint256 already = mintedInPhase[phaseId][to];
        if (ph.maxPerWallet != 0 && already + qty > ph.maxPerWallet) return (0, R_WALLET_LIMIT);
        mintedInPhase[phaseId][to] = already + qty;
        start = nextId; nextId += uint32(qty);
        emit Assigned(originEid, to, start, qty);
    }

    /// @notice Escrow-only, hub chain: handle a REQUEST from another chain. Assigns ids and mints the hub's escrow copies.
    function hubAssign(uint32 srcEid, address to, uint256 qty, uint256 phaseId) external onlyEscrow returns (uint256 start, uint8 reason) {
        if (!isHub() || srcEid == localEid || !_hasEid(srcEid)) revert BadParams();
        if (paused) return (0, R_PAUSED);
        if (qty == 0 || qty > MAX_QTY || phaseId >= _phases.length) return (0, R_SOLD_OUT);
        (start, reason) = _assign(srcEid, to, qty, phaseId);
        if (start != 0) { for (uint256 k; k < qty; ++k) _mint(address(escrow), start + k); emit EscrowCopies(start, qty, qty); }
    }

    /// @notice Escrow-only, origin chain: the hub assigned [start, start+qty). Mint them Active to the minter here.
    function confirmMint(uint256 rid, uint256 start) external onlyEscrow {
        Request storage r = requests[rid];
        if (r.status != Req.Pending || start == 0) revert NotPending();
        r.status = Req.Confirmed; r.start = uint32(start);
        held -= r.paid; pendingQty -= r.qty; mintedHere += r.qty;
        for (uint256 k; k < r.qty; ++k) _mint(r.to, start + k); // reverts if an id somehow exists here: never two copies
        emit MintConfirmed(rid, start, r.qty);
        emit Minted(r.to, 0, start, r.qty, r.paid);
    }

    /// @notice Escrow-only, origin chain: the hub rejected the request. Refund the held payment (push, else claimable).
    function rejectMint(uint256 rid, uint8 reason) external onlyEscrow {
        Request storage r = requests[rid];
        if (r.status != Req.Pending) revert NotPending();
        r.status = Req.Refunded; pendingQty -= r.qty;
        uint256 v = r.paid;
        (bool ok, ) = r.payer.call{ value: v, gas: 30_000 }("");
        if (ok) held -= v; else refundOf[r.payer] += v; // stays in `held` until claimed
        emit MintRejected(rid, reason, v);
    }
    function claimRefund() external nonReentrant {
        uint256 v = refundOf[msg.sender]; refundOf[msg.sender] = 0; held -= v;
        if (v > 0) { (bool ok, ) = msg.sender.call{ value: v }(""); if (!ok) revert PayFailed(); }
    }

    /// @notice Escrow-only: COPY from the hub. Mint ids into escrow unless they already exist here (e.g. the token was moved
    ///         here before its copy arrived). Never reverts on existing ids, so a late or retried COPY can't get stuck.
    function copyIn(uint256 start, uint256 qty) external onlyEscrow returns (uint256 created) {
        if (start == 0 || qty == 0 || start + qty - 1 > maxSupply) revert BadParams();
        for (uint256 k; k < qty; ++k) if (_ownerOf(start + k) == address(0)) { _mint(address(escrow), start + k); ++created; }
        emit EscrowCopies(start, qty, created);
    }

    // ------------------------------------------------------------------ move (lock here, release there)
    /// @notice Lock `tokenId` in this chain's escrow and make it Active for `to` on `dstEid`. msg.value = platform + LZ fee.
    function moveTo(uint32 dstEid, uint256 tokenId, address to) external payable nonReentrant {
        address holder = _requireOwned(tokenId);
        if (!_isAuthorized(holder, msg.sender, tokenId) || holder == address(escrow)) revert NotMovable();
        if (dstEid == localEid || !_hasEid(dstEid)) revert BadParams();
        _update(address(escrow), tokenId, address(0)); // lock: escrow becomes the holder, approvals cleared
        escrow.sendMove{ value: msg.value }(collectionId, dstEid, tokenId, to, msg.sender);
        emit MoveStarted(tokenId, holder, dstEid, to);
    }

    /// @notice Escrow-only: a token locked on another chain becomes Active here.
    function release(address to, uint256 tokenId) external onlyEscrow {
        address cur = _ownerOf(tokenId);
        if (cur != address(0)) {
            if (cur != address(escrow)) revert NotMovable(); // already Active here: never two Active copies
            _update(to, tokenId, address(0));
            emit Released(tokenId, to, false);
        } else {
            // The COPY for this id has not arrived yet (it is still in flight or owed). The id was assigned by the hub
            // and is locked on the source, so materialise it straight to the recipient; the late COPY becomes a no-op.
            if (tokenId == 0 || tokenId > maxSupply) revert BadParams();
            _mint(to, tokenId);
            emit Released(tokenId, to, true);
        }
    }

    // ------------------------------------------------------------------ money + creator admin
    /// @notice Pays out this chain's mint proceeds. Payments of pending requests and unclaimed refunds are excluded.
    function withdraw() external nonReentrant {
        uint256 bal = address(this).balance - held; uint256 fee = (bal * platformFeeBps) / 10_000;
        if (fee > 0) { (bool a, ) = feeWallet.call{ value: fee }(""); if (!a) revert PayFailed(); }
        if (bal > fee) { (bool b, ) = payout.call{ value: bal - fee }(""); if (!b) revert PayFailed(); }
        emit Withdrawn(bal - fee, fee);
    }
    function setPaused(bool v) external onlyOwner { paused = v; }
    function setPayout(address a) external onlyOwner { if (a == address(0)) revert BadParams(); payout = a; }
    function reveal(string calldata b) external onlyOwner { if (metadataFrozen) revert Frozen(); _base = b; revealed = true; }
    function freezeMetadata() external onlyOwner { if (!revealed) revert BadParams(); metadataFrozen = true; }
    function transferOwnership(address to) external onlyOwner { pendingOwner = to; }
    function acceptOwnership() external { if (msg.sender != pendingOwner) revert NotOwner(); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; pendingOwner = address(0); }

    // ------------------------------------------------------------------ views
    function eids() external view returns (uint32[] memory) { return _eids; }
    function phases() external view returns (MultiSeaDrop.Phase[] memory) { return _phases; }
    /// @notice true if `id` is Active (held by a user) on this chain; false if locked in escrow / not yet arrived here.
    function isActiveHere(uint256 id) external view returns (bool) { address o = _ownerOf(id); return o != address(0) && o != address(escrow); }
    function existsHere(uint256 id) external view returns (bool) { return _ownerOf(id) != address(0); }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return revealed ? string.concat(_base, id.toString(), ".json") : preRevealURI;
    }
    function supportsInterface(bytes4 id) public view override(ERC721Upgradeable, ERC2981) returns (bool) {
        return ERC721Upgradeable.supportsInterface(id) || ERC2981.supportsInterface(id);
    }
    function _hasEid(uint32 e) internal view returns (bool) { for (uint256 i; i < _eids.length; ++i) if (_eids[i] == e) return true; return false; }
}
