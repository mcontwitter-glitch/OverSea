// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC1155Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { MultiSeaPackCards } from "./MultiSeaPackCards.sol";

interface IPackEscrow {
    function localEid() external view returns (uint32);
    function quoteMint(bytes32 cid, uint16 tierId, uint32 qty) external view returns (uint256);
    function quoteReveal(bytes32 cid, uint32 cards) external view returns (uint256);
    function quoteMovePack(bytes32 cid, uint32 dstEid, uint16 tierId, uint32 amount) external view returns (uint256 platform, uint256 lz);
    function quoteMoveCard(bytes32 cid, uint32 dstEid, uint256 tokenId) external view returns (uint256 platform, uint256 lz);
    function sendMintRequest(bytes32 cid, uint256 rid, bytes32 to, uint16 tierId, uint32 qty, uint256 phaseId, address refund) external payable;
    function sendReveal(bytes32 cid, uint256 commitId, bytes32 to, bytes32 seed, uint16 tierId, uint32 qty, address refund) external payable;
    function sendMovePack(bytes32 cid, uint32 dstEid, uint16 tierId, uint32 amount, bytes32 to, address refund) external payable;
    function sendMoveCard(bytes32 cid, uint32 dstEid, uint256 tokenId, bytes32 to, address refund) external payable;
    function fanoutCards(bytes32 cid, uint256 startId, uint16[] calldata types, uint32 originEid, address refund) external payable;
}

