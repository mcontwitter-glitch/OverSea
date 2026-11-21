// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable, Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MultiSeaOnchainDrop } from "./MultiSeaOnchainDrop.sol";
import { MultiSeaOnchainOmniDrop } from "./MultiSeaOnchainOmniDrop.sol";

interface IOmniEscrowRegistry { function register(bytes32 cid, address drop) external; }

/// @title MultiSeaOnchainFactory
/// @notice EIP-1167 factory for fully on-chain-art drops. Independent of the live IPFS
///         MultiSeaLaunchpadFactory so existing factory addresses and the IPFS path stay unchanged.
contract MultiSeaOnchainFactory is Ownable2Step, EIP712 {
    uint16 public constant MAX_FEE_BPS = 1500;

    address public implementation;
    address public feeWallet;
    address public approver;
    uint16 public platformFeeBps;
    mapping(bytes32 => bool) public usedSalt;
    mapping(address => bool) public isDrop;

    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("DropApproval(address creator,bytes32 configHash,bytes32 salt,uint256 deadline)");

    address public omniImplementation;
    address public omniEscrow;
    bytes32 public constant OMNI_APPROVAL_TYPEHASH =
        keccak256("OmniDropApproval(address creator,bytes32 configHash,bytes32 collectionId,uint256 deadline)");
    event OmniDropCreated(address indexed drop, address indexed creator, bytes32 indexed collectionId, uint16 feeBps);
    event OmniSet(address impl, address escrow);

    event DropCreated(address indexed drop, address indexed creator, bytes32 indexed salt, uint16 feeBps);
    event FeeSet(uint16 bps);
    event FeeWalletSet(address wallet);
    event ApproverSet(address approver);
    event ImplementationSet(address impl);
    event ArtMode(address indexed drop, bool storeLocal);

    error Expired();
    error BadSignature();
    error SaltUsed();
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address owner_, address impl_, address feeWallet_, address approver_, uint16 feeBps_)
        Ownable(owner_) EIP712("MultiSeaOnchain", "1")
    {
        if (impl_ == address(0) || feeWallet_ == address(0) || approver_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        implementation = impl_; feeWallet = feeWallet_; approver = approver_; platformFeeBps = feeBps_;
    }

    /// @notice keccak256 of the ABI-encoded init params with the factory-controlled fields zeroed.
    function configHash(MultiSeaOnchainDrop.InitParams calldata p) public pure returns (bytes32) {
        MultiSeaOnchainDrop.InitParams memory q = p; q.feeWallet = address(0); q.platformFeeBps = 0;
        return keccak256(abi.encode(q));
    }

    function approvalDigest(address creator, bytes32 cfg, bytes32 salt, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, creator, cfg, salt, deadline)));
    }

    function predictDrop(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// @notice Creator deploys their approved drop (creator pays gas). msg.sender must be the approved creator.
    function createDrop(MultiSeaOnchainDrop.InitParams calldata p, bytes32 salt, uint256 deadline, bytes calldata sig) external returns (address drop) {
        if (block.timestamp > deadline) revert Expired();
        if (usedSalt[salt]) revert SaltUsed();
        bytes32 cfg = configHash(p);
        if (ECDSA.recover(approvalDigest(msg.sender, cfg, salt, deadline), sig) != approver) revert BadSignature();
        usedSalt[salt] = true;
        MultiSeaOnchainDrop.InitParams memory q = p; q.feeWallet = feeWallet; q.platformFeeBps = platformFeeBps;
        drop = Clones.cloneDeterministic(implementation, salt);
        isDrop[drop] = true;
        MultiSeaOnchainDrop(drop).initialize(q);
        emit DropCreated(drop, msg.sender, salt, platformFeeBps);
        emit ArtMode(drop, p.storeLocal);
    }

    function omniConfigHash(MultiSeaOnchainOmniDrop.OmniInit calldata p) public pure returns (bytes32) {
        MultiSeaOnchainOmniDrop.OmniInit memory q = p; q.feeWallet = address(0); q.platformFeeBps = 0;
        return keccak256(abi.encode(q));
    }
    function omniDigest(address creator, bytes32 cfg, bytes32 cid, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(OMNI_APPROVAL_TYPEHASH, creator, cfg, cid, deadline)));
    }
    function predictOmniDrop(bytes32 cid) external view returns (address) {
        return Clones.predictDeterministicAddress(omniImplementation, cid, address(this));
    }
    function createOmniDrop(MultiSeaOnchainOmniDrop.OmniInit calldata p, bytes32 cid, uint256 deadline, bytes calldata sig) external returns (address drop) {
        if (omniImplementation == address(0) || omniEscrow == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert Expired();
        if (usedSalt[cid]) revert SaltUsed();
        if (ECDSA.recover(omniDigest(p.owner, omniConfigHash(p), cid, deadline), sig) != approver) revert BadSignature();
        usedSalt[cid] = true;
        MultiSeaOnchainOmniDrop.OmniInit memory q = p; q.feeWallet = feeWallet; q.platformFeeBps = platformFeeBps;
        drop = Clones.cloneDeterministic(omniImplementation, cid);
        isDrop[drop] = true;
        MultiSeaOnchainOmniDrop(drop).initialize(q, omniEscrow, cid);
        IOmniEscrowRegistry(omniEscrow).register(cid, drop);
        emit OmniDropCreated(drop, p.owner, cid, platformFeeBps);
        emit ArtMode(drop, p.storeLocal);
    }

    function setOmni(address impl, address escrow) external onlyOwner {
        if (impl == address(0) || escrow == address(0)) revert ZeroAddress();
        omniImplementation = impl; omniEscrow = escrow; emit OmniSet(impl, escrow);
    }
    function setFee(uint16 bps) external onlyOwner { if (bps > MAX_FEE_BPS) revert FeeTooHigh(); platformFeeBps = bps; emit FeeSet(bps); }
    function setFeeWallet(address w) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; emit FeeWalletSet(w); }
    function setApprover(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); approver = a; emit ApproverSet(a); }
    function setImplementation(address i) external onlyOwner { if (i == address(0)) revert ZeroAddress(); implementation = i; emit ImplementationSet(i); }
}
