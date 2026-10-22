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
    function copyMode() external view returns (uint8);
    function batchK() external view returns (uint16);
    function batchT() external view returns (uint32);
    function mintClosed() external view returns (bool);
    function feeWallet() external view returns (address);
    function totalAssigned() external view returns (uint256);
    function maxSupply() external view returns (uint32);
}

/// @title MultiSeaOmniEscrow
/// @notice One per chain, shared by every multichain (escrow-mode) launchpad drop on that chain. It is
///         - the ESCROW: on every chain where a token is not Active, its copy is owned by this contract (locked, never burned);
///         - the LayerZero V2 OApp that carries five message kinds between the drop's clones:
///             REQUEST  origin -> hub   "mint qty for `to`" (payment held on the origin; native drop pays the hub's fan-out)
///             CONFIRM  hub -> origin   "ids [start, start+qty) are yours": minted Active on the origin
///             REJECT   hub -> origin   sold out / wallet limit: the origin refunds the held payment
///             COPY     hub -> others   "mint ids [start, start+qty) into escrow here" (AT_MINT mode: one message per chain per mint)
///             BATCH    hub -> others   "mint these id ranges into escrow here" (BATCHED mode, the default: one message per chain
///                                       per flush, carrying every queued range)
///         BATCHED mode: the hub QUEUES copy ranges instead of sending them at each mint. A flush becomes possible once K ids
///         are queued, T seconds after the oldest queued range, or when minting has closed. flush() is permissionless and
///         paid from the drop's copy pool, which every mint funds with a small per-id share (batch quote / K + buffer);
///         the flusher is reimbursed its gas from the pool surplus. The pool is accounted per drop; what is left after the
///         final batch (decision M3b) goes to the MultiSea fee wallet the factory configured for the drop. It is swept
///         straight from this escrow, so it never touches the drop's balance or the 0.5% withdraw fee math.
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
    uint8 public constant BATCH = 6;
    uint8 public constant G_REQUEST_BATCHED = 7; // gas key only: hub handling a REQUEST in BATCHED mode (CONFIRM + enqueue)
    uint8 public constant MODE_BATCHED = 0;
    uint8 public constant MODE_AT_MINT = 1;
    uint256 public constant MAX_FLUSH_IDS = 200;  // ids per flush (bounds destination gas)
    uint256 public constant QUOTE_RANGES = 8;     // ranges assumed per batch message when sizing the per-id share

    /// @dev queued range, packed: origin eid (32) | enqueued at (40) | start (32) | qty (32)
    struct Queue { uint64 oldest; uint32 ids; uint32 head; uint32 tail; }

    struct Gas { uint64 base; uint64 perId; }

    address public factory;
    address public feeWallet;
    uint256 public moveFee; // platform fee per move in this chain's native token (≈ $0.30), set by the owner
    mapping(bytes32 => address) public dropOf;   // collectionId => local drop clone
    mapping(address => bytes32) public idOfDrop; // local drop clone => collectionId
    mapping(uint8 => Gas) public gasOf;          // destination lzReceive gas per message kind (enforced, owner-tunable)
    mapping(bytes32 => bool) public owed;        // keccak(dstEid, payload) of fan-out legs not yet sent
    mapping(address => uint256) public refundOf; // hub: unspent native-drop budget, claimable by the minter
    mapping(bytes32 => Queue) public queueOf;    // hub, BATCHED: copy ranges waiting for the next flush
    mapping(bytes32 => mapping(uint256 => uint256)) public rangeAt;
    mapping(bytes32 => uint256) public poolOf;   // hub, BATCHED: per-drop copy pool (minters' shares), pays flushes
    uint256 public totalPools;                   // sum of poolOf (accounting)
    uint256 public totalRefunds;                 // sum of refundOf (minters' unspent native-drop buffers)
    mapping(bytes32 => uint64) public lastQueuedAt; // hub, BATCHED: last time a range was queued (sweep grace period)
    uint256 public constant SWEEP_GRACE = 3 days; // after a phase-end close: late REQUESTs already in flight may still queue
    uint16 public shareBufferBps = 2000;         // +20% on the batch quote: covers quote drift + the flusher's gas
    uint256 public maxTipGasPrice = 1 gwei;      // cap on the gas price reimbursed to a flusher

    event Registered(bytes32 indexed collectionId, address drop);
    event Sent(bytes32 indexed guid, bytes32 indexed collectionId, uint8 kind, uint32 dstEid, uint256 a, uint256 b, address to);
    event Received(bytes32 indexed guid, bytes32 indexed collectionId, uint8 kind, uint32 srcEid);
    event LegOwed(uint32 indexed dstEid, bytes payload, uint256 fee);
    event LegRetried(uint32 indexed dstEid, bytes32 leg);
    event CopiesQueued(bytes32 indexed collectionId, uint32 originEid, uint256 start, uint256 qty, uint256 share, uint256 queuedIds);
    event Flushed(bytes32 indexed collectionId, address indexed flusher, uint256 ids, uint256 ranges, uint256 lzFees, uint256 tip);
    event PoolFunded(bytes32 indexed collectionId, address indexed from, uint256 amount);
    event PoolSwept(bytes32 indexed collectionId, address feeWallet, uint256 amount);

    error NotFactory();
    error NotDrop();
    error UnknownCollection(bytes32 collectionId);
    error AlreadyRegistered();
    error InsufficientFee(uint256 required, uint256 sent);
    error NotOwed();
    error PayFailed();
    error ZeroAddress();
    error FactorySet();
    error NothingQueued();
    error NotReady();
    error InsufficientPool(uint256 required, uint256 available);
    error NotClosed();
    error BadBuffer();
    error Underfunded();

    constructor(address _endpoint, address _owner, address _feeWallet, uint256 _moveFee) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_feeWallet == address(0)) revert ZeroAddress();
        feeWallet = _feeWallet; moveFee = _moveFee;
        // Defaults sized from the Foundry gas report (+40-60% headroom). The timelock can tune them per kind.
        gasOf[MOVE] = Gas(150_000, 0);
        gasOf[REQUEST] = Gas(2_400_000, 60_000); // hub: assign + escrow-mint qty locally + send up to 4 legs (~300k gas per real LZ send)
        gasOf[CONFIRM] = Gas(90_000, 45_000);
        gasOf[REJECT] = Gas(90_000, 0);
        gasOf[COPY] = Gas(80_000, 45_000);
        gasOf[BATCH] = Gas(100_000, 45_000);
        gasOf[G_REQUEST_BATCHED] = Gas(1_600_000, 60_000); // hub: assign + escrow-mint qty + 1 CONFIRM send + 4 quotes (pool share) + enqueue
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
        return _quote(hub, _payload(REQUEST, cid, 0, qty, 0, to), optionsFor(_reqKey(cid), qty, hubValue), false).nativeFee;
    }
    function _reqKey(bytes32 cid) internal view returns (uint8) { return IOmniDrop(dropOf[cid]).copyMode() == MODE_BATCHED ? G_REQUEST_BATCHED : REQUEST; }
    function _batched(bytes32 cid) internal view returns (bool) { return IOmniDrop(dropOf[cid]).copyMode() == MODE_BATCHED; }

    /// @notice HUB chain, BATCHED: the per-mint copy-pool share for `qty` ids = (cost of one full batch of K ids to every
    ///         other chain) / K * qty, plus `shareBufferBps`. The real flush usually costs less (fewer ranges, origin chains
    ///         skipped), so the pool runs a surplus that reimburses flushers; the final leftover goes to the MultiSea fee wallet.
    function quoteBatchShare(bytes32 cid, uint256 qty) public view returns (uint256) {
        IOmniDrop d = IOmniDrop(dropOf[cid]);
        uint256 k = d.batchK();
        uint256[] memory r = new uint256[](QUOTE_RANGES);
        bytes memory pl = abi.encode(BATCH, cid, r);
        bytes memory o = optionsFor(BATCH, k, 0);
        uint32[] memory all = d.eids(); uint32 hub = endpoint.eid(); uint256 sum;
        for (uint256 i; i < all.length; ++i) if (all[i] != hub) sum += _quote(all[i], pl, o, false).nativeFee;
        return (sum * qty * (10_000 + shareBufferBps)) / (k * 10_000);
    }
    /// @notice HUB chain: hub-native value a REQUEST from `originEid` must carry (before the UI's own buffer):
    ///         BATCHED = the CONFIRM leg + the copy-pool share; AT_MINT = the full fan-out.
    function quoteHubValue(bytes32 cid, uint32 originEid, uint256 qty) external view returns (uint256) {
        if (!_batched(cid)) return quoteFanout(cid, originEid, qty);
        bytes memory pl = _payload(CONFIRM, cid, 0, 1, qty, address(0));
        return _quote(originEid, pl, _opts(pl), false).nativeFee + quoteBatchShare(cid, qty);
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
        _sendExact(cid, IOmniDrop(msg.sender).hubEid(), _payload(REQUEST, cid, rid, qty, phaseId, to), optionsFor(_reqKey(cid), qty, hubValue), 0, refund);
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

    // ------------------------------------------------------------------ BATCHED copies (hub)
    /// @notice Hub-local mint in BATCHED mode: take the copy-pool share, queue [start, start+qty) for every other chain and,
    ///         if a flush is due and the pool covers it, flush in the same tx (best effort, no tip). Excess is refunded.
    function queueCopies(bytes32 cid, uint256 start, uint256 qty, address refund) external payable onlyDrop(cid) nonReentrant {
        uint256 share = quoteBatchShare(cid, qty);
        if (msg.value < share) revert InsufficientFee(share, msg.value);
        _fund(cid, share);
        _enqueue(cid, endpoint.eid(), start, qty, share);
        if (msg.value > share) _pay(refund, msg.value - share);
        if (_ready(cid)) {
            (, uint256 need) = _plan(cid);
            if (need <= poolOf[cid]) _flush(cid, address(0), 0);
        }
    }

    /// @notice Permissionless: send every queued range (up to MAX_FLUSH_IDS ids) to each other chain in ONE message per
    ///         chain, paid from the drop's copy pool. msg.value tops up the pool. The caller is reimbursed its gas (capped
    ///         at maxTipGasPrice) from what the pool has left after the LayerZero fees.
    function flush(bytes32 cid) external payable nonReentrant {
        uint256 g0 = gasleft();
        if (dropOf[cid] == address(0)) revert UnknownCollection(cid);
        if (queueOf[cid].ids == 0) revert NothingQueued();
        if (!_ready(cid)) revert NotReady();
        if (msg.value > 0) _fund(cid, msg.value);
        _flush(cid, msg.sender, g0);
    }

    /// @notice Anyone can add to a drop's copy pool (e.g. if LayerZero quotes rose above what the shares collected).
    function fundPool(bytes32 cid) external payable { if (dropOf[cid] == address(0)) revert UnknownCollection(cid); _fund(cid, msg.value); }

    /// @notice Decision M3b: once every copy has been sent, the pool's true leftover goes to the MultiSea fee wallet that the
    ///         factory configured for this drop (`drop.feeWallet()`). Only `poolOf[cid]` can be swept, never other drops'
    ///         pools or minters' `refundOf` balances. It requires an empty queue and closed minting. After a sell-out no
    ///         request can queue again (they are rejected), so the sweep is immediate. After a phase-end close it waits
    ///         SWEEP_GRACE after the last queued range, so a REQUEST still in flight can't find its batch unfunded. The
    ///         money moves escrow -> fee wallet directly; it never enters the drop, so withdraw()'s 0.5% is not applied to it
    ///         and the creator is not charged twice.
    function sweepPool(bytes32 cid) external nonReentrant {
        IOmniDrop d = IOmniDrop(dropOf[cid]);
        if (address(d) == address(0)) revert UnknownCollection(cid);
        if (queueOf[cid].ids != 0 || !d.mintClosed()) revert NotClosed();
        bool soldOut = d.totalAssigned() >= d.maxSupply();
        if (!soldOut && block.timestamp < uint256(lastQueuedAt[cid]) + SWEEP_GRACE) revert NotClosed();
        uint256 v = poolOf[cid]; poolOf[cid] = 0; totalPools -= v;
        address to = d.feeWallet();
        if (v > 0) _pay(to, v);
        if (address(this).balance < totalPools + totalRefunds) revert Underfunded(); // other pools + refunds stay covered
        emit PoolSwept(cid, to, v);
    }

    /// @notice A flush is due when K ids are queued, T seconds passed since the oldest queued range, or minting closed.
    function flushReady(bytes32 cid) external view returns (bool) { return queueOf[cid].ids != 0 && _ready(cid); }
    /// @notice LayerZero cost of flushing now (what the pool must cover) and how many ids that flush carries.
    function quoteFlush(bytes32 cid) external view returns (uint256 ids, uint256 fees) { return _plan(cid); }

    function _fund(bytes32 cid, uint256 v) internal { poolOf[cid] += v; totalPools += v; emit PoolFunded(cid, msg.sender, v); }

    function _enqueue(bytes32 cid, uint32 origin, uint256 start, uint256 qty, uint256 share) internal {
        Queue storage q = queueOf[cid];
        if (q.ids == 0) q.oldest = uint64(block.timestamp);
        lastQueuedAt[cid] = uint64(block.timestamp);
        rangeAt[cid][q.tail++] = (uint256(origin) << 104) | (uint256(uint40(block.timestamp)) << 64) | (start << 32) | qty;
        q.ids += uint32(qty);
        emit CopiesQueued(cid, origin, start, qty, share, q.ids);
    }

    function _ready(bytes32 cid) internal view returns (bool) {
        IOmniDrop d = IOmniDrop(dropOf[cid]);
        Queue memory q = queueOf[cid];
        return q.ids >= d.batchK() || block.timestamp >= uint256(q.oldest) + d.batchT() || d.mintClosed();
    }

    /// @dev Which ranges the next flush takes ([head, end)), and the payload for chain `dst` (ranges minted on `dst` are
    ///      skipped: the token is Active there already).
    function _take(bytes32 cid) internal view returns (uint256 end, uint256 ids) {
        Queue memory q = queueOf[cid];
        end = q.head;
        while (end < q.tail) {
            uint256 n = rangeAt[cid][end] & 0xffffffff;
            if (ids != 0 && ids + n > MAX_FLUSH_IDS) break;
            ids += n; ++end;
        }
    }
    function _batchFor(bytes32 cid, uint32 dst, uint256 end) internal view returns (bytes memory pl, uint256 ids) {
        uint256 head = queueOf[cid].head; uint256 n;
        uint256[] memory r = new uint256[](end - head);
        for (uint256 i = head; i < end; ++i) {
            uint256 v = rangeAt[cid][i];
            if (uint32(v >> 104) == dst) continue;
            r[n++] = v & 0xffffffffffffffff; ids += v & 0xffffffff; // start << 32 | qty
        }
        assembly { mstore(r, n) }
        if (n > 0) pl = abi.encode(BATCH, cid, r);
    }
    function _plan(bytes32 cid) internal view returns (uint256 ids, uint256 fees) {
        uint256 end; (end, ids) = _take(cid);
        uint32[] memory all = IOmniDrop(dropOf[cid]).eids(); uint32 hub = endpoint.eid();
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == hub) continue;
            (bytes memory pl, uint256 n) = _batchFor(cid, all[i], end);
            if (n > 0) fees += _quote(all[i], pl, optionsFor(BATCH, n, 0), false).nativeFee;
        }
    }

    function _flush(bytes32 cid, address flusher, uint256 g0) internal {
        (uint256 end, uint256 ids) = _take(cid);
        uint32[] memory all = IOmniDrop(dropOf[cid]).eids(); uint32 hub = endpoint.eid();
        uint256 fees;
        for (uint256 i; i < all.length; ++i) {
            if (all[i] == hub) continue;
            (bytes memory pl, uint256 n) = _batchFor(cid, all[i], end);
            if (n == 0) continue;
            bytes memory o = optionsFor(BATCH, n, 0);
            uint256 fee = _quote(all[i], pl, o, false).nativeFee;
            fees += fee;
            if (fees > poolOf[cid]) revert InsufficientPool(fees, poolOf[cid]);
            MessagingReceipt memory r = _lzSend(all[i], pl, o, MessagingFee(fee, 0), payable(address(this)));
            emit Sent(r.guid, cid, BATCH, all[i], ids, n, address(0));
        }
        Queue storage q = queueOf[cid];
        uint256 ranges = end - q.head;
        for (uint256 i = q.head; i < end; ++i) delete rangeAt[cid][i];
        q.head = uint32(end); q.ids -= uint32(ids);
        q.oldest = q.ids == 0 ? 0 : uint64(uint40(rangeAt[cid][end] >> 64));
        poolOf[cid] -= fees; totalPools -= fees;
        uint256 tip;
        if (flusher != address(0)) {
            uint256 gp = tx.gasprice < maxTipGasPrice ? tx.gasprice : maxTipGasPrice;
            tip = (g0 - gasleft() + 40_000) * gp;
            if (tip > poolOf[cid]) tip = poolOf[cid];
            if (tip > 0) { poolOf[cid] -= tip; totalPools -= tip; _pay(flusher, tip); }
        }
        emit Flushed(cid, flusher, ids, ranges, fees, tip);
    }

    function claimRefund(address who) external nonReentrant {
        uint256 v = refundOf[who]; refundOf[who] = 0; totalRefunds -= v; if (v > 0) _pay(who, v);
    }

    // --------------------------------------------------------------- receive
    /// @dev Only the endpoint calls this and OAppReceiver rejects senders that are not the configured peer escrow.
    ///      Reverts (unknown collection) keep the message retryable in LayerZero.
    function _lzReceive(Origin calldata o, bytes32 guid, bytes calldata m, address, bytes calldata) internal override nonReentrant {
        _dispatch(o.srcEid, guid, m);
    }
    function _dispatch(uint32 src, bytes32 guid, bytes calldata m) internal {
        if (uint8(m[31]) == BATCH) return _batchIn(src, guid, m);
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

    /// @dev BATCH: mint every range into escrow here (copyIn skips ids that already exist, e.g. moved here before the batch).
    function _batchIn(uint32 src, bytes32 guid, bytes calldata m) internal {
        (, bytes32 cid, uint256[] memory r) = abi.decode(m, (uint8, bytes32, uint256[]));
        address drop = dropOf[cid];
        if (drop == address(0)) revert UnknownCollection(cid);
        emit Received(guid, cid, BATCH, src);
        for (uint256 i; i < r.length; ++i) IOmniDrop(drop).copyIn(r[i] >> 32, r[i] & 0xffffffff);
    }

    /// @dev HUB: assign ids [start, start+qty) (or reject), then fan out CONFIRM/REJECT + COPY legs paid from the native drop.
    ///      Legs the budget cannot cover are recorded as OWED (retryLeg) instead of reverting, so ids already assigned are
    ///      never lost and the request is never processed twice.
    function _hubRequest(uint32 src, address drop, bytes calldata m) internal {
        (, bytes32 cid, uint256 rid, uint256 qty, uint256 phaseId, address to) = _decode(m);
        (uint256 start, uint8 reason) = IOmniDrop(drop).hubAssign(src, to, qty, phaseId);
        if (IOmniDrop(drop).copyMode() == MODE_BATCHED) return _hubRequestBatched(src, cid, to, rid, start, qty, reason);
        (uint32[] memory dst, bytes[] memory pl) = _legs(cid, src, start, qty, rid, reason);
        uint256 budget = msg.value; // native drop paid by the minter on the origin chain
        for (uint256 i; i < dst.length; ++i) {
            uint256 fee = _quote(dst[i], pl[i], _opts(pl[i]), false).nativeFee;
            if (fee <= budget) { budget -= fee; _sendPaid(cid, dst[i], pl[i], fee); }
            else { owed[keccak256(abi.encode(dst[i], pl[i]))] = true; emit LegOwed(dst[i], pl[i], fee); }
        }
        if (budget > 0) { refundOf[to] += budget; totalRefunds += budget; } // unspent buffer: the minter can claim it on the hub chain
    }

    /// @dev BATCHED: send CONFIRM (or REJECT) straight back to the origin so the minter's NFT is Active right away, put the
    ///      copy-pool share in the pool and queue the copies. A leg the budget can't pay is OWED (retryLeg), as above.
    function _hubRequestBatched(uint32 src, bytes32 cid, address to, uint256 rid, uint256 start, uint256 qty, uint8 reason) internal {
        bytes memory pl = start == 0 ? _payload(REJECT, cid, rid, reason, 0, address(0)) : _payload(CONFIRM, cid, rid, start, qty, address(0));
        uint256 budget = msg.value;
        uint256 fee = _quote(src, pl, _opts(pl), false).nativeFee;
        if (fee <= budget) { budget -= fee; _sendPaid(cid, src, pl, fee); }
        else { owed[keccak256(abi.encode(src, pl))] = true; emit LegOwed(src, pl, fee); }
        if (start != 0) {
            uint256 share = quoteBatchShare(cid, qty);
            if (share > budget) share = budget; // under-funded: the pool can be topped up (fundPool / flush{value})
            if (share > 0) { _fund(cid, share); budget -= share; }
            _enqueue(cid, src, start, qty, share);
        }
        if (budget > 0) { refundOf[to] += budget; totalRefunds += budget; }
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
    ///      only balances kept here between transactions are `refundOf` (claimable by minters) and the per-drop copy pools.
    function _payNative(uint256 _nativeFee) internal pure override returns (uint256) { return _nativeFee; }

    function _pay(address to, uint256 amount) internal { (bool ok,) = payable(to).call{ value: amount }(""); if (!ok) revert PayFailed(); }

    receive() external payable {} // LayerZero refunds of over-quoted hub sends

    // ----------------------------------------------------------------- admin (timelock)
    function setFactory(address f) external onlyOwner { if (factory != address(0)) revert FactorySet(); if (f == address(0)) revert ZeroAddress(); factory = f; }
    function setMoveFee(address w, uint256 fee) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; moveFee = fee; }
    function setGas(uint8 kind, uint64 base, uint64 perId) external onlyOwner { gasOf[kind] = Gas(base, perId); }
    function setBatchParams(uint16 bufferBps, uint256 tipGasPrice) external onlyOwner { if (bufferBps > 10_000) revert BadBuffer(); shareBufferBps = bufferBps; maxTipGasPrice = tipGasPrice; }
}