/// @title MultiSeaPacks
/// @notice Sealed ERC-1155 pack tiers. `mint` sells packs through regular launchpad phases. `open` burns a pack and
///         commits to a future blockhash; `reveal` (a few blocks later) lazy-mints the ERC-721 cards. Per-rarity supply
///         caps are enforced here (and on the hub in a multichain drop). If the reveal blockhash expires after 256
///         blocks the owner may `recommit` to a new future block — not while the original hash is still readable.
contract MultiSeaPacks is ERC1155Upgradeable, ReentrancyGuard {
    uint16 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MAX_QTY = 20;
    uint32 public constant REVEAL_DELAY = 3;
    uint32 public constant HASH_WINDOW = 256;
    uint8 public constant MAX_RARITIES = 16;
    uint16 public constant MAX_CARD_TYPES = 256;
    uint8 public constant MAX_TIERS = 8;
    uint8 public constant ST_PENDING = 1;
    uint8 public constant ST_REVEALING = 2;
    uint8 public constant ST_REVEALED = 3;

    struct Phase {
        uint64 start;
        uint64 end;
        uint128 price;
        uint32 maxPerWallet;
        uint32 maxSupply;
        bytes32 merkleRoot;
    }

    struct Rarity {
        string name;
        uint32 weight;
        uint32 cap;
    }

    struct CardType {
        uint8 rarityId; // 1-indexed into rarities
        uint32 weight;  // 0 = equal (treated as 1)
    }

    struct Tier {
        string name;
        uint8 cardsPerPack;
        uint8 guaranteedRarity; // 0 = none (1-indexed)
        uint32 maxPacks;        // 0 = only limited by remaining card slots
        uint128 price;          // wei; 0 = fall back to the phase price
    }

    struct Commit {
        address owner;
        uint32 revealBlock;
        uint16 tierId;
        uint16 qty;
        uint8 status;
        bytes32 seed; // set on the first valid reveal attempt; reused if the LZ confirm must be retried
    }

    struct PackInit {
        string name;       // cards collection
        string symbol;
        string packName;
        string packSymbol;
        address owner;
        address payout;
        address feeWallet;
        uint16 platformFeeBps;
        address royaltyReceiver;
        uint96 royaltyBps;
        string cardBaseURI;
        string packBaseURI;
        Rarity[] rarities;
        CardType[] cards;
        Tier[] tiers;
        Phase[] phases;
        uint32[] eids;
        uint32 hubEid;
        uint128[] prices; // length = eids * phases (index = chainIdx * phases + phaseId). Empty = use Phase.price (single-chain).
    }

    string public name;
    string public symbol;
    string public packName;
    string public packSymbol;
    address public owner;
    address public pendingOwner;
    address public payout;
    address public feeWallet;
    uint16 public platformFeeBps;
    bool public paused;
    bool public metadataFrozen;
    string private _packBase;
    MultiSeaPackCards public cards;
    IPackEscrow public escrow;
    bytes32 public collectionId;
    uint32 public localEid;
    uint32 public hubEid;
    uint16 private _chainIdx;
    uint32 public nextCardId; // hub (or single-chain): next ERC-721 id (starts at 1)
    uint32 public reservedSlots;
    uint32 public mintedCards;
    uint32 public totalCap;
    uint256 public nextCommitId;
    uint256 public nextRid;
    uint256 public held;
    uint32[] private _eids;
    uint128[] private _prices;
    Phase[] private _phases;
    Rarity[] private _rarities;
    CardType[] private _cardTypes;
    Tier[] private _tiers;
    uint32[] public rarityMinted;
    uint32[] public rarityReserved; // unrevealed guaranteed slots
    uint32[] public packMinted;     // per tier
    mapping(uint256 => mapping(address => uint256)) public mintedInPhase;
    mapping(uint256 => uint256) public phaseMinted;
    mapping(uint256 => Commit) public commits;
    mapping(uint256 => MintReq) public requests;
    mapping(address => uint256) public refundOf;

    struct MintReq { address to; address payer; uint16 tierId; uint32 qty; uint32 phaseId; uint8 status; uint128 paid; }

    event PackMinted(address indexed to, uint256 indexed phaseId, uint16 indexed tierId, uint32 qty, uint256 paid);
    event Opened(uint256 indexed commitId, address indexed owner, uint16 tierId, uint16 qty, uint32 revealBlock);
    event Revealed(uint256 indexed commitId, address indexed owner, uint256 firstId, uint16 cards);
    event Recommitted(uint256 indexed commitId, uint32 revealBlock);
    event MintRequested(uint256 indexed rid, address indexed to, uint16 tierId, uint32 qty, uint256 paid);
    event MintConfirmed(uint256 indexed rid, uint16 tierId, uint32 qty);
    event MintRejected(uint256 indexed rid, uint8 reason, uint256 refunded);
    event Withdrawn(uint256 toCreator, uint256 toPlatform);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event PackMoved(address indexed from, uint32 dstEid, uint16 tierId, uint32 amount);
    event CardMoved(address indexed from, uint32 dstEid, uint256 tokenId);

    error NotOwner();
    error NotEscrow();
    error IsPaused();
    error PhaseNotActive();
    error NotAllowlisted();
    error WalletLimit();
    error PhaseSoldOut(uint256 left);
    error SoldOut();
    error WrongPayment(uint256 required);
    error BadParams();
    error NotPending();
    error RevealTooEarly();
    error HashExpired();
    error NotCommitOwner();
    error PayFailed();
    error Frozen();
    error NoGuarantee();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyEscrow() { if (msg.sender != address(escrow)) revert NotEscrow(); _; }

    constructor() { _disableInitializers(); }

    function initialize(PackInit calldata p, address cards_, address escrow_, bytes32 cid) external initializer {
        if (p.owner == address(0) || p.payout == address(0) || p.rarities.length == 0 || p.cards.length == 0 || p.tiers.length == 0 || p.phases.length == 0) revert BadParams();
        if (p.rarities.length > MAX_RARITIES || p.cards.length > MAX_CARD_TYPES || p.tiers.length > MAX_TIERS || p.phases.length > 8) revert BadParams();
        if (p.royaltyBps > MAX_ROYALTY_BPS) revert BadParams();
        if (p.eids.length == 0 || p.eids.length > 8) revert BadParams();
        __ERC1155_init("");
        name = p.name; symbol = p.symbol; packName = p.packName; packSymbol = p.packSymbol;
        owner = p.owner; payout = p.payout; feeWallet = p.feeWallet; platformFeeBps = p.platformFeeBps;
        _packBase = p.packBaseURI; cards = MultiSeaPackCards(cards_); collectionId = cid;
        nextCardId = 1; nextCommitId = 1; nextRid = 1;
        _initChain(p, escrow_);
        _initSet(p);
        _initSale(p);
        cards.bind(p.owner, p.royaltyReceiver == address(0) ? p.payout : p.royaltyReceiver, p.royaltyBps);
        emit OwnershipTransferred(address(0), p.owner);
    }

    function _initChain(PackInit calldata p, address escrow_) internal {
        uint256 nEid = p.eids.length;
        if (escrow_ != address(0)) {
            escrow = IPackEscrow(escrow_);
            localEid = escrow.localEid();
            hubEid = p.hubEid;
        } else {
            if (nEid != 1) revert BadParams();
            localEid = p.eids[0];
            hubEid = p.hubEid == 0 ? p.eids[0] : p.hubEid;
            if (hubEid != p.eids[0]) revert BadParams();
        }
        bool found; bool hubIn;
        for (uint256 i; i < nEid; ++i) {
            for (uint256 j; j < i; ++j) if (p.eids[j] == p.eids[i]) revert BadParams();
            if (p.eids[i] == localEid) { found = true; _chainIdx = uint16(i); }
            if (p.eids[i] == hubEid) hubIn = true;
            _eids.push(p.eids[i]);
        }
        if (!found || !hubIn) revert BadParams();
    }

    function _initSet(PackInit calldata p) internal {
        uint32 capSum;
        uint256 nR = p.rarities.length;
        for (uint256 i; i < nR; ++i) {
            if (p.rarities[i].cap > 0 && p.rarities[i].weight == 0) revert BadParams();
            _rarities.push(p.rarities[i]);
            rarityMinted.push(0);
            rarityReserved.push(0);
            capSum += p.rarities[i].cap;
        }
        if (capSum == 0) revert BadParams();
        totalCap = capSum;
        uint256[] memory perR = new uint256[](nR + 1);
        for (uint256 i; i < p.cards.length; ++i) {
            uint8 r = p.cards[i].rarityId;
            if (r == 0 || r > nR) revert BadParams();
            _cardTypes.push(p.cards[i]);
            unchecked { ++perR[r]; }
        }
        for (uint256 i; i < nR; ++i) if (_rarities[i].cap > 0 && perR[i + 1] == 0) revert BadParams();
        for (uint256 i; i < p.tiers.length; ++i) {
            uint8 cpp = p.tiers[i].cardsPerPack;
            uint8 g = p.tiers[i].guaranteedRarity;
            if (cpp == 0 || cpp > 20) revert BadParams();
            if (g > nR) revert BadParams();
            if (g != 0 && _rarities[g - 1].cap == 0) revert BadParams();
            _tiers.push(p.tiers[i]);
            packMinted.push(0);
        }
    }

    function _initSale(PackInit calldata p) internal {
        uint256 nP = p.prices.length;
        if (nP != 0 && nP != p.eids.length * p.phases.length && nP != p.eids.length * p.phases.length * p.tiers.length) revert BadParams();
        for (uint256 i; i < p.phases.length; ++i) {
            if (p.phases[i].end != 0 && p.phases[i].end <= p.phases[i].start) revert BadParams();
            _phases.push(p.phases[i]);
        }
        for (uint256 i; i < p.prices.length; ++i) _prices.push(p.prices[i]);
    }

    function isHub() public view returns (bool) { return localEid == hubEid; }
    function priceOf(uint256 phaseId) public view returns (uint256) { return priceOf(phaseId, 1); }
    function priceOf(uint256 phaseId, uint16 tierId) public view returns (uint256) {
        uint256 nP = _phases.length;
        uint256 nT = _tiers.length;
        if (nT > 0 && _prices.length == _eids.length * nP * nT) {
            return _prices[(uint256(_chainIdx) * nP + phaseId) * nT + (tierId - 1)];
        }
        if (_prices.length == _eids.length * nP) return _prices[uint256(_chainIdx) * nP + phaseId];
        uint128 tp = _tiers[tierId - 1].price;
        if (tp != 0) return tp;
        return _phases[phaseId].price;
    }
    function rarityCount() external view returns (uint256) { return _rarities.length; }
    function cardTypeCount() external view returns (uint256) { return _cardTypes.length; }
    function tierCount() external view returns (uint256) { return _tiers.length; }
    function phaseCount() external view returns (uint256) { return _phases.length; }
    function rarities() external view returns (Rarity[] memory) { return _rarities; }
    function cardTypes() external view returns (CardType[] memory) { return _cardTypes; }
    function tiers() external view returns (Tier[] memory) { return _tiers; }
    function phases() external view returns (Phase[] memory) { return _phases; }
    function eids() external view returns (uint32[] memory) { return _eids; }
    function remaining(uint8 rarityId) public view returns (uint32) {
        if (rarityId == 0 || rarityId > _rarities.length) return 0;
        uint32 cap = _rarities[rarityId - 1].cap;
        uint32 used = rarityMinted[rarityId - 1] + rarityReserved[rarityId - 1];
        return cap > used ? cap - used : 0;
    }
    function remainingSlots() public view returns (uint32) {
        uint32 used = mintedCards + reservedSlots;
        return totalCap > used ? totalCap - used : 0;
    }

    function quoteMint(uint256 phaseId, uint16 tierId, uint32 qty) external view returns (uint256 price, uint256 lz) {
        price = priceOf(phaseId, tierId) * qty;
        if (!isHub() && address(escrow) != address(0)) lz = escrow.quoteMint(collectionId, tierId, qty);
    }

    function mint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof) external payable nonReentrant {
        _checkMint(to, phaseId, tierId, qty, proof);
        uint256 cost = priceOf(phaseId, tierId) * qty;
        if (isHub() || address(escrow) == address(0)) _mintLocal(to, phaseId, tierId, qty, cost);
        else _mintRemote(to, phaseId, tierId, qty, cost);
    }

    function _checkMint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof) internal view {
        if (paused) revert IsPaused();
        if (to == address(0) || qty == 0 || qty > MAX_QTY || phaseId >= _phases.length || tierId == 0 || tierId > _tiers.length) revert BadParams();
        Phase memory ph = _phases[phaseId];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) revert PhaseNotActive();
        if (ph.merkleRoot != bytes32(0)) {
            if (!MerkleProof.verifyCalldata(proof, ph.merkleRoot, keccak256(bytes.concat(keccak256(abi.encode(to)))))) revert NotAllowlisted();
        }
        if (ph.maxPerWallet != 0 && mintedInPhase[phaseId][to] + qty > ph.maxPerWallet) revert WalletLimit();
        if (ph.maxSupply != 0 && phaseMinted[phaseId] + qty > ph.maxSupply) revert PhaseSoldOut(uint32(ph.maxSupply - phaseMinted[phaseId]));
        if (_tiers[tierId - 1].maxPacks != 0 && packMinted[tierId - 1] + qty > _tiers[tierId - 1].maxPacks) revert SoldOut();
    }

    function _mintLocal(address to, uint256 phaseId, uint16 tierId, uint32 qty, uint256 cost) internal {
        _reserve(tierId, qty);
        if (msg.value != cost) revert WrongPayment(cost);
        mintedInPhase[phaseId][to] += qty;
        phaseMinted[phaseId] += qty;
        packMinted[tierId - 1] += qty;
        _mint(to, tierId, qty, "");
        emit PackMinted(to, phaseId, tierId, qty, cost);
    }

    function _mintRemote(address to, uint256 phaseId, uint16 tierId, uint32 qty, uint256 cost) internal {
        if (msg.value < cost) revert WrongPayment(cost);
        uint256 rid = nextRid++;
        requests[rid] = MintReq(to, msg.sender, tierId, qty, uint32(phaseId), 1, uint128(cost));
        held += cost;
        emit MintRequested(rid, to, tierId, qty, cost);
        bytes32 dest = bytes32(uint256(uint160(to)));
        escrow.sendMintRequest{ value: msg.value - cost }(collectionId, rid, dest, tierId, qty, phaseId, msg.sender);
    }

    function _reserve(uint16 tierId, uint32 qty) internal {
        Tier storage t = _tiers[tierId - 1];
        uint32 slots = uint32(t.cardsPerPack) * qty;
        if (remainingSlots() < slots) revert SoldOut();
        if (t.guaranteedRarity != 0 && remaining(t.guaranteedRarity) < qty) revert NoGuarantee();
        reservedSlots += slots;
        if (t.guaranteedRarity != 0) rarityReserved[t.guaranteedRarity - 1] += qty;
    }

    // Escrow (hub): reserve slots for a spoke mint. Returns 0 on success, else a reason code.
    function hubReserve(uint16 tierId, uint32 qty, uint256 phaseId, bytes32 to) external onlyEscrow returns (uint8 reason) {
        if (paused) return 1;
        if (tierId == 0 || tierId > _tiers.length) return 2;
        address who = address(uint160(uint256(to)));
        Phase memory ph = _phases[phaseId];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) return 3;
        if (ph.maxPerWallet != 0 && mintedInPhase[phaseId][who] + qty > ph.maxPerWallet) return 4;
        if (ph.maxSupply != 0 && phaseMinted[phaseId] + qty > ph.maxSupply) return 5;
        Tier storage t = _tiers[tierId - 1];
        if (t.maxPacks != 0 && packMinted[tierId - 1] + qty > t.maxPacks) return 6;
        if (remainingSlots() < uint32(t.cardsPerPack) * qty) return 7;
        if (t.guaranteedRarity != 0 && remaining(t.guaranteedRarity) < qty) return 8;
        _reserve(tierId, qty);
        mintedInPhase[phaseId][who] += qty;
        phaseMinted[phaseId] += qty;
        packMinted[tierId - 1] += qty;
        return 0;
    }

    function confirmMint(uint256 rid) external onlyEscrow {
        MintReq storage r = requests[rid];
        if (r.status != 1) revert NotPending();
        r.status = 2;
        held -= r.paid;
        packMinted[r.tierId - 1] += r.qty;
        _mint(r.to, r.tierId, r.qty, "");
        emit MintConfirmed(rid, r.tierId, r.qty);
        emit PackMinted(r.to, r.phaseId, r.tierId, r.qty, r.paid);
    }

    function rejectMint(uint256 rid, uint8 reason) external onlyEscrow {
        MintReq storage r = requests[rid];
        if (r.status != 1) revert NotPending();
        r.status = 3;
        held -= r.paid;
        refundOf[r.payer] += r.paid;
        emit MintRejected(rid, reason, r.paid);
    }

    function claimRefund() external nonReentrant {
        uint256 a = refundOf[msg.sender];
        if (a == 0) revert BadParams();
        refundOf[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{ value: a }("");
        if (!ok) revert PayFailed();
    }

    // ---------------- open / reveal ----------------

    function open(uint16 tierId, uint16 qty) external nonReentrant {
        if (paused) revert IsPaused();
        if (qty == 0 || qty > MAX_QTY || tierId == 0 || tierId > _tiers.length) revert BadParams();
        if (balanceOf(msg.sender, tierId) < qty) revert BadParams();
        _burn(msg.sender, tierId, qty);
        uint256 id = nextCommitId++;
        uint32 rb = uint32(block.number + REVEAL_DELAY);
        commits[id] = Commit(msg.sender, rb, tierId, qty, ST_PENDING, bytes32(0));
        emit Opened(id, msg.sender, tierId, qty, rb);
    }

    function reveal(uint256 commitId) external payable nonReentrant {
        Commit storage c = commits[commitId];
        if (c.owner == address(0) || (c.status != ST_PENDING && c.status != ST_REVEALING)) revert NotPending();
        if (msg.sender != c.owner) revert NotCommitOwner();
        if (c.seed == 0) {
            if (block.number <= c.revealBlock) revert RevealTooEarly();
            bytes32 bh = blockhash(c.revealBlock);
            if (bh == 0) revert HashExpired();
            c.seed = keccak256(abi.encodePacked(bh, commitId, collectionId, c.owner, c.revealBlock, c.tierId, c.qty));
        }
        uint32 nCards = uint32(_tiers[c.tierId - 1].cardsPerPack) * c.qty;
        if (isHub() || address(escrow) == address(0)) {
            (uint256 start, uint16[] memory types) = _assign(c.seed, c.tierId, c.qty);
            c.status = ST_REVEALED;
            cards.mintActive(c.owner, start, types);
            emit Revealed(commitId, c.owner, start, uint16(types.length));
            if (address(escrow) != address(0) && _eids.length > 1) {
                escrow.fanoutCards{ value: msg.value }(collectionId, start, types, localEid, msg.sender);
            } else if (msg.value != 0) revert WrongPayment(0);
        } else {
            uint256 lz = escrow.quoteReveal(collectionId, nCards);
            if (msg.value < lz) revert WrongPayment(lz);
            c.status = ST_REVEALING;
            escrow.sendReveal{ value: msg.value }(collectionId, commitId, bytes32(uint256(uint160(c.owner))), c.seed, c.tierId, c.qty, msg.sender);
        }
    }

    function recommit(uint256 commitId) external {
        Commit storage c = commits[commitId];
        if (c.owner != msg.sender) revert NotCommitOwner();
        if (c.status != ST_PENDING || c.seed != bytes32(0)) revert NotPending();
        if (block.number <= c.revealBlock) revert RevealTooEarly();
        if (blockhash(c.revealBlock) != bytes32(0)) revert NotPending(); // hash still available: must reveal, not grind
        c.revealBlock = uint32(block.number + REVEAL_DELAY);
        emit Recommitted(commitId, c.revealBlock);
    }

    /// @dev Hub: assign card IDs and types for a spoke reveal. Debits rarity caps.
    function hubAssign(bytes32 seed, uint16 tierId, uint32 qty) external onlyEscrow returns (uint256 start, uint16[] memory types) {
        return _assign(seed, tierId, qty);
    }

    function confirmReveal(uint256 commitId, uint256 start, uint16[] calldata types) external onlyEscrow {
        Commit storage c = commits[commitId];
        if (c.status != ST_REVEALING) revert NotPending();
        c.status = ST_REVEALED;
        cards.mintActive(c.owner, start, types);
        emit Revealed(commitId, c.owner, start, uint16(types.length));
    }

    function copyCards(uint256 start, uint16[] calldata types) external onlyEscrow {
        cards.mintEscrow(address(escrow), start, types);
    }

    function _assign(bytes32 seed, uint16 tierId, uint32 qty) internal returns (uint256 start, uint16[] memory types) {
        Tier storage t = _tiers[tierId - 1];
        uint256 n = uint256(t.cardsPerPack) * qty;
        types = new uint16[](n);
        // release the reservation taken at mint, then assign against live remaining
        uint32 slots = uint32(n);
        reservedSlots -= slots;
        if (t.guaranteedRarity != 0) rarityReserved[t.guaranteedRarity - 1] -= qty;
        start = nextCardId;
        uint256 drawn;
        for (uint32 p; p < qty; ++p) {
            uint8 g = t.guaranteedRarity;
            uint256 gSlot = g == 0 ? type(uint256).max : uint256(_fold(seed, p, 0xff)) % t.cardsPerPack;
            for (uint8 s; s < t.cardsPerPack; ++s) {
                uint8 r = (g != 0 && s == gSlot) ? g : _pickRarity(seed, (p << 8) | s, g != 0 && s == gSlot ? g : 0);
                types[drawn] = _pickCard(seed, (p << 16) | s, r);
                rarityMinted[r - 1] += 1;
                mintedCards += 1;
                unchecked { ++drawn; }
            }
        }
        nextCardId = uint32(start + n);
    }

    function _pickRarity(bytes32 seed, uint256 nonce, uint8 force) internal view returns (uint8) {
        if (force != 0) {
            if (rarityMinted[force - 1] >= _rarities[force - 1].cap) revert NoGuarantee();
            return force;
        }
        uint256 wsum;
        uint256 n = _rarities.length;
        uint32[] memory left = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            uint32 cap = _rarities[i].cap;
            uint32 used = rarityMinted[i];
            uint32 rem = cap > used ? cap - used : 0;
            left[i] = rem;
            if (rem > 0) wsum += uint256(_rarities[i].weight);
        }
        if (wsum == 0) revert SoldOut();
        uint256 roll = uint256(_fold(seed, nonce, 1)) % wsum;
        uint256 acc;
        for (uint256 i; i < n; ++i) {
            if (left[i] == 0) continue;
            acc += _rarities[i].weight;
            if (roll < acc) return uint8(i + 1);
        }
        return uint8(n);
    }

    function _pickCard(bytes32 seed, uint256 nonce, uint8 rarityId) internal view returns (uint16) {
        uint256 wsum;
        uint256 n = _cardTypes.length;
        for (uint256 i; i < n; ++i) {
            if (_cardTypes[i].rarityId != rarityId) continue;
            uint32 w = _cardTypes[i].weight;
            wsum += w == 0 ? 1 : w;
        }
        if (wsum == 0) revert BadParams();
        uint256 roll = uint256(_fold(seed, nonce, 2)) % wsum;
        uint256 acc;
        for (uint256 i; i < n; ++i) {
            if (_cardTypes[i].rarityId != rarityId) continue;
            uint32 w = _cardTypes[i].weight;
            acc += w == 0 ? 1 : w;
            if (roll < acc) return uint16(i + 1);
        }
        return uint16(n);
    }

    function _fold(bytes32 seed, uint256 nonce, uint256 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed, nonce, salt));
    }

    // ---------------- bridge ----------------

    function movePack(uint32 dstEid, uint16 tierId, uint32 amount, address to) external payable nonReentrant {
        if (address(escrow) == address(0) || to == address(0) || amount == 0 || tierId == 0 || tierId > _tiers.length) revert BadParams();
        if (balanceOf(msg.sender, tierId) < amount) revert BadParams();
        _burn(msg.sender, tierId, amount);
        (uint256 pf, uint256 lz) = escrow.quoteMovePack(collectionId, dstEid, tierId, amount);
        if (msg.value < pf + lz) revert WrongPayment(pf + lz);
        emit PackMoved(msg.sender, dstEid, tierId, amount);
        escrow.sendMovePack{ value: msg.value }(collectionId, dstEid, tierId, amount, bytes32(uint256(uint160(to))), msg.sender);
    }

    function creditPacks(address to, uint16 tierId, uint32 amount) external onlyEscrow {
        _mint(to, tierId, amount, "");
    }

    function moveCard(uint32 dstEid, uint256 tokenId, address to) external payable nonReentrant {
        if (address(escrow) == address(0) || to == address(0)) revert BadParams();
        if (cards.ownerOf(tokenId) != msg.sender) revert BadParams();
        cards.lock(msg.sender, tokenId, address(escrow));
        (uint256 pf, uint256 lz) = escrow.quoteMoveCard(collectionId, dstEid, tokenId);
        if (msg.value < pf + lz) revert WrongPayment(pf + lz);
        emit CardMoved(msg.sender, dstEid, tokenId);
        escrow.sendMoveCard{ value: msg.value }(collectionId, dstEid, tokenId, bytes32(uint256(uint160(to))), msg.sender);
    }

    function releaseCardKnown(bytes32 to, uint256 tokenId) external onlyEscrow {
        if (!cards.exists(tokenId)) revert BadParams(); // COPY has not landed yet; executor should retry
        cards.release(address(uint160(uint256(to))), tokenId, address(escrow));
    }

    // ---------------- money / admin ----------------

    function withdraw() external nonReentrant {
        uint256 bal = address(this).balance - held;
        uint256 fee = (bal * platformFeeBps) / 10_000;
        uint256 rest = bal - fee;
        if (fee > 0) { (bool ok1, ) = feeWallet.call{ value: fee }(""); if (!ok1) revert PayFailed(); }
        if (rest > 0) { (bool ok2, ) = payout.call{ value: rest }(""); if (!ok2) revert PayFailed(); }
        emit Withdrawn(rest, fee);
    }

    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setPayout(address a) external onlyOwner { if (a == address(0)) revert BadParams(); payout = a; }
    function setPhases(Phase[] calldata ph) external onlyOwner {
        delete _phases;
        for (uint256 i; i < ph.length; ++i) {
            if (ph[i].end != 0 && ph[i].end <= ph[i].start) revert BadParams();
            _phases.push(ph[i]);
        }
    }
    function setPackURI(string calldata u) external onlyOwner { if (metadataFrozen) revert Frozen(); _packBase = u; }
    function setCardURI(string calldata u) external onlyOwner { cards.setBaseURI(u); }
    function freezeMetadata() external onlyOwner { metadataFrozen = true; cards.freezeMetadata(); }

    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function uri(uint256 id) public view override returns (string memory) {
        return string(abi.encodePacked(_packBase, _toString(id), ".json"));
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return super.supportsInterface(id);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { unchecked { ++len; j /= 10; } }
        bytes memory b = new bytes(len);
        while (v != 0) { unchecked { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; } }
        return string(b);
    }
}
