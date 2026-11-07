// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import { MultiSeaMirror } from "./MultiSeaMirror.sol";

/// @notice Creates MultiSeaMirror contracts for one MultiSeaFactory (keeps the mirror bytecode out of the factory, EIP-170).
contract MultiSeaMirrorDeployer {
    address public immutable factory;
    error NotFactory();
    constructor(address f) { factory = f; }
    function deploy(string calldata n, string calldata s, string calldata b, uint256 firstId, uint256 supply) external returns (address) {
        if (msg.sender != factory) revert NotFactory();
        return address(new MultiSeaMirror(n, s, b, firstId, supply));
    }
    function initEscrow(address mirror, address escrow) external {
        if (msg.sender != factory) revert NotFactory();
        MultiSeaMirror(mirror).initEscrow(escrow);
    }
}
