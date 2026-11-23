// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721AUpgradeable } from "erc721a-upgradeable/ERC721AUpgradeable.sol";
import { ERC721A__InitializableStorage } from "erc721a-upgradeable/ERC721A__InitializableStorage.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { OnchainArt } from "./OnchainArt.sol";

/// @title MultiSeaOnchainDrop
/// @notice ERC-721A launchpad drop whose art and metadata live in SSTORE2 data contracts (optional alternative
///         to IPFS). Minting is blocked until the creator writes every token and calls finalize(). A new factory
///         deploys these clones; existing IPFS factories and MultiSeaDrop are unchanged.
///         - Phases (allowlist via Merkle root, or public) with their own price, window and per-wallet cap.
///         - Mint proceeds stay in the contract; withdraw() pays the platform fee (fixed at deploy, capped by the
///           factory) to the MultiSea fee wallet and the rest to the creator payout address. Anyone may call it.
///         - ERC-2981 royalties, reveal (pre-reveal URI -> base URI), permanent metadata freeze, pause.
///         - The creator owns the drop (2-step ownership transfer). The platform cannot touch funds or metadata;
///           it only receives its fee share.
contract MultiSeaOnchainDrop is ERC721AUpgradeable, ERC2981, ReentrancyGuard {
    struct Phase {
        uint64 start;          // unix seconds
        uint64 end;            // unix seconds (0 = open-ended)
        uint128 price;         // wei per token, native currency of the chain
        uint32 maxPerWallet;   // 0 = unlimited (still bounded by maxSupply)
        uint32 maxSupply;      // tokens mintable in this phase, all wallets together; 0 = no phase cap (still bounded by maxSupply)
        bytes32 merkleRoot;    // 0x0 = public phase
    }

    struct InitParams {
        string name;
        string symbol;
        address owner;           // creator
        address payout;          // creator payout address (can be a splitter)
        address feeWallet;       // MultiSea fee wallet (set by factory)
        uint16 platformFeeBps;   // set by factory, immutable for this drop
        uint32 maxSupply;
        uint32 creatorReserve;   // tokens the owner may airdrop for free (counts toward maxSupply)
        address royaltyReceiver;
        uint96 royaltyBps;
        string baseURI;          // final metadata (ipfs://CID/ or ar://TX/); empty when delayed reveal
        string preRevealURI;     // unused: mint is blocked until art is finalized
        Phase[] phases;
        bool storeLocal;         // true: this chain stores the bytes
        string rendererBase;     // used when storeLocal is false (spoke URI)
    }

    uint16 public constant MAX_ROYALTY_BPS = 1000; // 10%
    uint256 public constant MAX_QTY = 50; // per mint tx (same cap as MultiSeaOmniDrop)

    address public owner;
    address public pendingOwner;
    address public payout;
    address public feeWallet;
    uint16 public platformFeeBps;
    uint32 public maxSupply;
    uint32 public creatorReserve;
    uint32 public reserveMinted;
    bool public paused;
    bool public revealed;
    bool public metadataFrozen;
    string private _base;
    string public preRevealURI;
    Phase[] private _phases;
    mapping(uint256 => mapping(address => uint256)) public mintedInPhase; // phaseId => wallet => count
    mapping(uint256 => uint256) public phaseMinted; // phaseId => tokens minted in that phase (all wallets)
    OnchainArt.Store private _art;

    event Minted(address indexed to, uint256 indexed phaseId, uint256 qty, uint256 paid);
    event Withdrawn(uint256 toCreator, uint256 toPlatform);
    event Revealed(string baseURI);
    event MetadataFrozen();
    event PausedSet(bool paused);
    event PhasesSet(uint256 count);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId); // EIP-4906
    event ArtWritten(uint256 indexed id, uint256 bytesLength);
    event ArtFinalized(uint32 written);

    error NotOwner();
    error IsPaused();
    error PhaseNotActive();
    error NotAllowlisted();
    error WalletLimit();
    error SoldOut();
    error PhaseSoldOut(uint256 left);
    error WrongPayment(uint256 required);
    error Frozen();
    error BadParams();
    error PayFailed();
    error ArtNotFinalized();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    /// @dev Lock the implementation so nobody can initialize it directly.
    constructor() { ERC721A__InitializableStorage.layout()._initialized = true; }

    function initialize(InitParams calldata p) external initializerERC721A {
        if (p.owner == address(0) || p.payout == address(0) || p.maxSupply == 0 || p.creatorReserve > p.maxSupply) revert BadParams();
        if (p.royaltyBps > MAX_ROYALTY_BPS) revert BadParams();
        __ERC721A_init(p.name, p.symbol);
        owner = p.owner; payout = p.payout; feeWallet = p.feeWallet; platformFeeBps = p.platformFeeBps;
        maxSupply = p.maxSupply; creatorReserve = p.creatorReserve;
        _base = p.baseURI; preRevealURI = p.preRevealURI; revealed = bytes(p.preRevealURI).length == 0;
        if (p.royaltyBps > 0) _setDefaultRoyalty(p.royaltyReceiver == address(0) ? p.payout : p.royaltyReceiver, p.royaltyBps);
        _writePhases(p.phases);
        OnchainArt.init(_art, p.maxSupply, p.storeLocal, p.rendererBase);
        emit OwnershipTransferred(address(0), p.owner);
    }

    // ---------------- minting ----------------

    /// @notice Mint `qty` tokens to `to` in phase `phaseId`. `to` (not msg.sender) is checked against the allowlist and
    ///         the per-wallet cap so a Relay solver / smart wallet can mint on behalf of the buyer.
    function mint(address to, uint256 phaseId, uint256 qty, bytes32[] calldata proof) external payable nonReentrant {
        OnchainArt.requireFinalized(_art);
        if (paused) revert IsPaused();
        if (qty == 0 || qty > MAX_QTY || phaseId >= _phases.length) revert BadParams();
        Phase memory ph = _phases[phaseId];
        if (block.timestamp < ph.start || (ph.end != 0 && block.timestamp >= ph.end)) revert PhaseNotActive();
        if (ph.merkleRoot != bytes32(0)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(to))));
            if (!MerkleProof.verifyCalldata(proof, ph.merkleRoot, leaf)) revert NotAllowlisted();
        }
        uint256 already = mintedInPhase[phaseId][to];
        if (ph.maxPerWallet != 0 && already + qty > ph.maxPerWallet) revert WalletLimit();
        uint256 inPhase = phaseMinted[phaseId];
        if (ph.maxSupply != 0 && inPhase + qty > ph.maxSupply) revert PhaseSoldOut(ph.maxSupply - inPhase);
        // public supply excludes the part of the creator reserve not yet minted
        if (_totalMinted() + qty + (creatorReserve - reserveMinted) > maxSupply) revert SoldOut();
        uint256 cost = uint256(ph.price) * qty;
        if (msg.value != cost) revert WrongPayment(cost);
        mintedInPhase[phaseId][to] = already + qty; // effects before interaction
        phaseMinted[phaseId] = inPhase + qty;
        _mint(to, qty); // _mint (not _safeMint): no receiver callback, so no reentrancy surface during mint
        emit Minted(to, phaseId, qty, cost);
    }

    /// @notice Free creator reserve airdrop (team / giveaways). Bounded by creatorReserve.
    function mintReserve(address to, uint256 qty) external onlyOwner {
        OnchainArt.requireFinalized(_art);
        if (reserveMinted + qty > creatorReserve) revert SoldOut();
        reserveMinted += uint32(qty);
        _mint(to, qty);
    }

    // ---------------- money ----------------

    /// @notice Split the whole balance: platformFeeBps to the MultiSea fee wallet, the rest to the creator payout.
    function withdraw() external nonReentrant {
        uint256 bal = address(this).balance;
        uint256 fee = (bal * platformFeeBps) / 10_000;
        uint256 rest = bal - fee;
        if (fee > 0) { (bool ok1, ) = feeWallet.call{ value: fee }(""); if (!ok1) revert PayFailed(); }
        if (rest > 0) { (bool ok2, ) = payout.call{ value: rest }(""); if (!ok2) revert PayFailed(); }
        emit Withdrawn(rest, fee);
    }

    // ---------------- creator admin ----------------

    function setPhases(Phase[] calldata ph) external onlyOwner { delete _phases; _writePhases(ph); }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setPayout(address a) external onlyOwner { if (a == address(0)) revert BadParams(); payout = a; }
    function setRoyalty(address r, uint96 bps) external onlyOwner { if (bps > MAX_ROYALTY_BPS) revert BadParams(); _setDefaultRoyalty(r, bps); }


    function _writeOne(uint256 id, uint8 mime_, bytes calldata image, string calldata name_, string calldata description, string calldata attributes) private {
        OnchainArt.write(_art, id, mime_, image, name_, description, attributes);
    }

    function writeArt(uint256 id, uint8 mime, bytes calldata image, string calldata name, string calldata description, string calldata attributes) external onlyOwner {
        OnchainArt.write(_art, id, mime, image, name, description, attributes);
        emit ArtWritten(id, image.length);
    }

    function writeArtBatch(
        uint256[] calldata ids,
        uint8[] calldata mime,
        bytes[] calldata image,
        string[] calldata name,
        string[] calldata description,
        string[] calldata attributes
    ) external onlyOwner {
        uint256 n = ids.length;
        if (n == 0 || n != mime.length || n != image.length || n != name.length || n != description.length || n != attributes.length) revert BadParams();
        for (uint256 i; i < n; ++i) {
            _writeOne(ids[i], mime[i], image[i], name[i], description[i], attributes[i]);
            emit ArtWritten(ids[i], image[i].length);
        }
    }

    /// @notice One-way. Local storage: every id 1..maxSupply must be written. Then minting opens and metadata is frozen.
    function finalizeArt() external onlyOwner {
        OnchainArt.finalize(_art);
        revealed = true;
        metadataFrozen = true;
        emit ArtFinalized(_art.written);
        emit MetadataFrozen();
    }

    function reveal(string calldata) external onlyOwner { revert BadParams(); }
    function freezeMetadata() external onlyOwner { if (!_art.finalized) revert ArtNotFinalized(); metadataFrozen = true; emit MetadataFrozen(); }

    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external { if (msg.sender != pendingOwner) revert NotOwner(); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; pendingOwner = address(0); }

    // ---------------- views ----------------

    function phases() external view returns (Phase[] memory) { return _phases; }
    function phaseCount() external view returns (uint256) { return _phases.length; }
    function totalMinted() external view returns (uint256) { return _totalMinted(); }

    function tokenURI(uint256 id) public view override returns (string memory) {
        if (!_exists(id)) revert URIQueryForNonexistentToken();
        return OnchainArt.tokenURI(_art, id);
    }

    function artFinalized() external view returns (bool) { return _art.finalized; }
    function artWritten() external view returns (uint32) { return _art.written; }
    function artStoreLocal() external view returns (bool) { return _art.storeLocal; }
    function artWrittenOf(uint256 id) external view returns (bool) { return OnchainArt.writtenOf(_art, id); }
    function previewURI(uint256 id) external view returns (string memory) { return OnchainArt.tokenURI(_art, id); }
    function writtenFlags(uint256 start, uint256 n) external view returns (bool[] memory out) {
        out = new bool[](n);
        for (uint256 i; i < n; ++i) out[i] = OnchainArt.writtenOf(_art, start + i);
    }

    function supportsInterface(bytes4 id) public view override(ERC721AUpgradeable, ERC2981) returns (bool) {
        return ERC721AUpgradeable.supportsInterface(id) || ERC2981.supportsInterface(id) || id == bytes4(0x49064906);
    }

    function _startTokenId() internal pure override returns (uint256) { return 1; }

    function _writePhases(Phase[] calldata ph) internal {
        if (ph.length == 0 || ph.length > 8) revert BadParams();
        for (uint256 i; i < ph.length; ++i) {
            if (ph[i].end != 0 && ph[i].end <= ph[i].start) revert BadParams();
            if (ph[i].maxSupply > maxSupply) revert BadParams();
            _phases.push(ph[i]);
        }
        emit PhasesSet(ph.length);
    }
}
