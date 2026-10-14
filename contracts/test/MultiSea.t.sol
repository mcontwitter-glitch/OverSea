// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { MultiSeaEscrow } from "../src/MultiSeaEscrow.sol";
import { MultiSeaMirror } from "../src/MultiSeaMirror.sol";
import { MultiSeaFactory } from "../src/MultiSeaFactory.sol";

contract MockFeed {
    int256 public answer; uint256 public updatedAt; uint8 public decimals = 8;
    function set(int256 a, uint256 t) external { answer = a; updatedAt = t; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, updatedAt, updatedAt, 1); }
}

contract TestNFT is ERC721, Ownable {
    constructor(address o) ERC721("LIL FOOTS test", "LFT") Ownable(o) {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

contract Reenter {
    MultiSeaEscrow public e; uint32 public eid; uint256 public id; bytes public opts; bool public tried;
    function setup(MultiSeaEscrow _e, uint32 _eid, uint256 _id, bytes memory _o) external { e = _e; eid = _eid; id = _id; opts = _o; }
    function go() external payable { e.bridge{ value: msg.value }(eid, address(this), id, opts); }
    receive() external payable {
        if (!tried) { tried = true; e.bridge{ value: 0 }(eid, address(this), id, opts); } // must revert (nonReentrant)
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }
}

contract MultiSeaTest is TestHelperOz5 {
    using OptionsBuilder for bytes;
    uint32 constant A = 1; uint32 constant B = 2;
    address constant ADMIN = 0xCa89AE48a5C61D13E78236DAA4Ac29EE588ea475;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address op = address(0x0BEEF);
    address holder = address(0xA11CE);
    address bob = address(0xB0B);
    MockFeed feedA; MockFeed feedB;
    MultiSeaFactory facA; MultiSeaFactory facB;
    TestNFT nft; MultiSeaEscrow escA; MultiSeaEscrow escB; MultiSeaMirror mirror;
    bytes opts;

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);
        feedA = new MockFeed(); feedB = new MockFeed();
        feedA.set(2500e8, block.timestamp); feedB.set(2500e8, block.timestamp);
        facA = new MultiSeaFactory(address(endpoints[A]), ADMIN, op, FEE, address(feedA), 3600, 6);
        facB = new MultiSeaFactory(address(endpoints[B]), ADMIN, op, FEE, address(feedB), 3600, 6);
        nft = new TestNFT(ADMIN);
        nft.mint(holder, 7); nft.mint(holder, 8);
        uint32[] memory eids = new uint32[](2); eids[0] = A; eids[1] = B;
        vm.deal(ADMIN, 1 ether);
        vm.prank(ADMIN); (uint256 lid, address e) = facA.list{ value: 0.08 ether }(address(nft), eids);
        escA = MultiSeaEscrow(payable(e));
        vm.prank(op); (address m, address eb) = facB.deployMirror(lid, "LIL FOOTS test", "LFT", "ipfs://x/", 1, 4404);
        mirror = MultiSeaMirror(m); escB = MultiSeaEscrow(payable(eb));
        vm.startPrank(op);
        facA.setPeer(address(escA), B, addressToBytes32(address(escB)));
        facB.setPeer(address(escB), A, addressToBytes32(address(escA)));
        vm.stopPrank();
        opts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0);
        vm.deal(holder, 10 ether); vm.deal(bob, 10 ether);
    }

    function test_platformFeeIs30Cents() public view {
        // $0.30 / $2500 = 0.00012 ETH
        assertEq(escA.platformFee(), 0.00012 ether);
    }

    function test_feeRoundsUpAndTracksPrice() public {
        feedA.set(3333_33333333, block.timestamp);
        uint256 f = escA.platformFee();
        assertGe(f * 333333333333, 0.30e18 * 1e8 / 1); // f * price >= 0.30 USD (8-dec price)
        assertLt((f - 1) * 333333333333, 0.30e18 * 1e8);
    }

    function test_staleFeedReverts() public {
        feedA.set(2500e8, block.timestamp - 3601);
        vm.expectRevert(MultiSeaEscrow.StalePrice.selector);
        escA.platformFee();
        feedA.set(0, block.timestamp);
        vm.expectRevert(MultiSeaEscrow.BadPrice.selector);
        escA.platformFee();
    }

    function test_listingFeeTiers() public view {
        assertEq(facA.listingFee(2), 0.08 ether);
        assertEq(facA.listingFee(3), 0.095 ether);
        assertEq(facA.listingFee(4), 0.095 ether);
        assertEq(facA.listingFee(6), 0.12 ether);
    }

    function test_listingPaidToFeeWallet() public view {
        assertEq(FEE.balance, 0.08 ether);
        assertEq(facA.getListing(1).owner, ADMIN);
    }

    function test_listingRequiresOwnerAndExactFee() public {
        TestNFT other = new TestNFT(ADMIN);
        uint32[] memory eids = new uint32[](3); eids[0] = A; eids[1] = B; eids[2] = 3;
        vm.deal(bob, 1 ether);
        vm.prank(bob); vm.expectRevert(MultiSeaFactory.NotCollectionOwner.selector);
        facA.list{ value: 0.095 ether }(address(other), eids);
        vm.prank(ADMIN); vm.expectRevert(abi.encodeWithSelector(MultiSeaFactory.WrongFee.selector, 0.095 ether));
        facA.list{ value: 0.08 ether }(address(other), eids);
        uint32[] memory one = new uint32[](1); one[0] = A;
        vm.prank(ADMIN); vm.expectRevert(MultiSeaFactory.BadChainCount.selector);
        facA.list{ value: 0.08 ether }(address(other), one);
        vm.prank(ADMIN); vm.expectRevert(MultiSeaFactory.AlreadyListed.selector);
        facA.list{ value: 0.08 ether }(address(nft), new uint32[](2));
    }

    function test_onlyOperatorWiresAndDeploys() public {
        vm.prank(bob); vm.expectRevert(MultiSeaFactory.NotOperator.selector);
        facA.setPeer(address(escA), B, bytes32(uint256(1)));
        vm.prank(bob); vm.expectRevert(MultiSeaFactory.NotOperator.selector);
        facB.deployMirror(1, "x", "x", "", 1, 10);
        vm.prank(bob); vm.expectRevert();
        escA.setPeer(B, bytes32(uint256(1))); // escrow owned by factory
    }

    function test_mirrorSupplyHeldByEscrow() public view {
        assertEq(mirror.totalSupply(), 4404);
        assertEq(mirror.balanceOf(address(escB)), 4404);
        assertEq(mirror.ownerOf(1), address(escB));
        assertEq(mirror.ownerOf(4404), address(escB));
    }

    function test_roundTrip() public {
        (uint256 p, uint256 lz) = escA.quote(B, holder, 7, opts);
        assertEq(p, 0.00012 ether);
        assertGt(lz, 0);
        uint256 feeBefore = FEE.balance;
        vm.startPrank(holder);
        nft.approve(address(escA), 7);
        uint256 balBefore = holder.balance;
        escA.bridge{ value: p + lz + 0.01 ether }(B, holder, 7, opts); // overpay is refunded
        vm.stopPrank();
        assertEq(holder.balance, balBefore - p - lz);
        assertEq(FEE.balance, feeBefore + p);
        assertEq(nft.ownerOf(7), address(escA));
        verifyPackets(B, addressToBytes32(address(escB)));
        assertEq(mirror.ownerOf(7), holder);
        assertEq(mirror.balanceOf(address(escB)), 4403);

        // reverse: B -> A, holder sends to bob
        (p, lz) = escB.quote(A, bob, 7, opts);
        vm.startPrank(holder);
        mirror.approve(address(escB), 7);
        escB.bridge{ value: p + lz }(A, bob, 7, opts);
        vm.stopPrank();
        assertEq(mirror.ownerOf(7), address(escB));
        assertEq(mirror.balanceOf(address(escB)), 4404);
        verifyPackets(A, addressToBytes32(address(escA)));
        assertEq(nft.ownerOf(7), bob);

        // and out again: re-uses the materialised mirror token (transfer, not mint)
        (p, lz) = escA.quote(B, bob, 7, opts);
        vm.startPrank(bob); nft.approve(address(escA), 7); escA.bridge{ value: p + lz }(B, bob, 7, opts); vm.stopPrank();
        verifyPackets(B, addressToBytes32(address(escB)));
        assertEq(mirror.ownerOf(7), bob);
    }

    function test_insufficientFeeReverts() public {
        (uint256 p, uint256 lz) = escA.quote(B, holder, 7, opts);
        vm.startPrank(holder); nft.approve(address(escA), 7);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaEscrow.InsufficientFee.selector, p + lz, p + lz - 1));
        escA.bridge{ value: p + lz - 1 }(B, holder, 7, opts);
        vm.stopPrank();
    }

    function test_cannotBridgeOthersToken() public {
        (uint256 p, uint256 lz) = escA.quote(B, bob, 7, opts);
        vm.prank(bob); vm.expectRevert();
        escA.bridge{ value: p + lz }(B, bob, 7, opts);
    }

    function test_untrustedPeerRejected() public {
        Origin memory o = Origin({ srcEid: B, sender: addressToBytes32(address(0xBAD)), nonce: 1 });
        vm.prank(address(endpoints[A]));
        vm.expectRevert(abi.encodeWithSignature("OnlyPeer(uint32,bytes32)", B, addressToBytes32(address(0xBAD))));
        escA.lzReceive(o, bytes32(0), abi.encode(bob, uint256(8)), address(0), "");
        // and nobody but the endpoint may call lzReceive
        Origin memory good = Origin({ srcEid: B, sender: addressToBytes32(address(escB)), nonce: 1 });
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("OnlyEndpoint(address)", bob));
        escA.lzReceive(good, bytes32(0), abi.encode(bob, uint256(8)), address(0), "");
    }

    function test_reentrancyBlocked() public {
        Reenter r = new Reenter();
        vm.prank(holder); nft.transferFrom(holder, address(r), 8);
        r.setup(escA, B, 8, opts);
        vm.prank(address(r)); nft.approve(address(escA), 8);
        (uint256 p, uint256 lz) = escA.quote(B, address(r), 8, opts);
        // the overpay refund calls Reenter.receive, which tries to re-enter bridge -> whole tx reverts (PayFailed)
        vm.expectRevert(MultiSeaEscrow.PayFailed.selector);
        r.go{ value: p + lz + 1 }();
    }

    function test_ownerIsAdmin() public view {
        assertEq(facA.owner(), ADMIN);
        assertEq(escA.owner(), address(facA));
        assertEq(escA.feeWallet(), FEE);
    }
}
