// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ILayerZeroReceiver } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import { ILayerZeroEndpointV2, MessagingParams, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import { IslandWallet, IslandCall } from "./IslandWallet.sol";

/// @notice LayerZero library config for this OApp: endpoint.setConfig(address(this), lib, params).
struct LzLibConfig { address lib; SetConfigParam[] params; }

interface IIslandDrop {
    function isActiveHere(uint256 id) external view returns (bool);
    function ownerOf(uint256 id) external view returns (address);
    function escrow() external view returns (address);
}

/// @title IslandWalletFactory
/// @notice Creates Island's wallets (ERC-1167 clones of IslandWallet) at the same address on every chain, and carries
///         the holder's cross-chain wallet actions over LayerZero V2 (this contract is its own OApp; its peer on every
///         chain is its own address, because the factory is deployed with the deterministic deployer
///         0x4e59b44847b379578588920cA78FbF26c0B4956C with the same bytecode, constructor argument and salt everywhere).
///         Nothing chain-specific is in the bytecode: the Island contract and LayerZero endpoint are set ONCE per chain
///         by the owner after deployment (setChainConfig) and can never be changed afterwards.
///         Wallet of Island #N = CREATE2(this, keccak256(abi.encode(keccak256("multi-islands"), N)), clone(implementation)).
contract IslandWalletFactory is ILayerZeroReceiver {
    bytes32 public constant SALT_TAG = keccak256("multi-islands");
    uint8 public constant MSG_VERSION = 1;
    uint256 public constant MAX_TTL = 1 days;
    uint256 public constant MAX_CALLS = 16;

    address public immutable implementation;
    address public owner;
    address public pendingOwner;

    address public island;
    ILayerZeroEndpointV2 public endpoint;
    uint32 public localEid;
    bool public configured;

    mapping(uint32 => bool) public remoteEnabled;
    uint32[] internal _remotes;
    /// @notice Outbound per-wallet nonce (next one to use is outNonce + 1).
    mapping(uint256 => uint64) public outNonce;
    /// @notice srcEid => tokenId => nonce => executed (replay protection on top of LayerZero's own).
    mapping(uint32 => mapping(uint256 => mapping(uint64 => bool))) public usedNonce;

    event WalletCreated(uint256 indexed tokenId, address wallet);
    event ChainConfigured(address island, address endpoint, uint32 localEid);
    event RemoteEnabled(uint32 eid);
    event RemoteSent(uint256 indexed tokenId, uint32 indexed dstEid, uint64 nonce, bytes32 guid, address sender, uint64 deadline);
    event RemoteExecuted(uint256 indexed tokenId, uint32 indexed srcEid, uint64 nonce, bytes32 guid, address sender);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotConfigured();
    error AlreadyConfigured();
    error BadConfig();
    error NotLiveOwner();
    error UnknownRemote(uint32 eid);
    error BadDeadline();
    error TooManyCalls();
    error NotEndpoint();
    error BadPeer();
    error Expired();
    error Replayed();
    error LiveHere();
    error BadVersion();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address owner_) {
        owner = owner_;
        implementation = address(new IslandWallet());
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ addresses
    function saltOf(uint256 tokenId) public pure returns (bytes32) { return keccak256(abi.encode(SALT_TAG, tokenId)); }
    function walletOf(uint256 tokenId) public view returns (address) { return Clones.predictDeterministicAddress(implementation, saltOf(tokenId), address(this)); }
    function isDeployed(uint256 tokenId) public view returns (bool) { return walletOf(tokenId).code.length != 0; }

    /// @notice Create Island #tokenId's wallet on this chain (anyone may pay for it; it changes nothing about control).
    function deployWallet(uint256 tokenId) public returns (address w) {
        w = walletOf(tokenId);
        if (w.code.length != 0) return w;
        Clones.cloneDeterministic(implementation, saltOf(tokenId));
        IslandWallet(payable(w)).initialize(tokenId);
        emit WalletCreated(tokenId, w);
    }

    // ------------------------------------------------------------------ control
    /// @notice The holder of Island #tokenId on this chain if it is active here (not locked in the bridge escrow), else 0.
    function liveOwner(uint256 tokenId) public view returns (address) {
        address i = island; if (i == address(0)) return address(0);
        try IIslandDrop(i).isActiveHere(tokenId) returns (bool a) { if (!a) return address(0); } catch { return address(0); }
        try IIslandDrop(i).ownerOf(tokenId) returns (address o) { return o; } catch { return address(0); }
    }

    // ------------------------------------------------------------------ config (owner, once per chain)
    /// @param lz LayerZero DVN/executor settings for the pathways (the deploy page copies the Island bridge escrow's own
    ///        settings on this chain, so wallet messages are verified by exactly the DVNs that already move the Islands).
    function setChainConfig(address island_, address endpoint_, uint32[] calldata remoteEids, address delegate, LzLibConfig[] calldata lz) external onlyOwner {
        if (configured) revert AlreadyConfigured();
        if (island_.code.length == 0 || endpoint_.code.length == 0) revert BadConfig();
        IIslandDrop(island_).escrow(); // must be an omni drop (reverts otherwise)
        uint32 le = ILayerZeroEndpointV2(endpoint_).eid();
        configured = true; island = island_; endpoint = ILayerZeroEndpointV2(endpoint_); localEid = le;
        emit ChainConfigured(island_, endpoint_, le);
        for (uint256 k; k < remoteEids.length; ++k) _enable(remoteEids[k]);
        _setLz(lz);
        ILayerZeroEndpointV2(endpoint_).setDelegate(delegate == address(0) ? owner : delegate);
    }
    /// @notice Change the LayerZero settings later (same power as the endpoint delegate has anyway).
    function setLzConfig(LzLibConfig[] calldata lz) external onlyOwner { if (!configured) revert NotConfigured(); _setLz(lz); }
    function _setLz(LzLibConfig[] calldata lz) internal { for (uint256 k; k < lz.length; ++k) endpoint.setConfig(address(this), lz[k].lib, lz[k].params); }
    /// @notice Add a chain later (additive only; the peer there is always this same address).
    function addRemote(uint32 eid) external onlyOwner { if (!configured) revert NotConfigured(); _enable(eid); }
    function setDelegate(address d) external onlyOwner { if (!configured) revert NotConfigured(); endpoint.setDelegate(d); }
    function _enable(uint32 eid) internal {
        if (eid == 0 || eid == localEid) revert BadConfig();
        if (remoteEnabled[eid]) return;
        remoteEnabled[eid] = true; _remotes.push(eid); emit RemoteEnabled(eid);
    }
    function remotes() external view returns (uint32[] memory) { return _remotes; }

    function transferOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipTransferStarted(owner, to); }
    function acceptOwnership() external { if (msg.sender != pendingOwner) revert NotOwner(); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; pendingOwner = address(0); }
    function renounceOwnership() external onlyOwner { emit OwnershipTransferred(owner, address(0)); owner = address(0); pendingOwner = address(0); }

    // ------------------------------------------------------------------ cross-chain (LayerZero V2)
    function _peer() internal view returns (bytes32) { return bytes32(uint256(uint160(address(this)))); }
    function _message(uint256 tokenId, uint64 nonce, uint64 deadline, address sender, IslandCall[] calldata calls) internal pure returns (bytes memory) {
        return abi.encode(MSG_VERSION, tokenId, nonce, deadline, sender, calls);
    }
    function _params(uint256 tokenId, uint32 dstEid, uint64 nonce, uint64 deadline, IslandCall[] calldata calls, bytes calldata options)
        internal view returns (MessagingParams memory p)
    {
        p.dstEid = dstEid; p.receiver = _peer(); p.options = options;
        p.message = _message(tokenId, nonce, deadline, msg.sender, calls);
    }
    function _check(uint32 dstEid, uint64 deadline, uint256 n) internal view {
        if (!configured) revert NotConfigured();
        if (!remoteEnabled[dstEid]) revert UnknownRemote(dstEid);
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_TTL) revert BadDeadline();
        if (n == 0 || n > MAX_CALLS) revert TooManyCalls();
    }

    /// @notice LayerZero fee to run `calls` from Island #tokenId's wallet on dstEid. options = LayerZero type-3 options
    ///         (executor lzReceive gas sized for the calls, plus ~150k if the wallet isn't created there yet).
    function quoteRemote(uint256 tokenId, uint32 dstEid, IslandCall[] calldata calls, uint64 deadline, bytes calldata options) external view returns (uint256) {
        _check(dstEid, deadline, calls.length);
        return endpoint.quote(_params(tokenId, dstEid, outNonce[tokenId] + 1, deadline, calls, options), address(this)).nativeFee;
    }

    /// @notice The Island's live holder (on this chain) runs `calls` from the Island's wallet on dstEid. Excess fee is
    ///         refunded to the sender. The message is only valid until `deadline` (at most 1 day ahead).
    function remoteExecute(uint256 tokenId, uint32 dstEid, IslandCall[] calldata calls, uint64 deadline, bytes calldata options)
        external payable returns (bytes32 guid, uint64 nonce)
    {
        _check(dstEid, deadline, calls.length);
        address o = liveOwner(tokenId);
        if (o == address(0) || o != msg.sender) revert NotLiveOwner();
        nonce = ++outNonce[tokenId];
        guid = endpoint.send{ value: msg.value }(_params(tokenId, dstEid, nonce, deadline, calls, options), msg.sender).guid;
        emit RemoteSent(tokenId, dstEid, nonce, guid, msg.sender, deadline);
    }

    function allowInitializePath(Origin calldata o) external view returns (bool) { return configured && remoteEnabled[o.srcEid] && o.sender == _peer(); }
    function nextNonce(uint32, bytes32) external pure returns (uint64) { return 0; } // unordered delivery

    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address, bytes calldata) external payable {
        if (msg.sender != address(endpoint) || msg.sender == address(0)) revert NotEndpoint();
        if (!remoteEnabled[o.srcEid] || o.sender != _peer()) revert BadPeer();
        _handle(o.srcEid, guid, message);
    }

    function _handle(uint32 srcEid, bytes32 guid, bytes calldata message) internal {
        (uint8 v, uint256 tokenId, uint64 nonce, uint64 deadline, address sender, IslandCall[] memory calls) = abi.decode(message, (uint8, uint256, uint64, uint64, address, IslandCall[]));
        if (v != MSG_VERSION) revert BadVersion();
        if (block.timestamp > deadline) revert Expired();
        if (usedNonce[srcEid][tokenId][nonce]) revert Replayed();
        // If the Island is active on THIS chain, only its local holder controls the wallet here.
        if (liveOwner(tokenId) != address(0)) revert LiveHere();
        usedNonce[srcEid][tokenId][nonce] = true;
        address w = deployWallet(tokenId);
        if (msg.value != 0) { (bool ok,) = w.call{ value: msg.value }(""); ok; } // any executor native drop goes to the wallet
        IslandWallet(payable(w)).executeFromFactory(calls);
        emit RemoteExecuted(tokenId, srcEid, nonce, guid, sender);
    }
}
