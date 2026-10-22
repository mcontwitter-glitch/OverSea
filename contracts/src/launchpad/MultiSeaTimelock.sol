// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Owner of the launchpad factory + omni escrow on each chain. Mainnet: 48 h delay. Testnets: 5 min (staging).
///         Proposer + executor = the MultiSea admin wallet; no admin role (the timelock administers itself).
contract MultiSeaTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0)) {}
}
