// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { MultiSeaPacks } from "../src/packs/MultiSeaPacks.sol";
import { MultiSeaPacksOps } from "../src/packs/MultiSeaPacksOps.sol";
import { MultiSeaPacksStorage } from "../src/packs/MultiSeaPacksStorage.sol";
import { MultiSeaPackCards } from "../src/packs/MultiSeaPackCards.sol";
import { MultiSeaPackFactory } from "../src/packs/MultiSeaPackFactory.sol";
import { MultiSeaPackEscrow } from "../src/packs/MultiSeaPackEscrow.sol";

/// Two mock LZ chains. A is the hub. Escrows start at 0 balance: the buyer funds the round trip.
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
            fac[e] = new MultiSeaPackFactory(timelock, address(new MultiSeaPacks(address(new MultiSeaPacksOps()))), address(new MultiSeaPackCards()), FEE, approver, 50);
            vm.startPrank(timelock);
            esc[e].setFactory(address(fac[e]));
            fac[e].setEscrow(address(esc[e]));
            vm.stopPrank();
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
        assertEq(address(esc[A]).balance, 0, "hub escrow starts empty");
        assertEq(address(esc[B]).balance, 0, "spoke escrow starts empty");
    }

    function initParams() internal view returns (MultiSeaPacksStorage.PackInit memory p) {
        p.name = "Omni Cards"; p.symbol = "OCARD"; p.packName = "Omni Packs"; p.packSymbol = "OPACK";
        p.owner = creator; p.payout = creator; p.royaltyReceiver = creator; p.royaltyBps = 500;
        p.cardBaseURI = "ipfs://cards/"; p.packBaseURI = "ipfs://packs/";
        p.rarities = new MultiSeaPacksStorage.Rarity[](2);
        p.rarities[0] = MultiSeaPacksStorage.Rarity("Common", 80, 80);
        p.rarities[1] = MultiSeaPacksStorage.Rarity("Rare", 20, 20);
        p.cards = new MultiSeaPacksStorage.CardType[](2);
        p.cards[0] = MultiSeaPacksStorage.CardType(1, 0);
        p.cards[1] = MultiSeaPacksStorage.CardType(2, 0);
        p.tiers = new MultiSeaPacksStorage.Tier[](1);
        p.tiers[0] = MultiSeaPacksStorage.Tier("Standard", 5, 0, 0, 0);
        p.phases = new MultiSeaPacksStorage.Phase[](1);
        p.phases[0] = MultiSeaPacksStorage.Phase(uint64(block.timestamp), 0, 0.01 ether, 0, 0, bytes32(0));
        p.eids = new uint32[](2); p.eids[0] = A; p.eids[1] = B; p.hubEid = A;
        p.prices = new uint128[](2); p.prices[0] = 0.01 ether; p.prices[1] = 0.02 ether;
    }

    function cfg(MultiSeaPacksStorage.PackInit memory p) public pure returns (bytes32) {
        p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p));
    }

    function _deploy(uint32 e) internal returns (MultiSeaPacks) {
        MultiSeaPacksStorage.PackInit memory p = initParams();
        uint256 dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].approvalDigest(creator, this.cfg(p), CID, dl));
        vm.prank(creator);
        (address a,) = fac[e].createPackDrop(p, CID, dl, abi.encodePacked(r, s, v));
        return MultiSeaPacks(a);
    }

    function deliver(uint32 e) internal { verifyPackets(e, bytes32(uint256(uint160(address(esc[e]))))); }

    function mintHv(uint32 origin, uint32 qty) internal view returns (uint128) {
        return uint128(esc[A].quoteMintReturn(CID, origin, qty) * 11 / 10); // +10% buffer
    }

    function revealHv(uint32 origin, uint32 nCards) internal view returns (uint128) {
        return uint128(esc[A].quoteRevealReturn(CID, origin, nCards) * 11 / 10);
    }

    function mintOn(uint32 e, address who, uint32 qty) internal returns (uint256 price, uint256 lz, uint128 hv) {
        hv = e == A ? uint128(0) : mintHv(e, qty);
        (price, lz) = packs[e].quoteMint(0, 1, qty, hv);
        vm.prank(who);
        packs[e].mint{ value: price + lz }(who, 0, 1, qty, new bytes32[](0), hv);
    }

    function openReveal(uint32 e, address who, uint16 qty) internal {
        vm.prank(who);
        packs[e].open(1, qty);
        uint256 id = packs[e].nextCommitId() - 1;
        uint32 rb; (, rb,,,,) = packs[e].commits(id);
        vm.roll(rb + 1);
        uint32 nCards = packs[e].cardsInPack(1, qty);
        uint128 hv = e == A ? uint128(0) : revealHv(e, nCards);
        uint256 lz = packs[e].quoteReveal(id, hv);
        vm.prank(who);
        packs[e].reveal{ value: lz }(id, hv);
    }

    function test_hubMintOpenReveal_copiesOnOtherChain() public {
        mintOn(A, alice, 1);
        assertEq(packs[A].balanceOf(alice, 1), 1);
        assertEq(packs[B].balanceOf(alice, 1), 0);
        uint256 lz = 0;
        {
            vm.prank(alice);
            packs[A].open(1, 1);
            uint32 rb; (, rb,,,,) = packs[A].commits(1);
            vm.roll(rb + 1);
            lz = packs[A].quoteReveal(1, 0);
            emit log_named_uint("hub reveal fanout lz (5 cards, 1 dest)", lz);
            vm.prank(alice);
            packs[A].reveal{ value: lz }(1);
        }
        assertEq(cards[A].balanceOf(alice), 5);
        deliver(B);
        assertEq(cards[B].balanceOf(address(esc[B])), 5, "escrow copies on B");
        assertEq(cards[B].ownerOf(1), address(esc[B]));
        assertEq(cards[A].ownerOf(1), alice);
        assertEq(cards[B].cardTypeOf(1), cards[A].cardTypeOf(1));
        assertEq(address(esc[A]).balance, esc[A].refundOf(alice), "hub keeps only claimable leftover, if any");
    }

    function test_moveSealedPack() public {
        mintOn(A, alice, 2);
        (uint256 pf, uint256 lz) = esc[A].quoteMovePack(CID, B, 1, 1);
        vm.prank(alice);
        packs[A].movePack{ value: pf + lz }(B, 1, 1, bob);
        assertEq(packs[A].balanceOf(alice, 1), 1);
        deliver(B);
        assertEq(packs[B].balanceOf(bob, 1), 1);
    }

    function test_moveOpenedCard() public {
        mintOn(A, alice, 1);
        openReveal(A, alice, 1);
        deliver(B);
        (uint256 pf, uint256 lz) = esc[A].quoteMoveCard(CID, B, 1);
        vm.prank(alice);
        packs[A].moveCard{ value: pf + lz }(B, 1, bob);
        assertEq(cards[A].ownerOf(1), address(esc[A]));
        deliver(B);
        assertEq(cards[B].ownerOf(1), bob);
    }

    function test_spokeMint() public {
        (uint256 price, uint256 lz, uint128 hv) = mintOn(B, alice, 1);
        emit log_named_uint("spoke mint pack price", price);
        emit log_named_uint("spoke mint lz (request + nativeDrop for MINT_OK)", lz);
        emit log_named_uint("spoke mint hubValue (MINT_OK + 10%)", hv);
        assertEq(packs[B].balanceOf(alice, 1), 0, "held until hub confirms");
        deliver(A);
        deliver(B);
        assertEq(packs[B].balanceOf(alice, 1), 1);
        assertEq(packs[A].remainingSlots(), 100 - 5);
        if (esc[A].refundOf(alice) > 0) {
            uint256 before = alice.balance;
            uint256 due = esc[A].refundOf(alice);
            esc[A].claimRefund(alice);
            assertEq(alice.balance, before + due);
        }
    }

    function test_spokeMintAndReveal_buyerPays_escrowStartsEmpty() public {
        assertEq(address(esc[A]).balance, 0);
        assertEq(address(esc[B]).balance, 0);
        (uint256 price, uint256 lzMint, uint128 hvMint) = mintOn(B, alice, 1);
        emit log_named_uint("e2e spoke mint price", price);
        emit log_named_uint("e2e spoke mint lz", lzMint);
        emit log_named_uint("e2e spoke mint hubValue", hvMint);
        deliver(A);
        deliver(B);
        assertEq(packs[B].balanceOf(alice, 1), 1);

        vm.prank(alice);
        packs[B].open(1, 1);
        uint256 id = packs[B].nextCommitId() - 1;
        uint32 rb; (, rb,,,,) = packs[B].commits(id);
        vm.roll(rb + 1);
        uint128 hv = revealHv(B, 5);
        uint256 lz = packs[B].quoteReveal(id, hv);
        emit log_named_uint("e2e spoke reveal lz (request + nativeDrop for REVEAL_OK)", lz);
        emit log_named_uint("e2e spoke reveal hubValue (REVEAL_OK + 10%)", hv);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        packs[B].reveal{ value: lz }(id, hv);
        // origin refunds unused outbound fee immediately
        assertLe(aliceBefore - alice.balance, lz);
        deliver(A);
        deliver(B);
        assertEq(cards[B].balanceOf(alice), 5, "cards Active on origin");
        assertEq(cards[A].balanceOf(address(esc[A])), 5, "escrow copies on hub");
        assertEq(cards[B].ownerOf(1), alice);
        // escrow may hold only claimable leftover, never a pre-fund
        assertEq(address(esc[A]).balance, esc[A].refundOf(alice) + esc[A].refundOf(address(0)), "hub escrow has no unaccounted balance");
        assertEq(address(esc[B]).balance, esc[B].refundOf(alice), "spoke escrow refunded dust");
    }

    function test_spokeMint_underpays_reverts() public {
        uint128 hv = mintHv(B, 1);
        (uint256 price, uint256 lz) = packs[B].quoteMint(0, 1, 1, hv);
        uint256 need = price + lz;
        vm.expectRevert(abi.encodeWithSelector(MultiSeaPacksStorage.InsufficientFee.selector, need, need - 1));
        vm.prank(alice);
        packs[B].mint{ value: need - 1 }(alice, 0, 1, 1, new bytes32[](0), hv);
        assertEq(packs[B].balanceOf(alice, 1), 0);
        assertEq(address(esc[A]).balance, 0);
        assertEq(address(esc[B]).balance, 0);
    }

    function test_spokeReveal_underpays_reverts() public {
        mintOn(B, alice, 1);
        deliver(A);
        deliver(B);
        vm.prank(alice);
        packs[B].open(1, 1);
        uint256 id = packs[B].nextCommitId() - 1;
        uint32 rb; (, rb,,,,) = packs[B].commits(id);
        vm.roll(rb + 1);
        uint128 hv = revealHv(B, 5);
        uint256 lz = packs[B].quoteReveal(id, hv);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaPacksStorage.InsufficientFee.selector, lz, lz - 1));
        vm.prank(alice);
        packs[B].reveal{ value: lz - 1 }(id, hv);
        (,,,, uint8 status,) = packs[B].commits(id);
        assertEq(status, packs[B].ST_PENDING());
    }

    function test_hubReveal_underpays_reverts() public {
        mintOn(A, alice, 1);
        vm.prank(alice);
        packs[A].open(1, 1);
        uint32 rb; (, rb,,,,) = packs[A].commits(1);
        vm.roll(rb + 1);
        uint256 lz = packs[A].quoteReveal(1, 0);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaPacksStorage.InsufficientFee.selector, lz, lz - 1));
        vm.prank(alice);
        packs[A].reveal{ value: lz - 1 }(1);
    }
}
