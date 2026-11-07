// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { MultiSeaEscrow } from "./MultiSeaEscrow.sol";
import { MultiSeaMirrorDeployer } from "./MultiSeaMirrorDeployer.sol";
import { SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";

interface ILzEndpointConfig { function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external; }

/// @title MultiSeaFactory
/// @notice Registry + factory deployed once per chain. On the native chain a collection owner pays the listing fee and
///         the factory deploys the native escrow. On every other selected chain the operator (deployer bot) deploys
///         a mirror ERC721 + escrow. Escrows are owned by this factory; peers can only be wired by owner/operator.
contract MultiSeaFactory is Ownable, ReentrancyGuard {
    address public immutable endpoint;
    address public feeWallet;   // receives the $0.30 bridge platform fee (passed to escrows)
    address public gasWallet;   // receives listing fees: a pure reimbursement of the operator's deploy + wiring gas
    /// @notice Gas reimbursement, in this chain's native token, to deploy a mirror + escrow on `eid` and wire its peers.
    ///         Kept current by the operator from live gas prices and native/USD rates. 0 = chain not offered.
    mapping(uint32 => uint256) public chainGasCost;
    /// @notice Gas reimbursement for the native escrow deploy + peer wiring on this chain.
    uint256 public baseGasCost;
    address public priceFeed;
    uint256 public maxPriceAge;
    uint256 public supportedChains; // total number of chains MultiSea supports (for the "all chains" tier)
    mapping(address => bool) public operators;

    struct Listing { address owner; address nft; address escrow; uint32[] eids; uint256 paid; }
    mapping(uint256 => Listing) internal listings;
    /// @notice Launchpad drops pay the listing gas at review signing, before their contract exists.
    struct Prepaid { address payer; uint32[] eids; uint256 paid; bool used; }
    mapping(bytes32 => Prepaid) internal prepaids;
    uint256 public listingCount;
    mapping(address => address) public escrowOf; // local collection (native or mirror) => escrow

    event Listed(uint256 indexed id, address indexed nft, address indexed owner, address escrow, uint32[] eids, uint256 fee);
    event MirrorDeployed(uint256 indexed listingId, address mirror, address escrow);
    event OperatorSet(address op, bool on);
    event GasCostSet(uint32 indexed eid, uint256 cost);
    event Prepaid_(bytes32 indexed dropId, address indexed payer, uint32[] eids, uint256 fee);

    error NotOperator();
    error NotCollectionOwner();
    error BadChainCount();
    error WrongFee(uint256 required);
    error AlreadyListed();
    error PayFailed();
    error ChainNotOffered(uint32 eid);
    error BadPrepay();

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    constructor(address _endpoint, address _owner, address _operator, address _feeWallet, address _priceFeed, uint256 _maxPriceAge, uint256 _supportedChains)
        Ownable(_owner)
    {
        endpoint = _endpoint;
        feeWallet = _feeWallet;
        gasWallet = _operator != address(0) ? _operator : _owner;
        priceFeed = _priceFeed;
        maxPriceAge = _maxPriceAge;
        supportedChains = _supportedChains;
        if (_operator != address(0)) { operators[_operator] = true; emit OperatorSet(_operator, true); }
    }

    /// @notice Listing fee = gas only: the native escrow + wiring here plus a mirror deploy + wiring on each other chain.
    /// @param eids ALL chains (native first) the collection should live on.
    function listingFee(uint32[] calldata eids) public view returns (uint256 fee) {
        if (eids.length < 2 || eids.length > supportedChains) revert BadChainCount();
        fee = baseGasCost;
        for (uint256 i = 1; i < eids.length; i++) {
            uint256 c = chainGasCost[eids[i]];
            if (c == 0) revert ChainNotOffered(eids[i]);
            fee += c;
        }
    }

    /// @notice Called on the native chain by the collection's owner() with at least listingFee(eids); excess is refunded.
    function list(address nft, uint32[] calldata eids) external payable nonReentrant returns (uint256 id, address escrow) {
        if (_ownerOfCollection(nft) != msg.sender) revert NotCollectionOwner();
        uint256 fee = listingFee(eids);
        if (msg.value < fee) revert WrongFee(fee);
        (id, escrow) = _list(msg.sender, nft, eids, fee);
        _pay(gasWallet, fee);
        if (msg.value > fee) _pay(msg.sender, msg.value - fee);
    }

    /// @notice Launchpad: the creator pays the listing gas when signing the drop for review (dropId = keccak256(slug)).
    function prepay(bytes32 dropId, uint32[] calldata eids) external payable nonReentrant {
        if (prepaids[dropId].payer != address(0)) revert BadPrepay();
        uint256 fee = listingFee(eids);
        if (msg.value < fee) revert WrongFee(fee);
        prepaids[dropId] = Prepaid(msg.sender, eids, fee, false);
        _pay(gasWallet, fee);
        if (msg.value > fee) _pay(msg.sender, msg.value - fee);
        emit Prepaid_(dropId, msg.sender, eids, fee);
    }

    /// @notice Operator lists a prepaid drop once its contract is deployed; the collection owner must be the payer.
    function listPrepaid(bytes32 dropId, address nft) external onlyOperator nonReentrant returns (uint256 id, address escrow) {
        Prepaid storage p = prepaids[dropId];
        if (p.payer == address(0) || p.used) revert BadPrepay();
        if (_ownerOfCollection(nft) != p.payer) revert NotCollectionOwner();
        p.used = true;
        (id, escrow) = _list(p.payer, nft, p.eids, p.paid);
    }

    /// @notice Owner can refund a prepaid drop that was rejected in review (sent from the caller, e.g. the gas wallet).
    function refundPrepaid(bytes32 dropId) external payable onlyOwner nonReentrant {
        Prepaid storage p = prepaids[dropId];
        if (p.payer == address(0) || p.used || msg.value != p.paid) revert BadPrepay();
        p.used = true;
        _pay(p.payer, msg.value);
    }

    function _list(address owner_, address nft, uint32[] memory eids, uint256 fee) internal returns (uint256 id, address escrow) {
        if (escrowOf[nft] != address(0)) revert AlreadyListed();
        escrow = address(new MultiSeaEscrow(endpoint, address(this), nft, false, feeWallet, priceFeed, maxPriceAge));
        escrowOf[nft] = escrow;
        id = ++listingCount;
        listings[id] = Listing(owner_, nft, escrow, eids, fee);
        emit Listed(id, nft, owner_, escrow, eids, fee);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{ value: amount }("");
        if (!ok) revert PayFailed();
    }

    /// @notice Operator deploys the mirror + escrow for listing `listingId` (id from the native chain) on this chain.
    function deployMirror(uint256 listingId, string calldata name, string calldata symbol, string calldata baseURI, uint256 firstId, uint256 supply)
        external onlyOperator returns (address mirror, address escrow)
    {
        if (mirrorDeployer == address(0)) revert BadPrepay();
        mirror = MultiSeaMirrorDeployer(mirrorDeployer).deploy(name, symbol, baseURI, firstId, supply);
        escrow = address(new MultiSeaEscrow(endpoint, address(this), mirror, true, feeWallet, priceFeed, maxPriceAge));
        MultiSeaMirrorDeployer(mirrorDeployer).initEscrow(mirror, escrow);
        escrowOf[mirror] = escrow;
        emit MirrorDeployed(listingId, mirror, escrow);
    }

    // ---- One-call wiring (peers + DVN/executor config) so a server operator can finish a listing in ~2 tx per chain ----
    struct LzRoute { address sendLib; address receiveLib; address executor; address dvn; uint64 confirmations; }
    LzRoute public lzRoute;                       // this chain's libs / executor / DVN / outbound confirmations
    mapping(uint32 => uint64) public remoteConfirmations; // inbound confirmations per source eid (= the source's outbound)

    function setLzRoute(LzRoute calldata r, uint32[] calldata eids, uint64[] calldata confs) external onlyOperator {
        lzRoute = r;
        if (eids.length != confs.length) revert BadChainCount();
        for (uint256 i; i < eids.length; ++i) remoteConfirmations[eids[i]] = confs[i];
    }

    function _uln(uint64 conf, address dvn) internal pure returns (bytes memory) {
        address[] memory req = new address[](1); req[0] = dvn;
        return abi.encode(UlnCfg(conf, 1, 0, 0, req, new address[](0)));
    }
    struct UlnCfg { uint64 confirmations; uint8 requiredDVNCount; uint8 optionalDVNCount; uint8 optionalDVNThreshold; address[] requiredDVNs; address[] optionalDVNs; }
    struct ExeCfg { uint32 maxMessageSize; address executor; }

    /// @notice Set peers on `escrow` for every remote eid and, when a route is configured, its send + receive LZ config.
    function wire(address escrow, uint32[] calldata eids, bytes32[] calldata peers) external onlyOperator {
        if (eids.length != peers.length) revert BadChainCount();
        for (uint256 i; i < eids.length; ++i) MultiSeaEscrow(escrow).setPeer(eids[i], peers[i]);
        LzRoute memory r = lzRoute;
        if (r.dvn == address(0)) return;
        SetConfigParam[] memory s_ = new SetConfigParam[](eids.length * 2);
        SetConfigParam[] memory v_ = new SetConfigParam[](eids.length);
        for (uint256 i; i < eids.length; ++i) {
            uint64 rc = remoteConfirmations[eids[i]]; if (rc == 0) revert ChainNotOffered(eids[i]);
            s_[2 * i] = SetConfigParam(eids[i], 1, abi.encode(ExeCfg(10000, r.executor)));
            s_[2 * i + 1] = SetConfigParam(eids[i], 2, _uln(r.confirmations, r.dvn));
            v_[i] = SetConfigParam(eids[i], 2, _uln(rc, r.dvn));
        }
        ILzEndpointConfig(endpoint).setConfig(escrow, r.sendLib, s_);
        ILzEndpointConfig(endpoint).setConfig(escrow, r.receiveLib, v_);
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
    function setGasWallet(address w) external onlyOwner { gasWallet = w; }
    address public mirrorDeployer;
    function setMirrorDeployer(address d) external onlyOwner { if (mirrorDeployer != address(0)) revert BadPrepay(); mirrorDeployer = d; }
    /// @notice Operator keeps gas reimbursements current. eid 0 sets baseGasCost.
    function setGasCosts(uint32[] calldata eids, uint256[] calldata costs) external onlyOperator {
        if (eids.length != costs.length) revert BadChainCount();
        for (uint256 i = 0; i < eids.length; i++) {
            if (eids[i] == 0) baseGasCost = costs[i]; else chainGasCost[eids[i]] = costs[i];
            emit GasCostSet(eids[i], costs[i]);
        }
    }
    function getPrepaid(bytes32 id) external view returns (Prepaid memory) { return prepaids[id]; }
    function setPriceFeed(address f, uint256 age) external onlyOwner { priceFeed = f; maxPriceAge = age; }
    function setSupportedChains(uint256 n) external onlyOwner { supportedChains = n; }

    function getListing(uint256 id) external view returns (Listing memory) { return listings[id]; }

    function _ownerOfCollection(address nft) internal view returns (address o) {
        (bool ok, bytes memory r) = nft.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && r.length >= 32) o = abi.decode(r, (address));
    }

}
