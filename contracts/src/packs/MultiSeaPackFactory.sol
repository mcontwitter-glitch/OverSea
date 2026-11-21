// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable, Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MultiSeaPacks } from "./MultiSeaPacks.sol";
import { MultiSeaPackCards } from "./MultiSeaPackCards.sol";

interface IPackEscrowRegistry {
    function register(bytes32 cid, address packs, address cards) external;
}

/// @title MultiSeaPackFactory
/// @notice One per chain. Deploys a paired MultiSeaPacks (ERC-1155) + MultiSeaPackCards (ERC-721) EIP-1167 clone for a
///         drop MultiSea approved off-chain. Approval is an EIP-712 signature over the exact config, creator, deadline
///         and collection id, bound to this factory and chain. The creator pays gas and owns the drop. Existing
///         launchpad factories and drops are not touched.
contract MultiSeaPackFactory is Ownable2Step, EIP712 {
    uint16 public constant MAX_FEE_BPS = 1500;

    address public packImplementation;
    address public cardImplementation;
    address public escrow;
    address public feeWallet;
    address public approver;
    uint16 public platformFeeBps;
    mapping(bytes32 => bool) public usedSalt;
    mapping(address => bool) public isPacks;

    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("PackDropApproval(address creator,bytes32 configHash,bytes32 collectionId,uint256 deadline)");

    event PackDropCreated(address indexed packs, address indexed cards, address indexed creator, bytes32 collectionId, uint16 feeBps);
    event ImplementationsSet(address packs, address cards);
    event EscrowSet(address escrow);
    event FeeSet(uint16 bps);
    event FeeWalletSet(address wallet);
    event ApproverSet(address approver);

    error Expired();
    error BadSignature();
    error SaltUsed();
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address owner_, address packImpl_, address cardImpl_, address feeWallet_, address approver_, uint16 feeBps_)
        Ownable(owner_)
        EIP712("MultiSeaPacks", "1")
    {
        if (packImpl_ == address(0) || cardImpl_ == address(0) || feeWallet_ == address(0) || approver_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        packImplementation = packImpl_;
        cardImplementation = cardImpl_;
        feeWallet = feeWallet_;
        approver = approver_;
        platformFeeBps = feeBps_;
    }

    /// @notice keccak256 of the ABI-encoded init params with factory-controlled fee fields zeroed.
    function configHash(MultiSeaPacks.PackInit calldata p) public pure returns (bytes32) {
        MultiSeaPacks.PackInit memory q = p;
        q.feeWallet = address(0);
        q.platformFeeBps = 0;
        return keccak256(abi.encode(q));
    }

    function approvalDigest(address creator, bytes32 cfg, bytes32 collectionId, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, creator, cfg, collectionId, deadline)));
    }

    function predictPacks(bytes32 cid) external view returns (address) {
        return Clones.predictDeterministicAddress(packImplementation, cid, address(this));
    }

    function predictCards(bytes32 cid) external view returns (address) {
        return Clones.predictDeterministicAddress(cardImplementation, _cardSalt(cid), address(this));
    }

    function _cardSalt(bytes32 cid) internal pure returns (bytes32) {
        return keccak256(abi.encode(cid, "cards"));
    }

    /// @notice Creator deploys their approved pack drop (creator pays gas). msg.sender must be the signed creator.
    function createPackDrop(MultiSeaPacks.PackInit calldata p, bytes32 cid, uint256 deadline, bytes calldata sig)
        external
        returns (address packs, address cards)
    {
        if (block.timestamp > deadline) revert Expired();
        if (usedSalt[cid]) revert SaltUsed();
        if (ECDSA.recover(approvalDigest(msg.sender, configHash(p), cid, deadline), sig) != approver) revert BadSignature();
        usedSalt[cid] = true;
        MultiSeaPacks.PackInit memory q = p;
        q.feeWallet = feeWallet;
        q.platformFeeBps = platformFeeBps;
        packs = Clones.cloneDeterministic(packImplementation, cid);
        cards = Clones.cloneDeterministic(cardImplementation, _cardSalt(cid));
        isPacks[packs] = true;
        MultiSeaPackCards(cards).initialize(q.name, q.symbol, packs, q.cardBaseURI);
        MultiSeaPacks(packs).initialize(q, cards, escrow, cid);
        if (escrow != address(0) && q.eids.length > 1) IPackEscrowRegistry(escrow).register(cid, packs, cards);
        emit PackDropCreated(packs, cards, p.owner, cid, platformFeeBps);
    }

    function setImplementations(address packImpl, address cardImpl) external onlyOwner {
        if (packImpl == address(0) || cardImpl == address(0)) revert ZeroAddress();
        packImplementation = packImpl;
        cardImplementation = cardImpl;
        emit ImplementationsSet(packImpl, cardImpl);
    }

    function setEscrow(address e) external onlyOwner {
        escrow = e;
        emit EscrowSet(e);
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        platformFeeBps = bps;
        emit FeeSet(bps);
    }

    function setFeeWallet(address w) external onlyOwner {
        if (w == address(0)) revert ZeroAddress();
        feeWallet = w;
        emit FeeWalletSet(w);
    }

    function setApprover(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        approver = a;
        emit ApproverSet(a);
    }
}
