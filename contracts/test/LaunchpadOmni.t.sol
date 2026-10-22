// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaOmniDrop } from "../src/launchpad/MultiSeaOmniDrop.sol";
import { MultiSeaOmniEscrow } from "../src/launchpad/MultiSeaOmniEscrow.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";

/// Multichain (escrow) launchpad drops on 3 mock LayerZero endpoints (A, B, C stand in for Base, ApeChain, BNB).
contract LaunchpadOmniTest is TestHelperOz5 {
    using OptionsBuilder for bytes;
    uint32 constant A = 1; uint32 constant B = 2; uint32 constant C = 3;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address keeper = address(0x4EE9);
    address alice = address(0xA1); address bob = address(0xB0B);
    uint256 apk = 0xA11CE; address approver;
    bytes32 constant CID = keccak256("lil-foots-omni");
    uint256 constant MOVE_FEE = 0.0001 ether;
    mapping(uint32 => MultiSeaOmniEscrow) esc;
    mapping(uint32 => MultiSeaLaunchpadFactory) fac;
    mapping(uint32 => MultiSeaOmniDrop) drop;
    bytes opts;
    uint32[3] E = [A, B, C];

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(3, LibraryType.UltraLightNode);
        approver = vm.addr(apk);
        for (uint256 i; i < 3; ++i) {
            uint32 e = E[i];
            esc[e] = new MultiSeaOmniEscrow(address(endpoints[e]), timelock, FEE, MOVE_FEE);
            fac[e] = new MultiSeaLaunchpadFactory(timelock, address(new MultiSeaDrop()), FEE, approver, 50);
            address impl = address(new MultiSeaOmniDrop());
            vm.startPrank(timelock); esc[e].setFactory(address(fac[e])); fac[e].setOmni(impl, address(esc[e])); vm.stopPrank();
        }
        for (uint256 i; i < 3; ++i) for (uint256 j; j < 3; ++j) if (i != j) { vm.prank(timelock); esc[E[i]].setPeer(E[j], addressToBytes32(address(esc[E[j]]))); }
        opts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(250_000, 0);
        for (uint256 i; i < 3; ++i) drop[E[i]] = deploy(E[i], params());
        vm.deal(alice, 100 ether); vm.deal(bob, 100 ether); vm.deal(creator, 100 ether); vm.deal(keeper, 100 ether);
    }

    /// 10 tokens shared: A owns ids 1-4, B 5-7, C 8-10.
    function params() internal view returns (MultiSeaOmniDrop.OmniInit memory p) {
        p.name = "LIL FOOTS"; p.symbol = "FOOT"; p.owner = creator; p.payout = creator; p.maxSupply = 10;
        p.royaltyReceiver = creator; p.royaltyBps = 500; p.baseURI = "ipfs://bafyFINAL/"; p.rebalancer = keeper;
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 0, bytes32(0));
        p.eids = new uint32[](3); p.eids[0] = A; p.eids[1] = B; p.eids[2] = C;
        p.allocEnd = new uint32[](3); p.allocEnd[0] = 5; p.allocEnd[1] = 8; p.allocEnd[2] = 11;
        p.prices = new uint128[](3); p.prices[0] = 0.003 ether; p.prices[1] = 12 ether; p.prices[2] = 0.012 ether; // ETH, APE, BNB
    }
    /// Mirrors MultiSeaLaunchpadFactory.omniConfigHash (fee fields zeroed); test_cfgHashMatchesFactory checks they agree.
    function cfg(MultiSeaLaunchpadFactory, MultiSeaOmniDrop.OmniInit memory p) public pure returns (bytes32) { p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p)); }
    function deploy(uint32 e, MultiSeaOmniDrop.OmniInit memory p) internal returns (MultiSeaOmniDrop) {
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].omniDigest(p.owner, cfg(fac[e], p), CID, dl));
        vm.prank(address(0xDE91)); // anyone may submit (e.g. MultiSea's deployer); owner is fixed by the signed config
        return MultiSeaOmniDrop(fac[e].createOmniDrop(p, CID, dl, abi.encodePacked(r, s, v)));
    }
    function mint(uint32 e, address who, uint256 q) internal { uint256 v = drop[e].priceOf(0) * q; vm.prank(who); drop[e].mint{ value: v }(who, 0, q, new bytes32[](0)); }
    function move(uint32 from, uint32 to, address who, uint256 id) internal {
        (uint256 pf, uint256 lz) = esc[from].quoteMove(CID, to, id, who, opts);
        vm.prank(who); drop[from].moveTo{ value: pf + lz }(to, id, who, opts);
        verifyPackets(to, addressToBytes32(address(esc[to])));
    }
    function activeCount(uint256 id) internal view returns (uint256 n) { for (uint256 i; i < 3; ++i) if (drop[E[i]].isActiveHere(id)) ++n; }
    function supplyLeft() internal view returns (uint256 n) { for (uint256 i; i < 3; ++i) n += drop[E[i]].available() + drop[E[i]].mintedHere(); }

    // ---------------------------------------------------------------- tests
    function test_deploySameConfigEverywhere() public view {
        for (uint256 i; i < 3; ++i) { assertEq(drop[E[i]].owner(), creator); assertEq(drop[E[i]].maxSupply(), 10); assertEq(esc[E[i]].dropOf(CID), address(drop[E[i]])); assertEq(drop[E[i]].platformFeeBps(), 50); }
        assertEq(drop[A].available(), 4); assertEq(drop[B].available(), 3); assertEq(drop[C].available(), 3);
        assertEq(supplyLeft(), 10);
    }

    function test_mintOnOneChainIsActiveOnlyThere() public {
        mint(B, alice, 2); // pays 24 APE on B
        assertEq(drop[B].ownerOf(5), alice); assertEq(drop[B].ownerOf(6), alice);
        assertEq(address(drop[B]).balance, 24 ether);
        assertTrue(drop[B].isActiveHere(5)); assertFalse(drop[A].isActiveHere(5)); assertFalse(drop[C].isActiveHere(5));
        assertEq(activeCount(5), 1);
        vm.expectRevert(); drop[A].ownerOf(5); // not materialised on A: virtually held by A's escrow
    }

    function test_lockOnSourceReleaseOnDestination_andBack() public {
        mint(B, alice, 1); // id 5 on B
        uint256 f0 = FEE.balance;
        move(B, A, alice, 5);
        assertEq(drop[B].ownerOf(5), address(esc[B]), "locked in B escrow, not burned");
        assertEq(drop[A].ownerOf(5), alice, "released (materialised) on A");
        assertEq(activeCount(5), 1);
        assertEq(FEE.balance - f0, MOVE_FEE);
        move(A, C, alice, 5);
        assertEq(drop[A].ownerOf(5), address(esc[A])); assertEq(drop[C].ownerOf(5), alice); assertEq(activeCount(5), 1);
        move(C, B, alice, 5); // back home: released from B's escrow (transfer, not mint)
        assertEq(drop[B].ownerOf(5), alice); assertEq(drop[C].ownerOf(5), address(esc[C])); assertEq(activeCount(5), 1);
        vm.prank(alice); drop[B].transferFrom(alice, bob, 5); assertEq(drop[B].ownerOf(5), bob); // normal ERC-721 when Active
    }

    function test_noDoubleActive() public {
        mint(A, alice, 1); // id 1 Active on A
        // A forged release for a token that is Active on this chain is impossible: only the escrow may call release,
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotEscrow.selector); drop[A].release(alice, 1);
        // and even the escrow cannot release a token that is Active here (it would create a second Active copy).
        vm.prank(address(esc[A])); vm.expectRevert(MultiSeaOmniDrop.NotMovable.selector); drop[A].release(bob, 1);
        // nor materialise an id that is still unminted in this chain's own pool (it was never minted anywhere).
        vm.prank(address(esc[B])); vm.expectRevert(abi.encodeWithSelector(MultiSeaOmniDrop.InLocalPool.selector, 6)); drop[B].release(bob, 6);
        // nor can a non-endpoint / non-peer deliver messages to the escrow.
        vm.expectRevert(); esc[B].lzReceive(origin(A, address(esc[A])), bytes32(0), abi.encode(uint8(1), CID, uint256(1), uint256(0), bob), address(0), "");
        // a locked token cannot be moved again from the chain where it is locked
        move(A, B, alice, 1);
        vm.prank(alice); vm.expectRevert(); drop[A].moveTo{ value: 1 ether }(C, 1, alice, opts);
        assertEq(activeCount(1), 1);
        // the escrow itself cannot be the mover
        vm.prank(address(esc[A])); vm.expectRevert(MultiSeaOmniDrop.NotMovable.selector); drop[A].moveTo(C, 1, alice, opts);
    }

    function test_noOversellAcrossChains() public {
        mint(A, alice, 4); mint(B, alice, 3); mint(C, bob, 3);
        for (uint256 i; i < 3; ++i) { uint32 e = E[i]; uint256 v = drop[e].priceOf(0); vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaOmniDrop.SoldOutHere.selector, uint32(0))); drop[e].mint{ value: v }(alice, 0, 1, new bytes32[](0)); }
        // every id 1..10 minted exactly once across all chains
        for (uint256 id = 1; id <= 10; ++id) assertEq(activeCount(id), 1);
        assertEq(supplyLeft(), 10);
    }

    function test_rebalanceDebitBeforeCredit() public {
        mint(A, alice, 4); // A sold out, C still has 3
        vm.prank(alice); vm.expectRevert(); drop[A].mint{ value: 0.003 ether }(alice, 0, 1, new bytes32[](0));
        uint256 lz = esc[C].quoteRange(CID, A, 9, 11, opts);
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDrop.NotOwner.selector); drop[C].rebalance{ value: lz }(A, 2, opts);
        vm.prank(keeper); drop[C].rebalance{ value: lz }(A, 2, opts); // moves unminted ids 9,10 from C to A
        // in flight: removed from C, not yet on A -> total sellable is 8, never 12
        assertEq(drop[C].available(), 1); assertEq(drop[A].available(), 0); assertEq(supplyLeft(), 8);
        verifyPackets(A, addressToBytes32(address(esc[A])));
        assertEq(drop[A].available(), 2); assertEq(supplyLeft(), 10);
        assertTrue(drop[A].inLocalPool(9)); assertFalse(drop[C].inLocalPool(9));
        mint(A, bob, 2); assertEq(drop[A].ownerOf(9), bob); assertEq(drop[A].ownerOf(10), bob);
        mint(C, bob, 1); assertEq(drop[C].ownerOf(8), bob);
        vm.prank(bob); vm.expectRevert(); drop[C].mint{ value: 0.012 ether }(bob, 0, 1, new bytes32[](0));
        for (uint256 id = 1; id <= 10; ++id) assertEq(activeCount(id), id >= 5 && id <= 7 ? 0 : 1); // 5-7 still unminted on B
    }

    function step(uint8 op) internal {
        uint32 e = E[op % 3]; uint32 d = E[(op / 3) % 3];
        if ((op / 9) % 3 < 2) { if (drop[e].available() > 0) mint(e, alice, 1); return; }
        if (d == e) return;
        MultiSeaOmniDrop.Range[] memory rs = drop[e].ranges(); if (rs.length == 0) return;
        MultiSeaOmniDrop.Range memory last = rs[rs.length - 1]; if (last.end <= last.next) return;
        uint256 lz = esc[e].quoteRange(CID, d, last.end - 1, last.end, opts);
        vm.prank(keeper); drop[e].rebalance{ value: lz }(d, 1, opts);
        verifyPackets(d, addressToBytes32(address(esc[d])));
    }
    function testFuzz_supplyConserved(uint8[12] calldata ops) public {
        for (uint256 k; k < ops.length; ++k) { step(ops[k]); assertEq(supplyLeft(), 10); }
        for (uint256 id = 1; id <= 10; ++id) assertLe(activeCount(id), 1);
    }

    function test_badPartitionRejected() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); p.allocEnd[2] = 12; // covers 11 ids for a supply of 10
        uint256 dl = block.timestamp + 1 days; bytes32 cid = keccak256("bad");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[A].omniDigest(p.owner, cfg(fac[A], p), cid, dl));
        vm.expectRevert(); fac[A].createOmniDrop(p, cid, dl, abi.encodePacked(r, s, v));
    }

    function test_approvalTamperAndReplay() public {
        MultiSeaOmniDrop.OmniInit memory p = params(); uint256 dl = block.timestamp + 1 days; bytes32 cid = keccak256("x");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[A].omniDigest(p.owner, cfg(fac[A], p), cid, dl));
        bytes memory sig = abi.encodePacked(r, s, v);
        p.allocEnd[0] = 9; p.allocEnd[1] = 10; // creator tries to grab more of the supply on chain A
        vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); fac[A].createOmniDrop(p, cid, dl, sig);
        p = params(); fac[A].createOmniDrop(p, cid, dl, sig);
        vm.expectRevert(MultiSeaLaunchpadFactory.SaltUsed.selector); fac[A].createOmniDrop(p, cid, dl, sig);
        vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); fac[B].createOmniDrop(p, cid, dl, sig); // other chain/factory domain
    }

    function test_moveFeeAndRefund() public {
        mint(A, alice, 1);
        (uint256 pf, uint256 lz) = esc[A].quoteMove(CID, B, 1, alice, opts);
        vm.prank(alice); vm.expectRevert(); drop[A].moveTo{ value: pf + lz - 1 }(B, 1, alice, opts);
        uint256 a0 = alice.balance;
        vm.prank(alice); drop[A].moveTo{ value: pf + lz + 1 ether }(B, 1, alice, opts);
        assertEq(a0 - alice.balance, pf + lz, "excess refunded");
    }

    function test_withdrawSplitPerChain() public {
        mint(B, alice, 3); // 36 APE
        uint256 f0 = FEE.balance; drop[B].withdraw();
        assertEq(FEE.balance - f0, 36 ether * 50 / 10000); assertEq(creator.balance, 100 ether + 36 ether - 36 ether * 50 / 10000);
    }

    /// Cross-check vector for worker/test/launchpad.test.mjs (viem omniConfigHash must equal this).
    function test_omniConfigHashVector() public {
        bytes32 h = cfg(fac[A], params()); emit log_named_bytes32("omniConfigHash", h);
        assertEq(h, 0xab5a4c531768ef27025f95820c4fc60ef1c5b2b4a4afe43a4675c74c1d56c988);
    }

    function origin(uint32 src, address sender) internal pure returns (Origin memory) { return Origin(src, bytes32(uint256(uint160(sender))), 1); }
}

import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
