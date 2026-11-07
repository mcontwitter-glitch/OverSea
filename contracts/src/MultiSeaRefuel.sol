// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MultiSeaRefuel
/// @notice Carries listing gas from the creator's chain to the other chains. One LayerZero message per destination
///         with an executor native drop to `to`, so the listing fee paid on one chain pays setup gas on every chain.
contract MultiSeaRefuel is OApp {
    error BadInput();
    error NotEnough(uint256 needed);
    uint128 public constant RECEIVE_GAS = 50_000;

    constructor(address _endpoint, address _owner) OApp(_endpoint, _owner) Ownable(_owner) {}

    function options(uint128 amount, address to) public pure returns (bytes memory) {
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), RECEIVE_GAS,
            uint8(1), uint16(49), uint8(2), amount, bytes32(uint256(uint160(to))));
    }

    function quote(uint32[] calldata dsts, uint128[] calldata amounts, address to) public view returns (uint256 total) {
        if (dsts.length != amounts.length) revert BadInput();
        for (uint256 i; i < dsts.length; ++i) total += _quote(dsts[i], abi.encode(to), options(amounts[i], to), false).nativeFee;
    }

    /// @notice Pay quote(...) to drop amounts[i] of each destination's native gas token to `to`. Excess is refunded.
    function refuel(uint32[] calldata dsts, uint128[] calldata amounts, address to) external payable {
        if (dsts.length != amounts.length) revert BadInput();
        uint256 spent;
        for (uint256 i; i < dsts.length; ++i) {
            bytes memory opt = options(amounts[i], to);
            MessagingFee memory f = _quote(dsts[i], abi.encode(to), opt, false);
            spent += f.nativeFee;
            if (spent > msg.value) revert NotEnough(spent);
            _lzSend(dsts[i], abi.encode(to), opt, f, payable(msg.sender));
        }
        if (msg.value > spent) { (bool ok, ) = msg.sender.call{ value: msg.value - spent }(""); if (!ok) revert BadInput(); }
    }

    // Each send pays its own fee out of the batch's msg.value.
    function _payNative(uint256 _nativeFee) internal pure override returns (uint256) { return _nativeFee; }
    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal override {}
}
