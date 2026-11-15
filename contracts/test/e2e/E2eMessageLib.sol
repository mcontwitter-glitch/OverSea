// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IMessageLib, MessageLibType } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLib.sol";
import { Packet } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ISendLib.sol";
import { ILayerZeroEndpointV2, MessagingFee, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { PacketV1Codec } from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import { EndpointV2Mock } from "@layerzerolabs/test-devtools-evm-foundry/contracts/mocks/EndpointV2Mock.sol";

/// Local end-to-end only (anvil): LayerZero's SimpleMessageLib behaviour without the Foundry test helper. A relayer
/// verifies packets coming from Solana with validatePacket(); packets to Solana are read from EndpointV2's PacketSent.
contract E2eMessageLib is ERC165 {
    using PacketV1Codec for bytes;
    address public immutable endpoint;
    uint256 public nativeFee = 1e12;
    constructor(address _endpoint) { endpoint = _endpoint; }
    function supportsInterface(bytes4 i) public view override returns (bool) { return i == type(IMessageLib).interfaceId || super.supportsInterface(i); }
    function validatePacket(bytes calldata p) external {
        ILayerZeroEndpointV2(endpoint).verify(Origin(p.srcEid(), p.sender(), p.nonce()), p.receiverB20(), keccak256(p.payload()));
    }
    function send(Packet calldata _packet, bytes memory _options, bool) external returns (MessagingFee memory fee, bytes memory encodedPacket, bytes memory options) {
        require(msg.sender == endpoint, "only endpoint");
        encodedPacket = PacketV1Codec.encode(_packet); options = _options; fee = MessagingFee(nativeFee, 0);
    }
    function quote(Packet calldata, bytes calldata, bool) external view returns (MessagingFee memory) { return MessagingFee(nativeFee, 0); }
    function isSupportedEid(uint32) external pure returns (bool) { return true; }
    function version() external pure returns (uint64, uint8, uint8) { return (0, 0, 2); }
    function messageLibType() external pure returns (MessageLibType) { return MessageLibType.SendAndReceive; }
    function setConfig(address, bytes calldata) external {}
    function getConfig(uint32, address, uint32) external pure returns (bytes memory) { return ""; }
    receive() external payable {}
}

/// Re-export so forge emits an artifact for the e2e deployer.
contract E2eEndpoint is EndpointV2Mock { constructor(uint32 eid, address owner) EndpointV2Mock(eid, owner) {} }
