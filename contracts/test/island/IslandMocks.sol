// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { MessagingParams, MessagingReceipt, MessagingFee, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import { ILayerZeroReceiver } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";

/// Omni-drop-like Island: a token is "active here" unless it is held by the escrow.
contract MockIslandDrop is ERC721 {
    address public escrow;
    constructor(address escrow_) ERC721("Island's", "ISL") { escrow = escrow_; }
    function mint(address to, uint256 id) external { _mint(to, id); }
    function isActiveHere(uint256 id) external view returns (bool) { address o = _ownerOf(id); return o != address(0) && o != escrow; }
    function lock(uint256 id) external { _update(escrow, id, address(0)); }
    function release(uint256 id, address to) external { _update(to, id, address(0)); }
}

contract MockEndpoint {
    uint32 public eid; address public delegate; uint256 public fee = 0.01 ether; uint64 public n;
    MessagingParams internal _last; address public lastSender; address public lastRefund;
    constructor(uint32 eid_) { eid = eid_; }
    function setDelegate(address d) external { delegate = d; }
    uint256 public configCalls;
    function setConfig(address, address, SetConfigParam[] calldata) external { ++configCalls; }
    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) { return MessagingFee(fee, 0); }
    function send(MessagingParams calldata p, address refund) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= fee, "fee");
        _last = p; lastSender = msg.sender; lastRefund = refund; ++n;
        if (msg.value > fee) { (bool ok,) = refund.call{ value: msg.value - fee }(""); require(ok); }
        r.guid = keccak256(abi.encode(n, p.dstEid)); r.nonce = n; r.fee = MessagingFee(fee, 0);
    }
    function lastMessage() external view returns (bytes memory) { return _last.message; }
    function lastDst() external view returns (uint32) { return _last.dstEid; }
    function lastReceiver() external view returns (bytes32) { return _last.receiver; }
    function deliver(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 guid, bytes calldata m) external {
        ILayerZeroReceiver(oapp).lzReceive(Origin(srcEid, sender, nonce), guid, m, address(this), "");
    }
}

contract MockERC20 is ERC20 { constructor() ERC20("T", "T") {} function mint(address to, uint256 v) external { _mint(to, v); } }
contract MockERC721 is ERC721 { constructor() ERC721("N", "N") {} function mint(address to, uint256 id) external { _mint(to, id); } }
contract MockERC1155 is ERC1155 { constructor() ERC1155("") {} function mint(address to, uint256 id, uint256 v) external { _mint(to, id, v, ""); } }
