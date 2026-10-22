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
    function sendMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to, bytes calldata options, address refund) external payable;
    function sendRange(bytes32 cid, uint32 dstEid, uint32 start, uint32 end, bytes calldata options, address refund) external payable;
}

/// @title MultiSeaOmniDrop
/// @notice Multichain (escrow) launchpad drop. The same clone config is deployed on every chain of the drop.
///         - Every token id 1..maxSupply exists on every chain, but is ACTIVE on exactly one chain. On every other chain
///           it is held by MultiSeaOmniEscrow (locked, never burned; materialised lazily on the first release there).
///         - Shared supply without overselling: the id space is PARTITIONED into per-chain ranges in the signed config
///           (identical on all chains). A chain can only mint ids from its own unminted pool. Pools are rebalanced by
///           debit-then-credit LayerZero RANGE messages, so an id is never mintable on two chains at once.
///         - Moving: moveTo() locks the token in the local escrow and LayerZero releases it on the destination.
/// @dev    PREVIEW / UNAUDITED. Not deployed anywhere. OZ ERC721 (not 721A) because ids are not sequential per chain.
contract MultiSeaOmniDrop is ERC721Upgradeable, ERC2981, ReentrancyGuard {
    using Strings for uint256;

    struct Range { uint32 next; uint32 end; } // unminted ids [next, end)

    struct OmniInit {
        string name;
        string symbol;
        address owner;
        address payout;
        address feeWallet;       // set by factory
        uint16 platformFeeBps;   // set by factory
        uint32 maxSupply;        // shared across ALL chains
        address royaltyReceiver;
        uint96 royaltyBps;
        string baseURI;
        string preRevealURI;
        MultiSeaDrop.Phase[] phases; // timing / per-wallet cap / Merkle root shared; `price` ignored (see prices)
        uint32[] eids;               // LayerZero EIDs of the drop's chains
        uint32[] allocEnd;           // initial partition: chain i owns [allocEnd[i-1] (or 1), allocEnd[i])
        uint128[] prices;            // per chain per phase, native token: prices[i * phases.length + phaseId]
        address rebalancer;          // optional MultiSea keeper allowed to rebalance pools (besides the owner)
    }

    uint16 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MAX_RANGES = 64;

    IOmniEscrow public escrow;
    bytes32 public collectionId;
    uint32 public localEid;
    uint32 public maxSupply;
    uint32 public available;   // unminted ids in this chain's pool
    uint32 public mintedHere;  // ids first minted on this chain
    uint16 public platformFeeBps;
    uint16 private _chainIdx;
    address public owner;
    address public pendingOwner;
    address public payout;
    address public feeWallet;
    address public rebalancer;
    bool public paused;
    bool public revealed;
    bool public metadataFrozen;
    string private _base;
    string public preRevealURI;
    MultiSeaDrop.Phase[] private _phases;
    uint32[] private _eids;
    uint128[] private _prices;
    Range[] private _ranges;
    uint256 private _head;
    mapping(uint256 => mapping(address => uint256)) public mintedInPhase;

    event Minted(address indexed to, uint256 indexed phaseId, uint256 firstId, uint256 qty, uint256 paid);
    event MoveStarted(uint256 indexed tokenId, address indexed from, uint32 dstEid, address to);
    event Released(uint256 indexed tokenId, address indexed to, bool materialised);
    event RangeDebited(uint32 dstEid, uint32 start, uint32 end);
    event RangeCredited(uint32 start, uint32 end);
    event Withdrawn(uint256 toCreator, uint256 toPlatform);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotEscrow();
    error IsPaused();
    error PhaseNotActive();
    error NotAllowlisted();
    error WalletLimit();
    error SoldOutHere(uint32 available);
    error WrongPayment(uint256 required);
    error BadParams();
    error NotMovable();
    error InLocalPool(uint256 tokenId);
    error Frozen();
    error PayFailed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyEscrow() { if (msg.sender != address(escrow)) revert NotEscrow(); _; }

    constructor() { _disableInitializers(); }

    function initialize(OmniInit calldata p, address escrow_, bytes32 cid) external initializer {
        uint256 n = p.eids.length; uint256 np = p.phases.length;
        if (p.owner == address(0) || p.payout == address(0) || p.maxSupply == 0 || p.royaltyBps > MAX_ROYALTY_BPS) revert BadParams();
        if (n < 2 || n > 8 || p.allocEnd.length != n || np == 0 || np > 8 || p.prices.length != n * np) revert BadParams();
        __ERC721_init(p.name, p.symbol);
        escrow = IOmniEscrow(escrow_); collectionId = cid; localEid = escrow.localEid();
        owner = p.owner; payout = p.payout; feeWallet = p.feeWallet; platformFeeBps = p.platformFeeBps; rebalancer = p.rebalancer;
        maxSupply = p.maxSupply; _base = p.baseURI; preRevealURI = p.preRevealURI; revealed = bytes(p.preRevealURI).length == 0;
        if (p.royaltyBps > 0) _setDefaultRoyalty(p.royaltyReceiver == address(0) ? p.payout : p.royaltyReceiver, p.royaltyBps);
        // The partition must cover exactly 1..maxSupply, in order, with no gaps or overlaps. Same check on every chain.
        uint32 start = 1; bool found;
        for (uint256 i; i < n; ++i) {
            uint32 end = p.allocEnd[i];
            if (end < start) revert BadParams();
            for (uint256 j; j < i; ++j) if (p.eids[j] == p.eids[i]) revert BadParams();
            if (p.eids[i] == localEid) { found = true; _chainIdx = uint16(i); if (end > start) { _ranges.push(Range(start, end)); available = end - start; } }
            start = end;
        }
        if (start != p.maxSupply + 1 || !found) revert BadParams();
        for (uint256 i; i < np; ++i) { if (p.phases[i].end != 0 && p.phases[i].end <= p.phases[i].start) revert BadParams(); _phases.push(p.phases[i]); }
        for (uint256 i; i < n; ++i) _eids.push(p.eids[i]);
        for (uint256 i; i < p.prices.length; ++i) _prices.push(p.prices[i]);
        emit OwnershipTransferred(address(0), p.owner);
    }

    // ------------------------------------------------------------------ mint (local, no LayerZero)
    function priceOf(uint256 phaseId) public view returns (uint256) { return _prices[uint256(_chainIdx) * _phases.length + phaseId]; }

    function mint(address to, uint256 phaseId, uint256 qty, bytes32[] calldata proof) external payable nonReentrant {
        if (paused) revert IsPaused();
        if (qty == 0 || phaseId >= _phases.length) revert BadParams();
        MultiSeaDrop.Phase memory ph = _phases[phaseId];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) revert PhaseNotActive();
        if (ph.merkleRoot != bytes32(0) && !MerkleProof.verifyCalldata(proof, ph.merkleRoot, keccak256(bytes.concat(keccak256(abi.encode(to)))))) revert NotAllowlisted();
        uint256 already = mintedInPhase[phaseId][to];
        if (ph.maxPerWallet != 0 && already + qty > ph.maxPerWallet) revert WalletLimit();
        if (qty > available) revert SoldOutHere(available);
        uint256 cost = priceOf(phaseId) * qty;
        if (msg.value != cost) revert WrongPayment(cost);
        mintedInPhase[phaseId][to] = already + qty;
        available -= uint32(qty); mintedHere += uint32(qty);
        uint256 first;
        for (uint256 k; k < qty; ++k) {
            Range storage r = _ranges[_head];
            uint256 id = r.next++;
            if (r.next == r.end) ++_head;
            if (k == 0) first = id;
            _mint(to, id); // no receiver callback
        }
        emit Minted(to, phaseId, first, qty, cost);
    }

    // ------------------------------------------------------------------ move (lock here, release there)
    /// @notice Lock `tokenId` in this chain's escrow and make it Active for `to` on `dstEid`. msg.value = platform + LZ fee.
    function moveTo(uint32 dstEid, uint256 tokenId, address to, bytes calldata options) external payable nonReentrant {
        address holder = _requireOwned(tokenId);
        if (!_isAuthorized(holder, msg.sender, tokenId) || holder == address(escrow)) revert NotMovable();
        if (dstEid == localEid || !_hasEid(dstEid)) revert BadParams();
        _update(address(escrow), tokenId, address(0)); // lock: escrow becomes the holder, approvals cleared
        escrow.sendMove{ value: msg.value }(collectionId, dstEid, tokenId, to, options, msg.sender);
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
            if (tokenId == 0 || tokenId > maxSupply || inLocalPool(tokenId)) revert InLocalPool(tokenId);
            _mint(to, tokenId); // first arrival on this chain: materialise out of the (virtual) escrow balance
            emit Released(tokenId, to, true);
        }
    }

    // ------------------------------------------------------------------ pool rebalancing (debit, then LZ credit)
    function rebalance(uint32 dstEid, uint32 count, bytes calldata options) external payable nonReentrant {
        if (msg.sender != owner && msg.sender != rebalancer) revert NotOwner();
        if (count == 0 || dstEid == localEid || !_hasEid(dstEid) || _ranges.length == 0) revert BadParams();
        Range storage r = _ranges[_ranges.length - 1];
        if (_ranges.length - 1 < _head || r.end - r.next < count) revert SoldOutHere(available);
        uint32 end = r.end; uint32 start = end - count;
        r.end = start; available -= count;
        if (r.next == r.end) { _ranges.pop(); }
        emit RangeDebited(dstEid, start, end);
        escrow.sendRange{ value: msg.value }(collectionId, dstEid, start, end, options, msg.sender);
    }

    function creditRange(uint32 start, uint32 end) external onlyEscrow {
        if (start == 0 || end <= start || end > maxSupply + 1 || _ranges.length - _head >= MAX_RANGES) revert BadParams();
        _ranges.push(Range(start, end)); available += end - start;
        emit RangeCredited(start, end);
    }

    function inLocalPool(uint256 id) public view returns (bool) {
        for (uint256 i = _head; i < _ranges.length; ++i) if (id >= _ranges[i].next && id < _ranges[i].end) return true;
        return false;
    }

    // ------------------------------------------------------------------ money + creator admin
    function withdraw() external nonReentrant {
        uint256 bal = address(this).balance; uint256 fee = (bal * platformFeeBps) / 10_000;
        if (fee > 0) { (bool a, ) = feeWallet.call{ value: fee }(""); if (!a) revert PayFailed(); }
        if (bal > fee) { (bool b, ) = payout.call{ value: bal - fee }(""); if (!b) revert PayFailed(); }
        emit Withdrawn(bal - fee, fee);
    }
    function setPaused(bool v) external onlyOwner { paused = v; }
    function setPayout(address a) external onlyOwner { if (a == address(0)) revert BadParams(); payout = a; }
    function setRebalancer(address a) external onlyOwner { rebalancer = a; }
    function reveal(string calldata b) external onlyOwner { if (metadataFrozen) revert Frozen(); _base = b; revealed = true; }
    function freezeMetadata() external onlyOwner { if (!revealed) revert BadParams(); metadataFrozen = true; }
    function transferOwnership(address to) external onlyOwner { pendingOwner = to; }
    function acceptOwnership() external { if (msg.sender != pendingOwner) revert NotOwner(); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; pendingOwner = address(0); }

    // ------------------------------------------------------------------ views
    function eids() external view returns (uint32[] memory) { return _eids; }
    function phases() external view returns (MultiSeaDrop.Phase[] memory) { return _phases; }
    function ranges() external view returns (Range[] memory out) { out = new Range[](_ranges.length - _head); for (uint256 i = _head; i < _ranges.length; ++i) out[i - _head] = _ranges[i]; }
    /// @notice true if `id` is Active (held by a user) on this chain; false if locked in escrow / not yet arrived here.
    function isActiveHere(uint256 id) external view returns (bool) { address o = _ownerOf(id); return o != address(0) && o != address(escrow); }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return revealed ? string.concat(_base, id.toString(), ".json") : preRevealURI;
    }
    function supportsInterface(bytes4 id) public view override(ERC721Upgradeable, ERC2981) returns (bool) {
        return ERC721Upgradeable.supportsInterface(id) || ERC2981.supportsInterface(id);
    }
    function _hasEid(uint32 e) internal view returns (bool) { for (uint256 i; i < _eids.length; ++i) if (_eids[i] == e) return true; return false; }
}
