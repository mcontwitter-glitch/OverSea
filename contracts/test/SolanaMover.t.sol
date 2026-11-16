// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaOmniDrop } from "../src/launchpad/MultiSeaOmniDrop.sol";
import { MultiSeaOmniEscrow } from "../src/launchpad/MultiSeaOmniEscrow.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";
import { MultiSeaSolanaMover } from "../src/launchpad/MultiSeaSolanaMover.sol";

/// Stands in for the MultiSea Solana program: like the real Store it accepts MOVE from the chain's mover and sends
/// returns to the chain's existing escrow (two addresses per EVM chain). Records the last payload it received.
contract SolanaProgramStub is OApp {
    bytes32 public last; uint32 public lastSrc; bytes32 public mover;
    constructor(address ep, address o) OApp(ep, o) Ownable(o) {}
    function setMover(bytes32 m) external { mover = m; }
    function allowInitializePath(Origin calldata o) public view override returns (bool) { return o.sender == mover || peers[o.srcEid] == o.sender; }
    function lzReceive(Origin calldata o, bytes32 g, bytes calldata m, address e, bytes calldata x) public payable override {
        require(msg.sender == address(endpoint) && (o.sender == mover || o.sender == peers[o.srcEid]), "sender");
        _lzReceive(o, g, m, e, x);
    }
    function _lzReceive(Origin calldata o, bytes32, bytes calldata m, address, bytes calldata) internal override { last = keccak256(m); lastSrc = o.srcEid; }
    function send(uint32 dst, bytes calldata m) external payable {
        _lzSend(dst, m, OptionsBuilder.addExecutorLzReceiveOption(OptionsBuilder.newOptions(), 200_000, 0), MessagingFee(msg.value, 0), payable(msg.sender));
    }
    function quote(uint32 dst, bytes calldata m) external view returns (uint256) {
        return _quote(dst, m, OptionsBuilder.addExecutorLzReceiveOption(OptionsBuilder.newOptions(), 200_000, 0), false).nativeFee;
    }
}

