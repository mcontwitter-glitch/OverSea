// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { MultiSeaPacksStorage, IPackEscrow } from "./MultiSeaPacksStorage.sol";
import { MultiSeaPackCards } from "./MultiSeaPackCards.sol";

/// @title MultiSeaPacksOps
/// @notice Logic module for MultiSeaPacks (mint / open / reveal / rarity / moves). Deployed once per chain and
///         reached only via delegatecall from a MultiSeaPacks clone, so it shares the drop's storage. Direct calls
///         on this contract hit empty storage and revert.
contract MultiSeaPacksOps is MultiSeaPacksStorage {
    constructor() { _disableInitializers(); }

function mint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof) external payable {
        mint(to, phaseId, tierId, qty, proof, 0);
    }
function mint(address to, uint256 phaseId, uint16 tierId, uint32 qty, bytes32[] calldata proof, uint128 hubValue)
        public
        payable
    {
        _checkMint(to, phaseId, tierId, qty, proof);
        uint256 cost = priceOf(phaseId, tierId) * qty;
        if (isHub() || address(escrow) == address(0)) _mintLocal(to, phaseId, tierId, qty, cost);
        else _mintRemote(to, phaseId, tierId, qty, cost, hubValue);
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
function _mintRemote(address to, uint256 phaseId, uint16 tierId, uint32 qty, uint256 cost, uint128 hubValue) internal {
        uint256 need = cost + escrow.quoteMint(collectionId, tierId, qty, hubValue);
        if (msg.value < need) revert InsufficientFee(need, msg.value);
        uint256 rid = nextRid++;
        requests[rid] = MintReq(to, msg.sender, tierId, qty, uint32(phaseId), 1, uint128(cost));
        held += cost;
        emit MintRequested(rid, to, tierId, qty, cost);
        _sendMintReq(rid, to, tierId, qty, phaseId, cost, hubValue);
    }
function _sendMintReq(uint256 rid, address to, uint16 tierId, uint32 qty, uint256 phaseId, uint256 cost, uint128 hubValue) internal {
        escrow.sendMintRequest{ value: msg.value - cost }(
            collectionId, rid, bytes32(uint256(uint160(to))), tierId, qty, phaseId, msg.sender, hubValue
        );
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
    function hubReserve(uint16 tierId, uint32 qty, uint256 phaseId, bytes32 to) external returns (uint8 reason) {
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
function confirmMint(uint256 rid) external {
        MintReq storage r = requests[rid];
        if (r.status != 1) revert NotPending();
        r.status = 2;
        held -= r.paid;
        packMinted[r.tierId - 1] += r.qty;
        _mint(r.to, r.tierId, r.qty, "");
        emit MintConfirmed(rid, r.tierId, r.qty);
        emit PackMinted(r.to, r.phaseId, r.tierId, r.qty, r.paid);
    }
function rejectMint(uint256 rid, uint8 reason) external {
        MintReq storage r = requests[rid];
        if (r.status != 1) revert NotPending();
        r.status = 3;
        held -= r.paid;
        refundOf[r.payer] += r.paid;
        emit MintRejected(rid, reason, r.paid);
    }
function claimRefund() external {
        uint256 a = refundOf[msg.sender];
        if (a == 0) revert BadParams();
        refundOf[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{ value: a }("");
        if (!ok) revert PayFailed();
    }
// ---------------- open / reveal ----------------

    function open(uint16 tierId, uint16 qty) external {
        if (paused) revert IsPaused();
        if (qty == 0 || qty > MAX_QTY || tierId == 0 || tierId > _tiers.length) revert BadParams();
        if (balanceOf(msg.sender, tierId) < qty) revert BadParams();
        _burn(msg.sender, tierId, qty);
        uint256 id = nextCommitId++;
        uint32 rb = uint32(block.number + REVEAL_DELAY);
        commits[id] = Commit(msg.sender, rb, tierId, qty, ST_PENDING, bytes32(0));
        emit Opened(id, msg.sender, tierId, qty, rb);
    }
function reveal(uint256 commitId) external payable {
        reveal(commitId, 0);
    }
function reveal(uint256 commitId, uint128 hubValue) public payable {
        Commit storage c = commits[commitId];
        if (c.owner == address(0) || (c.status != ST_PENDING && c.status != ST_REVEALING)) revert NotPending();
        if (msg.sender != c.owner) revert NotCommitOwner();
        if (c.seed == 0) {
            if (block.number <= c.revealBlock) revert RevealTooEarly();
            bytes32 bh = blockhash(c.revealBlock);
            if (bh == 0) revert HashExpired();
            c.seed = keccak256(abi.encodePacked(bh, commitId, collectionId, c.owner, c.revealBlock, c.tierId, c.qty));
        }
        uint32 nCards = cardsInPack(c.tierId, c.qty);
        if (isHub() || address(escrow) == address(0)) {
            (uint256 start, uint16[] memory types) = _assign(c.seed, c.tierId, c.qty);
            c.status = ST_REVEALED;
            cards.mintActive(c.owner, start, types);
            emit Revealed(commitId, c.owner, start, uint16(types.length));
            if (address(escrow) != address(0) && _eids.length > 1) {
                uint256 lz = escrow.quoteFanout(collectionId, localEid, nCards);
                if (msg.value < lz) revert InsufficientFee(lz, msg.value);
                escrow.fanoutCards{ value: msg.value }(collectionId, start, types, localEid, msg.sender);
            } else if (msg.value != 0) revert WrongPayment(0);
        } else {
            uint256 lz = escrow.quoteReveal(collectionId, nCards, hubValue);
            if (msg.value < lz) revert InsufficientFee(lz, msg.value);
            c.status = ST_REVEALING;
            escrow.sendReveal{ value: msg.value }(
                collectionId, commitId, bytes32(uint256(uint160(c.owner))), c.seed, c.tierId, c.qty, nCards, msg.sender, hubValue
            );
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
    function hubAssign(bytes32 seed, uint16 tierId, uint32 qty) external returns (uint256 start, uint16[] memory types) {
        return _assign(seed, tierId, qty);
    }
function confirmReveal(uint256 commitId, uint256 start, uint16[] calldata types) external {
        Commit storage c = commits[commitId];
        if (c.status != ST_REVEALING) revert NotPending();
        c.status = ST_REVEALED;
        cards.mintActive(c.owner, start, types);
        emit Revealed(commitId, c.owner, start, uint16(types.length));
    }
function copyCards(uint256 start, uint16[] calldata types) external {
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

    function movePack(uint32 dstEid, uint16 tierId, uint32 amount, address to) external payable {
        if (address(escrow) == address(0) || to == address(0) || amount == 0 || tierId == 0 || tierId > _tiers.length) revert BadParams();
        if (balanceOf(msg.sender, tierId) < amount) revert BadParams();
        _burn(msg.sender, tierId, amount);
        (uint256 pf, uint256 lz) = escrow.quoteMovePack(collectionId, dstEid, tierId, amount);
        if (msg.value < pf + lz) revert WrongPayment(pf + lz);
        emit PackMoved(msg.sender, dstEid, tierId, amount);
        escrow.sendMovePack{ value: msg.value }(collectionId, dstEid, tierId, amount, bytes32(uint256(uint160(to))), msg.sender);
    }
function creditPacks(address to, uint16 tierId, uint32 amount) external {
        _mint(to, tierId, amount, "");
    }
function moveCard(uint32 dstEid, uint256 tokenId, address to) external payable {
        if (address(escrow) == address(0) || to == address(0)) revert BadParams();
        if (cards.ownerOf(tokenId) != msg.sender) revert BadParams();
        cards.lock(msg.sender, tokenId, address(escrow));
        (uint256 pf, uint256 lz) = escrow.quoteMoveCard(collectionId, dstEid, tokenId);
        if (msg.value < pf + lz) revert WrongPayment(pf + lz);
        emit CardMoved(msg.sender, dstEid, tokenId);
        escrow.sendMoveCard{ value: msg.value }(collectionId, dstEid, tokenId, bytes32(uint256(uint160(to))), msg.sender);
    }
function releaseCardKnown(bytes32 to, uint256 tokenId) external {
        if (!cards.exists(tokenId)) revert BadParams(); // COPY has not landed yet; executor should retry
        cards.release(address(uint160(uint256(to))), tokenId, address(escrow));
    }

    function withdraw() external {
        uint256 bal = address(this).balance - held;
        uint256 fee = (bal * platformFeeBps) / 10_000;
        uint256 rest = bal - fee;
        if (fee > 0) { (bool ok1, ) = feeWallet.call{ value: fee }(""); if (!ok1) revert PayFailed(); }
        if (rest > 0) { (bool ok2, ) = payout.call{ value: rest }(""); if (!ok2) revert PayFailed(); }
        emit Withdrawn(rest, fee);
    }

    function setPhases(Phase[] calldata ph) external {
        delete _phases;
        for (uint256 i; i < ph.length; ++i) {
            if (ph[i].end != 0 && ph[i].end <= ph[i].start) revert BadParams();
            _phases.push(ph[i]);
        }
    }
}
