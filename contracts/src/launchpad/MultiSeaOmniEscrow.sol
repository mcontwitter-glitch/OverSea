// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOmniDrop {
    function eids() external view returns (uint32[] memory);
    function hubEid() external view returns (uint32);
    function release(address to, uint256 tokenId) external;
    function hubAssign(uint32 srcEid, address to, uint256 qty, uint256 phaseId) external returns (uint256 start, uint8 reason);
    function confirmMint(uint256 rid, uint256 start) external;
    function rejectMint(uint256 rid, uint8 reason) external;
    function copyIn(uint256 start, uint256 qty) external returns (uint256 created);
}

/// @title MultiSeaOmniEscrow
/// @notice One per chain, shared by every multichain (escrow-mode) launchpad drop on that chain. It is
///         - the ESCROW: on every chain where a token is not Active, its copy is owned by this contract (locked, never burned);
///         - the LayerZero V2 OApp that carries five message kinds between the drop's clones:
///             REQUEST  origin -> hub   "mint qty for `to`" (payment held on the origin; native drop pays the hub's fan-out)
///             CONFIRM  hub -> origin   "ids [start, start+qty) are yours": minted Active on the origin
///             REJECT   hub -> origin   sold out / wallet limit: the origin refunds the held payment
///             COPY     hub -> others   "mint ids [start, start+qty) into escrow here" (one message per chain per mint)
///             MOVE     any -> any      the holder locked id on the source; release it to `to` here
///         The HUB (Base for MultiSea) is the only place ids are assigned, so ids never collide and the shared cap holds even
///         when minters on different chains mint at the same moment: LayerZero deliveries to the hub execute one at a time.
///         Fan-out legs that cannot be paid from the budget are recorded as OWED and can be resent by anyone (retryLeg),
///         so a partial broadcast is never lost and never creates a second Active copy (COPY only ever mints into escrow).
/// @dev    PREVIEW / UNAUDITED. Not deployed anywhere.
contract MultiSeaOmniEscrow is OApp, ReentrancyGuard {
    using OptionsBuilder for bytes;

    uint8 public constant MOVE = 1;
    uint8 public constant REQUEST = 2;
    uint8 public constant CONFIRM = 3;
    uint8 public constant REJECT = 4;
    uint8 public constant COPY = 5;

    struct Gas { uint64 base; uint64 perId; }

    address public factory;
    address public feeWallet;
    uint256 public moveFee; // platform fee per move in this chain's native token (≈ $0.30), set by the owner
    mapping(bytes32 => address) public dropOf;   // collectionId => local drop clone
    mapping(address => bytes32) public idOfDrop; // local drop clone => collectionId
    mapping(uint8 => Gas) public gasOf;          // destination lzReceive gas per message kind (enforced, owner-tunable)
    mapping(bytes32 => bool) public owed;        // keccak(dstEid, payload) of fan-out legs not yet sent
    mapping(address => uint256) public refundOf; // hub: unspent native-drop budget, claimable by the minter

    event Registered(bytes32 indexed collectionId, address drop);
    event Sent(bytes32 indexed guid, bytes32 indexed collectionId, uint8 kind, uint32 dstEid, uint256 a, uint256 b, address to);
    event Received(bytes32 indexed guid, bytes32 indexed collectionId, uint8 kind, uint32 srcEid);
    event LegOwed(uint32 indexed dstEid, bytes payload, uint256 fee);
    event LegRetried(uint32 indexed dstEid, bytes32 leg);

    error NotFactory();
    error NotDrop();
    error UnknownCollection(bytes32 collectionId);
    error AlreadyRegistered();
    error InsufficientFee(uint256 required, uint256 sent);
    error NotOwed();
    error PayFailed();
    error ZeroAddress();
    error FactorySet();

    constructor(address _endpoint, address _owner, address _feeWallet, uint256 _moveFee) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_feeWallet == address(0)) revert ZeroAddress();
        feeWallet = _feeWallet; moveFee = _moveFee;
        // Defaults sized from the Foundry gas report (+40-60% headroom). The timelock can tune them per kind.
        gasOf[MOVE] = Gas(150_000, 0);
        gasOf[REQUEST] = Gas(2_400_000, 60_000); // hub: assign + escrow-mint qty locally + send up to 4 legs (~300k gas per real LZ send)
        gasOf[CONFIRM] = Gas(90_000, 45_000);
        gasOf[REJECT] = Gas(90_000, 0);
        gasOf[COPY] = Gas(80_000, 45_000);
    }

    modifier onlyDrop(bytes32 cid) { if (dropOf[cid] != msg.sender || cid == bytes32(0)) revert NotDrop(); _; }

    function localEid() external view returns (uint32) { return endpoint.eid(); }

    function register(bytes32 cid, address drop) external {
        if (msg.sender != factory) revert NotFactory();
        if (dropOf[cid] != address(0) || idOfDrop[drop] != bytes32(0)) revert AlreadyRegistered();
        dropOf[cid] = drop; idOfDrop[drop] = cid;
        emit Registered(cid, drop);
    }

    // ---------------------------------------------------------------- options + payloads
    function optionsFor(uint8 kind, uint256 qty, uint128 nativeDrop) public view returns (bytes memory) {
        Gas memory g = gasOf[kind];
        return OptionsBuilder.newOptions().addExecutorLzReceiveOption(uint128(g.base + g.perId * qty), nativeDrop);
    }
    /// Payload: (kind, collectionId, a, b, c, to)
    ///   REQUEST a=rid b=qty c=phaseId to=minter · CONFIRM a=rid b=start c=qty · REJECT a=rid b=reason · COPY a=start b=qty · MOVE a=tokenId to=recipient
    function _payload(uint8 kind, bytes32 cid, uint256 a, uint256 b, uint256 c, address to) internal pure returns (bytes memory) { return abi.encode(kind, cid, a, b, c, to); }
    function _decode(bytes memory m) internal pure returns (uint8 kind, bytes32 cid, uint256 a, uint256 b, uint256 c, address to) { return abi.decode(m, (uint8, bytes32, uint256, uint256, uint256, address)); }
    function _qty(bytes memory m) internal pure returns (uint8 kind, uint256 qty) {
        uint256 b; uint256 c; (kind, , , b, c, ) = _decode(m);
        qty = (kind == COPY || kind == REQUEST) ? b : kind == CONFIRM ? c : 1;
    }
    function _opts(bytes memory m) internal view returns (bytes memory) { (uint8 k, uint256 q) = _qty(m); return optionsFor(k, q, 0); }

    /// @dev The legs the hub sends after it handled a mint from `originEid` (CONFIRM first: it matters most to the minter).
    function _legs(bytes32 cid, uint32 originEid, uint256 start, uint256 qty, uint256 rid, uint8 reason)
        internal view returns (uint32[] memory dst, bytes[] memory pl)
    {
        address drop = dropOf[cid];
        uint32 hub = endpoint.eid();
        if (start == 0) { // rejected: one REJECT back to the origin
            dst = new uint32[](1); pl = new bytes[](1);
            dst[0] = originEid; pl[0] = _payload(REJECT, cid, rid, reason, 0, address(0)); return (dst, pl);
        }
        uint32[] memory all = IOmniDrop(drop).eids();
        uint256 n = all.length - 1; // every chain except the hub
        dst = new uint32[](n); pl = new bytes[](n);
        uint256 k;
        if (originEid != hub) { dst[k] = originEid; pl[k] = _payload(CONFIRM, cid, rid, start, qty, address(0)); ++k; }
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == hub || all[i] == originEid) continue;
            dst[k] = all[i]; pl[k] = _payload(COPY, cid, start, qty, 0, address(0)); ++k;
        }
    }

    // ---------------------------------------------------------------- quotes (for the UI and the drop)
    /// @notice HUB chain: LayerZero cost of everything the hub sends for one mint of `qty` from `originEid`.
    ///         For a non-hub origin the UI converts this into the native drop of the REQUEST (with a small buffer).
    function quoteFanout(bytes32 cid, uint32 originEid, uint256 qty) public view returns (uint256 total) {
        (uint32[] memory dst, bytes[] memory pl) = _legs(cid, originEid, 1, qty, 0, 0);
        for (uint256 i; i < dst.length; ++i) total += _quote(dst[i], pl[i], _opts(pl[i]), false).nativeFee;
    }
    /// @notice ORIGIN chain: LayerZero cost of the REQUEST to the hub carrying `hubValue` (hub-native wei) for the fan-out.
    function quoteRequest(bytes32 cid, uint256 qty, address to, uint128 hubValue) public view returns (uint256) {
        uint32 hub = IOmniDrop(dropOf[cid]).hubEid();
        return _quote(hub, _payload(REQUEST, cid, 0, qty, 0, to), optionsFor(REQUEST, qty, hubValue), false).nativeFee;
    }
    function quoteMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to) external view returns (uint256 platform, uint256 lzFee) {
        platform = moveFee; lzFee = _quote(dstEid, _payload(MOVE, cid, tokenId, 0, 0, to), optionsFor(MOVE, 1, 0), false).nativeFee;
    }

    // ------------------------------------------------------------------ sends initiated by a local drop
    /// @notice Hub-local mint: escrow copies to every other chain. The minter is present, so the fan-out must be fully paid.
    function fanoutCopies(bytes32 cid, uint256 start, uint256 qty, address refund) external payable onlyDrop(cid) nonReentrant {
        (uint32[] memory dst, bytes[] memory pl) = _legs(cid, endpoint.eid(), start, qty, 0, 0);
        uint256 spent;
        for (uint256 i; i < dst.length; ++i) spent += _send(cid, dst[i], pl[i], refund);
        if (msg.value < spent) revert InsufficientFee(spent, msg.value);
        if (msg.value > spent) _pay(refund, msg.value - spent);
    }

    /// @notice Non-hub mint: REQUEST to the hub. `hubValue` is dropped on the hub to pay its fan-out.
    function sendRequest(bytes32 cid, uint256 rid, address to, uint256 qty, uint256 phaseId, uint128 hubValue, address refund)
        external payable onlyDrop(cid) nonReentrant
    {
        _sendExact(cid, IOmniDrop(msg.sender).hubEid(), _payload(REQUEST, cid, rid, qty, phaseId, to), optionsFor(REQUEST, qty, hubValue), 0, refund);
    }
    /// @dev Send one message paid by msg.value (+ `extra` platform fee), refunding any excess to `refund`.
    function _sendExact(bytes32 cid, uint32 dst, bytes memory pl, bytes memory o, uint256 extra, address refund) internal {
        uint256 fee = _quote(dst, pl, o, false).nativeFee;
        if (msg.value < fee + extra) revert InsufficientFee(fee + extra, msg.value);
        MessagingReceipt memory r = _lzSend(dst, pl, o, MessagingFee(fee, 0), payable(refund));
        if (extra > 0) _pay(feeWallet, extra);
        if (msg.value > fee + extra) _pay(refund, msg.value - fee - extra);
        (uint8 k, , uint256 a, uint256 b, , address to) = _decode(pl);
        emit Sent(r.guid, cid, k, dst, a, b, to);
    }

    /// @notice Called by the drop AFTER it moved `tokenId` into this escrow (locked). Pays the platform fee + LZ fee.
    function sendMove(bytes32 cid, uint32 dstEid, uint256 tokenId, address to, address refund) external payable onlyDrop(cid) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _sendExact(cid, dstEid, _payload(MOVE, cid, tokenId, 0, 0, to), optionsFor(MOVE, 1, 0), moveFee, refund);
    }

    /// @notice Anyone can resend an OWED fan-out leg (paying its LayerZero fee). Same payload, so it is idempotent at the destination.
    function retryLeg(uint32 dstEid, bytes calldata payload) external payable nonReentrant {
        bytes32 leg = keccak256(abi.encode(dstEid, payload));
        if (!owed[leg]) revert NotOwed();
        delete owed[leg];
        bytes memory o = _opts(payload);
        uint256 fee = _quote(dstEid, payload, o, false).nativeFee;
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);
        _lzSend(dstEid, payload, o, MessagingFee(fee, 0), payable(msg.sender));
        if (msg.value > fee) _pay(msg.sender, msg.value - fee);
        emit LegRetried(dstEid, leg);
    }

    function claimRefund(address who) external nonReentrant {
        uint256 v = refundOf[who]; refundOf[who] = 0; if (v > 0) _pay(who, v);
    }

    // --------------------------------------------------------------- receive
    /// @dev Only the endpoint calls this and OAppReceiver rejects senders that are not the configured peer escrow.
    ///      Reverts (unknown collection) keep the message retryable in LayerZero.
    function _lzReceive(Origin calldata o, bytes32 guid, bytes calldata m, address, bytes calldata) internal override nonReentrant {
        _dispatch(o.srcEid, guid, m);
    }
    function _dispatch(uint32 src, bytes32 guid, bytes calldata m) internal {
        (uint8 kind, bytes32 cid, uint256 a, uint256 b, , address to) = _decode(m);
        address drop = dropOf[cid];
        if (drop == address(0)) revert UnknownCollection(cid);
        emit Received(guid, cid, kind, src);
        if (kind == MOVE) IOmniDrop(drop).release(to, a);
        else if (kind == COPY) IOmniDrop(drop).copyIn(a, b);
        else if (kind == CONFIRM) IOmniDrop(drop).confirmMint(a, b);
        else if (kind == REJECT) IOmniDrop(drop).rejectMint(a, uint8(b));
        else if (kind == REQUEST) _hubRequest(src, drop, m);
    }

    /// @dev HUB: assign ids [start, start+qty) (or reject), then fan out CONFIRM/REJECT + COPY legs paid from the native drop.
    ///      Legs the budget cannot cover are recorded as OWED (retryLeg) instead of reverting, so ids already assigned are
    ///      never lost and the request is never processed twice.
    function _hubRequest(uint32 src, address drop, bytes calldata m) internal {
        (, bytes32 cid, uint256 rid, uint256 qty, uint256 phaseId, address to) = _decode(m);
        (uint256 start, uint8 reason) = IOmniDrop(drop).hubAssign(src, to, qty, phaseId);
        (uint32[] memory dst, bytes[] memory pl) = _legs(cid, src, start, qty, rid, reason);
        uint256 budget = msg.value; // native drop paid by the minter on the origin chain
        for (uint256 i; i < dst.length; ++i) {
            uint256 fee = _quote(dst[i], pl[i], _opts(pl[i]), false).nativeFee;
            if (fee <= budget) { budget -= fee; _sendPaid(cid, dst[i], pl[i], fee); }
            else { owed[keccak256(abi.encode(dst[i], pl[i]))] = true; emit LegOwed(dst[i], pl[i], fee); }
        }
        if (budget > 0) refundOf[to] += budget; // unspent buffer: the minter can claim it on the hub chain
    }

    function _send(bytes32 cid, uint32 dst, bytes memory pl, address refund) internal returns (uint256 fee) {
        fee = _quote(dst, pl, _opts(pl), false).nativeFee;
        MessagingReceipt memory r = _lzSend(dst, pl, _opts(pl), MessagingFee(fee, 0), payable(refund));
        (uint8 k, , uint256 a, uint256 b, , ) = _decode(pl);
        emit Sent(r.guid, cid, k, dst, a, b, address(0));
    }
    function _sendPaid(bytes32 cid, uint32 dst, bytes memory pl, uint256 fee) internal {
        MessagingReceipt memory r = _lzSend(dst, pl, _opts(pl), MessagingFee(fee, 0), payable(address(this)));
        (uint8 k, , uint256 a, uint256 b, , ) = _decode(pl);
        emit Sent(r.guid, cid, k, dst, a, b, address(0));
    }

    /// @dev Fees are paid from this contract's balance; every entry point checks its own budget (msg.value) above, and the
    ///      only balance kept here between transactions is `refundOf` (claimable by minters).
    function _payNative(uint256 _nativeFee) internal pure override returns (uint256) { return _nativeFee; }

    function _pay(address to, uint256 amount) internal { (bool ok,) = payable(to).call{ value: amount }(""); if (!ok) revert PayFailed(); }

    receive() external payable {} // LayerZero refunds of over-quoted hub sends

    // ----------------------------------------------------------------- admin (timelock)
    function setFactory(address f) external onlyOwner { if (factory != address(0)) revert FactorySet(); if (f == address(0)) revert ZeroAddress(); factory = f; }
    function setMoveFee(address w, uint256 fee) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; moveFee = fee; }
    function setGas(uint8 kind, uint64 base, uint64 perId) external onlyOwner { gasOf[kind] = Gas(base, perId); }
}
