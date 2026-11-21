// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { MultiSeaOnchainDrop } from "../src/onchain/MultiSeaOnchainDrop.sol";
import { MultiSeaOnchainOmniDrop } from "../src/onchain/MultiSeaOnchainOmniDrop.sol";
import { MultiSeaOnchainFactory } from "../src/onchain/MultiSeaOnchainFactory.sol";

/// @dev MC deploys on-chain-art factories himself. This script is not broadcast by the agent.
///      Example: forge script script/DeployOnchainFactory.s.sol --rpc-url $RPC --broadcast
///      Constructor: factory(owner, impl, feeWallet, approver, feeBps). Then setOmni(omniImpl, existing OmniEscrowV2).
///      After all chains: record addresses in config/launchpad.json onchainDrops.factories.
contract DeployOnchainFactory is Script {
    function run() external {
        address owner = vm.envAddress("ONCHAIN_OWNER");
        address feeWallet = vm.envAddress("ONCHAIN_FEE_WALLET");
        address approver = vm.envAddress("ONCHAIN_APPROVER");
        uint16 feeBps = uint16(vm.envOr("ONCHAIN_FEE_BPS", uint256(50)));
        address escrow = vm.envOr("ONCHAIN_OMNI_ESCROW", address(0));
        vm.startBroadcast();
        MultiSeaOnchainDrop impl = new MultiSeaOnchainDrop();
        MultiSeaOnchainOmniDrop omniImpl = new MultiSeaOnchainOmniDrop();
        MultiSeaOnchainFactory factory = new MultiSeaOnchainFactory(owner, address(impl), feeWallet, approver, feeBps);
        if (escrow != address(0)) factory.setOmni(address(omniImpl), escrow);
        vm.stopBroadcast();
    }
}
