// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MultiSeaPacksStorage, IPackEscrow } from "./MultiSeaPacksStorage.sol";
import { MultiSeaPacksOps } from "./MultiSeaPacksOps.sol";
import { MultiSeaPackCards } from "./MultiSeaPackCards.sol";

/// @title MultiSeaPacks
/// @notice Sealed ERC-1155 pack tiers. `mint` sells packs through regular launchpad phases. `open` burns a pack and
///         commits to a future blockhash; `reveal` (a few blocks later) lazy-mints the ERC-721 cards. Per-rarity supply
///         caps are enforced here (and on the hub in a multichain drop). If the reveal blockhash expires after 256
///         blocks the owner may `recommit` to a new future block — not while the original hash is still readable.
/// @dev    Heavy mint/open/reveal/move logic lives in MultiSeaPacksOps and is reached by delegatecall so this
///         implementation stays under the EIP-170 runtime size limit. Ops is an immutable set in the constructor
///         (baked into the implementation, inherited by EIP-1167 clones).
contract MultiSeaPacks is MultiSeaPacksStorage {
    address private immutable ops;

    constructor(address ops_) {
        if (ops_ == address(0)) revert BadParams();
        ops = ops_;
        _disableInitializers();
    }

    function _delegate(bytes memory data) private returns (bytes memory ret) {
        address ops_ = ops;
        assembly {
            let ok := delegatecall(gas(), ops_, add(data, 0x20), mload(data), 0, 0)
            let size := returndatasize()
            ret := mload(0x40)
            mstore(0x40, add(ret, add(size, 0x20)))
            mstore(ret, size)
            returndatacopy(add(ret, 0x20), 0, size)
            if iszero(ok) { revert(add(ret, 0x20), size) }
        }
    }

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

function rarityCount() external view returns (uint256) { return _rarities.length; }
function cardTypeCount() external view returns (uint256) { return _cardTypes.length; }
function tierCount() external view returns (uint256) { return _tiers.length; }
function phaseCount() external view returns (uint256) { return _phases.length; }
function rarities() external view returns (Rarity[] memory) { return _rarities; }
function cardTypes() external view returns (CardType[] memory) { return _cardTypes; }
function tiers() external view returns (Tier[] memory) { return _tiers; }
function phases() external view returns (Phase[] memory) { return _phases; }
function eids() external view returns (uint32[] memory) { return _eids; }
function quoteMint(uint256 phaseId, uint16 tierId, uint32 qty) external view returns (uint256 price, uint256 lz) {
        return quoteMint(phaseId, tierId, qty, 0);
    }
/// @notice Total the buyer sends: pack price + LayerZero. `hubValue` is ignored on the hub / single-chain;
    ///         on a spoke it is the hub-native amount (from escrow.quoteMintReturn, plus a buffer) dropped on the hub
    ///         so the hub can pay MINT_OK / MINT_FAIL without a pre-funded escrow.
    function quoteMint(uint256 phaseId, uint16 tierId, uint32 qty, uint128 hubValue) public view returns (uint256 price, uint256 lz) {
        price = priceOf(phaseId, tierId) * qty;
        if (!isHub() && address(escrow) != address(0)) lz = escrow.quoteMint(collectionId, tierId, qty, hubValue);
    }
function quoteReveal(uint256 commitId) external view returns (uint256 lz) {
        return quoteReveal(commitId, 0);
    }
/// @notice LayerZero the revealer sends. On the hub this is the CARD_COPY fan-out; on a spoke it is REVEAL_REQ
    ///         carrying `hubValue` (from escrow.quoteRevealReturn, plus a buffer) so the hub can pay REVEAL_OK + copies.
    function quoteReveal(uint256 commitId, uint128 hubValue) public view returns (uint256 lz) {
        Commit storage c = commits[commitId];
        if (c.owner == address(0) || address(escrow) == address(0)) return 0;
        uint32 nCards = cardsInPack(c.tierId, c.qty);
        if (isHub()) {
            if (_eids.length > 1) lz = escrow.quoteFanout(collectionId, localEid, nCards);
        } else {
            lz = escrow.quoteReveal(collectionId, nCards, hubValue);
        }
    }

    function withdraw() external nonReentrant {
        _delegate(msg.data);
    }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setPayout(address a) external onlyOwner { if (a == address(0)) revert BadParams(); payout = a; }
    function setPhases(Phase[] calldata ph) external onlyOwner { _delegate(msg.data); }
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
function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { unchecked { ++len; j /= 10; } }
        bytes memory b = new bytes(len);
        while (v != 0) { unchecked { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; } }
        return string(b);
    }

    // ---- ops module (delegatecall) ----

    function mint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof) external payable {
        mint(to, phaseId, tierId, qty, proof, 0);
    }

    // Public overload may be called internally by the 5-arg mint, so we cannot forward msg.data.
    function mint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof, uint128 hubValue)
        public
        payable
        nonReentrant
    {
        _delegate(abi.encodeWithSelector(bytes4(keccak256("mint(address,uint256,uint16,uint32,bytes32[],uint128)")), to, phaseId, tierId, qty, proof, hubValue));
    }

    function hubReserve(uint16 tierId, uint32 qty, uint256 phaseId, bytes32 to) external onlyEscrow returns (uint8 reason) {
        return abi.decode(_delegate(msg.data), (uint8));
    }

    function confirmMint(uint256 rid) external onlyEscrow {
        _delegate(msg.data);
    }

    function rejectMint(uint256 rid, uint8 reason) external onlyEscrow {
        _delegate(msg.data);
    }

    function claimRefund() external nonReentrant {
        _delegate(msg.data);
    }

    function open(uint16 tierId, uint16 qty) external nonReentrant {
        _delegate(msg.data);
    }

    function reveal(uint256 commitId) external payable {
        reveal(commitId, 0);
    }

    function reveal(uint256 commitId, uint128 hubValue) public payable nonReentrant {
        _delegate(abi.encodeWithSelector(bytes4(keccak256("reveal(uint256,uint128)")), commitId, hubValue));
    }

    function recommit(uint256 commitId) external {
        _delegate(msg.data);
    }

    function hubAssign(bytes32 seed, uint16 tierId, uint32 qty) external onlyEscrow returns (uint256 start, uint16[] memory types) {
        return abi.decode(_delegate(msg.data), (uint256, uint16[]));
    }

    function confirmReveal(uint256 commitId, uint256 start, uint16[] calldata types) external onlyEscrow {
        _delegate(msg.data);
    }

    function copyCards(uint256 start, uint16[] calldata types) external onlyEscrow {
        _delegate(msg.data);
    }

    function movePack(uint32 dstEid, uint16 tierId, uint32 amount, address to) external payable nonReentrant {
        _delegate(msg.data);
    }

    function creditPacks(address to, uint16 tierId, uint32 amount) external onlyEscrow {
        _delegate(msg.data);
    }

    function moveCard(uint32 dstEid, uint256 tokenId, address to) external payable nonReentrant {
        _delegate(msg.data);
    }

    function releaseCardKnown(bytes32 to, uint256 tokenId) external onlyEscrow {
        _delegate(msg.data);
    }
}
