// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IMultiSeaMirror {
    function exists(uint256 tokenId) external view returns (bool);
    function mintFromEscrow(address to, uint256 tokenId) external;
}

/// @title MultiSeaEscrow
/// @notice Per-chain escrow contract for one collection. Holders lock a token here and a LayerZero v2
///         message tells the escrow on the destination chain to release the same tokenId to the recipient.
///         On the collection's native chain `nft` is the original ERC721; on other chains it is a MultiSeaMirror
///         whose entire supply is held by this escrow (lazily materialised on first release).
contract MultiSeaEscrow is OApp, ReentrancyGuard, IERC721Receiver {
    /// @notice Platform fee in USD with 8 decimals: $0.30.
    uint256 public constant FEE_USD_8 = 30_000_000;

    IERC721 public immutable nft;
    bool public immutable isMirror;
    address public feeWallet;
    IAggregatorV3 public priceFeed;
    uint256 public maxPriceAge; // seconds

    event BridgeOut(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, address to, uint256 tokenId, uint256 platformFee);
    event BridgeIn(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 tokenId);
    event FeeConfig(address feeWallet, address priceFeed, uint256 maxPriceAge);

    error StalePrice();
    error BadPrice();
    error InsufficientFee(uint256 required, uint256 sent);
    error NotHeld(uint256 tokenId);
    error ZeroAddress();
    error PayFailed();

    constructor(
        address _endpoint,
        address _owner,
        address _nft,
        bool _isMirror,
        address _feeWallet,
        address _priceFeed,
        uint256 _maxPriceAge
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_nft == address(0) || _feeWallet == address(0) || _priceFeed == address(0)) revert ZeroAddress();
        nft = IERC721(_nft);
        isMirror = _isMirror;
        feeWallet = _feeWallet;
        priceFeed = IAggregatorV3(_priceFeed);
        maxPriceAge = _maxPriceAge;
        emit FeeConfig(_feeWallet, _priceFeed, _maxPriceAge);
    }

    // ------------------------------------------------------------------ fees
    /// @notice $0.30 in wei at the current Chainlink ETH/USD price (rounded up).
    function platformFee() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (updatedAt == 0 || block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
        uint256 dec = priceFeed.decimals();
        // fee = 0.30 USD * 1e18 / price ; FEE_USD_8 has 8 decimals, price has `dec` decimals
        uint256 num = FEE_USD_8 * 1e18 * (10 ** dec);
        uint256 den = uint256(answer) * 1e8;
        return (num + den - 1) / den;
    }

    function _payload(address to, uint256 tokenId) internal pure returns (bytes memory) {
        return abi.encode(to, tokenId);
    }

    /// @notice Returns (platform fee, LayerZero native fee) for a bridge call.
    function quote(uint32 dstEid, address to, uint256 tokenId, bytes calldata options)
        external view returns (uint256 platform, uint256 lzFee)
    {
        platform = platformFee();
        MessagingFee memory f = _quote(dstEid, _payload(to, tokenId), options, false);
        lzFee = f.nativeFee;
    }

    // ---------------------------------------------------------------- bridge
    /// @notice Lock `tokenId` here and release it to `to` on `dstEid`. Caller must own it and have approved this escrow.
    ///         msg.value must cover platformFee() + the LayerZero fee from quote(); any excess is refunded.
    function bridge(uint32 dstEid, address to, uint256 tokenId, bytes calldata options)
        external payable nonReentrant returns (MessagingReceipt memory receipt)
    {
        if (to == address(0)) revert ZeroAddress();
        uint256 pfee = platformFee();
        bytes memory payload = _payload(to, tokenId);
        MessagingFee memory f = _quote(dstEid, payload, options, false);
        uint256 required = pfee + f.nativeFee;
        if (msg.value < required) revert InsufficientFee(required, msg.value);

        nft.transferFrom(msg.sender, address(this), tokenId); // reverts unless caller owns/approved

        receipt = _lzSend(dstEid, payload, options, MessagingFee(f.nativeFee, 0), payable(msg.sender));

        _pay(feeWallet, pfee);
        uint256 extra = msg.value - required;
        if (extra > 0) _pay(msg.sender, extra);
        emit BridgeOut(receipt.guid, dstEid, msg.sender, to, tokenId, pfee);
    }

    /// @dev Only the endpoint can call lzReceive, and OAppReceiver rejects any sender that is not the configured peer.
    function _lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata)
        internal virtual override nonReentrant
    {
        (address to, uint256 tokenId) = abi.decode(message, (address, uint256));
        if (isMirror && !IMultiSeaMirror(address(nft)).exists(tokenId)) {
            IMultiSeaMirror(address(nft)).mintFromEscrow(to, tokenId);
        } else {
            if (nft.ownerOf(tokenId) != address(this)) revert NotHeld(tokenId);
            nft.safeTransferFrom(address(this), to, tokenId);
        }
        emit BridgeIn(guid, origin.srcEid, to, tokenId);
    }

    function _payNative(uint256 _nativeFee) internal override returns (uint256) {
        // msg.value also carries the platform fee, so only forward the LayerZero part to the endpoint.
        if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
        return _nativeFee;
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{ value: amount }("");
        if (!ok) revert PayFailed();
    }

    // ----------------------------------------------------------------- admin
    function setFeeConfig(address _feeWallet, address _priceFeed, uint256 _maxPriceAge) external onlyOwner {
        if (_feeWallet == address(0) || _priceFeed == address(0)) revert ZeroAddress();
        feeWallet = _feeWallet;
        priceFeed = IAggregatorV3(_priceFeed);
        maxPriceAge = _maxPriceAge;
        emit FeeConfig(_feeWallet, _priceFeed, _maxPriceAge);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