/// Existing V1 collection on A (hub, "Base") and B (another EVM chain), plus Solana (S, stub). The mover on A moves tokens
/// to Solana through A's EXISTING escrow; Solana returns through the existing escrow's normal MOVE handling.
contract SolanaMoverTest is TestHelperOz5 {
    uint32 constant A = 1; uint32 constant B = 2; uint32 constant S = 3;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    uint256 constant MOVE_FEE = 0.0001 ether;
    bytes32 constant CID = keccak256("multi-islands");
    bytes32 constant SOL_ALICE = keccak256("alice's phantom");
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1); address bob = address(0xB0B); address op = address(0x0F);
    uint256 apk = 0xA11CE;
    mapping(uint32 => MultiSeaOmniEscrow) esc;
    mapping(uint32 => MultiSeaOmniDrop) drop;
    MultiSeaSolanaMover mover;
    SolanaProgramStub sol;

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(3, LibraryType.UltraLightNode);
        uint32[2] memory evm = [A, B];
        for (uint256 i; i < 2; ++i) {
            uint32 e = evm[i];
            esc[e] = new MultiSeaOmniEscrow(address(endpoints[e]), timelock, FEE, MOVE_FEE);
            MultiSeaLaunchpadFactory f = new MultiSeaLaunchpadFactory(timelock, address(new MultiSeaDrop()), FEE, vm.addr(apk), 50);
            address impl = address(new MultiSeaOmniDrop());
            vm.startPrank(timelock); esc[e].setFactory(address(f)); f.setOmni(impl, address(esc[e])); vm.stopPrank();
            drop[e] = deploy(f, params());
        }
        vm.startPrank(timelock);
        esc[A].setPeer(B, addressToBytes32(address(esc[B]))); esc[B].setPeer(A, addressToBytes32(address(esc[A])));
        vm.stopPrank();
        // the new pieces: mover on A (owner = MultiSea), Solana side, and the one timelock call on A's existing escrow
        sol = new SolanaProgramStub(address(endpoints[S]), address(this));
        mover = new MultiSeaSolanaMover(address(endpoints[A]), address(this), address(esc[A]), S);
        mover.setPeer(S, addressToBytes32(address(sol)));
        sol.setPeer(A, addressToBytes32(address(esc[A]))); sol.setMover(addressToBytes32(address(mover)));
        vm.prank(timelock); esc[A].setPeer(S, addressToBytes32(address(sol)));
        mover.setCollection(CID, true);
        vm.deal(alice, 100 ether); vm.deal(bob, 100 ether); vm.deal(op, 100 ether); vm.deal(address(this), 100 ether);
        // alice mints #1-#2 on the hub (AT_MINT: copies to B), bob mints #3
        mintHub(alice, 2); mintHub(bob, 1);
        verifyPackets(B, addressToBytes32(address(esc[B])));
    }

    function params() internal view returns (MultiSeaOmniDrop.OmniInit memory p) {
        p.name = "MULTI ISLANDS"; p.symbol = "ISL"; p.owner = creator; p.payout = creator; p.maxSupply = 100;
        p.royaltyReceiver = creator; p.royaltyBps = 500; p.baseURI = "ipfs://bafyISLANDS/";
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 0, 0, bytes32(0));
        p.eids = new uint32[](2); p.eids[0] = A; p.eids[1] = B; p.hubEid = A;
        p.prices = new uint128[](2); p.prices[0] = 0.001 ether; p.prices[1] = 0.001 ether;
        p.copyMode = 1;
    }
    function deploy(MultiSeaLaunchpadFactory f, MultiSeaOmniDrop.OmniInit memory p) internal returns (MultiSeaOmniDrop) {
        uint256 dl = block.timestamp + 1 days;
        MultiSeaOmniDrop.OmniInit memory q = p; q.feeWallet = address(0); q.platformFeeBps = 0;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, f.omniDigest(p.owner, keccak256(abi.encode(q)), CID, dl));
        return MultiSeaOmniDrop(f.createOmniDrop(p, CID, dl, abi.encodePacked(r, s, v)));
    }
    function mintHub(address who, uint256 q) internal {
        (uint256 price, uint256 lz) = drop[A].quoteMint(0, q, who, 0);
        vm.prank(who); drop[A].mint{ value: price + lz }(who, 0, q, new bytes32[](0), 0);
    }
    function v1Move(uint256 id, address to) internal pure returns (bytes memory) { return abi.encode(uint8(1), CID, id, uint256(0), uint256(0), to); }
    function toSol(address caller, uint256 id, bytes32 to) internal {
        (uint256 pf, uint256 lz) = mover.quoteToSolana(CID, id, to);
        vm.prank(caller); mover.toSolana{ value: pf + lz }(CID, id, to);
    }

    // ---------------------------------------------------------------- tests
    function test_toSolana_locksInExistingEscrow_sendsMove_neverHolds() public {
        vm.prank(alice); drop[A].approve(address(mover), 1);
        (uint256 pf, uint256 lz) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        assertEq(pf, MOVE_FEE, "platform fee = the escrow's move fee");
        uint256 a0 = alice.balance; uint256 f0 = FEE.balance;
        vm.prank(alice); mover.toSolana{ value: pf + lz + 1 ether }(CID, 1, SOL_ALICE); // overpay: refunded
        assertEq(drop[A].ownerOf(1), address(esc[A]), "locked in the EXISTING escrow");
        assertEq(drop[A].balanceOf(address(mover)), 0, "mover never holds a token");
        assertFalse(drop[A].isActiveHere(1));
        assertEq(FEE.balance - f0, MOVE_FEE, "move fee to the escrow's fee wallet");
        assertEq(a0 - alice.balance, pf + lz, "excess refunded");
        verifyPackets(S, addressToBytes32(address(sol)));
        assertEq(sol.last(), keccak256(abi.encode(uint8(1), CID, uint256(1), uint256(0), uint256(0), SOL_ALICE)), "192-byte MOVE with the bytes32 Solana recipient");
        assertEq(sol.lastSrc(), A);
        // B is untouched: its copy of #1 stays locked in B's escrow
        assertEq(drop[B].ownerOf(1), address(esc[B]));
    }

    function test_returnFromSolana_releasesThroughExistingEscrow() public {
        vm.prank(alice); drop[A].approve(address(mover), 1);
        toSol(alice, 1, SOL_ALICE);
        verifyPackets(S, addressToBytes32(address(sol)));
        // Solana move_out: MOVE in the V1 layout (EVM recipient in the low 20 bytes) to A's existing escrow
        bytes memory m = v1Move(1, bob);
        sol.send{ value: sol.quote(A, m) }(A, m);
        verifyPackets(A, addressToBytes32(address(esc[A])));
        assertEq(drop[A].ownerOf(1), bob, "released by the existing escrow");
        assertTrue(drop[A].isActiveHere(1)); assertFalse(drop[B].isActiveHere(1));
        // and it can go again (the escrow is unchanged by any of this)
        vm.prank(bob); drop[A].setApprovalForAll(address(mover), true);
        toSol(bob, 1, SOL_ALICE);
        assertEq(drop[A].ownerOf(1), address(esc[A]));
    }

    function test_returnFromSolana_toAnotherEvmChain_usesThatChainsEscrow() public {
        // the Solana side can return to any chain of the collection; B's existing escrow releases B's locked copy
        vm.prank(timelock); esc[B].setPeer(S, addressToBytes32(address(sol)));
        sol.setPeer(B, addressToBytes32(address(esc[B])));
        vm.prank(alice); drop[A].approve(address(mover), 2);
        toSol(alice, 2, SOL_ALICE);
        bytes memory m = v1Move(2, bob);
        sol.send{ value: sol.quote(B, m) }(B, m);
        verifyPackets(B, addressToBytes32(address(esc[B])));
        assertEq(drop[B].ownerOf(2), bob); assertEq(drop[A].ownerOf(2), address(esc[A]), "one Active copy across EVM chains");
    }

    function test_approvedOperatorCanMove() public {
        vm.startPrank(alice); drop[A].setApprovalForAll(address(mover), true); drop[A].setApprovalForAll(op, true); vm.stopPrank();
        toSol(op, 2, SOL_ALICE);
        assertEq(drop[A].ownerOf(2), address(esc[A]));
    }

    function test_strangerCannotMoveSomeoneElsesToken() public {
        vm.prank(alice); drop[A].setApprovalForAll(address(mover), true); // even with the mover approved for all
        (uint256 pf, uint256 lz) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        vm.prank(bob); vm.expectRevert(MultiSeaSolanaMover.NotAuthorized.selector);
        mover.toSolana{ value: pf + lz }(CID, 1, keccak256("bob's phantom"));
        assertEq(drop[A].ownerOf(1), alice);
    }

    function test_needsTheHoldersApprovalForTheMover() public {
        (uint256 pf, uint256 lz) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(mover), 1));
        mover.toSolana{ value: pf + lz }(CID, 1, SOL_ALICE);
    }

    function test_tokenAlreadyInEscrow_notMovable() public {
        // #3 moved A -> B with the normal V1 flow: on A it sits in the escrow
        (uint256 pf, uint256 lz) = esc[A].quoteMove(CID, B, 3, bob);
        vm.prank(bob); drop[A].moveTo{ value: pf + lz }(B, 3, bob);
        (pf, lz) = mover.quoteToSolana(CID, 3, SOL_ALICE);
        vm.prank(bob); vm.expectRevert(MultiSeaSolanaMover.NotMovable.selector);
        mover.toSolana{ value: pf + lz }(CID, 3, SOL_ALICE);
    }

    function test_feeAndRecipientChecks() public {
        vm.prank(alice); drop[A].approve(address(mover), 1);
        (uint256 pf, uint256 lz) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaSolanaMover.InsufficientFee.selector, pf + lz, pf + lz - 1));
        mover.toSolana{ value: pf + lz - 1 }(CID, 1, SOL_ALICE);
        vm.prank(alice); vm.expectRevert(MultiSeaSolanaMover.ZeroRecipient.selector);
        mover.toSolana{ value: pf + lz }(CID, 1, bytes32(0));
        assertEq(drop[A].ownerOf(1), alice, "nothing moved");
    }

    function test_onlyEnabledCollections_ownerOnly() public {
        mover.setCollection(CID, false);
        vm.prank(alice); drop[A].approve(address(mover), 1);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(MultiSeaSolanaMover.NotEnabled.selector, CID));
        mover.toSolana{ value: 1 ether }(CID, 1, SOL_ALICE);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaSolanaMover.UnknownCollection.selector, keccak256("nope")));
        mover.setCollection(keccak256("nope"), true);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        mover.setCollection(CID, true);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        mover.setSolanaOptions(1, 1);
    }

    function test_moverAcceptsNothingInbound() public {
        Origin memory o = Origin(S, addressToBytes32(address(sol)), 1);
        vm.prank(address(endpoints[A])); vm.expectRevert(MultiSeaSolanaMover.NoInbound.selector);
        mover.lzReceive(o, bytes32(uint256(1)), v1Move(1, alice), address(0), "");
    }

    function test_solanaOptionsInQuote() public {
        (, uint256 lz0) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        mover.setSolanaOptions(120_000, 3_500_000);
        (, uint256 lz1) = mover.quoteToSolana(CID, 1, SOL_ALICE);
        assertGt(lz1, lz0, "lamports for a copy the program must create are paid by the mover");
    }
}
