// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MultiSeaOrdinalEscrow} from "../../src/launchpad/ordinals/MultiSeaOrdinalEscrow.sol";

contract MockUSDCLocal is ERC20 {
    constructor() ERC20("Mock USD Coin", "mUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address a, uint256 v) external { _mint(a, v); }
}

/// LOCAL ONLY (anvil). Deploys MockUSDC + MultiSeaOrdinalEscrow (2-of-3), configures a collection, regtest BTC addresses.
contract DeployLocal is Script {
    function run() external {
        require(block.chainid == 31337, "DeployLocal: anvil only");
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address[] memory att = vm.envAddress("ATTESTERS", ",");
        address buyer = vm.envAddress("BUYER");
        address artist = vm.envAddress("ARTIST");
        address feeTo = vm.envAddress("FEE_RECIPIENT");
        address owner = vm.addr(pk);
        vm.startBroadcast(pk);
        MockUSDCLocal usdc = new MockUSDCLocal();
        MultiSeaOrdinalEscrow esc = new MultiSeaOrdinalEscrow(owner, feeTo, att, 2);
        bytes32 cid = keccak256("multisea-demo");
        esc.configureCollection(cid, MultiSeaOrdinalEscrow.CollectionConfig(artist, 500, 444, 0, 1 days, true, 0));
        esc.setTokenPrice(cid, address(usdc), 25e6);
        esc.setBtcNetwork(2);
        usdc.mint(buyer, 1000e6);
        vm.stopBroadcast();
        console.log("USDC", address(usdc));
        console.log("ESCROW", address(esc));
    }
}
