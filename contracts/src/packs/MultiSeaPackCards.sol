// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import { ERC2981 } from "@openzeppelin/contracts/token/common/ERC2981.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title MultiSeaPackCards
/// @notice ERC-721 cards lazy-minted when a sealed pack is revealed. Token IDs are assigned by the pack drop (the hub
///         in a multichain drop). Only the paired MultiSeaPacks contract may mint, lock, or release.
contract MultiSeaPackCards is ERC721Upgradeable, ERC2981 {
    address public packs;
    address public owner;
    bool public metadataFrozen;
    string private _base;
    mapping(uint256 => uint16) public cardTypeOf; // tokenId => card type (1-indexed)

    event MetadataFrozen();
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    error NotPacks();
    error Frozen();
    error BadParams();

    modifier onlyPacks() { if (msg.sender != packs) revert NotPacks(); _; }

    constructor() { _disableInitializers(); }

    function initialize(string calldata name_, string calldata symbol_, address packs_, string calldata baseURI_)
        external
        initializer
    {
        if (packs_ == address(0)) revert BadParams();
        __ERC721_init(name_, symbol_);
        packs = packs_;
        _base = baseURI_;
    }

    /// @dev Called once by the paired packs contract during its initialize.
    function bind(address owner_, address royaltyReceiver, uint96 royaltyBps) external {
        if (msg.sender != packs) revert NotPacks();
        if (owner != address(0)) revert BadParams();
        owner = owner_;
        if (royaltyBps > 0) _setDefaultRoyalty(royaltyReceiver == address(0) ? owner_ : royaltyReceiver, royaltyBps);
    }

    function mintActive(address to, uint256 startId, uint16[] calldata types) external onlyPacks {
        uint256 n = types.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = startId + i;
            cardTypeOf[id] = types[i];
            _mint(to, id);
        }
        if (n > 0) emit BatchMetadataUpdate(startId, startId + n - 1);
    }

    function mintEscrow(address escrow, uint256 startId, uint16[] calldata types) external onlyPacks {
        uint256 n = types.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = startId + i;
            if (_ownerOf(id) == address(0)) {
                cardTypeOf[id] = types[i];
                _mint(escrow, id);
            }
        }
    }

    function lock(address from, uint256 tokenId, address escrow) external onlyPacks {
        _transfer(from, escrow, tokenId);
    }

    function release(address to, uint256 tokenId, address escrow) external onlyPacks {
        address o = _ownerOf(tokenId);
        if (o == address(0)) revert BadParams();
        if (o != escrow) revert BadParams();
        _transfer(escrow, to, tokenId);
    }

    function exists(uint256 tokenId) external view returns (bool) { return _ownerOf(tokenId) != address(0); }

    function existsHere(uint256 tokenId) external view returns (bool) { return _ownerOf(tokenId) != address(0); }

    function setBaseURI(string calldata baseURI_) external {
        if (msg.sender != owner) revert NotPacks();
        if (metadataFrozen) revert Frozen();
        _base = baseURI_;
    }

    function freezeMetadata() external {
        if (msg.sender != owner) revert NotPacks();
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string(abi.encodePacked(_base, _toString(cardTypeOf[id]), ".json"));
    }

    function supportsInterface(bytes4 id) public view override(ERC721Upgradeable, ERC2981) returns (bool) {
        return ERC721Upgradeable.supportsInterface(id) || ERC2981.supportsInterface(id) || id == bytes4(0x49064906);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { unchecked { ++len; j /= 10; } }
        bytes memory b = new bytes(len);
        while (v != 0) { unchecked { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; } }
        return string(b);
    }
}
