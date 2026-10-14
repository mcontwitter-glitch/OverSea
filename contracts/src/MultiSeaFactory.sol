// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MultiSeaEscrow } from "./MultiSeaEscrow.sol";
import { MultiSeaMirror } from "./MultiSeaMirror.sol";

/// @title MultiSeaFactory
/// @notice Registry + factory deployed once per chain. On the native chain a collection owner pays the listing fee and
///         the factory deploys the native escrow. On every other selected chain the operator (deployer bot) deploys
///         a mirror ERC721 + escrow. Escrows are owned by this factory; peers can only be wired by owner/operator.
contract MultiSeaFactory is Ownable, ReentrancyGuard {
    uint256 public constant FEE_2 = 0.08 ether;
    uint256 public constant FEE_3_4 = 0.095 ether;
    uint256 public constant FEE_ALL = 0.12 ether;

    address public immutable endpoint;
    address public feeWallet;
    address public priceFeed;
    uint256 public maxPriceAge;
    uint256 public supportedChains; // total number of chains MultiSea supports (for the "all chains" tier)
    mapping(address => bool) public operators;

    struct Listing { address owner; address nft; address escrow; uint32[] eids; uint256 paid; }
    mapping(uint256 => Listing) internal listings;
    uint256 public listingCount;
    mapping(address => address) public escrowOf; // local collection (native or mirror) => escrow

    event Listed(uint256 indexed id, address indexed nft, address indexed owner, address escrow, uint32[] eids, uint256 fee);
    event MirrorDeployed(uint256 indexed listingId, address mirror, address escrow);
    event OperatorSet(address op, bool on);

    error NotOperator();
    error NotCollectionOwner();
    error BadChainCount();
    error WrongFee(uint256 required);
    error AlreadyListed();
    error PayFailed();

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    constructor(address _endpoint, address _owner, address _operator, address _feeWallet, address _priceFeed, uint256 _maxPriceAge, uint256 _supportedChains)
        Ownable(_owner)
    {
        endpoint = _endpoint;
        feeWallet = _feeWallet;
        priceFeed = _priceFeed;
        maxPriceAge = _maxPriceAge;
        supportedChains = _supportedChains;
        if (_operator != address(0)) { operators[_operator] = true; emit OperatorSet(_operator, true); }
    }

    /// @notice Listing fee for a number of chains (including the native one).
    function listingFee(uint256 chainCount) public view returns (uint256) {
        if (chainCount < 2 || chainCount > supportedChains) revert BadChainCount();
        if (chainCount == 2) return FEE_2;
        if (chainCount <= 4) return FEE_3_4;
        return FEE_ALL; // 5+ chains = the all-chains tier
    }

    /// @notice Called on the native chain by the collection's owner() (the deployer/admin wallet) with the exact fee.
    /// @param eids LayerZero endpoint ids of ALL chains (native included) the collection should live on.
    function list(address nft, uint32[] calldata eids) external payable nonReentrant returns (uint256 id, address escrow) {
        if (escrowOf[nft] != address(0)) revert AlreadyListed();
        if (_ownerOfCollection(nft) != msg.sender) revert NotCollectionOwner();
        uint256 fee = listingFee(eids.length);
        if (msg.value != fee) revert WrongFee(fee);
        escrow = address(new MultiSeaEscrow(endpoint, address(this), nft, false, feeWallet, priceFeed, maxPriceAge));
        escrowOf[nft] = escrow;
        id = ++listingCount;
        listings[id] = Listing(msg.sender, nft, escrow, eids, fee);
        (bool ok,) = payable(feeWallet).call{ value: fee }("");
        if (!ok) revert PayFailed();
        emit Listed(id, nft, msg.sender, escrow, eids, fee);
    }

    /// @notice Operator deploys the mirror + escrow for listing `listingId` (id from the native chain) on this chain.
    function deployMirror(uint256 listingId, string calldata name, string calldata symbol, string calldata baseURI, uint256 firstId, uint256 supply)
        external onlyOperator returns (address mirror, address escrow)
    {
        mirror = address(new MultiSeaMirror(name, symbol, baseURI, firstId, supply));
        escrow = address(new MultiSeaEscrow(endpoint, address(this), mirror, true, feeWallet, priceFeed, maxPriceAge));
        MultiSeaMirror(mirror).initEscrow(escrow);
        escrowOf[mirror] = escrow;
        emit MirrorDeployed(listingId, mirror, escrow);
    }

    /// @notice Wire a trusted LayerZero peer on one of this factory's escrows.
    function setPeer(address escrow, uint32 eid, bytes32 peer) external onlyOperator {
        MultiSeaEscrow(escrow).setPeer(eid, peer);
    }

    function setEscrowFeeConfig(address escrow, address _feeWallet, address _priceFeed, uint256 _maxPriceAge) external onlyOwner {
        MultiSeaEscrow(escrow).setFeeConfig(_feeWallet, _priceFeed, _maxPriceAge);
    }

    /// @notice Hand an escrow over to the admin directly (e.g. to set LayerZero DVN/executor config).
    function transferEscrowOwnership(address escrow, address to) external onlyOwner {
        MultiSeaEscrow(escrow).transferOwnership(to);
    }

    function setOperator(address op, bool on) external onlyOwner { operators[op] = on; emit OperatorSet(op, on); }
    function setFeeWallet(address w) external onlyOwner { feeWallet = w; }
    function setPriceFeed(address f, uint256 age) external onlyOwner { priceFeed = f; maxPriceAge = age; }
    function setSupportedChains(uint256 n) external onlyOwner { supportedChains = n; }

    function getListing(uint256 id) external view returns (Listing memory) { return listings[id]; }

    function _ownerOfCollection(address nft) internal view returns (address o) {
        (bool ok, bytes memory r) = nft.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && r.length >= 32) o = abi.decode(r, (address));
    }

}
