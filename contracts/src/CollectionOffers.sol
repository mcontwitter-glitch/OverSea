// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title CollectionOffers
/// @notice Escrowed collection offers paid in the chain's native coin. One deployment per chain
///         (same bytecode, CREATE2 for a shared address). A buyer deposits price × quantity;
///         any current holder of that collection on this chain can accept one NFT per fill.
///         There is no admin withdrawal, sweep, or pause that can trap user funds. The owner
///         may only rotate the marketplace fee recipient. Fee bps are immutable (0.5%).
contract CollectionOffers is ReentrancyGuard, Ownable {
    uint16 public constant FEE_BPS = 50; // 0.5%, same as MultiSea native listings
    uint16 public constant MAX_ROYALTY_BPS = 1000; // 10%
    uint16 public constant BPS_DENOM = 10_000;
    uint32 public constant MAX_QUANTITY = 100_000;
    uint256 public constant MAX_EXPIRY = 180 days;

    address public feeRecipient;
    uint256 public nextId;
    uint256 public totalEscrowed;

    struct Offer {
        address buyer;
        address collection;
        address royaltyRecipient;
        uint96 pricePerItem;
        uint32 remaining;
        uint40 expiry;
        uint16 royaltyBps;
        bool cancelled;
    }

    mapping(uint256 => Offer) public offers;

    event OfferMade(
        uint256 indexed id,
        address indexed buyer,
        address indexed collection,
        uint256 pricePerItem,
        uint256 quantity,
        uint256 expiry,
        address royaltyRecipient,
        uint16 royaltyBps
    );
    event OfferAccepted(uint256 indexed id, address indexed seller, uint256 indexed tokenId, uint256 remaining);
    event OfferCancelled(uint256 indexed id, uint256 refunded);
    event OfferRefunded(uint256 indexed id, uint256 refunded);
    event FeeRecipientUpdated(address indexed previous, address indexed current);

    error InvalidPrice();
    error InvalidQuantity();
    error InvalidCollection();
    error InvalidExpiry();
    error InvalidRoyalty();
    error InvalidFeeRecipient();
    error WrongValue();
    error NotBuyer();
    error OfferClosed();
    error OfferExpired();
    error OfferNotExpired();
    error NotTokenOwner();
    error BuyerCannotAccept();
    error TransferFailed();

    constructor(address owner_, address feeRecipient_) Ownable(owner_) {
        if (feeRecipient_ == address(0)) revert InvalidFeeRecipient();
        feeRecipient = feeRecipient_;
    }

    /// @notice Rotate the marketplace fee recipient. Cannot touch escrowed funds.
    function setFeeRecipient(address next) external onlyOwner {
        if (next == address(0)) revert InvalidFeeRecipient();
        emit FeeRecipientUpdated(feeRecipient, next);
        feeRecipient = next;
    }

    /// @notice Deposit native coin for a collection-wide offer. Royalty is locked in at make time
    ///         so a later collection-config change cannot surprise buyer or seller.
    function makeOffer(
        address collection,
        uint256 pricePerItem,
        uint256 quantity,
        uint256 expiry,
        address royaltyRecipient,
        uint16 royaltyBps
    ) external payable nonReentrant returns (uint256 id) {
        if (collection == address(0) || collection.code.length == 0) revert InvalidCollection();
        if (pricePerItem == 0 || pricePerItem > type(uint96).max) revert InvalidPrice();
        if (quantity == 0 || quantity > MAX_QUANTITY) revert InvalidQuantity();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) revert InvalidExpiry();
        if (royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyalty();
        if (royaltyBps > 0 ? royaltyRecipient == address(0) : royaltyRecipient != address(0)) revert InvalidRoyalty();

        uint256 total = pricePerItem * quantity;
        if (msg.value != total) revert WrongValue();

        id = ++nextId;
        offers[id] = Offer({
            buyer: msg.sender,
            collection: collection,
            royaltyRecipient: royaltyRecipient,
            pricePerItem: uint96(pricePerItem),
            remaining: uint32(quantity),
            expiry: uint40(expiry),
            royaltyBps: royaltyBps,
            cancelled: false
        });
        totalEscrowed += total;
        emit OfferMade(id, msg.sender, collection, pricePerItem, quantity, expiry, royaltyRecipient, royaltyBps);
    }

    /// @notice Fill one item of an open offer by transferring `tokenId` of the offer's collection.
    ///         Caller must be the current owner and must have approved this contract.
    function accept(uint256 id, uint256 tokenId) external nonReentrant {
        Offer storage o = offers[id];
        if (o.remaining == 0 || o.cancelled) revert OfferClosed();
        if (block.timestamp >= o.expiry) revert OfferExpired();
        if (msg.sender == o.buyer) revert BuyerCannotAccept();

        IERC721 nft = IERC721(o.collection);
        if (nft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        // Effects before any external call (NFT hook or ETH receivers).
        o.remaining -= 1;
        uint256 remaining = o.remaining;
        uint256 price = o.pricePerItem;
        totalEscrowed -= price;

        address buyer = o.buyer;
        address royTo = o.royaltyRecipient;
        uint16 royBps = o.royaltyBps;
        address feeTo = feeRecipient;

        nft.safeTransferFrom(msg.sender, buyer, tokenId);

        uint256 fee = (price * FEE_BPS) / BPS_DENOM;
        uint256 royalty = royBps == 0 ? 0 : (price * royBps) / BPS_DENOM;
        _pay(feeTo, fee);
        if (royalty != 0) _pay(royTo, royalty);
        _pay(msg.sender, price - fee - royalty);

        emit OfferAccepted(id, msg.sender, tokenId, remaining);
    }

    /// @notice Buyer withdraws the unused remainder at any time.
    function cancel(uint256 id) external nonReentrant {
        Offer storage o = offers[id];
        if (msg.sender != o.buyer) revert NotBuyer();
        _closeAndRefund(o, id, true);
    }

    /// @notice After expiry, unused funds are refunded to the buyer. Anyone may trigger it.
    function refundExpired(uint256 id) external nonReentrant {
        Offer storage o = offers[id];
        if (o.remaining == 0 || o.cancelled) revert OfferClosed();
        if (block.timestamp < o.expiry) revert OfferNotExpired();
        _closeAndRefund(o, id, false);
    }

    function _closeAndRefund(Offer storage o, uint256 id, bool isCancel) internal {
        uint256 qty = o.remaining;
        if (qty == 0 || o.cancelled) revert OfferClosed();
        uint256 refund = qty * uint256(o.pricePerItem);
        o.remaining = 0;
        o.cancelled = true;
        totalEscrowed -= refund;
        _pay(o.buyer, refund);
        if (isCancel) emit OfferCancelled(id, refund);
        else emit OfferRefunded(id, refund);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    /// @notice ETH still reserved for an offer (`remaining * pricePerItem`, or 0 if closed).
    function lockedValue(uint256 id) external view returns (uint256) {
        Offer storage o = offers[id];
        if (o.cancelled) return 0;
        return uint256(o.remaining) * uint256(o.pricePerItem);
    }
}
