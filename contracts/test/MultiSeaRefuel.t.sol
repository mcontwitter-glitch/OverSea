// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import { Test } from "forge-std/Test.sol";
import { MultiSeaRefuel } from "../src/MultiSeaRefuel.sol";

contract MultiSeaRefuelTest is Test {
    function test_optionsLayout() public {
        MultiSeaRefuel r = new MultiSeaRefuel(address(new FakeEp()), address(this));
        bytes memory o = r.options(1 ether, address(0xBEEF));
        assertEq(o.length, 2 + (4 + 16) + (4 + 16 + 32));
        assertEq(uint8(o[1]), 3);
        assertEq(uint8(o[25]), 2); // second option type = native drop
    }
}
contract FakeEp { function setDelegate(address) external {} }
