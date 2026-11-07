// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MultiSeaPriceFeed
/// @notice Chainlink-compatible native/USD feed for chains with no Chainlink feed. The owner/updater pushes the price
///         (8 decimals); escrows still enforce maxPriceAge, so a stale push stops bridging instead of mispricing it.
contract MultiSeaPriceFeed is Ownable {
    uint8 public constant decimals = 8;
    string public description;
    int256 public answer;
    uint256 public updatedAt;
    mapping(address => bool) public updaters;
    error NotUpdater();
    error BadPrice();
    constructor(address _owner, address _updater, string memory _description, int256 _answer) Ownable(_owner) {
        description = _description;
        if (_updater != address(0)) updaters[_updater] = true;
        _set(_answer);
    }
    function setUpdater(address u, bool on) external onlyOwner { updaters[u] = on; }
    function push(int256 a) external { if (!updaters[msg.sender] && msg.sender != owner()) revert NotUpdater(); _set(a); }
    function _set(int256 a) internal { if (a <= 0) revert BadPrice(); answer = a; updatedAt = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, updatedAt, updatedAt, 1); }
}
