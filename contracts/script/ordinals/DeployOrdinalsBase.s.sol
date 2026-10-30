// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {MultiSeaOrdinalEscrow} from "../../src/launchpad/ordinals/MultiSeaOrdinalEscrow.sol";

/// Base deploy for the Ordinals escrow (spec §7.9). UNAUDITED. Do NOT broadcast until BIG approves the pilot.
/// Reads config/ordinals-base.json. The single attester (1-of-1) comes from env ATTESTER (an address, never a key).
/// Owner is the admin wallet, so collection setup is done afterwards by the admin (see `collectionCalldata`).
contract DeployOrdinalsBase is Script {
    uint96 constant FEE_BPS = 50;          // 0.5% (§11, #1)
    uint32 constant DELIVERY_WINDOW = 21600; // 6h (Q5)

    function _cfg() internal view returns (address owner, address feeTo, address usdc) {
        string memory j = vm.readFile("config/ordinals-base.json");
        owner = vm.parseJsonAddress(j, ".owner");
        feeTo = vm.parseJsonAddress(j, ".feeRecipient");
        usdc = vm.parseJsonAddress(j, ".usdc");
        require(vm.parseJsonUint(j, ".feeBps") == FEE_BPS, "feeBps must be 50");
        require(vm.parseJsonUint(j, ".deliveryWindow") == DELIVERY_WINDOW, "deliveryWindow must be 21600");
        require(vm.parseJsonUint(j, ".threshold") == 1, "threshold must be 1");
        address[] memory allowed = vm.parseJsonAddressArray(j, ".allowedTokens");
        require(allowed.length == 1 && allowed[0] == usdc, "allowlist must be exactly Base USDC");
        require(vm.parseJsonUint(j, ".serviceEnv.DEADLINE_SAFETY_SECS_NUM") < DELIVERY_WINDOW, "safety >= window");
    }

    function run() external returns (MultiSeaOrdinalEscrow esc) {
        require(block.chainid == 8453 || block.chainid == 84532 || block.chainid == 31337, "Base / Base Sepolia / local only");
        (address owner, address feeTo,) = _cfg();
        require(feeTo != address(0) && owner != address(0), "zero address"); // B11 guard at deploy time
        address[] memory att = new address[](1);
        att[0] = vm.envAddress("ATTESTER");
        vm.startBroadcast();
        esc = new MultiSeaOrdinalEscrow(owner, feeTo, att, 1);
        vm.stopBroadcast();
        require(esc.feeRecipient() == feeTo && esc.btcOpsRecipient() == feeTo && esc.owner() == owner && esc.threshold() == 1
                && esc.btcNetwork() == 0 && esc.minBtcConfs() == 3, "post-deploy check");
        console.log("ORDINAL_ESCROW", address(esc));
    }

    /// Prints the admin calls for one collection (configureCollection + setTokenPrice). Nothing is sent.
    function collectionCalldata(bytes32 id, address artist, uint32 maxSupply, uint256 priceUsdc6) external view {
        (,, address usdc) = _cfg();
        MultiSeaOrdinalEscrow.CollectionConfig memory c =
            MultiSeaOrdinalEscrow.CollectionConfig(artist, FEE_BPS, maxSupply, 0, DELIVERY_WINDOW, true, 0);
        console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.configureCollection, (id, c)));
        console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.setTokenPrice, (id, usdc, priceUsdc6)));
        string memory j = vm.readFile("config/ordinals-base.json");
        console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.setInscriptionFeeCap, (id, vm.parseJsonUint(j, ".inscriptionFeeCapUsdc6"))));
    }

    /// One-time admin calls after deploy (allowlist Base USDC; confs; optional btcOps wallet). Nothing is sent.
    function adminCalldata() external view {
        (,, address usdc) = _cfg();
        string memory j = vm.readFile("config/ordinals-base.json");
        console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.setAllowedToken, (usdc, true)));
        console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.setMinBtcConfs, (vm.parseJsonUint(j, ".minBtcConfs"))));
        address ops = vm.parseJsonAddress(j, ".btcOpsRecipient");
        if (ops != vm.parseJsonAddress(j, ".feeRecipient")) console.logBytes(abi.encodeCall(MultiSeaOrdinalEscrow.setBtcOpsRecipient, (ops)));
    }
}
