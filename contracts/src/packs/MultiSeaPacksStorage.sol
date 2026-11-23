// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC1155Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MultiSeaPackCards } from "./MultiSeaPackCards.sol";

interface IPackEscrow {
    function localEid() external view returns (uint32);
    function quoteMint(bytes32 cid, uint16 tierId, uint32 qty, uint128 hubValue) external view returns (uint256);
    function quoteReveal(bytes32 cid, uint32 cards, uint128 hubValue) external view returns (uint256);
    function quoteFanout(bytes32 cid, uint32 originEid, uint32 cards) external view returns (uint256);
    function quoteMovePack(bytes32 cid, uint32 dstEid, uint16 tierId, uint32 amount) external view returns (uint256 platform, uint256 lz);
    function quoteMoveCard(bytes32 cid, uint32 dstEid, uint256 tokenId) external view returns (uint256 platform, uint256 lz);
    function sendMintRequest(bytes32 cid, uint256 rid, bytes32 to, uint16 tierId, uint32 qty, uint256 phaseId, address refund, uint128 hubValue) external payable;
    function sendReveal(bytes32 cid, uint256 commitId, bytes32 to, bytes32 seed, uint16 tierId, uint32 qty, uint32 cards, address refund, uint128 hubValue) external payable;
    function sendMovePack(bytes32 cid, uint32 dstEid, uint16 tierId, uint32 amount, bytes32 to, address refund) external payable;
    function sendMoveCard(bytes32 cid, uint32 dstEid, uint256 tokenId, bytes32 to, address refund) external payable;
    function fanoutCards(bytes32 cid, uint256 startId, uint16[] calldata types, uint32 originEid, address refund) external payable;
}

/// @title MultiSeaPacksStorage
/// @notice Shared storage layout and types for MultiSeaPacks and its ops module (delegatecall).
///         Storage order is the source of truth for both; the ops module must not declare extra state.
contract MultiSeaPacksStorage is ERC1155Upgradeable, ReentrancyGuard {
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
    string internal _packBase;
    MultiSeaPackCards public cards;
    IPackEscrow public escrow;
    bytes32 public collectionId;
    uint32 public localEid;
    uint32 public hubEid;
    uint16 internal _chainIdx;
    uint32 public nextCardId; // hub (or single-chain): next ERC-721 id (starts at 1)
    uint32 public reservedSlots;
    uint32 public mintedCards;
    uint32 public totalCap;
    uint256 public nextCommitId;
    uint256 public nextRid;
    uint256 public held;
    uint32[] internal _eids;
    uint128[] internal _prices;
    Phase[] internal _phases;
    Rarity[] internal _rarities;
    CardType[] internal _cardTypes;
    Tier[] internal _tiers;
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
    error InsufficientFee(uint256 required, uint256 sent);
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
    function cardsInPack(uint16 tierId, uint32 qty) public view returns (uint32) {
        if (tierId == 0 || tierId > _tiers.length) return 0;
        return uint32(_tiers[tierId - 1].cardsPerPack) * qty;
    }
}
