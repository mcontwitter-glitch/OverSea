// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPacksHub {
    function hubReserve(uint16 tierId, uint32 qty, uint256 phaseId, bytes32 to) external returns (uint8 reason);
    function confirmMint(uint256 rid) external;
    function rejectMint(uint256 rid, uint8 reason) external;
    function hubAssign(bytes32 seed, uint16 tierId, uint32 qty) external returns (uint256 start, uint16[] memory types);
    function confirmReveal(uint256 commitId, uint256 start, uint16[] calldata types) external;
    function copyCards(uint256 start, uint16[] calldata types) external;
    function creditPacks(address to, uint16 tierId, uint32 amount) external;
    function releaseCardKnown(bytes32 to, uint256 tokenId) external;
    function eids() external view returns (uint32[] memory);
    function hubEid() external view returns (uint32);
}

/// @title MultiSeaPackEscrow
/// @notice One per chain, shared by every pack drop on that chain. LayerZero V2 OApp that carries:
///         MINT_REQ  spoke -> hub    reserve card slots and mint packs
///         MINT_OK / MINT_FAIL        confirm or refund the spoke
///         REVEAL_REQ spoke -> hub    assign card IDs from the origin's commit-reveal seed
///         REVEAL_OK                  mint cards Active on the origin
///         CARD_COPY  hub -> others   mint the same IDs into escrow (omni-drop copy pattern)
///         MOVE_PACK / MOVE_CARD      holder-initiated bridge (packs are burned/credited; cards lock/release)
///         Solana is out of scope. Pack factories and this escrow are new; existing omni drops are untouched.
contract MultiSeaPackEscrow is OApp, ReentrancyGuard {
    using OptionsBuilder for bytes;

    uint8 public constant MINT_REQ = 1;
    uint8 public constant MINT_OK = 2;
    uint8 public constant MINT_FAIL = 3;
    uint8 public constant REVEAL_REQ = 4;
    uint8 public constant REVEAL_OK = 5;
    uint8 public constant CARD_COPY = 6;
    uint8 public constant MOVE_PACK = 7;
    uint8 public constant MOVE_CARD = 8;

    struct Gas { uint64 base; uint64 perId; }

    address public factory;
    address public feeWallet;
    uint256 public moveFee;
    mapping(bytes32 => address) public packsOf;
    mapping(address => bytes32) public idOfPacks;
    mapping(uint8 => Gas) public gasOf;

    event Registered(bytes32 indexed collectionId, address packs, address cards);
    event Sent(bytes32 indexed collectionId, uint8 kind, uint32 dstEid);
    event Received(bytes32 indexed collectionId, uint8 kind, uint32 srcEid);

    error NotFactory();
    error NotDrop();
    error AlreadyRegistered();
    error InsufficientFee(uint256 required, uint256 sent);
    error ZeroAddress();
    error FactorySet();
    error UnknownCollection();

    constructor(address endpoint_, address owner_, address feeWallet_, uint256 moveFee_) OApp(endpoint_, owner_) Ownable(owner_) {
        if (feeWallet_ == address(0)) revert ZeroAddress();
        feeWallet = feeWallet_;
        moveFee = moveFee_;
        gasOf[MINT_REQ] = Gas(1_200_000, 20_000);
        gasOf[MINT_OK] = Gas(200_000, 30_000);
        gasOf[MINT_FAIL] = Gas(90_000, 0);
        gasOf[REVEAL_REQ] = Gas(2_000_000, 40_000);
        gasOf[REVEAL_OK] = Gas(200_000, 80_000);
        gasOf[CARD_COPY] = Gas(200_000, 80_000);
        gasOf[MOVE_PACK] = Gas(120_000, 10_000);
        gasOf[MOVE_CARD] = Gas(150_000, 0);
    }

    modifier onlyPacks(bytes32 cid) {
        if (packsOf[cid] != msg.sender || cid == bytes32(0)) revert NotDrop();
        _;
    }

    function localEid() external view returns (uint32) { return endpoint.eid(); }

    function setFactory(address f) external onlyOwner {
        if (factory != address(0)) revert FactorySet();
        if (f == address(0)) revert ZeroAddress();
        factory = f;
    }

    function setMoveFee(uint256 v) external onlyOwner { moveFee = v; }
    function setFeeWallet(address w) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; }
    function setGas(uint8 kind, uint64 base, uint64 perId) external onlyOwner { gasOf[kind] = Gas(base, perId); }

    function register(bytes32 cid, address packs, address /* cards */) external {
        if (msg.sender != factory) revert NotFactory();
        if (packsOf[cid] != address(0) || idOfPacks[packs] != bytes32(0)) revert AlreadyRegistered();
        packsOf[cid] = packs;
        idOfPacks[packs] = cid;
        emit Registered(cid, packs, address(0));
    }

    function optionsFor(uint8 kind, uint256 qty) public view returns (bytes memory) {
        Gas memory g = gasOf[kind];
        return OptionsBuilder.newOptions().addExecutorLzReceiveOption(uint128(g.base + g.perId * qty), 0);
    }

    function _fee(uint32 dst, bytes memory payload, bytes memory opts) internal view returns (uint256) {
        MessagingFee memory f = _quote(dst, payload, opts, false);
        return f.nativeFee;
    }

    function quoteMint(bytes32 cid, uint16, uint32 qty) external view returns (uint256) {
        IPacksHub p = IPacksHub(packsOf[cid]);
        if (address(p) == address(0)) revert UnknownCollection();
        uint32 hub = p.hubEid();
        bytes memory payload = abi.encode(MINT_REQ, cid, uint256(0), bytes32(0), uint16(0), qty, uint256(0));
        return _fee(hub, payload, optionsFor(MINT_REQ, qty));
    }

    function quoteReveal(bytes32 cid, uint32 cards) external view returns (uint256) {
        IPacksHub p = IPacksHub(packsOf[cid]);
        if (address(p) == address(0)) revert UnknownCollection();
        uint32 hub = p.hubEid();
        bytes memory payload = abi.encode(REVEAL_REQ, cid, uint256(0), bytes32(0), bytes32(0), uint16(0), uint32(0));
        return _fee(hub, payload, optionsFor(REVEAL_REQ, cards));
    }

    function quoteMovePack(bytes32 cid, uint32 dstEid, uint16, uint32 amount) external view returns (uint256 platform, uint256 lz) {
        bytes memory payload = abi.encode(MOVE_PACK, cid, bytes32(0), uint16(0), amount);
        return (moveFee, _fee(dstEid, payload, optionsFor(MOVE_PACK, amount)));
    }

    function quoteMoveCard(bytes32 cid, uint32 dstEid, uint256) external view returns (uint256 platform, uint256 lz) {
        bytes memory payload = abi.encode(MOVE_CARD, cid, bytes32(0), uint256(0));
        return (moveFee, _fee(dstEid, payload, optionsFor(MOVE_CARD, 1)));
    }

    function sendMintRequest(bytes32 cid, uint256 rid, bytes32 to, uint16 tierId, uint32 qty, uint256 phaseId, address refund)
        external
        payable
        onlyPacks(cid)
    {
        uint256 keep = address(this).balance - msg.value;
        IPacksHub p = IPacksHub(msg.sender);
        bytes memory payload = abi.encode(MINT_REQ, cid, rid, to, tierId, qty, phaseId);
        _paySend(p.hubEid(), payload, optionsFor(MINT_REQ, qty), refund);
        _refundDust(refund, keep);
        emit Sent(cid, MINT_REQ, p.hubEid());
    }

    function sendReveal(bytes32 cid, uint256 commitId, bytes32 to, bytes32 seed, uint16 tierId, uint32 qty, address refund)
        external
        payable
        onlyPacks(cid)
    {
        uint256 keep = address(this).balance - msg.value;
        IPacksHub p = IPacksHub(msg.sender);
        bytes memory payload = abi.encode(REVEAL_REQ, cid, commitId, to, seed, tierId, qty);
        uint32 cards = qty; // lower bound; options use per-id headroom
        _paySend(p.hubEid(), payload, optionsFor(REVEAL_REQ, cards < 1 ? 1 : cards), refund);
        _refundDust(refund, keep);
        emit Sent(cid, REVEAL_REQ, p.hubEid());
    }

    function sendMovePack(bytes32 cid, uint32 dstEid, uint16 tierId, uint32 amount, bytes32 to, address refund)
        external
        payable
        onlyPacks(cid)
    {
        uint256 keep = address(this).balance - msg.value;
        _takeMoveFee();
        bytes memory payload = abi.encode(MOVE_PACK, cid, to, tierId, amount);
        _paySend(dstEid, payload, optionsFor(MOVE_PACK, amount), refund);
        _refundDust(refund, keep);
        emit Sent(cid, MOVE_PACK, dstEid);
    }

    function sendMoveCard(bytes32 cid, uint32 dstEid, uint256 tokenId, bytes32 to, address refund) external payable onlyPacks(cid) {
        uint256 keep = address(this).balance - msg.value;
        _takeMoveFee();
        bytes memory payload = abi.encode(MOVE_CARD, cid, to, tokenId);
        _paySend(dstEid, payload, optionsFor(MOVE_CARD, 1), refund);
        _refundDust(refund, keep);
        emit Sent(cid, MOVE_CARD, dstEid);
    }

    function fanoutCards(bytes32 cid, uint256 startId, uint16[] calldata types, uint32 originEid, address refund)
        external
        payable
        onlyPacks(cid)
    {
        uint256 keep = address(this).balance - msg.value;
        uint32[] memory dests = IPacksHub(msg.sender).eids();
        uint256 left = msg.value;
        for (uint256 i; i < dests.length; ++i) {
            if (dests[i] == originEid) continue;
            bytes memory payload = abi.encode(CARD_COPY, cid, startId, types);
            bytes memory opts = optionsFor(CARD_COPY, types.length);
            uint256 fee = _fee(dests[i], payload, opts);
            if (left < fee) revert InsufficientFee(fee, left);
            _lzSend(dests[i], payload, opts, MessagingFee(fee, 0), payable(refund));
            unchecked { left -= fee; }
            emit Sent(cid, CARD_COPY, dests[i]);
        }
        _refundDust(refund, keep);
        left;
    }

    function _takeMoveFee() internal {
        if (moveFee == 0) return;
        if (msg.value < moveFee) revert InsufficientFee(moveFee, msg.value);
        (bool ok, ) = feeWallet.call{ value: moveFee }("");
        require(ok);
    }

    function _paySend(uint32 dst, bytes memory payload, bytes memory opts, address refund) internal {
        uint256 fee = _fee(dst, payload, opts);
        if (address(this).balance < fee) revert InsufficientFee(fee, address(this).balance);
        _lzSend(dst, payload, opts, MessagingFee(fee, 0), payable(address(this)));
        refund; // refunded by the payable entry point against a pre-call keep
    }

    function _refundDust(address refund, uint256 keep) internal {
        uint256 bal = address(this).balance;
        if (bal > keep && refund != address(0)) {
            (bool ok, ) = refund.call{ value: bal - keep }("");
            require(ok);
        }
    }

    /// @dev Pay LZ fees from this contract's balance (msg.value may cover several messages plus a platform fee).
    function _payNative(uint256 _nativeFee) internal view override returns (uint256) {
        if (address(this).balance < _nativeFee) revert InsufficientFee(_nativeFee, address(this).balance);
        return _nativeFee;
    }

    function _lzReceive(Origin calldata origin, bytes32, bytes calldata payload, address, bytes calldata) internal override {
        uint8 k;
        bytes32 cid;
        (k, cid) = abi.decode(payload, (uint8, bytes32));
        address packs = packsOf[cid];
        if (packs == address(0)) revert UnknownCollection();
        if (k == MINT_REQ) _onMintReq(origin.srcEid, packs, payload);
        else if (k == MINT_OK) _onMintOk(packs, payload);
        else if (k == MINT_FAIL) _onMintFail(packs, payload);
        else if (k == REVEAL_REQ) _onRevealReq(origin.srcEid, packs, payload);
        else if (k == REVEAL_OK) _onRevealOk(packs, payload);
        else if (k == CARD_COPY) _onCopy(packs, payload);
        else if (k == MOVE_PACK) _onMovePack(packs, payload);
        else if (k == MOVE_CARD) _onMoveCard(packs, payload);
        emit Received(cid, k, origin.srcEid);
    }

    function _onMintReq(uint32 srcEid, address packs, bytes calldata payload) internal {
        (, , uint256 rid, bytes32 to, uint16 tierId, uint32 qty, uint256 phaseId) =
            abi.decode(payload, (uint8, bytes32, uint256, bytes32, uint16, uint32, uint256));
        uint8 reason = IPacksHub(packs).hubReserve(tierId, qty, phaseId, to);
        bytes32 cid = idOfPacks[packs];
        if (reason == 0) {
            bytes memory out = abi.encode(MINT_OK, cid, rid);
            _send(srcEid, out, optionsFor(MINT_OK, qty));
        } else {
            bytes memory out = abi.encode(MINT_FAIL, cid, rid, reason);
            _send(srcEid, out, optionsFor(MINT_FAIL, 0));
        }
    }

    function _onMintOk(address packs, bytes calldata payload) internal {
        (, , uint256 rid) = abi.decode(payload, (uint8, bytes32, uint256));
        IPacksHub(packs).confirmMint(rid);
    }

    function _onMintFail(address packs, bytes calldata payload) internal {
        (, , uint256 rid, uint8 reason) = abi.decode(payload, (uint8, bytes32, uint256, uint8));
        IPacksHub(packs).rejectMint(rid, reason);
    }

    function _onRevealReq(uint32 srcEid, address packs, bytes calldata payload) internal {
        (, , uint256 commitId, , bytes32 seed, uint16 tierId, uint32 qty) =
            abi.decode(payload, (uint8, bytes32, uint256, bytes32, bytes32, uint16, uint32));
        (uint256 start, uint16[] memory types) = IPacksHub(packs).hubAssign(seed, tierId, qty);
        IPacksHub(packs).copyCards(start, types);
        bytes32 cid = idOfPacks[packs];
        bytes memory out = abi.encode(REVEAL_OK, cid, commitId, start, types);
        _send(srcEid, out, optionsFor(REVEAL_OK, types.length));
        _copyOthers(packs, cid, srcEid, start, types);
    }

    function _copyOthers(address packs, bytes32 cid, uint32 srcEid, uint256 start, uint16[] memory types) internal {
        uint32[] memory dests = IPacksHub(packs).eids();
        uint32 here = endpoint.eid();
        uint256 n = types.length;
        for (uint256 i; i < dests.length; ++i) {
            if (dests[i] == srcEid || dests[i] == here) continue;
            bytes memory cp = abi.encode(CARD_COPY, cid, start, types);
            uint256 fee = _fee(dests[i], cp, optionsFor(CARD_COPY, n));
            if (address(this).balance >= fee) _send(dests[i], cp, optionsFor(CARD_COPY, n));
        }
    }

    function _onRevealOk(address packs, bytes calldata payload) internal {
        (, , uint256 commitId, uint256 start, uint16[] memory types) =
            abi.decode(payload, (uint8, bytes32, uint256, uint256, uint16[]));
        IPacksHub(packs).confirmReveal(commitId, start, types);
    }

    function _onCopy(address packs, bytes calldata payload) internal {
        (, , uint256 start, uint16[] memory types) = abi.decode(payload, (uint8, bytes32, uint256, uint16[]));
        IPacksHub(packs).copyCards(start, types);
    }

    function _onMovePack(address packs, bytes calldata payload) internal {
        (, , bytes32 to, uint16 tierId, uint32 amount) = abi.decode(payload, (uint8, bytes32, bytes32, uint16, uint32));
        IPacksHub(packs).creditPacks(address(uint160(uint256(to))), tierId, amount);
    }

    function _onMoveCard(address packs, bytes calldata payload) internal {
        (, , bytes32 to, uint256 tokenId) = abi.decode(payload, (uint8, bytes32, bytes32, uint256));
        IPacksHub(packs).releaseCardKnown(to, tokenId);
    }

    function _send(uint32 dst, bytes memory payload, bytes memory opts) internal {
        _lzSend(dst, payload, opts, MessagingFee(_fee(dst, payload, opts), 0), payable(address(this)));
    }

    receive() external payable {}
}
