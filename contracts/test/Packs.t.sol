// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { MultiSeaPacks } from "../src/packs/MultiSeaPacks.sol";
import { MultiSeaPacksOps } from "../src/packs/MultiSeaPacksOps.sol";
import { MultiSeaPacksStorage } from "../src/packs/MultiSeaPacksStorage.sol";
import { MultiSeaPackCards } from "../src/packs/MultiSeaPackCards.sol";
import { MultiSeaPackFactory } from "../src/packs/MultiSeaPackFactory.sol";

contract PacksTest is Test {
    MultiSeaPackFactory f;
    address timelock = address(0x71);
    address feeWallet = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    uint256 apk = 0xA11CE;
    address approver;
    address creator = address(0xC0FFEE);
    address alice = address(0xA1);
    address bob = address(0xB0B);
    uint32 constant EID = 30184; // Base

    // rarities: Common 70 / Rare 25 / Legendary 5, caps 700 / 250 / 50 (1000 cards)
    // 200 packs of 5 cards = 1000 cards
    // 2 card types each rarity

    function setUp() public {
        vm.warp(1_800_000_000);
        approver = vm.addr(apk);
        f = new MultiSeaPackFactory(timelock, address(new MultiSeaPacks(address(new MultiSeaPacksOps()))), address(new MultiSeaPackCards()), feeWallet, approver, 50);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(creator, 100 ether);
    }

    function baseInit() internal view returns (MultiSeaPacksStorage.PackInit memory p) {
        p.name = "Island Cards";
        p.symbol = "ICARD";
        p.packName = "Island Packs";
        p.packSymbol = "IPACK";
        p.owner = creator;
        p.payout = creator;
        p.royaltyReceiver = creator;
        p.royaltyBps = 500;
        p.cardBaseURI = "ipfs://cards/";
        p.packBaseURI = "ipfs://packs/";
        p.rarities = new MultiSeaPacksStorage.Rarity[](3);
        p.rarities[0] = MultiSeaPacksStorage.Rarity("Common", 70, 700);
        p.rarities[1] = MultiSeaPacksStorage.Rarity("Rare", 25, 250);
        p.rarities[2] = MultiSeaPacksStorage.Rarity("Legendary", 5, 50);
        p.cards = new MultiSeaPacksStorage.CardType[](6);
        p.cards[0] = MultiSeaPacksStorage.CardType(1, 0);
        p.cards[1] = MultiSeaPacksStorage.CardType(1, 0);
        p.cards[2] = MultiSeaPacksStorage.CardType(2, 0);
        p.cards[3] = MultiSeaPacksStorage.CardType(2, 0);
        p.cards[4] = MultiSeaPacksStorage.CardType(3, 0);
        p.cards[5] = MultiSeaPacksStorage.CardType(3, 0);
        p.tiers = new MultiSeaPacksStorage.Tier[](2);
        p.tiers[0] = MultiSeaPacksStorage.Tier("Standard", 5, 0, 0, 0);
        p.tiers[1] = MultiSeaPacksStorage.Tier("Rare pack", 5, 2, 40, 0); // guaranteed 1 rare, max 40 packs
        p.phases = new MultiSeaPacksStorage.Phase[](1);
        p.phases[0] = MultiSeaPacksStorage.Phase(uint64(block.timestamp), 0, 0.01 ether, 0, 0, bytes32(0));
        p.eids = new uint32[](1);
        p.eids[0] = EID;
        p.hubEid = EID;
    }

    function cfg(MultiSeaPacksStorage.PackInit memory p) public pure returns (bytes32) {
        p.feeWallet = address(0);
        p.platformFeeBps = 0;
        return keccak256(abi.encode(p));
    }

    function sign(MultiSeaPacksStorage.PackInit memory p, bytes32 cid, uint256 dl) internal view returns (bytes memory) {
        bytes32 d = f.approvalDigest(creator, this.cfg(p), cid, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, d);
        return abi.encodePacked(r, s, v);
    }

    function deploy() internal returns (MultiSeaPacks packs, MultiSeaPackCards cards) {
        return deployCid(keccak256("island-packs"));
    }

    function deployCid(bytes32 cid) internal returns (MultiSeaPacks packs, MultiSeaPackCards cards) {
        MultiSeaPacksStorage.PackInit memory p = baseInit();
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = sign(p, cid, dl);
        uint256 g = gasleft();
        vm.prank(creator);
        (address a, address b) = f.createPackDrop(p, cid, dl, sig);
        emit log_named_uint("createPackDrop gas (incl. test overhead)", g - gasleft());
        packs = MultiSeaPacks(a);
        cards = MultiSeaPackCards(b);
    }

    function testCreateAndClone() public {
        address predicted = f.predictPacks(keccak256("island-packs"));
        address predictedCards = f.predictCards(keccak256("island-packs"));
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        assertEq(address(packs), predicted);
        assertEq(address(cards), predictedCards);
        assertTrue(f.isPacks(address(packs)));
        assertEq(packs.owner(), creator);
        assertEq(packs.feeWallet(), feeWallet);
        assertEq(packs.platformFeeBps(), 50);
        assertEq(packs.tierCount(), 2);
        assertEq(packs.rarityCount(), 3);
        assertEq(packs.cardTypeCount(), 6);
        assertEq(packs.remainingSlots(), 1000);
        assertEq(address(packs).code.length, 45); // EIP-1167
        assertEq(cards.packs(), address(packs));
        assertEq(cards.owner(), creator);
        assertEq(cards.name(), "Island Cards");
    }

    function testCannotReinitialize() public {
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        MultiSeaPacksStorage.PackInit memory p = baseInit();
        vm.expectRevert();
        packs.initialize(p, address(cards), address(0), bytes32(uint256(1)));
    }

    function testSignatureReplayAndTamper() public {
        MultiSeaPacksStorage.PackInit memory p = baseInit();
        uint256 dl = block.timestamp + 1 hours;
        bytes32 cid = keccak256("s");
        bytes memory sig = sign(p, cid, dl);
        vm.prank(alice);
        vm.expectRevert(MultiSeaPackFactory.BadSignature.selector);
        f.createPackDrop(p, cid, dl, sig);
        p.royaltyBps = 100;
        vm.prank(creator);
        vm.expectRevert(MultiSeaPackFactory.BadSignature.selector);
        f.createPackDrop(p, cid, dl, sig);
        p.royaltyBps = 500;
        vm.prank(creator);
        f.createPackDrop(p, cid, dl, sig);
        vm.prank(creator);
        vm.expectRevert(MultiSeaPackFactory.SaltUsed.selector);
        f.createPackDrop(p, cid, dl, sig);
    }

    function testMintAndBurnOnOpen() public {
        (MultiSeaPacks packs,) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.03 ether }(alice, 0, 1, 3, new bytes32[](0));
        assertEq(packs.balanceOf(alice, 1), 3);
        assertEq(packs.remainingSlots(), 1000 - 15);
        uint256 g = gasleft();
        vm.prank(alice);
        packs.open(1, 2);
        emit log_named_uint("open 2 packs gas (incl. test overhead)", g - gasleft());
        assertEq(packs.balanceOf(alice, 1), 1, "two packs burned, one sealed remains");
        (address o,, uint16 tier, uint16 qty, uint8 st,) = packs.commits(1);
        assertEq(o, alice);
        assertEq(tier, 1);
        assertEq(qty, 2);
        assertEq(st, packs.ST_PENDING());
    }

    function testRevealTooEarlyAndHappyPath() public {
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        vm.prank(alice);
        packs.open(1, 1);
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.RevealTooEarly.selector);
        packs.reveal(1);
        uint32 rb;
        (, rb,,,,) = packs.commits(1);
        vm.roll(rb); // still the reveal block itself
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.RevealTooEarly.selector);
        packs.reveal(1);
        vm.roll(rb + 1);
        uint256 g = gasleft();
        vm.prank(alice);
        packs.reveal(1);
        emit log_named_uint("reveal 1 standard pack (5 cards) gas", g - gasleft());
        assertEq(cards.balanceOf(alice), 5);
        assertEq(packs.mintedCards(), 5);
        (,,,, uint8 st,) = packs.commits(1);
        assertEq(st, packs.ST_REVEALED());
        // tokens 1..5 exist, have a card type in 1..6
        for (uint256 i = 1; i <= 5; ++i) {
            assertEq(cards.ownerOf(i), alice);
            uint16 typ = cards.cardTypeOf(i);
            assertTrue(typ >= 1 && typ <= 6);
            assertEq(cards.tokenURI(i), string.concat("ipfs://cards/", _s(typ), ".json"));
        }
        assertEq(packs.uri(1), "ipfs://packs/1.json");
    }

    function testCommitRevealExpiryAndRecommit() public {
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        vm.prank(alice);
        packs.open(1, 1);
        uint32 rb;
        (, rb,,,,) = packs.commits(1);
        // hash still available: cannot recommit (would let the user grind)
        vm.roll(rb + 1);
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.NotPending.selector);
        packs.recommit(1);
        // expire the hash (257 blocks after the reveal block: blockhash is 0)
        vm.roll(uint256(rb) + 257);
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.HashExpired.selector);
        packs.reveal(1);
        vm.prank(bob);
        vm.expectRevert(MultiSeaPacksStorage.NotCommitOwner.selector);
        packs.recommit(1);
        vm.prank(alice);
        packs.recommit(1);
        uint32 rb2;
        (, rb2,,,,) = packs.commits(1);
        assertEq(rb2, uint32(block.number + 3));
        vm.roll(rb2 + 1);
        vm.prank(alice);
        packs.reveal(1);
        assertEq(cards.balanceOf(alice), 5);
        // cannot recommit after a successful reveal
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.NotPending.selector);
        packs.recommit(1);
    }

    function testOnlyOwnerCanRevealTheirCommit() public {
        (MultiSeaPacks packs,) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        vm.prank(alice);
        packs.open(1, 1);
        uint32 rb; (, rb,,,,) = packs.commits(1);
        vm.roll(rb + 1);
        vm.prank(bob);
        vm.expectRevert(MultiSeaPacksStorage.NotCommitOwner.selector);
        packs.reveal(1);
    }

    function testRarityCapsEnforced() public {
        (MultiSeaPacks packs,) = deploy();
        // 200 standard packs * 5 = 1000 cards, exactly the cap
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            packs.mint{ value: 0.20 ether }(alice, 0, 1, 20, new bytes32[](0));
        }
        assertEq(packs.remainingSlots(), 0);
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.SoldOut.selector);
        packs.mint{ value: 0.01 ether }(alice, 0, 1, 1, new bytes32[](0));
        // guaranteed rare packs also consume remaining rare reservation — none left
        vm.prank(bob);
        vm.expectRevert(MultiSeaPacksStorage.SoldOut.selector);
        packs.mint{ value: 0.01 ether }(bob, 0, 2, 1, new bytes32[](0));
    }

    function testGuaranteedRareAndTierCap() public {
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.20 ether }(alice, 0, 2, 20, new bytes32[](0));
        vm.prank(alice);
        packs.mint{ value: 0.20 ether }(alice, 0, 2, 20, new bytes32[](0));
        vm.prank(alice);
        vm.expectRevert(MultiSeaPacksStorage.SoldOut.selector);
        packs.mint{ value: 0.01 ether }(alice, 0, 2, 1, new bytes32[](0));
        // open and reveal all 40 guaranteed-rare packs in batches of 10
        for (uint256 b; b < 4; ++b) {
            vm.prank(alice);
            packs.open(2, 10);
            uint256 id = b + 1;
            uint32 rb; (, rb,,,,) = packs.commits(id);
            vm.roll(rb + 1);
            vm.prank(alice);
            packs.reveal(id);
        }
        assertEq(cards.balanceOf(alice), 200);
        // at least 40 rares (types 3-4) — one guaranteed per pack
        uint256 rares;
        uint256 legs;
        for (uint256 i = 1; i <= 200; ++i) {
            uint16 typ = cards.cardTypeOf(i);
            uint8 r = typ <= 2 ? 1 : typ <= 4 ? 2 : 3;
            if (r == 2) ++rares;
            if (r == 3) ++legs;
        }
        assertGe(rares, 40, "guaranteed rare slot");
        assertLe(packs.rarityMinted(1), 250);
        assertLe(packs.rarityMinted(2), 50);
        legs;
    }

    function testRandomDistributionMatchesWeights() public {
        (MultiSeaPacks packs, MultiSeaPackCards cards) = deploy();
        // 100 standard packs * 5 = 500 cards: expect roughly 70/25/5
        for (uint256 i; i < 5; ++i) {
            vm.prank(alice);
            packs.mint{ value: 0.20 ether }(alice, 0, 1, 20, new bytes32[](0));
        }
        for (uint256 i; i < 100; ++i) {
            vm.prank(alice);
            packs.open(1, 1);
            uint32 rb; (, rb,,,,) = packs.commits(i + 1);
            // vary the reveal block a little so seeds differ
            vm.roll(rb + 1 + (i % 3));
            vm.prank(alice);
            packs.reveal(i + 1);
        }
        uint256[4] memory cnt; // 1..3
        uint256 n = cards.balanceOf(alice);
        assertEq(n, 500);
        for (uint256 i = 1; i <= n; ++i) {
            uint16 typ = cards.cardTypeOf(i);
            uint8 r = typ <= 2 ? 1 : typ <= 4 ? 2 : 3;
            ++cnt[r];
        }
        emit log_named_uint("commons", cnt[1]);
        emit log_named_uint("rares", cnt[2]);
        emit log_named_uint("legendaries", cnt[3]);
        // 70/25/5 of 500 = 350 / 125 / 25. Allow wide but useful bounds (binomial, ~6-8 sigma would be tighter;
        // use ±15pp on common/rare and a floor on legendary so a broken RNG fails).
        assertGt(cnt[1], 280);
        assertLt(cnt[1], 420);
        assertGt(cnt[2], 70);
        assertLt(cnt[2], 190);
        assertGt(cnt[3], 5);
        assertLt(cnt[3], 55);
        assertLe(cnt[1], 700);
        assertLe(cnt[2], 250);
        assertLe(cnt[3], 50);
    }

    function testWithdrawFeeSplit() public {
        (MultiSeaPacks packs,) = deploy();
        for (uint256 i; i < 5; ++i) {
            vm.prank(alice);
            packs.mint{ value: 0.20 ether }(alice, 0, 1, 20, new bytes32[](0));
        }
        uint256 beforeC = creator.balance;
        uint256 beforeF = feeWallet.balance;
        packs.withdraw();
        assertEq(creator.balance - beforeC, 1 ether - 0.005 ether);
        assertEq(feeWallet.balance - beforeF, 0.005 ether);
    }

    function testSealedPacksTransferable() public {
        (MultiSeaPacks packs,) = deploy();
        vm.prank(alice);
        packs.mint{ value: 0.02 ether }(alice, 0, 1, 2, new bytes32[](0));
        vm.prank(alice);
        packs.safeTransferFrom(alice, bob, 1, 1, "");
        assertEq(packs.balanceOf(alice, 1), 1);
        assertEq(packs.balanceOf(bob, 1), 1);
        vm.prank(bob);
        packs.open(1, 1);
        assertEq(packs.balanceOf(bob, 1), 0);
    }

    function testConfigHashMatchesFactory() public view {
        MultiSeaPacksStorage.PackInit memory p = baseInit();
        assertEq(this.cfg(p), f.configHash(p));
    }

    function _s(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { unchecked { ++len; j /= 10; } }
        bytes memory b = new bytes(len);
        while (v != 0) { unchecked { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; } }
        return string(b);
    }
}
