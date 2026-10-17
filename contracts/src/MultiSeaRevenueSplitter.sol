// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MultiSeaRevenueSplitter (option sketch; NOT deployed)
/// @notice Pull-based revenue split for a fixed-supply ERC-721: anyone deposits native or ERC-20 revenue (e.g. MultiSea's
///         fee share + a creator's pledged royalty share); each token accrues an equal share via a cumulative index; the
///         token's current holder claims what that token has accrued since it last claimed. Claims follow the token, so a
///         buyer inherits unclaimed revenue. Mirrors the Worker KV ledger (acc per token, claimed per token).
/// @dev Holder snapshots are not needed: entitlement is per tokenId. Dust (deposit % supply) carries to the next deposit.
contract MultiSeaRevenueSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC721 public immutable collection;
    uint256 public immutable supply;
    /// @dev token ids must lie in [firstId, firstId + supply)
    uint256 public immutable firstId;

    /// currency (address(0) = native) => cumulative amount per token
    mapping(address => uint256) public accPerToken;
    /// currency => undistributed remainder (< supply)
    mapping(address => uint256) public dust;
    /// currency => tokenId => accPerToken already paid out for this token
    mapping(address => mapping(uint256 => uint256)) public claimedPerToken;

    event Deposited(address indexed currency, address indexed from, uint256 amount, uint256 newAccPerToken);
    event Claimed(address indexed currency, address indexed holder, uint256[] tokenIds, uint256 amount);

    error ZeroAmount();
    error NotHolder(uint256 tokenId);
    error BadToken(uint256 tokenId);
    error TransferFailed();

    constructor(IERC721 _collection, uint256 _supply, uint256 _firstId) {
        require(address(_collection) != address(0) && _supply > 0, "bad config");
        collection = _collection; supply = _supply; firstId = _firstId;
    }

    receive() external payable { _deposit(address(0), msg.value); }
    function depositNative() external payable { _deposit(address(0), msg.value); }
    function depositToken(IERC20 token, uint256 amount) external nonReentrant {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        _deposit(address(token), token.balanceOf(address(this)) - before); // fee-on-transfer safe
    }

    function _deposit(address currency, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 total = amount + dust[currency];
        accPerToken[currency] += total / supply;
        dust[currency] = total % supply;
        emit Deposited(currency, msg.sender, amount, accPerToken[currency]);
    }

    function claimable(address currency, uint256 tokenId) public view returns (uint256) {
        if (tokenId < firstId || tokenId >= firstId + supply) return 0;
        return accPerToken[currency] - claimedPerToken[currency][tokenId];
    }

    function claimableMany(address currency, uint256[] calldata ids) external view returns (uint256 sum) {
        for (uint256 i; i < ids.length; ++i) sum += claimable(currency, ids[i]);
    }

    /// @notice Claim for tokens you currently hold. Pays msg.sender.
    function claim(address currency, uint256[] calldata ids) external nonReentrant returns (uint256 amount) {
        uint256 acc = accPerToken[currency];
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (id < firstId || id >= firstId + supply) revert BadToken(id);
            if (collection.ownerOf(id) != msg.sender) revert NotHolder(id);
            amount += acc - claimedPerToken[currency][id];
            claimedPerToken[currency][id] = acc; // effects before interaction
        }
        if (amount == 0) revert ZeroAmount();
        if (currency == address(0)) { (bool ok,) = msg.sender.call{ value: amount }(""); if (!ok) revert TransferFailed(); }
        else IERC20(currency).safeTransfer(msg.sender, amount);
        emit Claimed(currency, msg.sender, ids, amount);
    }
}
