// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { Vm } from "forge-std/Vm.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaOmniDrop } from "../src/launchpad/MultiSeaOmniDrop.sol";
import { MultiSeaOmniEscrow } from "../src/launchpad/MultiSeaOmniEscrow.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";

/// BATCHED copy mode (the default for multichain drops). A is the HUB (Base); B, C, D are other chains.
/// Minting id X makes X Active on the minter's chain right away (hub: same tx; elsewhere: CONFIRM straight back from the
/// hub). The escrow copies on the other chains are QUEUED on the hub and flushed in batches: one message per chain.
contract LaunchpadOmniBatchTest is TestHelperOz5 {
    uint32 constant A = 1; uint32 constant B = 2; uint32 constant C = 3; uint32 constant D = 4;
    uint256 constant N = 4;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1); address bob = address(0xB0B); address carol = address(0xCA401);
    address flusher = address(0xF1F1);
    uint256 apk = 0xA11CE; address approver;
    bytes32 constant CID = keccak256("lil-foots-batched");
    uint256 constant MOVE_FEE = 0.0001 ether;
    uint32 constant SUPPLY = 30;
    uint16 constant K = 10;
    uint32 constant T = 30 minutes;
    mapping(uint32 => MultiSeaOmniEscrow) esc;
    mapping(uint32 => MultiSeaLaunchpadFactory) fac;
    mapping(uint32 => MultiSeaOmniDrop) drop;
    uint32[4] E = [A, B, C, D];

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(4, LibraryType.UltraLightNode);
        approver = vm.addr(apk);
        for (uint256 i; i < N; ++i) {
            uint32 e = E[i];
            esc[e] = new MultiSeaOmniEscrow(address(endpoints[e]), timelock, FEE, MOVE_FEE);
            fac[e] = new MultiSeaLaunchpadFactory(timelock, address(new MultiSeaDrop()), FEE, approver, 50);
            address impl = address(new MultiSeaOmniDrop());
            vm.startPrank(timelock); esc[e].setFactory(address(fac[e])); fac[e].setOmni(impl, address(esc[e])); vm.stopPrank();
        }
        for (uint256 i; i < N; ++i) for (uint256 j; j < N; ++j) if (i != j) { vm.prank(timelock); esc[E[i]].setPeer(E[j], addressToBytes32(address(esc[E[j]]))); }
        for (uint256 i; i < N; ++i) drop[E[i]] = deploy(E[i], params(), CID);
        vm.deal(alice, 1000 ether); vm.deal(bob, 1000 ether); vm.deal(carol, 1000 ether); vm.deal(flusher, 1 ether);
        vm.deal(address(this), 1000 ether); // test = mock executor (pays native drops)
    }

    function params() internal view returns (MultiSeaOmniDrop.OmniInit memory p) {
        p.name = "LIL FOOTS"; p.symbol = "FOOT"; p.owner = creator; p.payout = creator; p.maxSupply = SUPPLY;
        p.royaltyReceiver = creator; p.royaltyBps = 500; p.baseURI = "ipfs://bafyFINAL/";
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 0, bytes32(0));
        p.eids = new uint32[](4); p.eids[0] = A; p.eids[1] = B; p.eids[2] = C; p.eids[3] = D; p.hubEid = A;
        p.prices = new uint128[](4); p.prices[0] = 0.003 ether; p.prices[1] = 12 ether; p.prices[2] = 0.012 ether; p.prices[3] = 0.003 ether;
        p.copyMode = 0; p.batchK = K; p.batchT = T; // BATCHED (default)
    }
    function cfg(MultiSeaOmniDrop.OmniInit memory p) public pure returns (bytes32) { p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p)); }
    function deploy(uint32 e, MultiSeaOmniDrop.OmniInit memory p, bytes32 cid) internal returns (MultiSeaOmniDrop) {
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].omniDigest(p.owner, cfg(p), cid, dl));
        return MultiSeaOmniDrop(fac[e].createOmniDrop(p, cid, dl, abi.encodePacked(r, s, v)));
    }

    // ---------------------------------------------------------------- helpers
    function hubValue(uint32 origin, uint256 q) internal view returns (uint128) { return uint128(esc[A].quoteHubValue(CID, origin, q) * 11 / 10); }
    function mint(uint32 e, address who, uint256 q) internal {
        uint128 hv = e == A ? 0 : hubValue(e, q);
        (uint256 price, uint256 lz) = drop[e].quoteMint(0, q, who, hv);
        vm.prank(who); drop[e].mint{ value: price + lz }(who, 0, q, new bytes32[](0), hv);
    }
    function deliver(uint32 e) internal { verifyPackets(e, addressToBytes32(address(esc[e]))); }
    function deliverAll() internal { deliver(A); deliver(B); deliver(C); deliver(D); }
    function move(uint32 from, uint32 to, address who, uint256 id) internal {
        (uint256 pf, uint256 lz) = esc[from].quoteMove(CID, to, id, who);
        vm.prank(who); drop[from].moveTo{ value: pf + lz }(to, id, who);
        deliver(to);
    }
    function queued() internal view returns (uint256 ids) { (, ids, , ) = esc[A].queueOf(CID); }
    function activeCount(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < N; ++i) if (drop[E[i]].isActiveHere(id)) ++n; }
    function copies(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < N; ++i) if (drop[E[i]].existsHere(id)) ++n; }
    function batchSends() internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Sent(bytes32,bytes32,uint8,uint32,uint256,uint256,address)");
        for (uint256 i; i < logs.length; ++i) if (logs[i].topics[0] == sig && logs[i].emitter == address(esc[A])) {
            (uint8 k, , , , ) = abi.decode(logs[i].data, (uint8, uint32, uint256, uint256, address));
            if (k == 6) ++n;
        }
    }

    // ---------------------------------------------------------------- tests
    function test_hubMint_activeNow_copiesQueued() public {
        mint(A, alice, 2);
        assertEq(drop[A].ownerOf(1), alice, "Active on Base in the mint tx"); assertEq(drop[A].copyMode(), 0);
        assertEq(queued(), 2); assertGt(esc[A].poolOf(CID), 0, "pool share collected");
        assertEq(esc[A].poolOf(CID), esc[A].quoteBatchShare(CID, 2));
        deliverAll(); assertEq(copies(1), 1, "nothing sent at mint");
        assertFalse(esc[A].flushReady(CID));
        vm.expectRevert(MultiSeaOmniEscrow.NotReady.selector); esc[A].flush(CID);
    }

    function test_remoteMint_confirmImmediately_copiesQueued() public {
        mint(B, bob, 1);
        deliver(A); // hub assigns 1, mints its escrow copy, CONFIRMs to B now, queues copies for C and D
        assertEq(drop[A].ownerOf(1), address(esc[A])); assertEq(queued(), 1);
        deliver(B); assertEq(drop[B].ownerOf(1), bob, "Active on B without waiting for the batch");
        deliver(C); deliver(D); assertEq(copies(1), 2, "C/D copies still queued");
        assertEq(drop[B].held(), 0);
    }

    function test_Ktrigger_hubMintAutoFlushes_oneMessagePerChain() public {
        mint(A, alice, 4); mint(B, bob, 3); deliver(A); deliver(B); // 7 queued
        assertFalse(esc[A].flushReady(CID));
        vm.recordLogs();
        mint(A, carol, 3); // 10 queued == K: this hub mint flushes in the same tx
        assertEq(batchSends(), 3, "one BATCH message per other chain");
        assertEq(queued(), 0);
        deliverAll();
        for (uint256 id = 1; id <= 10; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); }
        for (uint256 id = 5; id <= 7; ++id) assertEq(drop[B].ownerOf(id), bob, "B's own ids were not copied over its Active tokens");
        assertEq(drop[C].ownerOf(5), address(esc[C]));
    }

    function test_Ktrigger_permissionlessFlush_reimbursesFlusher() public {
        mint(B, bob, 4); mint(C, carol, 4); mint(D, bob, 3); deliver(A); // 11 queued from remote mints (no auto-flush)
        assertTrue(esc[A].flushReady(CID));
        uint256 p0 = esc[A].poolOf(CID); (, uint256 fees) = esc[A].quoteFlush(CID);
        assertLt(fees, p0, "shares cover the batch");
        vm.txGasPrice(0.01 gwei);
        uint256 f0 = flusher.balance;
        vm.prank(flusher); esc[A].flush(CID);
        uint256 tip = flusher.balance - f0;
        assertGt(tip, 0, "flusher reimbursed"); assertLt(tip, 0.0001 ether);
        assertEq(esc[A].poolOf(CID), p0 - fees - tip); assertEq(esc[A].totalPools(), esc[A].poolOf(CID));
        vm.expectRevert(MultiSeaOmniEscrow.NothingQueued.selector); esc[A].flush(CID);
        deliverAll();
        for (uint256 id = 1; id <= 11; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); }
        assertEq(FEE.balance, 0, "no MultiSea fee taken from the pool");
    }

    function test_Ttrigger_flushAfterOldest() public {
        mint(A, alice, 5); mint(B, bob, 3); deliver(A); deliver(B); // 8 < K queued
        vm.warp(block.timestamp + T - 1);
        assertFalse(esc[A].flushReady(CID));
        vm.expectRevert(MultiSeaOmniEscrow.NotReady.selector); esc[A].flush(CID);
        vm.warp(block.timestamp + 1);
        assertTrue(esc[A].flushReady(CID), "T after the oldest queued range");
        // a partial batch costs more per id than the K-sized batch the shares were priced on: the pool's surplus from
        // earlier batches covers the difference; here (first batch, no surplus yet) the flusher adds the shortfall.
        (, uint256 fees) = esc[A].quoteFlush(CID); uint256 pool = esc[A].poolOf(CID);
        assertGt(pool, fees / 2);
        vm.prank(flusher); esc[A].flush{ value: fees > pool ? fees - pool : 0 }(CID);
        deliverAll();
        for (uint256 id = 1; id <= 8; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); }
        (uint64 oldest, , , ) = esc[A].queueOf(CID); assertEq(oldest, 0);
        // a single late mint: T passes, but one share can't pay a whole message per chain. The flush waits (reverts)
        // until more mints arrive or anyone tops the pool up; the token itself was Active from the start.
        mint(A, carol, 1); vm.warp(block.timestamp + T);
        (, fees) = esc[A].quoteFlush(CID); uint256 have = esc[A].poolOf(CID);
        if (fees > have) {
            vm.prank(flusher); vm.expectRevert(); esc[A].flush(CID);
            vm.prank(creator); vm.deal(creator, 1 ether); esc[A].fundPool{ value: fees - have }(CID);
        }
        vm.prank(flusher); esc[A].flush(CID); deliverAll(); assertEq(copies(9), 4);
    }

    function test_insufficientPool_flushReverts_untilToppedUp() public {
        // the minter's native drop covers the CONFIRM leg only: no share reaches the pool
        uint256 full = esc[A].quoteHubValue(CID, B, 1);
        uint128 hv = uint128(full - esc[A].quoteBatchShare(CID, 1));
        (uint256 price, uint256 lz) = drop[B].quoteMint(0, 1, alice, hv);
        vm.prank(alice); drop[B].mint{ value: price + lz }(alice, 0, 1, new bytes32[](0), hv);
        deliver(A); deliver(B);
        assertEq(drop[B].ownerOf(1), alice, "CONFIRM still sent"); assertEq(esc[A].poolOf(CID), 0); assertEq(queued(), 1);
        vm.warp(block.timestamp + T);
        (, uint256 fees) = esc[A].quoteFlush(CID);
        assertGt(fees, 0);
        vm.prank(flusher); vm.expectRevert(); esc[A].flush(CID); // InsufficientPool
        assertEq(esc[A].poolOf(CID), 0);
        assertEq(queued(), 1, "queue kept");
        vm.prank(flusher); esc[A].flush{ value: fees }(CID); // anyone may top up
        deliverAll(); assertEq(copies(1), 4); assertEq(activeCount(1), 1); assertEq(queued(), 0);
    }

    function test_moveOfQueuedId_materialisesOnArrival_lateBatchNoop() public {
        mint(A, alice, 1); // id 1 Active on Base, copies queued
        mint(B, bob, 1); deliver(A); deliver(B); // id 2 Active on B, copies queued
        move(A, C, alice, 1); // C has no copy yet: release materialises id 1 straight to alice
        move(B, D, bob, 2);
        assertEq(drop[C].ownerOf(1), alice); assertEq(drop[A].ownerOf(1), address(esc[A]), "locked, not burned");
        assertEq(drop[D].ownerOf(2), bob); assertEq(drop[B].ownerOf(2), address(esc[B]));
        assertEq(activeCount(1), 1); assertEq(activeCount(2), 1);
        vm.warp(block.timestamp + T); vm.prank(flusher); esc[A].flush{ value: 1 ether }(CID); deliverAll();
        assertEq(drop[C].ownerOf(1), alice, "late batch did not touch the Active token");
        assertEq(drop[D].ownerOf(2), bob);
        for (uint256 id = 1; id <= 2; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); }
        move(C, B, alice, 1); assertEq(drop[B].ownerOf(1), alice); assertEq(activeCount(1), 1);
    }

    function test_soldOut_rejectRefund_finalFlush_sweepToFeeWallet() public {
        mint(A, alice, 20); mint(A, alice, 7); // 27 assigned (auto-flushed at K)
        mint(B, bob, 3); mint(C, carol, 3); // 6 requested for 3 left: B first fits, C is rejected
        uint256 c0 = carol.balance;
        deliver(A); deliverAll();
        assertEq(drop[A].totalAssigned(), SUPPLY);
        (, , , , MultiSeaOmniDrop.Req st, ) = drop[C].requests(1);
        assertEq(uint8(st), uint8(MultiSeaOmniDrop.Req.Refunded)); assertEq(carol.balance - c0, 0.036 ether);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaOmniDrop.SoldOut.selector, 0));
        drop[A].mint{ value: 1 ether }(alice, 0, 1, new bytes32[](0), 0);
        assertTrue(drop[A].mintClosed());
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(CID); // copies still queued
        assertTrue(esc[A].flushReady(CID), "sold out: final batch is due now");
        vm.prank(flusher); esc[A].flush(CID); deliverAll();
        for (uint256 id = 1; id <= SUPPLY; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); }
        assertEq(copies(SUPPLY + 1), 0);
        uint256 left = esc[A].poolOf(CID); uint256 k0 = creator.balance; uint256 f0 = FEE.balance;
        assertGt(left, 0, "a leftover exists");
        vm.prank(flusher); esc[A].sweepPool(CID); // anyone may trigger it; the recipient is fixed
        assertEq(FEE.balance - f0, left, "leftover to the MultiSea fee wallet (M3b)");
        assertEq(creator.balance, k0, "creator gets nothing from the pool"); assertEq(esc[A].totalPools(), 0); assertEq(esc[A].poolOf(CID), 0);
        vm.expectRevert(); esc[A].sweepPool(keccak256("unknown"));
        esc[A].sweepPool(CID); assertEq(FEE.balance - f0, left, "second sweep pays nothing");
    }

    /// The sweep is separate from the drop's 0.5% withdraw fee: the creator's proceeds are charged exactly once.
    function test_sweep_separateFromWithdrawFee_noDoubleCharge() public {
        mint(A, alice, 20); mint(A, alice, 10); // sells out; the second mint completes the final batch
        assertEq(queued(), 0); assertTrue(drop[A].mintClosed());
        uint256 proceeds = address(drop[A]).balance; assertEq(proceeds, 30 * 0.003 ether, "pool share never sits in the drop");
        uint256 left = esc[A].poolOf(CID); uint256 f0 = FEE.balance; uint256 k0 = creator.balance;
        esc[A].sweepPool(CID);
        drop[A].withdraw();
        uint256 fee = proceeds * 50 / 10_000;
        assertEq(FEE.balance - f0, left + fee, "fee wallet: pool leftover + 0.5% of proceeds, nothing more");
        assertEq(creator.balance - k0, proceeds - fee, "creator: proceeds minus 0.5% exactly once");
    }

    /// Sweep only takes TRUE leftovers: not while copies are queued, not before minting closes, not during the grace period
    /// after a phase-end close (a REQUEST in flight can still queue), and never other drops' pools or minters' refunds.
    function test_sweep_cannotTouchPendingFunds() public {
        // a second drop whose only phase ends in 1 hour, on all 4 chains
        MultiSeaOmniDrop.OmniInit memory p = params(); p.phases[0].end = uint64(block.timestamp + 1 hours);
        bytes32 c2 = keccak256("ends-soon");
        MultiSeaOmniDrop[4] memory d2;
        for (uint256 i; i < N; ++i) d2[i] = deploy(E[i], p, c2);
        mint(A, alice, 2); // main drop: its pool must stay untouched
        uint256 mainPool = esc[A].poolOf(CID);
        // c2: a Base mint, plus a REQUEST from B with a big buffer (-> claimable refundOf) that is still in flight at close
        (uint256 pr, uint256 lz) = d2[0].quoteMint(0, 3, alice, 0);
        vm.prank(alice); d2[0].mint{ value: pr + lz }(alice, 0, 3, new bytes32[](0), 0);
        uint128 hv = uint128(esc[A].quoteHubValue(c2, B, 1) * 3);
        (pr, lz) = d2[1].quoteMint(0, 1, bob, hv);
        vm.prank(bob); d2[1].mint{ value: pr + lz }(bob, 0, 1, new bytes32[](0), hv);
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(c2); // minting open, copies queued
        vm.warp(block.timestamp + 2 hours); // phase over: mintClosed, final batch due
        assertTrue(d2[0].mintClosed());
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(c2); // copies still queued
        vm.prank(flusher); esc[A].flush{ value: 0.1 ether }(c2);
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(c2); // grace period after close
        deliver(A); // the late REQUEST lands after close: id 4 assigned, its copies queue, its buffer is refundable
        assertEq(d2[0].totalAssigned(), 4);
        (, uint256 q2, , ) = esc[A].queueOf(c2); assertEq(q2, 1);
        uint256 bobRefund = esc[A].refundOf(bob); assertGt(bobRefund, 0);
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(c2); // its copies are still owed
        vm.prank(flusher); esc[A].flush{ value: 0.1 ether }(c2);
        vm.warp(block.timestamp + 3 days - 1);
        vm.expectRevert(MultiSeaOmniEscrow.NotClosed.selector); esc[A].sweepPool(c2); // grace counts from the LAST queue
        vm.warp(block.timestamp + 1);
        uint256 left = esc[A].poolOf(c2); uint256 f0 = FEE.balance;
        esc[A].sweepPool(c2);
        assertEq(FEE.balance - f0, left);
        assertEq(esc[A].poolOf(CID), mainPool, "other drops' pools untouched");
        assertEq(esc[A].refundOf(bob), bobRefund, "minter refunds untouched");
        assertEq(esc[A].totalPools(), mainPool); assertEq(esc[A].totalRefunds(), bobRefund);
        assertGe(address(esc[A]).balance, esc[A].totalPools() + esc[A].totalRefunds(), "escrow still covers what it owes");
        uint256 b0 = bob.balance; esc[A].claimRefund(bob); assertEq(bob.balance - b0, bobRefund);
        deliver(B); deliver(C); deliver(D);
        for (uint256 id = 1; id <= 4; ++id) { uint256 n; for (uint256 i; i < N; ++i) if (d2[i].existsHere(id)) ++n; assertEq(n, 4, "every id has its 4 copies"); }
    }

    function deployExpectRevert(MultiSeaOmniDrop.OmniInit memory p, bytes32 cid) internal {
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[A].omniDigest(p.owner, cfg(p), cid, dl));
        vm.expectRevert(); fac[A].createOmniDrop(p, cid, dl, abi.encodePacked(r, s, v));
    }
    function test_atMintAlternativeStillSelectable_andBadBatchParams() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); p.copyMode = 1; p.batchK = 0; p.batchT = 0;
        MultiSeaOmniDrop d = deploy(A, p, keccak256("at-mint"));
        assertEq(d.copyMode(), 1);
        p = params(); p.batchK = 9; deployExpectRevert(p, keccak256("k"));
        p = params(); p.batchK = 201; deployExpectRevert(p, keccak256("k2"));
        p = params(); p.batchT = 299; deployExpectRevert(p, keccak256("t"));
        p = params(); p.batchT = 86_401; deployExpectRevert(p, keccak256("t2"));
        p = params(); p.copyMode = 2; deployExpectRevert(p, keccak256("m"));
        p = params(); p.batchK = 200; p.batchT = 24 hours; deploy(A, p, keccak256("max-ok"));
    }

    // fuzz: hub mints, remote requests, deliveries, moves and flush attempts in random order
    function step(uint8 op) internal {
        uint32 e = E[op % 4]; uint256 q = 1 + (op / 4) % 3;
        uint8 kind = (op / 12) % 5;
        if (kind < 2) {
            if (e == A) { if (drop[A].totalAssigned() + q <= SUPPLY) mint(A, alice, q); }
            else mint(e, bob, q);
        } else if (kind == 2) deliver(e);
        else if (kind == 3) {
            for (uint256 id = 1; id <= drop[A].totalAssigned(); ++id) if (drop[e].isActiveHere(id)) {
                uint32 to = E[(op % 4 + 1 + (op / 60) % 3) % 4]; move(e, to, drop[e].ownerOf(id), id); break;
            }
        } else { vm.warp(block.timestamp + T / 2); if (esc[A].flushReady(CID)) { (, uint256 f) = esc[A].quoteFlush(CID); if (f <= esc[A].poolOf(CID)) { vm.prank(flusher); esc[A].flush(CID); } } }
    }
    function testFuzz_batchedInvariants(uint8[16] calldata ops) public {
        for (uint256 k; k < ops.length; ++k) {
            step(ops[k]);
            assertLe(drop[A].totalAssigned(), SUPPLY);
            for (uint256 id = 1; id <= SUPPLY; ++id) assertLe(activeCount(id), 1, "never Active on two chains");
        }
        deliverAll(); deliverAll();
        vm.warp(block.timestamp + T);
        while (queued() > 0) { vm.prank(flusher); esc[A].flush{ value: 1 ether }(CID); }
        deliverAll();
        uint256 t = drop[A].totalAssigned();
        for (uint256 id = 1; id <= t; ++id) { assertEq(activeCount(id), 1, "every assigned id Active exactly once"); assertEq(copies(id), 4); }
        for (uint256 id = t + 1; id <= SUPPLY + 1; ++id) assertEq(copies(id), 0, "unassigned ids exist nowhere");
        for (uint256 i; i < N; ++i) { assertEq(drop[E[i]].held(), 0); assertEq(drop[E[i]].pendingQty(), 0); }
    }

    /// Cross-check vector for worker/test/launchpad.test.mjs (viem omniConfigHash must equal this). BATCHED, K=10, T=30 min.
    function test_omniConfigHashVector() public {
        bytes32 h = cfg(params()); emit log_named_bytes32("omniConfigHash", h);
        assertEq(h, 0x6115664fee8498b1e1533fc5c415bc3861629814e6238bf7074b227638197050);
    }
}
