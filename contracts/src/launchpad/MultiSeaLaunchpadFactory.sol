// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable, Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MultiSeaDrop } from "./MultiSeaDrop.sol";

/// @title MultiSeaLaunchpadFactory
/// @notice One per chain. Deploys MultiSeaDrop EIP-1167 clones for drops that MultiSea approved off-chain (admin
///         review queue). Approval = an EIP-712 signature from `approver` over the exact drop config, the creator,
///         a deadline and a one-time salt, bound to this chain + factory, so it can't be replayed on another chain,
///         reused for a second deploy, or applied to a different config.
///         Factory owner is meant to be a TimelockController (proposer = MultiSea admin multisig) so fee changes and
///         implementation upgrades for FUTURE drops are delayed and public. Existing drops are never affected.
/// @dev    PREVIEW / UNAUDITED. Not deployed anywhere.
contract MultiSeaLaunchpadFactory is Ownable2Step, EIP712 {
    uint16 public constant MAX_FEE_BPS = 1500; // hard cap 15% on primary sales

    address public implementation;
    address public feeWallet;
    address public approver;
    uint16 public platformFeeBps;
    mapping(bytes32 => bool) public usedSalt;
    mapping(address => bool) public isDrop;

    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("DropApproval(address creator,bytes32 configHash,bytes32 salt,uint256 deadline)");

    event DropCreated(address indexed drop, address indexed creator, bytes32 indexed salt, uint16 feeBps);
    event FeeSet(uint16 bps);
    event FeeWalletSet(address wallet);
    event ApproverSet(address approver);
    event ImplementationSet(address impl);

    error Expired();
    error BadSignature();
    error SaltUsed();
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address owner_, address impl_, address feeWallet_, address approver_, uint16 feeBps_)
        Ownable(owner_) EIP712("MultiSeaLaunchpad", "1")
    {
        if (impl_ == address(0) || feeWallet_ == address(0) || approver_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        implementation = impl_; feeWallet = feeWallet_; approver = approver_; platformFeeBps = feeBps_;
    }

    /// @notice keccak256 of the ABI-encoded init params with the factory-controlled fields zeroed.
    function configHash(MultiSeaDrop.InitParams calldata p) public pure returns (bytes32) {
        MultiSeaDrop.InitParams memory q = p; q.feeWallet = address(0); q.platformFeeBps = 0;
        return keccak256(abi.encode(q));
    }

    function approvalDigest(address creator, bytes32 cfg, bytes32 salt, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, creator, cfg, salt, deadline)));
    }

    function predictDrop(bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// @notice Creator deploys their approved drop (creator pays gas). msg.sender must be the approved creator.
    function createDrop(MultiSeaDrop.InitParams calldata p, bytes32 salt, uint256 deadline, bytes calldata sig) external returns (address drop) {
        if (block.timestamp > deadline) revert Expired();
        if (usedSalt[salt]) revert SaltUsed();
        bytes32 cfg = configHash(p);
        if (ECDSA.recover(approvalDigest(msg.sender, cfg, salt, deadline), sig) != approver) revert BadSignature();
        usedSalt[salt] = true;
        MultiSeaDrop.InitParams memory q = p; q.feeWallet = feeWallet; q.platformFeeBps = platformFeeBps;
        drop = Clones.cloneDeterministic(implementation, salt);
        isDrop[drop] = true;
        MultiSeaDrop(drop).initialize(q);
        emit DropCreated(drop, msg.sender, salt, platformFeeBps);
    }

    // ---- owner (timelock) ----
    function setFee(uint16 bps) external onlyOwner { if (bps > MAX_FEE_BPS) revert FeeTooHigh(); platformFeeBps = bps; emit FeeSet(bps); }
    function setFeeWallet(address w) external onlyOwner { if (w == address(0)) revert ZeroAddress(); feeWallet = w; emit FeeWalletSet(w); }
    function setApprover(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); approver = a; emit ApproverSet(a); }
    function setImplementation(address i) external onlyOwner { if (i == address(0)) revert ZeroAddress(); implementation = i; emit ImplementationSet(i); }
}
