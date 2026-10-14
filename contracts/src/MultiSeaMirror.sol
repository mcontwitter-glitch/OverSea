// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MultiSeaMirror
/// @notice Mirror of a native collection on another chain. The full supply [firstId, firstId+supply) belongs to the
///         escrow from deployment: ownerOf/balanceOf report the escrow for every token not yet materialised, and the
///         escrow materialises a token (a real mint, Transfer event from 0) the first time it releases it.
///         This is equivalent to minting the whole supply into the escrow without the gas cost of 1 mint per token.
contract MultiSeaMirror is ERC721 {
    address public escrow;
    address public immutable factory;
    uint256 public immutable firstId;
    uint256 public immutable supply;
    uint256 public materialised;
    string private base;

    error OnlyEscrow();
    error OutOfRange();
    error EscrowSet();

    constructor(string memory n, string memory s, string memory baseURI_, uint256 firstId_, uint256 supply_)
        ERC721(n, s)
    {
        factory = msg.sender;
        firstId = firstId_;
        supply = supply_;
        base = baseURI_;
    }

    /// @notice One-time link to the escrow that holds the whole supply (set by the deploying factory).
    function initEscrow(address e) external {
        if (msg.sender != factory || escrow != address(0) || e == address(0)) revert EscrowSet();
        escrow = e;
    }

    function inRange(uint256 id) public view returns (bool) {
        return id >= firstId && id < firstId + supply;
    }

    function exists(uint256 id) external view returns (bool) {
        return _ownerOf(id) != address(0);
    }

    function totalSupply() external view returns (uint256) {
        return supply;
    }

    function ownerOf(uint256 id) public view override returns (address) {
        address o = _ownerOf(id);
        if (o == address(0) && inRange(id)) return escrow;
        return super.ownerOf(id);
    }

    function balanceOf(address a) public view override returns (uint256) {
        uint256 b = super.balanceOf(a);
        return a == escrow ? b + (supply - materialised) : b;
    }

    function mintFromEscrow(address to, uint256 id) external {
        if (msg.sender != escrow) revert OnlyEscrow();
        if (!inRange(id)) revert OutOfRange();
        materialised++;
        _safeMint(to, id);
    }

    function _baseURI() internal view override returns (string memory) {
        return base;
    }
}
