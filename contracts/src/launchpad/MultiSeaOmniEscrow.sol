// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOmniDrop {
    function release(address to, uint256 tokenId) external;
    function creditRange(uint32 start, uint32 end) external;
}

/// @title MultiSeaOmniEscrow
/// @notice One per chain, shared by every multichain (escrow-mode) launchpad drop on that chain. It is both
///         - the ESCROW: tokens that are not Active on this chain are owned by this contract (locked, never burned), and
///         - the LayerZero V2 OApp adapter (ONFT-style lock/release): MOVE releases a token that was locked on the source
///           chain; RANGE credits a block of still-unminted token ids that the source chain removed from its own pool.
///         Peers (the escrows on the other chains) are wired once per chain by the owner (a TimelockController),
///         not once per drop. Drops are registered only by the launchpad factory.
/// @dev    PREVIEW / UNAUDITED. Not deployed anywhere.
contract MultiSeaOmniEscrow is OApp, ReentrancyGuard {
    uint8 internal constant MOVE = 1;
    uint8 internal constant RANGE = 2;

    address public factory;
    address public feeWallet;
    uint256 public moveFee; // platform fee per move in this chain's native token (≈ $0.30), set by the owner
    mapping(bytes32 => address) public dropOf;   // collectionId => local drop clone
    mapping(address => bytes32) public idOfDrop; // local drop clone => collectionId

    event Registered(bytes32 indexed collectionId, address drop);
    event MoveOut(bytes32 indexed guid, bytes32 indexed collectionId, uint32 dstEid, uint256 tokenId, address to, uint256 platformFee);
    event MoveIn(bytes32 indexed guid, bytes32 indexed collectionId, uint32 srcEid, uint256 tokenId, address to);
    event RangeOut(bytes32 indexed guid, bytes32 indexed collectionId, uint32 dstEid, uint32 start, uint32 end);
    event RangeIn(bytes32 indexed guid, bytes32 indexed collectionId, uint32 srcEid, uint32 start, uint32 end);

    error NotFactory();
    error NotDrop();
    error UnknownCollection(bytes32 collectionId);
    error AlreadyRegistered();
    error InsufficientFee(uint256 required, uint256 sent);
    error PayFailed();
    error ZeroAddress();
    error FactorySet();

    constructor(address _endpoint, address _owner, address _feeWallet, uint256 _moveFee) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_feeWallet == address(0)) revert ZeroAddress();
        feeWallet = _feeWallet; moveFee = _moveFee;
    }

    modifier onlyDrop(bytes32 cid) { if (dropOf[cid] != msg.sender || cid == bytes32(0)) revert NotDrop(); _; }

    function localEid() external view returns (uint32) { return endpoint.eid(); }

    function register(bytes32 cid, address drop) external {
        if (msg.sender != factory) revert NotFactory();
        if (dropOf[cid] != address(0) || idOfDrop[drop] != bytes32(0)) revert AlreadyRegistered();
        dropOf[cid] = drop; idOfDrop[drop] = cid;
        emit Registered(cid, drop);
    }

    // ---------------------------------------------------------------- quotes
    function quoteMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to, bytes calldata options) external view returns (uint256 platform, uint256 lzFee) {
        platform = moveFee; lzFee = _quote(dstEid, abi.encode(MOVE, cid, tokenId, uint256(0), to), options, false).nativeFee;
    }
    function quoteRange(bytes32 cid, uint32 dstEid, uint32 start, uint32 end, bytes calldata options) external view returns (uint256 lzFee) {
        lzFee = _quote(dstEid, abi.encode(RANGE, cid, uint256(start), uint256(end), address(0)), options, false).nativeFee;
    }

    // ------------------------------------------------------------------ send
    /// @notice Called by the drop AFTER it moved `tokenId` into this escrow (locked). Pays the platform fee + LZ fee.
    function sendMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to, bytes calldata options, address refund)
        external payable onlyDrop(cid) nonReentrant returns (MessagingReceipt memory r)
    {
        if (to == address(0)) revert ZeroAddress();
        bytes memory payload = abi.encode(MOVE, cid, tokenId, uint256(0), to);
        uint256 lz = _quote(dstEid, payload, options, false).nativeFee;
        uint256 required = moveFee + lz;
        if (msg.value < required) revert InsufficientFee(required, msg.value);
        r = _lzSend(dstEid, payload, options, MessagingFee(lz, 0), payable(refund));
        if (moveFee > 0) _pay(feeWallet, moveFee);
        if (msg.value > required) _pay(refund, msg.value - required);
        emit MoveOut(r.guid, cid, dstEid, tokenId, to, moveFee);
    }

    /// @notice Called by the drop AFTER it removed [start, end) from its own unminted pool (debit before credit).
    function sendRange(bytes32 cid, uint32 dstEid, uint32 start, uint32 end, bytes calldata options, address refund)
        external payable onlyDrop(cid) nonReentrant returns (MessagingReceipt memory r)
    {
        bytes memory payload = abi.encode(RANGE, cid, uint256(start), uint256(end), address(0));
        uint256 lz = _quote(dstEid, payload, options, false).nativeFee;
        if (msg.value < lz) revert InsufficientFee(lz, msg.value);
        r = _lzSend(dstEid, payload, options, MessagingFee(lz, 0), payable(refund));
        if (msg.value > lz) _pay(refund, msg.value - lz);
        emit RangeOut(r.guid, cid, dstEid, start, end);
    }

    // --------------------------------------------------------------- receive
    /// @dev Only the endpoint calls this and OAppReceiver rejects senders that are not the configured peer escrow.
    ///      If the collection is not registered here yet, this reverts and LayerZero keeps the message retryable.
    function _lzReceive(Origin calldata o, bytes32 guid, bytes calldata m, address, bytes calldata) internal override nonReentrant {
        (uint8 kind, bytes32 cid, uint256 a, uint256 b, address to) = abi.decode(m, (uint8, bytes32, uint256, uint256, address));
        address drop = dropOf[cid];
        if (drop == address(0)) revert UnknownCollection(cid);
        if (kind == MOVE) { IOmniDrop(drop).release(to, a); emit MoveIn(guid, cid, o.srcEid, a, to); }
        else if (kind == RANGE) { IOmniDrop(drop).creditRange(uint32(a), uint32(b)); emit RangeIn(guid, cid, o.srcEid, uint32(a), uint32(b)); }
    }

    function _payNative(uint256 _nativeFee) internal override returns (uint256) {
        if (msg.value < _nativeFee) revert NotEnoughNative(msg.value); // msg.value also carries the platform fee
        return _nativeFee;
    }

    function _pay(address to, uint256 amount) internal { (bool ok,) = payable(to).call{ value: amount }(""); if (!ok) revert PayFailed(); }

    // ----------------------------------------------------------------- admin (timelock)
    function setFactory(address f) external onlyOwner { if (factory != address(0)) revert FactorySet(); if (f == address(0)) revert ZeroAddress(); factory = f; }
    function setMoveFee(address w, uint256 fee) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; moveFee = fee; }
}
