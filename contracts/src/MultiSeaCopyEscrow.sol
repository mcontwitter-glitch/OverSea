// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { MultiSeaEscrow } from "./MultiSeaEscrow.sol";

/// @notice Existing LIL FOOTS copy contracts (AccessControl ERC721 with MINTER_ROLE).
interface ICopyNFT {
    function mintWithURI(address to, uint256 tokenId, string calldata uri) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title MultiSeaCopyEscrow
/// @notice Escrow for chains where the collection already exists as a role-gated copy contract that mints on demand.
///         Outbound: lock (same as MultiSeaEscrow). Inbound: release the token if this escrow holds it, otherwise
///         mint it with `mintWithURI` (this escrow must hold MINTER_ROLE on the copy contract).
///         The owner can pre-mint missing ids into the escrow so every id exists on this chain.
contract MultiSeaCopyEscrow is MultiSeaEscrow {
    using Strings for uint256;

    string public baseURI;
    uint256 public immutable firstId;
    uint256 public immutable lastId;

    event BaseURI(string baseURI);
    event PreMinted(uint256 count);

    error OutOfRange(uint256 tokenId);
    error AlreadyExists(uint256 tokenId);

    constructor(
        address _endpoint, address _owner, address _nft, address _feeWallet, address _priceFeed, uint256 _maxPriceAge,
        string memory _baseURI, uint256 _firstId, uint256 _lastId
    ) MultiSeaEscrow(_endpoint, _owner, _nft, false, _feeWallet, _priceFeed, _maxPriceAge) {
        baseURI = _baseURI; firstId = _firstId; lastId = _lastId;
        emit BaseURI(_baseURI);
    }

    function exists(uint256 tokenId) public view returns (bool) {
        try ICopyNFT(address(nft)).ownerOf(tokenId) returns (address o) { return o != address(0); } catch { return false; }
    }

    function _mintCopy(address to, uint256 tokenId) internal {
        if (tokenId < firstId || tokenId > lastId) revert OutOfRange(tokenId);
        ICopyNFT(address(nft)).mintWithURI(to, tokenId, string.concat(baseURI, tokenId.toString()));
    }

    function _lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata)
        internal override nonReentrant
    {
        (address to, uint256 tokenId) = abi.decode(message, (address, uint256));
        if (!exists(tokenId)) {
            _mintCopy(to, tokenId);
        } else {
            if (nft.ownerOf(tokenId) != address(this)) revert NotHeld(tokenId);
            nft.safeTransferFrom(address(this), to, tokenId);
        }
        emit BridgeIn(guid, origin.srcEid, to, tokenId);
    }

    /// @notice Pre-mint ids that do not exist on this chain yet into this escrow (they stay locked until bridged in).
    function preMint(uint256[] calldata ids) external onlyOwner nonReentrant {
        for (uint256 i; i < ids.length; ++i) {
            if (exists(ids[i])) revert AlreadyExists(ids[i]);
            _mintCopy(address(this), ids[i]);
        }
        emit PreMinted(ids.length);
    }

    function setBaseURI(string calldata u) external onlyOwner { baseURI = u; emit BaseURI(u); }
}
