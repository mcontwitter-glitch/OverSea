// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { CollectionOffers } from "../src/CollectionOffers.sol";

contract MockNFT is ERC721 {
    constructor() ERC721("Mock", "MOCK") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// @dev Transfer hook tries to re-enter accept with a second token the seller also holds.
contract ReenteringNFT is ERC721 {
    CollectionOffers public offers;
    uint256 public otherId;
    bool public attack;
    constructor() ERC721("Reenter", "RNFT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
    function setAttack(CollectionOffers o, uint256 other) external { offers = o; otherId = other; attack = true; }
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address prev = super._update(to, tokenId, auth);
        if (attack && address(offers) != address(0) && otherId != tokenId) {
            attack = false;
            offers.accept(1, otherId);
        }
        return prev;
    }
}

contract GreedyBuyer is IERC721Receiver {
    CollectionOffers public offers;
    uint256 public offerId;
    uint256 public otherToken;
    bool public go;
    function arm(CollectionOffers o, uint256 id, uint256 token) external { offers = o; offerId = id; otherToken = token; go = true; }
    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        if (go) {
            go = false;
            try offers.accept(offerId, otherToken) {} catch {}
            try offers.cancel(offerId) {} catch {}
        }
        return this.onERC721Received.selector;
    }
    receive() external payable {}
}

contract ReenteringSeller {
    CollectionOffers public offers;
    uint256 public offerId;
    uint256 public otherToken;
    bool public go;
    function arm(CollectionOffers o, uint256 id, uint256 token) external { offers = o; offerId = id; otherToken = token; go = true; }
    function onToken(uint256 /*id*/) external {}
    receive() external payable {
        if (go) {
            go = false;
            try offers.accept(offerId, otherToken) {} catch {}
            try offers.cancel(offerId) {} catch {}
        }
    }
    function approveAndAccept(CollectionOffers o, MockNFT nft, uint256 id, uint256 tokenId) external {
        nft.approve(address(o), tokenId);
        o.accept(id, tokenId);
    }
}

contract RejectEther {
    MockNFT public nft;
    constructor(MockNFT n) { nft = n; }
    function approveAndAccept(CollectionOffers o, uint256 id, uint256 tokenId) external {
        nft.approve(address(o), tokenId);
        o.accept(id, tokenId);
    }
}

