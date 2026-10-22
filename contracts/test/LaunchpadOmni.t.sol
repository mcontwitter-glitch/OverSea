// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaOmniDrop } from "../src/launchpad/MultiSeaOmniDrop.sol";
import { MultiSeaOmniEscrow } from "../src/launchpad/MultiSeaOmniEscrow.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";

/// Multichain (escrow) launchpad drops on 4 mock LayerZero endpoints. A is the HUB (stands for Base); B, C, D stand for
/// ApeChain, BNB and Robinhood. AT_MINT copy mode (creator-selectable alternative). Minting id X on one chain makes X Active there and mints X into escrow on the other three.
contract LaunchpadOmniTest is TestHelperOz5 {
    uint32 constant A = 1; uint32 constant B = 2; uint32 constant C = 3; uint32 constant D = 4;
    uint256 constant N = 4;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1); address bob = address(0xB0B); address carol = address(0xCA401);
    uint256 apk = 0xA11CE; address approver;
    bytes32 constant CID = keccak256("lil-foots-omni");
    uint256 constant MOVE_FEE = 0.0001 ether;
    uint32 constant SUPPLY = 10;
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
        for (uint256 i; i < N; ++i) drop[E[i]] = deploy(E[i], params());
        vm.deal(alice, 1000 ether); vm.deal(bob, 1000 ether); vm.deal(carol, 1000 ether); vm.deal(address(this), 1000 ether); // test = mock executor
    }

    function params() internal view returns (MultiSeaOmniDrop.OmniInit memory p) {
        p.name = "LIL FOOTS"; p.symbol = "FOOT"; p.owner = creator; p.payout = creator; p.maxSupply = SUPPLY;
        p.royaltyReceiver = creator; p.royaltyBps = 500; p.baseURI = "ipfs://bafyFINAL/";
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 0, bytes32(0));
        p.eids = new uint32[](4); p.eids[0] = A; p.eids[1] = B; p.eids[2] = C; p.eids[3] = D; p.hubEid = A;
        p.prices = new uint128[](4); p.prices[0] = 0.003 ether; p.prices[1] = 12 ether; p.prices[2] = 0.012 ether; p.prices[3] = 0.003 ether;
        p.copyMode = 1; // this suite covers the AT_MINT alternative (copies sent at each mint); BATCHED: LaunchpadOmniBatch.t.sol
    }
    /// Mirrors MultiSeaLaunchpadFactory.omniConfigHash (fee fields zeroed). createOmniDrop succeeding proves they agree.
    function cfg(MultiSeaOmniDrop.OmniInit memory p) public pure returns (bytes32) { p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p)); }
    function deploy(uint32 e, MultiSeaOmniDrop.OmniInit memory p) internal returns (MultiSeaOmniDrop) {
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].omniDigest(p.owner, cfg(p), CID, dl));
        vm.prank(address(0xDE91)); // anyone may submit; the owner is fixed by the signed config
        return MultiSeaOmniDrop(fac[e].createOmniDrop(p, CID, dl, abi.encodePacked(r, s, v)));
    }

    // ---------------------------------------------------------------- helpers
    function hubValue(uint32 origin, uint256 q) internal view returns (uint128) { return uint128(esc[A].quoteFanout(CID, origin, q) * 11 / 10); } // +10% buffer
    /// Mint on chain e. Hub: instant. Other chains: sends the REQUEST only (not delivered yet).
    function mint(uint32 e, address who, uint256 q) internal {
        uint128 hv = e == A ? 0 : hubValue(e, q);
        (uint256 price, uint256 lz) = drop[e].quoteMint(0, q, who, hv);
        vm.prank(who); drop[e].mint{ value: price + lz }(who, 0, q, new bytes32[](0), hv);
    }
    function deliver(uint32 e) internal { verifyPackets(e, addressToBytes32(address(esc[e]))); }
    function deliverAll() internal { deliver(A); deliver(B); deliver(C); deliver(D); deliver(B); deliver(C); deliver(D); }
    function move(uint32 from, uint32 to, address who, uint256 id) internal {
        (uint256 pf, uint256 lz) = esc[from].quoteMove(CID, to, id, who);
        vm.prank(who); drop[from].moveTo{ value: pf + lz }(to, id, who);
        deliver(to);
    }
    function activeCount(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < N; ++i) if (drop[E[i]].isActiveHere(id)) ++n; }
    function copies(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < N; ++i) if (drop[E[i]].existsHere(id)) ++n; }
    function escrowed(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < N; ++i) if (drop[E[i]].existsHere(id) && drop[E[i]].ownerOf(id) == address(esc[E[i]])) ++n; }

    // ---------------------------------------------------------------- tests
    function test_deploySameConfigEverywhere() public view {
        for (uint256 i; i < N; ++i) { assertEq(drop[E[i]].owner(), creator); assertEq(drop[E[i]].maxSupply(), SUPPLY); assertEq(drop[E[i]].hubEid(), A); assertEq(esc[E[i]].dropOf(CID), address(drop[E[i]])); }
        assertTrue(drop[A].isHub()); assertFalse(drop[B].isHub()); assertEq(drop[A].totalAssigned(), 0);
    }

    function test_hubMint_activeHere_escrowCopiesOnOtherChains() public {
        mint(A, alice, 2);
        assertEq(drop[A].ownerOf(1), alice); assertEq(drop[A].ownerOf(2), alice); assertEq(drop[A].totalAssigned(), 2);
        assertEq(copies(1), 1, "copies still in flight");
        deliver(B); deliver(C); deliver(D); // one COPY message per chain carries both ids
        for (uint256 id = 1; id <= 2; ++id) { assertEq(copies(id), 4); assertEq(activeCount(id), 1); assertEq(escrowed(id), 3); }
        assertEq(drop[B].ownerOf(1), address(esc[B])); assertEq(drop[D].ownerOf(2), address(esc[D]));
    }

    function test_remoteMint_twoStep_confirmThenCopies() public {
        mint(B, alice, 1); // pays 12 APE on B: held, nothing minted yet
        (, , , , MultiSeaOmniDrop.Req st, uint128 paid) = drop[B].requests(1);
        assertEq(uint8(st), uint8(MultiSeaOmniDrop.Req.Pending)); assertEq(paid, 12 ether); assertEq(drop[B].held(), 12 ether);
        assertEq(copies(1), 0);
        drop[B].withdraw(); assertEq(address(drop[B]).balance, 12 ether, "pending payment not withdrawable");
        deliver(A); // hub assigns id 1, mints its escrow copy, sends CONFIRM to B and COPY to C, D
        assertEq(drop[A].ownerOf(1), address(esc[A])); assertEq(drop[A].totalAssigned(), 1);
        deliver(B); assertEq(drop[B].ownerOf(1), alice, "Active on the chain the minter picked"); assertEq(drop[B].held(), 0);
        deliver(C); deliver(D);
        assertEq(copies(1), 4); assertEq(activeCount(1), 1); assertEq(escrowed(1), 3);
        drop[B].withdraw(); assertEq(FEE.balance, 12 ether * 50 / 10000);
    }

    function test_concurrentMintsOnDifferentChains_noCollision() public {
        // Three minters press Mint "at the same moment" on C, B and the hub; nothing has been delivered yet.
        mint(C, carol, 3); mint(B, bob, 3); mint(A, alice, 2);
        deliverAll();
        // hub-local mint got 1-2; requests were sequenced by the hub in delivery order: C 3-5, B 6-8
        for (uint256 id = 1; id <= 2; ++id) assertEq(drop[A].ownerOf(id), alice);
        for (uint256 id = 3; id <= 5; ++id) assertEq(drop[C].ownerOf(id), carol);
        for (uint256 id = 6; id <= 8; ++id) assertEq(drop[B].ownerOf(id), bob);
        for (uint256 id = 1; id <= 8; ++id) { assertEq(activeCount(id), 1, "one Active copy"); assertEq(copies(id), 4, "a copy on every chain"); }
        assertEq(drop[A].totalAssigned(), 8); assertEq(copies(9), 0);
    }

    function test_capRespected_rejectAndRefund() public {
        mint(A, alice, 6);
        mint(B, bob, 3); mint(C, carol, 3); // 12 requested for 4 left
        uint256 c0 = carol.balance;
        deliverAll();
        assertEq(drop[A].totalAssigned(), 9, "B got 7-9");
        for (uint256 id = 7; id <= 9; ++id) assertEq(drop[B].ownerOf(id), bob);
        (, , , , MultiSeaOmniDrop.Req st, ) = drop[C].requests(1);
        assertEq(uint8(st), uint8(MultiSeaOmniDrop.Req.Refunded));
        assertEq(carol.balance - c0, 0.036 ether, "price refunded on C"); assertEq(drop[C].held(), 0);
        for (uint256 id = 1; id <= 9; ++id) assertEq(activeCount(id), 1);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaOmniDrop.SoldOut.selector, 1));
        drop[A].mint{ value: 1 ether }(alice, 0, 2, new bytes32[](0), 0);
        mint(A, alice, 1); assertEq(drop[A].totalAssigned(), SUPPLY);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaOmniDrop.SoldOut.selector, 0));
        drop[A].mint{ value: 1 ether }(alice, 0, 1, new bytes32[](0), 0);
        mint(D, bob, 1); deliverAll(); // request after sell-out: rejected, refunded
        for (uint256 id = 1; id <= SUPPLY; ++id) { assertEq(activeCount(id), 1); assertEq(copies(id), 4); }
        assertEq(copies(11), 0);
    }

    function test_partialBroadcast_isRetryable_andNeverDoubleActive() public {
        // Underfunded native drop on the hub: enough for the CONFIRM leg only. COPY legs to C and D become OWED.
        uint256 confirmFee = esc[A].quoteFanout(CID, B, 1) - esc[A].quoteFanout(CID, A, 1) + esc[A].quoteFanout(CID, A, 1) / 3;
        uint128 hv = uint128(confirmFee);
        (uint256 price, uint256 lz) = drop[B].quoteMint(0, 1, alice, hv);
        vm.prank(alice); drop[B].mint{ value: price + lz }(alice, 0, 1, new bytes32[](0), hv);
        vm.recordLogs();
        deliver(A); deliver(B);
        assertEq(drop[B].ownerOf(1), alice);
        assertEq(copies(1), 2, "hub escrow + Active on B; C and D owed");
        bytes memory copyPl = abi.encode(uint8(5), CID, uint256(1), uint256(1), uint256(0), address(0));
        assertTrue(esc[A].owed(keccak256(abi.encode(C, copyPl)))); assertTrue(esc[A].owed(keccak256(abi.encode(D, copyPl))));
        // Before C's copy exists, alice moves the token B -> C: C materialises it straight to her (Active), B locks it.
        move(B, C, alice, 1);
        assertEq(drop[C].ownerOf(1), alice); assertEq(drop[B].ownerOf(1), address(esc[B])); assertEq(activeCount(1), 1);
        // Anyone resends the owed legs. The late COPY to C is a no-op (id exists), D gets its escrow copy.
        vm.deal(address(0xBEEF), 1 ether); vm.startPrank(address(0xBEEF));
        esc[A].retryLeg{ value: 0.1 ether }(C, copyPl); esc[A].retryLeg{ value: 0.1 ether }(D, copyPl);
        vm.expectRevert(MultiSeaOmniEscrow.NotOwed.selector); esc[A].retryLeg{ value: 0.1 ether }(D, copyPl);
        vm.stopPrank();
        deliver(C); deliver(D);
        assertEq(drop[C].ownerOf(1), alice, "late COPY did not touch the Active token");
        assertEq(drop[D].ownerOf(1), address(esc[D]));
        assertEq(copies(1), 4); assertEq(activeCount(1), 1);
    }

    function test_hubBufferRefundClaimable() public {
        uint128 hv = uint128(esc[A].quoteFanout(CID, B, 1) * 2); // 100% buffer
        (uint256 price, uint256 lz) = drop[B].quoteMint(0, 1, alice, hv);
        vm.prank(alice); drop[B].mint{ value: price + lz }(alice, 0, 1, new bytes32[](0), hv);
        deliver(A);
        uint256 r = esc[A].refundOf(alice); assertGt(r, 0);
        uint256 a0 = alice.balance; esc[A].claimRefund(alice); assertEq(alice.balance - a0, r);
    }

    function test_moveBetweenChains_lockAndRelease() public {
        mint(C, alice, 1); deliverAll(); // id 1 Active on C, escrow on A, B, D
        uint256 f0 = FEE.balance;
        move(C, A, alice, 1);
        assertEq(drop[C].ownerOf(1), address(esc[C]), "locked, not burned"); assertEq(drop[A].ownerOf(1), alice);
        assertEq(FEE.balance - f0, MOVE_FEE);
        move(A, D, alice, 1); assertEq(drop[D].ownerOf(1), alice); assertEq(drop[A].ownerOf(1), address(esc[A]));
        move(D, C, alice, 1); assertEq(drop[C].ownerOf(1), alice);
        assertEq(activeCount(1), 1); assertEq(copies(1), 4); assertEq(escrowed(1), 3);
        vm.prank(alice); drop[C].transferFrom(alice, bob, 1); assertEq(drop[C].ownerOf(1), bob);
    }

    function test_noDoubleActive_guards() public {
        mint(A, alice, 1); deliverAll();
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotEscrow.selector); drop[A].release(alice, 1);
        vm.prank(address(esc[A])); vm.expectRevert(MultiSeaOmniDrop.NotMovable.selector); drop[A].release(bob, 1); // Active here
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotEscrow.selector); drop[B].copyIn(1, 1);
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotEscrow.selector); drop[A].hubAssign(B, alice, 1, 0);
        vm.prank(address(esc[B])); vm.expectRevert(MultiSeaOmniDrop.BadParams.selector); drop[B].hubAssign(C, alice, 1, 0); // only the hub assigns
        // replayed / forged CONFIRM cannot mint a second Active copy
        mint(B, bob, 1); deliver(A); deliver(B);
        vm.prank(address(esc[B])); vm.expectRevert(MultiSeaOmniDrop.NotPending.selector); drop[B].confirmMint(1, 2);
        vm.prank(address(esc[B])); vm.expectRevert(MultiSeaOmniDrop.NotPending.selector); drop[B].rejectMint(1, 1);
        // non-endpoint callers cannot deliver messages
        vm.expectRevert(); esc[B].lzReceive(Origin(A, addressToBytes32(address(esc[A])), 1), bytes32(0), abi.encode(uint8(3), CID, uint256(1), uint256(1), uint256(1), address(0)), address(0), "");
        // a locked copy cannot be moved; the escrow cannot move
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotMovable.selector); drop[B].moveTo{ value: 1 ether }(C, 1, alice);
        vm.prank(address(esc[A])); vm.expectRevert(MultiSeaOmniDrop.NotMovable.selector); drop[A].moveTo(C, 1, alice);
        for (uint256 id = 1; id <= 2; ++id) assertEq(activeCount(id), 1);
    }

    function test_globalWalletLimitAtHub() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); p.phases[0].maxPerWallet = 2;
        bytes32 cid = keccak256("limited");
        MultiSeaOmniDrop[4] memory d;
        for (uint256 i; i < N; ++i) {
            uint256 dl = block.timestamp + 1 days;
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[E[i]].omniDigest(p.owner, cfg(p), cid, dl));
            d[i] = MultiSeaOmniDrop(fac[E[i]].createOmniDrop(p, cid, dl, abi.encodePacked(r, s, v)));
        }
        uint128 hv = uint128(esc[A].quoteFanout(cid, B, 2) * 2);
        (uint256 pr, uint256 lz) = d[1].quoteMint(0, 2, alice, hv);
        vm.prank(alice); d[1].mint{ value: pr + lz }(alice, 0, 2, new bytes32[](0), hv); // 2 on B (ok)
        (pr, lz) = d[2].quoteMint(0, 1, alice, hv);
        vm.prank(alice); d[2].mint{ value: pr + lz }(alice, 0, 1, new bytes32[](0), hv); // +1 on C: over the global limit
        deliverAll();
        assertEq(d[1].ownerOf(1), alice); (, , , , MultiSeaOmniDrop.Req st, ) = d[2].requests(1);
        assertEq(uint8(st), uint8(MultiSeaOmniDrop.Req.Refunded), "limit is global, not per chain");
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.WalletLimit.selector); d[0].mint{ value: 1 ether }(alice, 0, 1, new bytes32[](0), 0);
    }

    // fuzz: random interleaving of hub mints, remote requests, out-of-order deliveries and moves
    function step(uint8 op) internal {
        uint32 e = E[op % 4]; uint256 q = 1 + (op / 4) % 3;
        uint8 kind = (op / 12) % 4;
        if (kind < 2) {
            if (e == A) { if (drop[A].totalAssigned() + q <= SUPPLY) mint(A, alice, q); }
            else mint(e, bob, q);
        } else if (kind == 2) deliver(e);
        else { // move the first Active token we find on e somewhere else
            for (uint256 id = 1; id <= drop[A].totalAssigned(); ++id) if (drop[e].isActiveHere(id)) { address h = drop[e].ownerOf(id); move(e, E[(op / 48 + 1 + op % 4) % 4] == e ? E[(op % 4 + 1) % 4] : E[(op / 48 + 1 + op % 4) % 4], h, id); break; }
        }
    }
    function testFuzz_sharedSupplyInvariants(uint8[14] calldata ops) public {
        for (uint256 k; k < ops.length; ++k) {
            step(ops[k]);
            assertLe(drop[A].totalAssigned(), SUPPLY);
            for (uint256 id = 1; id <= SUPPLY; ++id) assertLe(activeCount(id), 1);
        }
        deliverAll(); deliverAll();
        uint256 t = drop[A].totalAssigned();
        for (uint256 id = 1; id <= t; ++id) { assertEq(activeCount(id), 1, "every assigned id Active exactly once"); assertEq(copies(id), 4); }
        for (uint256 id = t + 1; id <= SUPPLY + 1; ++id) assertEq(copies(id), 0, "unassigned ids exist nowhere");
        for (uint256 i; i < N; ++i) { assertEq(drop[E[i]].held(), 0); assertEq(drop[E[i]].pendingQty(), 0); }
    }

    function test_badParamsRejected() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); p.hubEid = 99; // hub not among the drop's chains
        uint256 dl = block.timestamp + 1 days; bytes32 cid = keccak256("bad");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[A].omniDigest(p.owner, cfg(p), cid, dl));
        vm.expectRevert(); fac[A].createOmniDrop(p, cid, dl, abi.encodePacked(r, s, v));
    }

    function test_approvalTamperAndReplay() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); uint256 dl = block.timestamp + 1 days; bytes32 cid = keccak256("x");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[A].omniDigest(p.owner, cfg(p), cid, dl));
        bytes memory sig = abi.encodePacked(r, s, v);
        p.maxSupply = 20; // creator tries to raise the shared supply
        vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); fac[A].createOmniDrop(p, cid, dl, sig);
        p = params(); fac[A].createOmniDrop(p, cid, dl, sig);
        vm.expectRevert(MultiSeaLaunchpadFactory.SaltUsed.selector); fac[A].createOmniDrop(p, cid, dl, sig);
        vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); fac[B].createOmniDrop(p, cid, dl, sig);
    }

    function test_feesAndRefunds() public {
        // hub mint: underpaying the fan-out reverts; overpaying refunds the excess
        (uint256 price, uint256 lz) = drop[A].quoteMint(0, 1, alice, 0);
        vm.prank(alice); vm.expectRevert(); drop[A].mint{ value: price + lz - 1 }(alice, 0, 1, new bytes32[](0), 0);
        uint256 a0 = alice.balance;
        vm.prank(alice); drop[A].mint{ value: price + lz + 1 ether }(alice, 0, 1, new bytes32[](0), 0);
        assertEq(a0 - alice.balance, price + lz, "excess refunded");
        deliverAll();
        (uint256 pf, uint256 mv) = esc[A].quoteMove(CID, B, 1, alice);
        vm.prank(alice); vm.expectRevert(); drop[A].moveTo{ value: pf + mv - 1 }(B, 1, alice);
        a0 = alice.balance; vm.prank(alice); drop[A].moveTo{ value: pf + mv + 1 ether }(B, 1, alice);
        assertEq(a0 - alice.balance, pf + mv);
    }

    /// AT_MINT config hash (the Worker cross-check vector for the default BATCHED config is in LaunchpadOmniBatch.t.sol).
    function test_omniConfigHashVector_atMint() public view {
        assertEq(cfg(params()), 0x38f6cc814ab373dcc1bee2df016bc9bb1a4add76f2737607739e3f8ef8fb937f);
    }
}
