// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IV1OmniEscrow {
    function dropOf(bytes32 collectionId) external view returns (address);
    function moveFee() external view returns (uint256);
    function feeWallet() external view returns (address);
}

interface IV1OmniDrop {
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address holder, address operator) external view returns (bool);
    function transferFrom(address from, address to, uint256 id) external;
}

/// @title MultiSeaSolanaMover
/// @notice Moves a token of an EXISTING multichain collection (V1 MultiSeaOmniDrop + MultiSeaOmniEscrow, whose drops can never
///         list Solana) to Solana, using the chain's existing escrow. One per EVM chain.
///         toSolana() atomically (1) transfers the holder's token straight into the chain's existing V1 escrow, the same
///         locked state MultiSeaOmniDrop.moveTo leaves it in, (2) checks the escrow owns it, and (3) sends the 192-byte MOVE
///         (bytes32 Solana recipient) to the MultiSea Solana program, which releases its locked copy of the id.
///         This contract never holds a token and has no function that moves one anywhere except into the escrow.
///         The way back is the existing V1 flow: the Solana program sends MOVE to this chain's escrow, which releases the copy.
///         The holder approves this contract for the token (approve or setApprovalForAll) and pays the escrow's move fee
///         (to the escrow's fee wallet, like moveTo) + the LayerZero fee.
contract MultiSeaSolanaMover is OApp, ReentrancyGuard {
    using OptionsBuilder for bytes;

    uint8 public constant MOVE = 1;
    IV1OmniEscrow public immutable escrow;
    uint32 public immutable solanaEid;
    /// Collections whose Solana side exists (registered + locked copies created on Solana), set by the owner.
    mapping(bytes32 => bool) public enabled;
    /// Solana lzReceive budget: compute units, and lamports in case the program must create the copy (0: copies pre-created).
    uint128 public solCompute = 120_000;
    uint128 public solLamports;

    event CollectionSet(bytes32 indexed collectionId, bool on);
    event SolanaOptionsSet(uint128 computeUnits, uint128 lamports);
    event MovedToSolana(bytes32 indexed guid, bytes32 indexed collectionId, uint256 indexed tokenId, address holder, bytes32 to);

    error NotEnabled(bytes32 collectionId);
    error UnknownCollection(bytes32 collectionId);
    error ZeroRecipient();
    error NotMovable();
    error NotAuthorized();
    error NotLocked();
    error InsufficientFee(uint256 required, uint256 sent);
    error PayFailed();
    error NoInbound();
    error ZeroAddress();

    constructor(address _endpoint, address _owner, address _escrow, uint32 _solanaEid) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_escrow == address(0)) revert ZeroAddress();
        escrow = IV1OmniEscrow(_escrow);
        solanaEid = _solanaEid;
    }

    function _payload(bytes32 cid, uint256 tokenId, bytes32 to) internal pure returns (bytes memory) {
        return abi.encode(MOVE, cid, tokenId, uint256(0), uint256(0), to);
    }
    function _options() internal view returns (bytes memory) {
        return OptionsBuilder.newOptions().addExecutorLzReceiveOption(solCompute, solLamports);
    }

    /// @notice What toSolana costs: the escrow's move fee (MultiSea) + the LayerZero fee.
    function quoteToSolana(bytes32 cid, uint256 tokenId, bytes32 to) external view returns (uint256 platform, uint256 lzFee) {
        platform = escrow.moveFee();
        lzFee = _quote(solanaEid, _payload(cid, tokenId, to), _options(), false).nativeFee;
    }

    /// @notice Lock `tokenId` in this chain's existing escrow and make it Active for the Solana wallet `to`.
    ///         Caller: the holder or an operator the holder approved. This contract must be approved for the token.
    function toSolana(bytes32 cid, uint256 tokenId, bytes32 to) external payable nonReentrant returns (bytes32 guid) {
        if (!enabled[cid]) revert NotEnabled(cid);
        if (to == bytes32(0)) revert ZeroRecipient();
        IV1OmniDrop d = IV1OmniDrop(escrow.dropOf(cid));
        address holder = d.ownerOf(tokenId);
        if (holder == address(escrow)) revert NotMovable(); // locked here already: Active on another chain
        if (msg.sender != holder && d.getApproved(tokenId) != msg.sender && !d.isApprovedForAll(holder, msg.sender)) revert NotAuthorized();
        d.transferFrom(holder, address(escrow), tokenId); // holder -> escrow directly; approvals are cleared by the transfer
        if (d.ownerOf(tokenId) != address(escrow)) revert NotLocked();

        bytes memory pl = _payload(cid, tokenId, to);
        bytes memory opt = _options();
        uint256 lz = _quote(solanaEid, pl, opt, false).nativeFee;
        uint256 platform = escrow.moveFee();
        if (msg.value < lz + platform) revert InsufficientFee(lz + platform, msg.value);
        MessagingReceipt memory r = _lzSend(solanaEid, pl, opt, MessagingFee(lz, 0), payable(msg.sender));
        if (platform > 0) _pay(escrow.feeWallet(), platform);
        if (msg.value > lz + platform) _pay(msg.sender, msg.value - lz - platform);
        emit MovedToSolana(r.guid, cid, tokenId, holder, to);
        return r.guid;
    }

    /// @dev msg.value also carries the platform fee and any excess (refunded above), so pay exactly the quoted fee.
    function _payNative(uint256 _nativeFee) internal pure override returns (uint256) { return _nativeFee; }

    function _pay(address to, uint256 amount) internal { (bool ok, ) = payable(to).call{ value: amount }(""); if (!ok) revert PayFailed(); }

    /// @dev Send-only: nothing is ever accepted from Solana here (returns go to the escrow).
    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal pure override { revert NoInbound(); }

    // ----------------------------------------------------------------- owner
    /// @notice Enable a collection once its Solana side exists (register_existing + existing_copies on Solana).
    function setCollection(bytes32 cid, bool on) external onlyOwner {
        if (on && escrow.dropOf(cid) == address(0)) revert UnknownCollection(cid);
        enabled[cid] = on;
        emit CollectionSet(cid, on);
    }
    function setSolanaOptions(uint128 computeUnits, uint128 lamports) external onlyOwner {
        solCompute = computeUnits; solLamports = lamports;
        emit SolanaOptionsSet(computeUnits, lamports);
    }
}
