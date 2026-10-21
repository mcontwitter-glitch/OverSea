// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";

contract Reenter {
    MultiSeaDrop d; bool tried;
    constructor(MultiSeaDrop _d) { d = _d; }
    receive() external payable { if (!tried) { tried = true; d.withdraw(); } }
}

contract LaunchpadTest is Test {
    MultiSeaLaunchpadFactory f;
    MultiSeaDrop impl;
    address timelock = address(0x71);
    address feeWallet = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    uint256 apk = 0xA11CE; address approver;
    address creator = address(0xC0FFEE);
    address alice = address(0xA1); address bob = address(0xB0B); address carol = address(0xCA);
    bytes32 root; bytes32[] proofA; bytes32[] proofB;

    function leaf(address a) internal pure returns (bytes32) { return keccak256(bytes.concat(keccak256(abi.encode(a)))); }
    function hp(bytes32 a, bytes32 b) internal pure returns (bytes32) { return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }

    function setUp() public {
        vm.warp(1_800_000_000);
        approver = vm.addr(apk);
        impl = new MultiSeaDrop();
        f = new MultiSeaLaunchpadFactory(timelock, address(impl), feeWallet, approver, 50); // 0.5%
        root = hp(leaf(alice), leaf(bob)); proofA.push(leaf(bob)); proofB.push(leaf(alice));
    }

    function params() internal view returns (MultiSeaDrop.InitParams memory p) {
        p.name = "LIL FOOTS"; p.symbol = "FOOT"; p.owner = creator; p.payout = creator;
        p.maxSupply = 4404; p.creatorReserve = 4; p.royaltyReceiver = creator; p.royaltyBps = 500;
        p.preRevealURI = "ipfs://placeholder.json";
        p.phases = new MultiSeaDrop.Phase[](2);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), uint64(block.timestamp + 1 days), 0.002 ether, 2, root);
        p.phases[1] = MultiSeaDrop.Phase(uint64(block.timestamp + 1 days), 0, 0.003 ether, 5, bytes32(0));
    }

    function sign(address who, MultiSeaDrop.InitParams memory p, bytes32 salt, uint256 dl) internal view returns (bytes memory) {
        bytes32 d = f.approvalDigest(who, this.cfgHash(p), salt, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, d); return abi.encodePacked(r, s, v);
    }
    function cfgHash(MultiSeaDrop.InitParams calldata p) external view returns (bytes32) { return f.configHash(p); }

    function deploy() internal returns (MultiSeaDrop d) {
        MultiSeaDrop.InitParams memory p = params(); uint256 dl = block.timestamp + 1 hours; bytes32 salt = keccak256("lil-foots");
        bytes memory sig = sign(creator, p, salt, dl);
        vm.prank(creator); d = MultiSeaDrop(f.createDrop(p, salt, dl, sig));
    }

    function testCreateAndClone() public {
        address predicted = f.predictDrop(keccak256("lil-foots"));
        uint256 g = gasleft(); MultiSeaDrop d = deploy(); emit log_named_uint("createDrop gas (incl. test overhead)", g - gasleft());
        assertEq(address(d), predicted); assertTrue(f.isDrop(address(d)));
        assertEq(d.owner(), creator); assertEq(d.feeWallet(), feeWallet); assertEq(d.platformFeeBps(), 50);
        assertEq(d.maxSupply(), 4404); assertEq(d.phaseCount(), 2);
        assertLt(address(d).code.length, 100); // EIP-1167 clone
    }

    function testCannotReinitialize() public {
        MultiSeaDrop d = deploy(); MultiSeaDrop.InitParams memory p = params();
        vm.expectRevert(); d.initialize(p);
        vm.expectRevert(); impl.initialize(p);
    }

    function testSignatureReplayAndTamper() public {
        MultiSeaDrop.InitParams memory p = params(); uint256 dl = block.timestamp + 1 hours; bytes32 salt = keccak256("s");
        bytes memory sig = sign(creator, p, salt, dl);
        vm.prank(alice); vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); f.createDrop(p, salt, dl, sig); // wrong creator
        p.maxSupply = 10000; vm.prank(creator); vm.expectRevert(MultiSeaLaunchpadFactory.BadSignature.selector); f.createDrop(p, salt, dl, sig); // tampered
        p.maxSupply = 4404; vm.prank(creator); f.createDrop(p, salt, dl, sig);
        vm.prank(creator); vm.expectRevert(MultiSeaLaunchpadFactory.SaltUsed.selector); f.createDrop(p, salt, dl, sig); // replay
        bytes32 s2 = keccak256("s2"); bytes memory sig2 = sign(creator, p, s2, dl); vm.warp(dl + 1);
        vm.prank(creator); vm.expectRevert(MultiSeaLaunchpadFactory.Expired.selector); f.createDrop(p, s2, dl, sig2);
    }

    function testAllowlistPhase() public {
        MultiSeaDrop d = deploy(); vm.deal(alice, 1 ether); vm.deal(carol, 1 ether);
        vm.prank(alice); d.mint{ value: 0.004 ether }(alice, 0, 2, proofA);
        assertEq(d.balanceOf(alice), 2); assertEq(d.ownerOf(1), alice);
        vm.prank(alice); vm.expectRevert(MultiSeaDrop.WalletLimit.selector); d.mint{ value: 0.002 ether }(alice, 0, 1, proofA);
        vm.prank(carol); vm.expectRevert(MultiSeaDrop.NotAllowlisted.selector); d.mint{ value: 0.002 ether }(carol, 0, 1, proofA);
        vm.prank(carol); vm.expectRevert(MultiSeaDrop.NotAllowlisted.selector); d.mint{ value: 0.002 ether }(carol, 0, 1, proofB);
        vm.prank(alice); vm.expectRevert(MultiSeaDrop.PhaseNotActive.selector); d.mint{ value: 0.003 ether }(alice, 1, 1, new bytes32[](0));
    }

    function testRelayStyleMintForRecipient() public {
        MultiSeaDrop d = deploy(); address solver = address(0x5017E7); vm.deal(solver, 1 ether);
        vm.prank(solver); d.mint{ value: 0.002 ether }(bob, 0, 1, proofB); // solver pays, bob is checked + receives
        assertEq(d.ownerOf(1), bob); assertEq(d.mintedInPhase(0, bob), 1);
    }

    function testPublicPhaseAndPayment() public {
        MultiSeaDrop d = deploy(); vm.warp(block.timestamp + 1 days); vm.deal(carol, 1 ether);
        vm.prank(carol); vm.expectRevert(abi.encodeWithSelector(MultiSeaDrop.WrongPayment.selector, 0.009 ether)); d.mint{ value: 0.008 ether }(carol, 1, 3, new bytes32[](0));
        vm.prank(carol); d.mint{ value: 0.009 ether }(carol, 1, 3, new bytes32[](0));
        assertEq(d.totalMinted(), 3);
    }

    function testSupplyCapRespectsReserve() public {
        MultiSeaDrop.InitParams memory p = params(); p.maxSupply = 10; p.creatorReserve = 4;
        p.phases[1].maxPerWallet = 0; p.phases[1].start = uint64(block.timestamp); p.phases[0].end = uint64(block.timestamp) + 1;
        bytes32 salt = keccak256("cap"); uint256 dl = block.timestamp + 1 hours; bytes memory sig = sign(creator, p, salt, dl);
        vm.prank(creator); MultiSeaDrop d = MultiSeaDrop(f.createDrop(p, salt, dl, sig));
        vm.deal(carol, 1 ether);
        vm.prank(carol); vm.expectRevert(MultiSeaDrop.SoldOut.selector); d.mint{ value: 0.021 ether }(carol, 1, 7, new bytes32[](0));
        vm.prank(carol); d.mint{ value: 0.018 ether }(carol, 1, 6, new bytes32[](0));
        vm.prank(creator); d.mintReserve(creator, 4); assertEq(d.totalMinted(), 10);
        vm.prank(creator); vm.expectRevert(MultiSeaDrop.SoldOut.selector); d.mintReserve(creator, 1);
    }

    function testWithdrawSplit() public {
        MultiSeaDrop d = deploy(); vm.warp(block.timestamp + 1 days);
        vm.deal(carol, 10 ether); vm.prank(carol); d.mint{ value: 0.015 ether }(carol, 1, 5, new bytes32[](0));
        uint256 c0 = creator.balance; uint256 f0 = feeWallet.balance;
        vm.prank(bob); d.withdraw(); // anyone can trigger; funds only go to the fixed recipients
        assertEq(feeWallet.balance - f0, 0.015 ether * 50 / 10000);
        assertEq(creator.balance - c0, 0.015 ether - 0.015 ether * 50 / 10000);
        assertEq(address(d).balance, 0);
    }

    function testWithdrawReentrancyBlocked() public {
        MultiSeaDrop d = deploy(); Reenter r = new Reenter(d);
        vm.prank(creator); d.setPayout(address(r));
        vm.warp(block.timestamp + 1 days); vm.deal(carol, 1 ether); vm.prank(carol); d.mint{ value: 0.003 ether }(carol, 1, 1, new bytes32[](0));
        vm.expectRevert(MultiSeaDrop.PayFailed.selector); d.withdraw();
    }

    function testPauseRevealFreezeRoyalty() public {
        MultiSeaDrop d = deploy(); vm.deal(alice, 1 ether);
        vm.prank(creator); d.setPaused(true);
        vm.prank(alice); vm.expectRevert(MultiSeaDrop.IsPaused.selector); d.mint{ value: 0.002 ether }(alice, 0, 1, proofA);
        vm.prank(creator); d.setPaused(false);
        vm.prank(alice); d.mint{ value: 0.002 ether }(alice, 0, 1, proofA);
        assertEq(d.tokenURI(1), "ipfs://placeholder.json");
        vm.prank(alice); vm.expectRevert(MultiSeaDrop.NotOwner.selector); d.reveal("ipfs://x/");
        vm.prank(creator); vm.expectRevert(MultiSeaDrop.BadParams.selector); d.freezeMetadata(); // must reveal first
        vm.prank(creator); d.reveal("ipfs://bafyFINAL/"); assertEq(d.tokenURI(1), "ipfs://bafyFINAL/1.json");
        vm.prank(creator); d.freezeMetadata();
        vm.prank(creator); vm.expectRevert(MultiSeaDrop.Frozen.selector); d.reveal("ipfs://evil/");
        (address rr, uint256 amt) = d.royaltyInfo(1, 1 ether); assertEq(rr, creator); assertEq(amt, 0.05 ether);
        assertTrue(d.supportsInterface(0x2a55205a)); assertTrue(d.supportsInterface(0x80ac58cd));
    }

    function testFactoryOwnerOnlyAndFeeCap() public {
        vm.expectRevert(); f.setFee(100);
        vm.prank(timelock); vm.expectRevert(MultiSeaLaunchpadFactory.FeeTooHigh.selector); f.setFee(1501);
        MultiSeaDrop d = deploy();
        vm.prank(timelock); f.setFee(250); assertEq(d.platformFeeBps(), 50); // existing drops unaffected
    }

    function testOwnershipTwoStep() public {
        MultiSeaDrop d = deploy();
        vm.prank(creator); d.transferOwnership(alice); assertEq(d.owner(), creator);
        vm.prank(alice); d.acceptOwnership(); assertEq(d.owner(), alice);
    }
}

