// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
/// @notice Testnet stand-in for LIL FOOTS (ids 1..4404). owner() is what the factory checks.
contract LilFootsTest is ERC721, Ownable {
    string private base;
    constructor(address o, string memory b) ERC721("LIL FOOTS test", "LFTEST") Ownable(o) { base = b; }
    function mint(address to, uint256 id) external onlyOwner { require(id >= 1 && id <= 4404, "range"); _mint(to, id); }
    function totalSupply() external pure returns (uint256) { return 4404; }
    function _baseURI() internal view override returns (string memory) { return base; }
}
