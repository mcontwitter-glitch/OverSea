// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { MultiSeaPacks } from "../src/packs/MultiSeaPacks.sol";
import { MultiSeaPackCards } from "../src/packs/MultiSeaPackCards.sol";
import { MultiSeaPackFactory } from "../src/packs/MultiSeaPackFactory.sol";
import { MultiSeaPackEscrow } from "../src/packs/MultiSeaPackEscrow.sol";

/// Two mock LZ chains. A is the hub. Packs mint locally on the hub; opened cards are copied into escrow on B.
/// Sealed packs and opened cards can be moved A ↔ B.
contract PacksOmniTest is TestHelperOz5 {
    uint32 constant A = 1;
    uint32 constant B = 2;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1);
    address bob = address(0xB0B);
    uint256 apk = 0xA11CE;
    address approver;
    bytes32 constant CID = keccak256("pack-omni");
    mapping(uint32 => MultiSeaPackEscrow) esc;
    mapping(uint32 => MultiSeaPackFactory) fac;
    mapping(uint32 => MultiSeaPacks) packs;
    mapping(uint32 => MultiSeaPackCards) cards;

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);
        approver = vm.addr(apk);
        uint32[2] memory E = [A, B];
        for (uint256 i; i < 2; ++i) {
            uint32 e = E[i];
            esc[e] = new MultiSeaPackEscrow(address(endpoints[e]), timelock, FEE, 0.0001 ether);
            fac[e] = new MultiSeaPackFactory(timelock, address(new MultiSeaPacks()), address(new MultiSeaPackCards()), FEE, approver, 50);
            vm.startPrank(timelock);
            esc[e].setFactory(address(fac[e]));
            fac[e].setEscrow(address(esc[e]));
            vm.stopPrank();
            vm.deal(address(esc[e]), 100 ether);
        }
        vm.startPrank(timelock);
        esc[A].setPeer(B, bytes32(uint256(uint160(address(esc[B])))));
        esc[B].setPeer(A, bytes32(uint256(uint160(address(esc[A])))));
        vm.stopPrank();
        packs[A] = _deploy(A);
        packs[B] = _deploy(B);
        cards[A] = MultiSeaPackCards(address(packs[A].cards()));
        cards[B] = MultiSeaPackCards(address(packs[B].cards()));
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function initParams() internal view returns (MultiSeaPacks.PackInit memory p) {
        p.name = "Omni Cards"; p.symbol = "OCARD"; p.packName = "Omni Packs"; p.packSymbol = "OPACK";
        p.owner = creator; p.payout = creator; p.royaltyReceiver = creator; p.royaltyBps = 500;
        p.cardBaseURI = "ipfs://cards/"; p.packBaseURI = "ipfs://packs/";
        p.rarities = new MultiSeaPacks.Rarity[](2);
        p.rarities[0] = MultiSeaPacks.Rarity("Common", 80, 80);
        p.rarities[1] = MultiSeaPacks.Rarity("Rare", 20, 20);
        p.cards = new MultiSeaPacks.CardType[](2);
        p.cards[0] = MultiSeaPacks.CardType(1, 0);
        p.cards[1] = MultiSeaPacks.CardType(2, 0);
        p.tiers = new MultiSeaPacks.Tier[](1);
        p.tiers[0] = MultiSeaPacks.Tier("Standard", 5, 0, 0, 0);
        p.phases = new MultiSeaPacks.Phase[](1);
        p.phases[0] = MultiSeaPacks.Phase(uint64(block.timestamp), 0, 0.01 ether, 0, 0, bytes32(0));
        p.eids = new uint32[](2); p.eids[0] = A; p.eids[1] = B; p.hubEid = A;
        p.prices = new uint128[](2); p.prices[0] = 0.01 ether; p.prices[1] = 0.02 ether;
    }

    function cfg(MultiSeaPacks.PackInit memory p) public pure returns (bytes32) {
        p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p));
    }

    function _deploy(uint32 e) internal returns (MultiSeaPacks) {
        MultiSeaPacks.PackInit memory p = initParams();
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].approvalDigest(creator, this.cfg(p), CID, dl));
        vm.prank(creator);
        (address a,) = fac[e].createPackDrop(p, CID, dl, abi.encodePacked(r, s, v));
        return MultiSeaPacks(a);
    }

    function deliver(uint32 e) internal { verifyPackets(e, bytes32(uint256(uint160(address(esc[e]))))); }

    function test_hubMintOpenReveal_copiesOnOtherChain() public {
        vm.prank(alice);
        packs[A].mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        assertEq(packs[A].balanceOf(alice, 1), 1);
        assertEq(packs[B].balanceOf(alice, 1), 0);
        vm.prank(alice);
        packs[A].open(1, 1);
        uint32 rb; (, rb,,,,) = packs[A].commits(1);
        vm.roll(rb + 1);
        vm.prank(alice);
        packs[A].reveal{ value: 1 ether }(1);
        assertEq(cards[A].balanceOf(alice), 5);
        deliver(B);
        assertEq(cards[B].balanceOf(address(esc[B])), 5, "escrow copies on B");
        assertEq(cards[B].ownerOf(1), address(esc[B]));
        assertEq(cards[A].ownerOf(1), alice);
        assertEq(cards[B].cardTypeOf(1), cards[A].cardTypeOf(1));
    }

    function test_moveSealedPack() public {
        vm.prank(alice);
        packs[A].mint{ value: 0.02 ether }(alice, 0, 1, 2, new bytes32[](0));
        (uint256 pf, uint256 lz) = esc[A].quoteMovePack(CID, B, 1, 1);
        vm.prank(alice);
        packs[A].movePack{ value: pf + lz }(B, 1, 1, bob);
        assertEq(packs[A].balanceOf(alice, 1), 1);
        deliver(B);
        assertEq(packs[B].balanceOf(bob, 1), 1);
    }

    function test_moveOpenedCard() public {
        vm.prank(alice);
        packs[A].mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        vm.prank(alice);
        packs[A].open(1, 1);
        uint32 rb; (, rb,,,,) = packs[A].commits(1);
        vm.roll(rb + 1);
        vm.prank(alice);
        packs[A].reveal{ value: 1 ether }(1);
        deliver(B);
        (uint256 pf, uint256 lz) = esc[A].quoteMoveCard(CID, B, 1);
        vm.prank(alice);
        packs[A].moveCard{ value: pf + lz }(B, 1, bob);
        assertEq(cards[A].ownerOf(1), address(esc[A]));
        deliver(B);
        assertEq(cards[B].ownerOf(1), bob);
    }

    function test_spokeMint() public {
        (uint256 price, uint256 lz) = packs[B].quoteMint(0, 1, 1);
        vm.prank(alice);
        packs[B].mint{ value: price + lz + 0.5 ether }(alice, 0, 1, 1, new bytes32[](0));
        assertEq(packs[B].balanceOf(alice, 1), 0, "held until hub confirms");
        deliver(A); // hub reserves + MINT_OK
        deliver(B);
        assertEq(packs[B].balanceOf(alice, 1), 1);
        assertEq(packs[A].remainingSlots(), 100 - 5);
    }
}
