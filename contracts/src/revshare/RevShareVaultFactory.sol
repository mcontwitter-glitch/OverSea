// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { RevShareVault } from "./RevShareVault.sol";

interface IOwnable { function owner() external view returns (address); }

/// @title RevShareVaultFactory
/// @notice Deploys one EIP-1167 minimal-proxy `RevShareVault` per collection per chain, in a single founder transaction
///         (the founder pays the gas). Only the collection's `owner()` can create its vault, so nobody can front-run or
///         squat a collection's vault. The vault address is deterministic (`predict`) and recorded in `vaultOf`.
contract RevShareVaultFactory {
    address public immutable implementation;
    mapping(address => address) public vaultOf;
    uint256 public vaultCount;

    event VaultCreated(address indexed collection, address indexed vault, address indexed owner, uint256 totalSupply, uint256 firstId);

    error NotCollectionOwner();
    error VaultExists(address vault);
    error BadConfig();

    constructor() { implementation = address(new RevShareVault()); }

    function createVault(address collection, uint256 totalSupply, uint256 firstId) external returns (address vault) {
        if (collection == address(0) || totalSupply == 0) revert BadConfig();
        address o;
        try IOwnable(collection).owner() returns (address a) { o = a; } catch { revert NotCollectionOwner(); }
        if (o != msg.sender) revert NotCollectionOwner();
        address existing = vaultOf[collection];
        if (existing != address(0)) revert VaultExists(existing);
        bytes32 salt = bytes32(uint256(uint160(collection)));
        address impl = implementation;
        assembly {
            let p := mload(0x40)
            mstore(p, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(p, 0x14), shl(0x60, impl))
            mstore(add(p, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            vault := create2(0, p, 0x37, salt)
        }
        if (vault == address(0)) revert BadConfig();
        RevShareVault(payable(vault)).initialize(collection, msg.sender, totalSupply, firstId);
        vaultOf[collection] = vault; unchecked { ++vaultCount; }
        emit VaultCreated(collection, vault, msg.sender, totalSupply, firstId);
    }

    /// @notice The address `createVault(collection, …)` will produce on this chain.
    function predict(address collection) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(collection))), h)))));
    }
}