/// Cross-check vector for worker/test/launchpad.test.mjs (viem configHash must equal Solidity configHash).
contract LaunchpadHashVector is Test {
    function testConfigHashVector() public {
        MultiSeaLaunchpadFactory f = new MultiSeaLaunchpadFactory(address(1), address(new MultiSeaDrop()), address(2), address(3), 50);
        MultiSeaDrop.InitParams memory p;
        p.name = "LIL FOOTS"; p.symbol = "FOOT"; p.owner = address(0xC0FFEE); p.payout = address(0xC0FFEE);
        p.feeWallet = address(0xdead); p.platformFeeBps = 77; // ignored by configHash
        p.maxSupply = 4404; p.creatorReserve = 4; p.royaltyReceiver = address(0xC0FFEE); p.royaltyBps = 500;
        p.baseURI = ""; p.preRevealURI = "ipfs://placeholder.json";
        p.phases = new MultiSeaDrop.Phase[](2);
        p.phases[0] = MultiSeaDrop.Phase(1800000000, 1800086400, 0.002 ether, 2, bytes32(uint256(0x1234)));
        p.phases[1] = MultiSeaDrop.Phase(1800086400, 0, 0.003 ether, 5, bytes32(0));
        bytes32 h = this.hashOf(f, p);
        emit log_named_bytes32("configHash", h);
        assertEq(h, 0x82b8279731e21087b8c73de97a07d66a0fc9ba869eaded0078005130b068ccef);
    }
    function hashOf(MultiSeaLaunchpadFactory f, MultiSeaDrop.InitParams calldata p) external pure returns (bytes32) { return f.configHash(p); }
}
