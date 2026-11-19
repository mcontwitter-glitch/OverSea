// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC1155Receiver } from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

struct IslandCall { address to; uint256 value; bytes data; }

interface IIslandWalletFactory {
    function liveOwner(uint256 tokenId) external view returns (address);
    function island() external view returns (address);
}

/// @title IslandWallet
/// @notice One Island's wallet. ERC-1167 clones of this implementation are created by IslandWalletFactory with
///         CREATE2 (salt from the token id only), so Island #N has the SAME address on every chain where the factory
///         sits at its deterministic address. The address can receive coins and plain NFT transfers before it is
///         deployed; safeTransferFrom needs the clone deployed (anyone may deploy it through the factory).
///         Control:
///         - owner() = the holder of the Island on THIS chain while the Island is active (not locked in the bridge
///           escrow) here. That holder calls execute / executeBatch directly.
///         - On chains where the Island is locked, only the factory can run calls, and only for a LayerZero message
///           sent by the factory on the chain where the Island is live, by its live holder (see the factory).
///         No MultiSea key can move anything out of a wallet.
contract IslandWallet is IERC721Receiver, IERC1155Receiver, IERC1271 {
    address public immutable factory;
    uint256 public tokenId;
    /// @notice Counts executions (changes on every state-changing call, like ERC-6551 state()).
    uint256 public state;
    bool private _initialized;

    event Executed(address indexed to, uint256 value, bytes data, bool viaLayerZero);

    error NotOwner();
    error NotFactory();
    error AlreadyInitialized();
    error CallFailed(uint256 index, bytes reason);
    error OwnIsland();

    constructor() { factory = msg.sender; _initialized = true; } // the implementation itself can never be initialized

    function initialize(uint256 tokenId_) external {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true; tokenId = tokenId_;
    }

    /// @notice The live holder of this wallet's Island on this chain (address(0) if the Island is locked here).
    function owner() public view returns (address) { return IIslandWalletFactory(factory).liveOwner(tokenId); }

    /// @notice ERC-6551-style binding info: (chain id, Island contract on this chain, token id).
    function token() external view returns (uint256, address, uint256) { return (block.chainid, IIslandWalletFactory(factory).island(), tokenId); }

    function execute(address to, uint256 value, bytes calldata data) external payable returns (bytes memory result) {
        if (msg.sender != owner() || msg.sender == address(0)) revert NotOwner();
        ++state;
        bool ok; (ok, result) = to.call{ value: value }(data);
        if (!ok) revert CallFailed(0, result);
        emit Executed(to, value, data, false);
    }

    function executeBatch(IslandCall[] calldata calls) external payable returns (bytes[] memory results) {
        if (msg.sender != owner() || msg.sender == address(0)) revert NotOwner();
        results = _run(calls, false);
    }

    /// @notice Factory only: calls carried by a verified LayerZero message from the Island's live chain.
    function executeFromFactory(IslandCall[] calldata calls) external returns (bytes[] memory) {
        if (msg.sender != factory) revert NotFactory();
        return _run(calls, true);
    }

    function _run(IslandCall[] calldata calls, bool lz) internal returns (bytes[] memory results) {
        ++state;
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].to.call{ value: calls[i].value }(calls[i].data);
            if (!ok) revert CallFailed(i, r);
            results[i] = r;
            emit Executed(calls[i].to, calls[i].value, calls[i].data, lz);
        }
    }

    receive() external payable {}

    /// @dev An Island inside its own wallet would own itself and be locked forever: refuse it.
    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        if (id == tokenId && msg.sender == IIslandWalletFactory(factory).island()) revert OwnIsland();
        return IERC721Receiver.onERC721Received.selector;
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return IERC1155Receiver.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return IERC1155Receiver.onERC1155BatchReceived.selector; }

    /// @notice ERC-1271: valid if signed by the live holder on this chain.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        address o = owner();
        return o != address(0) && SignatureChecker.isValidSignatureNow(o, hash, sig) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC721Receiver).interfaceId || id == type(IERC1155Receiver).interfaceId || id == type(IERC1271).interfaceId;
    }
}
