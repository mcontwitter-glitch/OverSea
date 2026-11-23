// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721Owner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title RevShareVault
/// @notice Trust-minimised revenue share for a fixed-supply ERC-721 on ONE chain. Anyone can send the chain's native token
///         (a plain transfer, e.g. a Seaport royalty payment, or `deposit()`); every deposit is split EQUALLY across the
///         token ids `[firstId, firstId + totalSupply)` with a staking-style accumulator (`accRewardPerToken`) and a
///         per-tokenId debt. Entitlement belongs to the TOKEN, not the wallet: `claim(tokenIds)` pays `msg.sender` only for
///         tokens it currently owns (`ownerOf`), so a buyer inherits unclaimed rewards.
/// @dev    Deployed as an EIP-1167 clone by `RevShareVaultFactory` (one per collection per chain), hence `initialize`.
///         NO RUG SURFACE: the owner can only (a) pause/unpause claims, (b) pause/unpause the explicit `deposit()` function,
///         (c) hand over ownership. There is no function that moves funds to anyone except the current token holder, and no
///         way to change the collection, the supply or the accounting after `initialize`.
///         Plain transfers (`receive`) are NEVER blocked, not even while paused, so a paused vault can never make a marketplace
///         sale revert when it is the royalty recipient. Funds received while paused still accrue to the tokens.
///         Rounding: `amount + dust` is divided by `totalSupply`; the remainder (< totalSupply wei) is carried to the next
///         deposit, so the vault always holds exactly `sum(pending) + dust` and every claim is exact.
contract RevShareVault {
    IERC721Owner public collection;
    address public owner;
    uint256 public totalSupply;
    uint256 public firstId;
    /// cumulative wei every token has earned since the vault was created
    uint256 public accRewardPerToken;
    /// undistributed remainder, always < totalSupply
    uint256 public dust;
    uint256 public totalDeposited;
    uint256 public totalClaimed;
    /// tokenId => accRewardPerToken already paid out for that token ("reward debt")
    mapping(uint256 => uint256) public claimedAcc;
    bool public claimsPaused;
    bool public depositsPaused;
    bool private _init;
    uint256 private _locked; // 0 = free, 1 = inside claim (clones start at 0, so no init needed)

    event Initialized(address indexed collection, address indexed owner, uint256 totalSupply, uint256 firstId);
    event Deposited(address indexed from, uint256 amount, uint256 accRewardPerToken, bool viaDeposit);
    event Claimed(address indexed holder, uint256[] tokenIds, uint256 amount);
    event ClaimsPaused(bool paused);
    event DepositsPaused(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error AlreadyInitialized();
    error BadConfig();
    error NotOwner();
    error Paused();
    error NotHolder(uint256 tokenId);
    error BadToken(uint256 tokenId);
    error Reentrant();
    error TransferFailed();
    error ZeroAmount();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (_locked != 0) revert Reentrant(); _locked = 1; _; _locked = 0; }

    /// @dev the implementation itself can never be initialised
    constructor() { _init = true; }

    function initialize(address collection_, address owner_, uint256 totalSupply_, uint256 firstId_) external {
        if (_init) revert AlreadyInitialized();
        if (collection_ == address(0) || owner_ == address(0) || totalSupply_ == 0 || totalSupply_ > 1e9) revert BadConfig();
        _init = true;
        collection = IERC721Owner(collection_); owner = owner_; totalSupply = totalSupply_; firstId = firstId_;
        emit Initialized(collection_, owner_, totalSupply_, firstId_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ deposits
    receive() external payable { if (msg.value != 0) _deposit(msg.value, false); }

    /// @notice Explicit deposit (e.g. MultiSea's fee share). Can be paused by the owner; plain transfers cannot.
    function deposit() external payable {
        if (depositsPaused) revert Paused();
        if (msg.value == 0) revert ZeroAmount();
        _deposit(msg.value, true);
    }

    function _deposit(uint256 amount, bool viaDeposit) internal {
        uint256 total = amount + dust;
        uint256 s = totalSupply;
        accRewardPerToken += total / s;
        dust = total % s;
        totalDeposited += amount;
        emit Deposited(msg.sender, amount, accRewardPerToken, viaDeposit);
    }

    // ------------------------------------------------------------------ claims
    /// @notice Pay `msg.sender` everything the listed tokens have earned. Reverts unless the caller owns every listed token.
    ///         A second claim (or a repeated id) simply pays 0 for that token.
    function claim(uint256[] calldata tokenIds) external nonReentrant returns (uint256 amount) {
        if (claimsPaused) revert Paused();
        uint256 acc = accRewardPerToken;
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            _checkId(id);
            if (_ownerOf(id) != msg.sender) revert NotHolder(id);
            amount += acc - claimedAcc[id];
            claimedAcc[id] = acc; // effects before the transfer
        }
        if (amount != 0) {
            totalClaimed += amount;
            (bool ok,) = msg.sender.call{ value: amount }("");
            if (!ok) revert TransferFailed();
        }
        emit Claimed(msg.sender, tokenIds, amount);
    }

    // ------------------------------------------------------------------ views
    function pendingOf(uint256 tokenId) public view returns (uint256) {
        if (tokenId < firstId || tokenId >= firstId + totalSupply) return 0;
        return accRewardPerToken - claimedAcc[tokenId];
    }

    /// @notice Sum of pending rewards for the given ids (duplicates are counted each time; use distinct ids).
    function pending(uint256[] calldata tokenIds) external view returns (uint256 sum) {
        for (uint256 i; i < tokenIds.length; ++i) sum += pendingOf(tokenIds[i]);
    }

    /// @notice Wei still owed to all tokens (excludes the carried dust).
    function totalPending() external view returns (uint256) { return totalDeposited - totalClaimed - dust; }

    function _checkId(uint256 id) internal view { if (id < firstId || id >= firstId + totalSupply) revert BadToken(id); }

    function _ownerOf(uint256 id) internal view returns (address o) {
        try collection.ownerOf(id) returns (address a) { o = a; } catch { o = address(0); }
    }

    // ------------------------------------------------------------------ owner (pause only, never withdraw)
    function setClaimsPaused(bool p) external onlyOwner { claimsPaused = p; emit ClaimsPaused(p); }
    function setDepositsPaused(bool p) external onlyOwner { depositsPaused = p; emit DepositsPaused(p); }
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert BadConfig();
        emit OwnershipTransferred(owner, newOwner); owner = newOwner;
    }
    /// @notice Give up the pause powers for good (claims can then never be paused again; they stay in whatever state they are in).
    function renounceOwnership() external onlyOwner { emit OwnershipTransferred(owner, address(0)); owner = address(0); }
}
