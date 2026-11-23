// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { MultiSeaPacks } from "../src/packs/MultiSeaPacks.sol";
import { MultiSeaPacksOps } from "../src/packs/MultiSeaPacksOps.sol";
import { MultiSeaPackCards } from "../src/packs/MultiSeaPackCards.sol";
import { MultiSeaPackFactory } from "../src/packs/MultiSeaPackFactory.sol";
import { MultiSeaPackEscrow } from "../src/packs/MultiSeaPackEscrow.sol";

/// @dev MC deploys pack factories himself. This script is not broadcast by the agent.
///      Example: forge script script/DeployPackFactory.s.sol --rpc-url $RPC --broadcast
///      Constructor: escrow(endpoint, owner, feeWallet, moveFee); factory(owner, packImpl, cardImpl, feeWallet, approver, feeBps).
///      After all 5 chains: escrow.setPeer on every pair, then record addresses in config/launchpad.json packDrops.
contract DeployPackFactory is Script {
    function run() external {
        address owner = vm.envAddress("PACK_OWNER");
        address feeWallet = vm.envAddress("PACK_FEE_WALLET");
        address approver = vm.envAddress("PACK_APPROVER");
        address endpoint = vm.envAddress("PACK_ENDPOINT");
        uint16 feeBps = uint16(vm.envOr("PACK_FEE_BPS", uint256(50)));
        uint256 moveFee = vm.envOr("PACK_MOVE_FEE", uint256(0));
        vm.startBroadcast();
        MultiSeaPacksOps packOps = new MultiSeaPacksOps();
        MultiSeaPacks packImpl = new MultiSeaPacks(address(packOps));
        MultiSeaPackCards cardImpl = new MultiSeaPackCards();
        MultiSeaPackEscrow escrow = new MultiSeaPackEscrow(endpoint, owner, feeWallet, moveFee);
        MultiSeaPackFactory factory = new MultiSeaPackFactory(owner, address(packImpl), address(cardImpl), feeWallet, approver, feeBps);
        escrow.setFactory(address(factory));
        factory.setEscrow(address(escrow));
        vm.stopBroadcast();
    }
}