contract CollectionOffersTest is Test {
    CollectionOffers offers;
    MockNFT nft;
    MockNFT other;
    address owner = address(0xB19F);
    address fee = address(0xFEE);
    address buyer = address(0xB0B);
    address seller = address(0x5E11);
    address royalty = address(0x401);
    address escrow = address(0xE5C);
    uint256 constant PRICE = 1 ether;

    function setUp() public {
        offers = new CollectionOffers(owner, fee);
        nft = new MockNFT();
        other = new MockNFT();
        vm.deal(buyer, 100 ether);
        vm.deal(seller, 1 ether);
        nft.mint(seller, 1);
        nft.mint(seller, 2);
        nft.mint(seller, 3);
        nft.mint(escrow, 99);
    }

    function _make(uint256 price, uint256 qty, uint256 duration, address royTo, uint16 royBps) internal returns (uint256 id) {
        vm.prank(buyer);
        id = offers.makeOffer{ value: price * qty }(address(nft), price, qty, block.timestamp + duration, royTo, royBps);
    }

    function _approve() internal { vm.prank(seller); nft.setApprovalForAll(address(offers), true); }

    function test_makeOffer_locksExactValue() public {
        uint256 id = _make(PRICE, 3, 7 days, address(0), 0);
        (address b, address col,, uint96 price, uint32 rem, uint40 exp,, bool cancelled) = offers.offers(id);
        assertEq(b, buyer);
        assertEq(col, address(nft));
        assertEq(price, PRICE);
        assertEq(rem, 3);
        assertFalse(cancelled);
        assertGt(exp, block.timestamp);
        assertEq(address(offers).balance, 3 ether);
        assertEq(offers.totalEscrowed(), 3 ether);
        assertEq(offers.lockedValue(id), 3 ether);
    }

    function test_accept_paysFeeAndSeller() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        _approve();
        uint256 s0 = seller.balance;
        uint256 f0 = fee.balance;
        vm.prank(seller);
        offers.accept(id, 1);
        assertEq(nft.ownerOf(1), buyer);
        uint256 feeAmt = PRICE * 50 / 10_000; // 0.005 ether
        assertEq(fee.balance - f0, feeAmt);
        assertEq(seller.balance - s0, PRICE - feeAmt);
        assertEq(offers.totalEscrowed(), 0);
        assertEq(address(offers).balance, 0);
        (,,,, uint32 rem,,,) = offers.offers(id);
        assertEq(rem, 0);
    }

    function test_accept_paysRoyaltyAndFee() public {
        // 5% royalty + 0.5% fee, seller gets remainder
        uint256 id = _make(PRICE, 1, 7 days, royalty, 500);
        _approve();
        uint256 s0 = seller.balance; uint256 f0 = fee.balance; uint256 r0 = royalty.balance;
        vm.prank(seller);
        offers.accept(id, 1);
        assertEq(fee.balance - f0, 0.005 ether);
        assertEq(royalty.balance - r0, 0.05 ether);
        assertEq(seller.balance - s0, 0.945 ether);
        assertEq(address(offers).balance, 0);
    }

    function test_partialFills_thenCancelRefundsRemainder() public {
        uint256 id = _make(PRICE, 3, 7 days, address(0), 0);
        _approve();
        vm.prank(seller);
        offers.accept(id, 1);
        vm.prank(seller);
        offers.accept(id, 2);
        assertEq(offers.totalEscrowed(), 1 ether);
        uint256 b0 = buyer.balance;
        vm.prank(buyer);
        offers.cancel(id);
        assertEq(buyer.balance - b0, 1 ether);
        assertEq(offers.totalEscrowed(), 0);
        assertEq(address(offers).balance, 0);
        vm.prank(seller);
        vm.expectRevert(CollectionOffers.OfferClosed.selector);
        offers.accept(id, 3);
    }

    function test_cancel_onlyBuyer() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        vm.prank(seller);
        vm.expectRevert(CollectionOffers.NotBuyer.selector);
        offers.cancel(id);
        uint256 b0 = buyer.balance;
        vm.prank(buyer);
        offers.cancel(id);
        assertEq(buyer.balance - b0, PRICE);
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.OfferClosed.selector);
        offers.cancel(id);
    }

    function test_expiry_acceptReverts_anyoneCanRefundBuyer() public {
        uint256 id = _make(PRICE, 2, 1 days, address(0), 0);
        vm.warp(block.timestamp + 1 days);
        _approve();
        vm.prank(seller);
        vm.expectRevert(CollectionOffers.OfferExpired.selector);
        offers.accept(id, 1);
        address stranger = address(0xABCD);
        uint256 b0 = buyer.balance;
        vm.prank(stranger);
        offers.refundExpired(id);
        assertEq(buyer.balance - b0, 2 ether);
        assertEq(offers.totalEscrowed(), 0);
        vm.prank(stranger);
        vm.expectRevert(CollectionOffers.OfferClosed.selector);
        offers.refundExpired(id);
    }

    function test_refundExpired_beforeExpiryReverts() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        vm.expectRevert(CollectionOffers.OfferNotExpired.selector);
        offers.refundExpired(id);
    }

    function test_nonOwnerCannotAccept() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        _approve();
        address rando = address(0xD00D);
        vm.prank(rando);
        vm.expectRevert(CollectionOffers.NotTokenOwner.selector);
        offers.accept(id, 1);
    }

    function test_escrowedToken_previousHolderCannotAccept() public {
        // Token 99 is owned by the escrow contract, not the previous holder.
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        vm.prank(seller);
        nft.setApprovalForAll(address(offers), true);
        vm.prank(seller);
        vm.expectRevert(CollectionOffers.NotTokenOwner.selector);
        offers.accept(id, 99);
        // The escrow itself could theoretically approve and accept; that is the current owner, which is correct.
        // A holder who already bridged away is not the owner and is rejected above.
    }

    function test_wrongCollection_tokenFromOtherNftDoesNotFill() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        other.mint(seller, 1);
        vm.prank(seller);
        other.setApprovalForAll(address(offers), true);
        // accept reads ownerOf on the offer's collection, so token 1 of `nft` is still required.
        // seller owns nft #1, but we transfer ownership of nft #1 away first:
        vm.prank(seller);
        nft.transferFrom(seller, address(0xDEAD), 1);
        vm.prank(seller);
        vm.expectRevert(CollectionOffers.NotTokenOwner.selector);
        offers.accept(id, 1);
    }

    function test_missingApprovalReverts() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        vm.prank(seller);
        vm.expectRevert(); // ERC721 insufficient approval
        offers.accept(id, 1);
    }

    function test_buyerCannotAcceptOwnOffer() public {
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        nft.mint(buyer, 7);
        vm.prank(buyer);
        nft.approve(address(offers), 7);
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.BuyerCannotAccept.selector);
        offers.accept(id, 7);
    }

    function test_reenteringNft_cannotDoubleFill() public {
        ReenteringNFT evil = new ReenteringNFT();
        vm.deal(buyer, 10 ether);
        evil.mint(seller, 1);
        evil.mint(seller, 2);
        vm.prank(buyer);
        uint256 id = offers.makeOffer{ value: 2 ether }(address(evil), PRICE, 2, block.timestamp + 7 days, address(0), 0);
        assertEq(id, 1);
        vm.prank(seller);
        evil.setApprovalForAll(address(offers), true);
        evil.setAttack(offers, 2);
        // The hook tries to accept token 2 in the middle of accepting token 1; the guard must stop it.
        vm.prank(seller);
        vm.expectRevert(); // ReentrancyGuardReentrantCall
        offers.accept(id, 1);
        // Offer still fully open; no NFT moved; escrow intact.
        assertEq(evil.ownerOf(1), seller);
        assertEq(offers.totalEscrowed(), 2 ether);
        assertEq(address(offers).balance, 2 ether);
    }

    function test_greedyBuyerReceiver_cannotReenter() public {
        GreedyBuyer gb = new GreedyBuyer();
        vm.deal(address(gb), 10 ether);
        nft.mint(seller, 10);
        nft.mint(seller, 11);
        vm.prank(address(gb));
        uint256 id = offers.makeOffer{ value: 2 ether }(address(nft), PRICE, 2, block.timestamp + 7 days, address(0), 0);
        _approve();
        // Buyer also somehow owns token 11? No — seller owns both. The receiver tries accept(11) and cancel.
        // accept(11) would require the buyer to own 11, which they don't (yet). cancel is only buyer — the
        // callback is from the buyer contract, so cancel could succeed if the guard were missing and remaining
        // had not been fully thought through. Guard must block both.
        gb.arm(offers, id, 11);
        uint256 f0 = fee.balance;
        vm.prank(seller);
        offers.accept(id, 10);
        assertEq(nft.ownerOf(10), address(gb));
        // Second item still open (reentrant accept failed); escrow reduced by one fill only.
        assertEq(offers.totalEscrowed(), 1 ether);
        assertEq(fee.balance - f0, 0.005 ether);
        (,,,, uint32 rem,,,) = offers.offers(id);
        assertEq(rem, 1);
    }

    function test_reenteringSeller_cannotReenterOnPayment() public {
        ReenteringSeller rs = new ReenteringSeller();
        nft.mint(address(rs), 20);
        nft.mint(address(rs), 21);
        uint256 id = _make(PRICE, 2, 7 days, address(0), 0);
        rs.arm(offers, id, 21);
        rs.approveAndAccept(offers, nft, id, 20);
        assertEq(nft.ownerOf(20), buyer);
        assertEq(offers.totalEscrowed(), 1 ether);
        (,,,, uint32 rem,,,) = offers.offers(id);
        assertEq(rem, 1);
    }

    function test_rejectEtherSeller_wholeTxReverts() public {
        RejectEther bad = new RejectEther(nft);
        nft.mint(address(bad), 30);
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        vm.expectRevert(CollectionOffers.TransferFailed.selector);
        bad.approveAndAccept(offers, id, 30);
        assertEq(nft.ownerOf(30), address(bad));
        assertEq(offers.totalEscrowed(), PRICE);
    }

    function test_zeroPriceReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidPrice.selector);
        offers.makeOffer{ value: 0 }(address(nft), 0, 1, block.timestamp + 1 days, address(0), 0);
    }

    function test_zeroQtyReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidQuantity.selector);
        offers.makeOffer{ value: 0 }(address(nft), PRICE, 0, block.timestamp + 1 days, address(0), 0);
    }

    function test_qtyAboveMaxReverts() public {
        uint256 qty = uint256(offers.MAX_QUANTITY()) + 1;
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidQuantity.selector);
        offers.makeOffer{ value: 0 }(address(nft), PRICE, qty, block.timestamp + 1 days, address(0), 0);
    }

    function test_zeroCollectionReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidCollection.selector);
        offers.makeOffer{ value: PRICE }(address(0), PRICE, 1, block.timestamp + 1 days, address(0), 0);
    }

    function test_eoaCollectionReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidCollection.selector);
        offers.makeOffer{ value: PRICE }(address(0x1234), PRICE, 1, block.timestamp + 1 days, address(0), 0);
    }

    function test_wrongValueReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.WrongValue.selector);
        offers.makeOffer{ value: PRICE - 1 }(address(nft), PRICE, 1, block.timestamp + 1 days, address(0), 0);
    }

    function test_expiryInPastReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidExpiry.selector);
        offers.makeOffer{ value: PRICE }(address(nft), PRICE, 1, block.timestamp, address(0), 0);
    }

    function test_expiryTooFarReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidExpiry.selector);
        offers.makeOffer{ value: PRICE }(address(nft), PRICE, 1, block.timestamp + 180 days + 1, address(0), 0);
    }

    function test_royaltyTooHighReverts() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidRoyalty.selector);
        offers.makeOffer{ value: PRICE }(address(nft), PRICE, 1, block.timestamp + 1 days, royalty, 1001);
    }

    function test_royaltyRecipientRequiredWhenBpsSet() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidRoyalty.selector);
        offers.makeOffer{ value: PRICE }(address(nft), PRICE, 1, block.timestamp + 1 days, address(0), 100);
    }

    function test_royaltyRecipientRejectedWhenBpsZero() public {
        vm.prank(buyer);
        vm.expectRevert(CollectionOffers.InvalidRoyalty.selector);
        offers.makeOffer{ value: PRICE }(address(nft), PRICE, 1, block.timestamp + 1 days, royalty, 0);
    }

    function test_setFeeRecipient_onlyOwner_andCannotSweep() public {
        vm.expectRevert();
        offers.setFeeRecipient(address(0x1111));
        vm.prank(owner);
        vm.expectRevert(CollectionOffers.InvalidFeeRecipient.selector);
        offers.setFeeRecipient(address(0));
        vm.prank(owner);
        offers.setFeeRecipient(address(0x1111));
        assertEq(offers.feeRecipient(), address(0x1111));
        // Later fills go to the new recipient; escrow cannot be withdrawn by owner.
        uint256 id = _make(PRICE, 1, 7 days, address(0), 0);
        assertEq(offers.totalEscrowed(), PRICE);
        // no withdraw/sweep function — low-level calls must return false, funds stay locked
        vm.prank(owner);
        (bool ok,) = address(offers).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(ok);
        vm.prank(owner);
        (ok,) = address(offers).call(abi.encodeWithSignature("sweep(address)", owner));
        assertFalse(ok);
        assertEq(address(offers).balance, PRICE);
        _approve();
        vm.prank(seller);
        offers.accept(id, 1);
        assertEq(address(0x1111).balance, 0.005 ether);
    }

    function test_feeRounding_dustGoesToSeller() public {
        // price 10000 wei: fee = 50, royalty 0, seller 9950
        uint256 price = 10_000;
        vm.prank(buyer);
        uint256 id = offers.makeOffer{ value: price }(address(nft), price, 1, block.timestamp + 1 days, address(0), 0);
        _approve();
        uint256 s0 = seller.balance;
        vm.prank(seller);
        offers.accept(id, 1);
        assertEq(fee.balance, 50);
        assertEq(seller.balance - s0, 9950);
    }

    function test_invariant_balanceCoversEscrow_afterMixedOps() public {
        uint256 a = _make(PRICE, 2, 7 days, address(0), 0);
        uint256 b = _make(0.5 ether, 4, 30 days, royalty, 250);
        _approve();
        vm.prank(seller);
        offers.accept(a, 1);
        vm.prank(buyer);
        offers.cancel(b);
        assertEq(address(offers).balance, offers.totalEscrowed());
        assertEq(offers.totalEscrowed(), PRICE); // one item left on offer a
        vm.warp(block.timestamp + 8 days);
        vm.prank(address(0x1));
        offers.refundExpired(a);
        assertEq(address(offers).balance, 0);
        assertEq(offers.totalEscrowed(), 0);
    }

    function test_constructor_rejectsZeroFeeRecipient() public {
        vm.expectRevert(CollectionOffers.InvalidFeeRecipient.selector);
        new CollectionOffers(owner, address(0));
    }
}

// silence unused-import if any
contract _ReceiverStub is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
