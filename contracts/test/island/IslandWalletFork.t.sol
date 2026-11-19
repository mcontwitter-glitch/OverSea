// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import { Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { IslandWalletFactory, LzLibConfig } from "../../src/island/IslandWalletFactory.sol";
import { IslandWallet, IslandCall } from "../../src/island/IslandWallet.sol";
import { MockERC20, MockERC721 } from "./IslandMocks.sol";

interface IIsl { function ownerOf(uint256) external view returns (address); function isActiveHere(uint256) external view returns (bool); function release(address to, uint256 id) external; function transferFrom(address, address, uint256) external; }
interface IReg { function createAccount(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external returns (address); function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address); }
interface ITBA { function initialize(address impl) external; function execute(address to, uint256 value, bytes calldata data, uint8 op) external payable returns (bytes memory); }
interface IEp {
    function getSendLibrary(address, uint32) external view returns (address);
    function getReceiveLibrary(address, uint32) external view returns (address, bool);
    function isDefaultSendLibrary(address, uint32) external view returns (bool);
    function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory);
}
struct Uln { uint64 confirmations; uint8 requiredDVNCount; uint8 optionalDVNCount; uint8 optionalDVNThreshold; address[] requiredDVNs; address[] optionalDVNs; }
struct TbOp { address to; uint256 value; bytes data; uint8 operation; }
interface ITBABatch { function executeBatch(TbOp[] calldata ops) external payable returns (bytes[] memory); }

/// Mainnet-fork tests on all 5 chains (run with ISLAND_FORK=1; RPCs overridable with RPC_<CHAIN>).
/// Nothing is broadcast: every deploy/config is simulated on local forks.
contract IslandWalletForkTest is Test {
    using OptionsBuilder for bytes;
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant MC = 0xb19F00e095B1387061d73751C772bbA848D196b1;
    bytes32 constant SALT = keccak256("MultiSea.IslandWalletFactory.v1");
    address constant TB_REG = 0x000000006551c19487814612e58FE06813775758;
    address constant TB_PROXY = 0x55266d75D1a14E4572138116aF39863Ed6596E7F;
    address constant TB_IMPL = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;
    bytes32 constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");

    struct C { string name; string rpc; uint256 chainId; uint32 eid; address island; address escrow; address endpoint; uint256 fork; }
    C[5] cs;
    uint256 constant RH = 4; // Robinhood: where Island #31 and #32 are live today
    bool on;

    function setUp() public {
        on = vm.envOr("ISLAND_FORK", false);
        if (!on) return;
        cs[0] = C("base", vm.envOr("RPC_BASE", string("https://base-rpc.publicnode.com")), 8453, 30184, 0x5A54e10A40320D6285bdFA323e44B7ABEcfE87eF, 0x6CB09C1Fca57540607f08273c9cD6335287374Ad, 0x1a44076050125825900e736c501f859c50fE728c, 0);
        cs[1] = C("ethereum", vm.envOr("RPC_ETHEREUM", string("https://ethereum-rpc.publicnode.com")), 1, 30101, 0x510b1bE747304dD83B296279ccF18CA3a3Fbfe88, 0x696E180F80cCA3d66D5D5CCF6cb55A7bE3661cFD, 0x1a44076050125825900e736c501f859c50fE728c, 0);
        cs[2] = C("apechain", vm.envOr("RPC_APECHAIN", string("https://rpc.apechain.com")), 33139, 30312, 0x710DA1692Ba974e7AA67EB071aC4A5d394e6471C, 0x8A6F25B25Db5AeFCD76631010A86B0e46663ddd3, 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B, 0);
        cs[3] = C("bnb", vm.envOr("RPC_BNB", string("https://bsc-rpc.publicnode.com")), 56, 30102, 0x710DA1692Ba974e7AA67EB071aC4A5d394e6471C, 0x8A6F25B25Db5AeFCD76631010A86B0e46663ddd3, 0x1a44076050125825900e736c501f859c50fE728c, 0);
        cs[4] = C("robinhood", vm.envOr("RPC_ROBINHOOD", string("https://rpc.mainnet.chain.robinhood.com")), 4663, 30416, 0x8BbA134d6ae56aBF32180754C030c935f28A79Ae, 0xDFe3Ad4AD4813dd89a822D732D690fDf33372aAe, 0x6F475642a6e85809B1c36Fa62763669b1b48DD5B, 0);
        for (uint256 i; i < 5; ++i) cs[i].fork = vm.createFork(cs[i].rpc);
    }

    function _init() internal pure returns (bytes memory) { return abi.encodePacked(type(IslandWalletFactory).creationCode, abi.encode(MC)); }
    function _predicted() internal pure returns (address) { return vm.computeCreate2Address(SALT, keccak256(_init()), ARACHNID); }

    /// Select chain i and deploy + configure the factory exactly as MC would (deterministic deployer, then setChainConfig).
    function _deploy(uint256 i) internal returns (IslandWalletFactory f, uint256 gDeploy, uint256 gConfig) {
        vm.selectFork(cs[i].fork);
        assertEq(block.chainid, cs[i].chainId, "rpc chain id");
        assertGt(ARACHNID.code.length, 0, "deterministic deployer missing");
        f = IslandWalletFactory(_predicted());
        if (address(f).code.length == 0) {
            vm.prank(MC); uint256 g0 = gasleft();
            (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(SALT, _init()));
            gDeploy = g0 - gasleft();
            require(ok, "deploy failed");
            assertEq(address(bytes20(ret)), address(f), "address");
            uint32[] memory r = new uint32[](4); uint256 n;
            for (uint256 j; j < 5; ++j) if (j != i) r[n++] = cs[j].eid;
            LzLibConfig[] memory lz = _lzCfg(i, r);
            vm.prank(MC); g0 = gasleft();
            f.setChainConfig(cs[i].island, cs[i].endpoint, r, MC, lz);
            gConfig = g0 - gasleft();
        }
    }

    /// ULN config as read back from the endpoint is the resolved one; a count of 0 there means "none", which must be
    /// written as NIL (255) so the factory doesn't fall back to LayerZero's default DVNs.
    function _norm(bytes memory b) internal pure returns (bytes memory) {
        Uln memory u = abi.decode(b, (Uln));
        if (u.requiredDVNCount == 0) u.requiredDVNCount = 255;
        if (u.optionalDVNCount == 0) { u.optionalDVNCount = 255; u.optionalDVNThreshold = 0; }
        return abi.encode(u);
    }
    /// Copy the Island bridge escrow's LayerZero settings on chain i (same DVNs, executor and confirmations).
    function _lzCfg(uint256 i, uint32[] memory r) internal view returns (LzLibConfig[] memory out) {
        IEp ep = IEp(cs[i].endpoint); address esc = cs[i].escrow;
        out = new LzLibConfig[](r.length * 2);
        for (uint256 j; j < r.length; ++j) {
            require(ep.isDefaultSendLibrary(esc, r[j]), "escrow uses a custom send library");
            address sl = ep.getSendLibrary(esc, r[j]); (address rl,) = ep.getReceiveLibrary(esc, r[j]);
            SetConfigParam[] memory sp = new SetConfigParam[](2);
            sp[0] = SetConfigParam(r[j], 1, ep.getConfig(esc, sl, r[j], 1));
            sp[1] = SetConfigParam(r[j], 2, _norm(ep.getConfig(esc, sl, r[j], 2)));
            SetConfigParam[] memory rp = new SetConfigParam[](1);
            rp[0] = SetConfigParam(r[j], 2, _norm(ep.getConfig(esc, rl, r[j], 2)));
            out[2 * j] = LzLibConfig(sl, sp); out[2 * j + 1] = LzLibConfig(rl, rp);
        }
    }

    function test_fork_same_address_on_all_5_chains() public {
        if (!on) return;
        address w31; address w1;
        for (uint256 i; i < 5; ++i) {
            (IslandWalletFactory f, uint256 gd, uint256 gc) = _deploy(i);
            console2.log(cs[i].name, address(f));
            console2.log("  deploy gas / config gas", gd, gc);
            assertEq(address(f), _predicted());
            assertEq(f.localEid(), cs[i].eid); assertEq(f.island(), cs[i].island); assertEq(f.owner(), MC);
            // The factory's LayerZero settings equal the bridge escrow's on every pathway.
            for (uint256 j; j < 5; ++j) if (j != i) {
                IEp ep = IEp(cs[i].endpoint); address sl = ep.getSendLibrary(cs[i].escrow, cs[j].eid);
                assertEq(ep.getSendLibrary(address(f), cs[j].eid), sl);
                assertEq(ep.getConfig(address(f), sl, cs[j].eid, 2), ep.getConfig(cs[i].escrow, sl, cs[j].eid, 2));
                assertEq(ep.getConfig(address(f), sl, cs[j].eid, 1), ep.getConfig(cs[i].escrow, sl, cs[j].eid, 1));
                (address rl,) = ep.getReceiveLibrary(cs[i].escrow, cs[j].eid);
                assertEq(ep.getConfig(address(f), rl, cs[j].eid, 2), ep.getConfig(cs[i].escrow, rl, cs[j].eid, 2));
            }
            if (i == 0) { w31 = f.walletOf(31); w1 = f.walletOf(1); }
            assertEq(f.walletOf(31), w31, "wallet #31 differs"); assertEq(f.walletOf(1), w1, "wallet #1 differs");
            // The Island is locked on every chain but one: liveOwner must agree with the drop's own isActiveHere.
            for (uint256 id = 30; id <= 33; ++id) {
                bool act = IIsl(cs[i].island).isActiveHere(id);
                assertEq(f.liveOwner(id) != address(0), act);
            }
        }
        console2.log("Island #31 wallet on all 5 chains", w31);
    }

    function test_fork_receive_before_deploy_on_all_5() public {
        if (!on) return;
        for (uint256 i; i < 5; ++i) {
            (IslandWalletFactory f,,) = _deploy(i);
            address w = f.walletOf(55);
            assertEq(w.code.length, 0);
            address payer = makeAddr("payer"); vm.deal(payer, 2 ether);
            uint256 b0 = w.balance;
            vm.prank(payer); (bool ok,) = w.call{ value: 1 ether }(""); assertTrue(ok);
            MockERC20 t = new MockERC20(); t.mint(payer, 10e18); vm.prank(payer); t.transfer(w, 3e18);
            MockERC721 n = new MockERC721(); n.mint(payer, 9); vm.prank(payer); n.transferFrom(payer, w, 9);
            assertEq(w.balance - b0, 1 ether); assertEq(t.balanceOf(w), 3e18); assertEq(n.ownerOf(9), w);
            uint256 g0 = gasleft(); f.deployWallet(55); console2.log(cs[i].name, "wallet create gas", g0 - gasleft());
            assertGt(w.code.length, 0); assertEq(w.balance - b0, 1 ether); assertEq(t.balanceOf(w), 3e18);
        }
    }

    function test_fork_direct_control_on_live_chain_only() public {
        if (!on) return;
        (IslandWalletFactory f,,) = _deploy(RH);
        address holder = IIsl(cs[RH].island).ownerOf(31);
        assertEq(f.liveOwner(31), holder);
        address w = f.deployWallet(31); vm.deal(w, 1 ether);
        address to = makeAddr("to");
        vm.prank(makeAddr("stranger")); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(to, 0.1 ether, "");
        vm.prank(holder); uint256 g0 = gasleft(); IslandWallet(payable(w)).execute(to, 0.25 ether, ""); console2.log("robinhood direct execute gas", g0 - gasleft());
        assertEq(to.balance, 0.25 ether);
        // On every other chain the copy is in the escrow: the same holder has no direct control there.
        for (uint256 i; i < 4; ++i) {
            (IslandWalletFactory g,,) = _deploy(i);
            assertEq(g.liveOwner(31), address(0));
            address w2 = g.deployWallet(31); vm.deal(w2, 1 ether);
            assertEq(w2, w);
            vm.prank(holder); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w2)).execute(to, 0.1 ether, "");
            vm.prank(cs[i].escrow); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w2)).execute(to, 0.1 ether, "");
        }
    }

    function _packet() internal returns (bytes32 guid, uint64 nonce, bytes memory message) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k; k < logs.length; ++k) if (logs[k].topics[0] == PACKET_SENT) {
            (bytes memory p,,) = abi.decode(logs[k].data, (bytes, bytes, address));
            nonce = uint64(bytes8(_slice(p, 1, 8))); guid = bytes32(_slice(p, 81, 32)); message = _slice(p, 113, p.length - 113);
            return (guid, nonce, message);
        }
        revert("no PacketSent");
    }
    function _slice(bytes memory b, uint256 s, uint256 l) internal pure returns (bytes memory r) { r = new bytes(l); for (uint256 k; k < l; ++k) r[k] = b[s + k]; }

    function _relay(uint256 i, IslandWalletFactory f, address holder, address w, address to) internal {
        // Pre-fund #31's wallet on the destination (before it exists there) with a coin and an NFT.
        vm.selectFork(cs[i].fork);
        vm.deal(w, 1 ether);
        MockERC721 n = new MockERC721(); n.mint(w, 77);
        assertEq(w.code.length, 0);
        IslandCall[] memory calls = new IslandCall[](2);
        calls[0] = IslandCall(to, 0.4 ether, "");
        calls[1] = IslandCall(address(n), 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", w, to, uint256(77)));
        (bytes32 guid, uint64 pn, bytes memory m) = _sendRemote(i, f, holder, calls);
        _deliver(i, f, guid, pn, m);
        assertEq(to.balance, 0.4 ether); assertEq(n.ownerOf(77), to); assertGt(w.code.length, 0);
        vm.deal(to, 0);
    }

    function _sendRemote(uint256 i, IslandWalletFactory f, address holder, IslandCall[] memory calls) internal returns (bytes32 guid, uint64 pn, bytes memory m) {
        // Send from Robinhood with the real endpoint and default LayerZero config.
        vm.selectFork(cs[RH].fork);
        bytes memory opts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(300_000, 0);
        uint64 dl = uint64(block.timestamp + 1 hours);
        uint256 fee = f.quoteRemote(31, cs[i].eid, calls, dl, opts);
        console2.log("LZ fee robinhood ->", cs[i].name, fee);
        vm.deal(holder, holder.balance + fee + 1 ether);
        vm.deal(makeAddr("thief"), fee); vm.prank(makeAddr("thief")); vm.expectRevert(IslandWalletFactory.NotLiveOwner.selector); f.remoteExecute{ value: fee }(31, cs[i].eid, calls, dl, opts);
        vm.recordLogs();
        vm.prank(holder); (guid,) = f.remoteExecute{ value: fee }(31, cs[i].eid, calls, dl, opts);
        bytes32 pg; (pg, pn, m) = _packet();
        assertEq(pg, guid);
    }

    function _deliver(uint256 i, IslandWalletFactory f, bytes32 guid, uint64 pn, bytes memory m) internal {
        vm.selectFork(cs[i].fork);
        IslandWalletFactory g = IslandWalletFactory(_predicted());
        Origin memory o = Origin(cs[RH].eid, bytes32(uint256(uint160(address(f)))), pn);
        assertTrue(g.allowInitializePath(o));
        vm.expectRevert(IslandWalletFactory.NotEndpoint.selector); g.lzReceive(o, guid, m, address(0), "");
        vm.prank(cs[i].endpoint); uint256 g0 = gasleft(); g.lzReceive(o, guid, m, address(0), ""); console2.log("  lzReceive gas incl. wallet create", g0 - gasleft());
        vm.prank(cs[i].endpoint); vm.expectRevert(IslandWalletFactory.Replayed.selector); g.lzReceive(o, guid, m, address(0), "");
    }

    /// Holder of #31 on Robinhood (live) moves coins and an NFT out of #31's wallet on each other chain through LayerZero.
    function test_fork_layerzero_relayed_control_to_all_other_chains() public {
        if (!on) return;
        for (uint256 i; i < 5; ++i) _deploy(i);
        vm.selectFork(cs[RH].fork);
        address holder = IIsl(cs[RH].island).ownerOf(31);
        IslandWalletFactory f = IslandWalletFactory(_predicted());
        address w = f.walletOf(31); address to = makeAddr("recipient");
        for (uint256 i; i < 4; ++i) _relay(i, f, holder, w, to);
        // A message for Robinhood itself (where #31 is live) is refused: only the local holder controls it there.
        vm.selectFork(cs[RH].fork);
        IslandCall[] memory c1 = new IslandCall[](1); c1[0] = IslandCall(to, 0, "");
        bytes memory forged = abi.encode(uint8(1), uint256(31), uint64(99), uint64(block.timestamp + 60), holder, c1);
        vm.prank(cs[RH].endpoint); vm.expectRevert(IslandWalletFactory.LiveHere.selector);
        f.lzReceive(Origin(cs[0].eid, bytes32(uint256(uint160(address(f)))), 1), bytes32(0), forged, address(0), "");
    }

    /// #32: 0.004 ETH at its old ERC-6551 address on Robinhood (Island live there) -> moved to the new address.
    function test_fork_migrate_island32_robinhood_eth() public {
        if (!on) return;
        (IslandWalletFactory f,,) = _deploy(RH);
        address holder = IIsl(cs[RH].island).ownerOf(32);
        address old = IReg(TB_REG).account(TB_PROXY, bytes32(0), cs[RH].chainId, cs[RH].island, 32);
        assertEq(old, 0x767bCBCe7562012D0287f0c7f8fCaCdad76d14B2);
        uint256 bal = old.balance; assertGt(bal, 0, "expected the #32 legacy balance");
        address neu = f.walletOf(32); uint256 n0 = neu.balance;
        // Step 1 (anyone): create + initialize the old Tokenbound account. Step 2 (holder): sweep to the new address.
        if (old.code.length == 0) IReg(TB_REG).createAccount(TB_PROXY, bytes32(0), cs[RH].chainId, cs[RH].island, 32);
        ITBA(old).initialize(TB_IMPL);
        TbOp[] memory ops = new TbOp[](1); ops[0] = TbOp(neu, bal, "", 0);
        vm.prank(makeAddr("stranger")); vm.expectRevert(); ITBABatch(old).executeBatch(ops);
        vm.prank(holder); uint256 g0 = gasleft(); ITBABatch(old).executeBatch(ops); console2.log("legacy sweep gas (1 coin)", g0 - gasleft());
        assertEq(old.balance, 0); assertEq(neu.balance - n0, bal);
    }

    /// #31: 2 LIL FOOTS at its old ERC-6551 address on Ethereum, Island live on Robinhood. Not movable until the Island
    /// is on Ethereum (Tokenbound checks ownerOf there); after it arrives the holder moves both in one batch.
    function test_fork_migrate_island31_ethereum_nfts() public {
        if (!on) return;
        (IslandWalletFactory f,,) = _deploy(1);
        vm.selectFork(cs[RH].fork); address holder = IIsl(cs[RH].island).ownerOf(31);
        vm.selectFork(cs[1].fork);
        address lf = 0xf12476842cCbE4c7e6847eb67777f29f25419738;
        address old = IReg(TB_REG).account(TB_PROXY, bytes32(0), 1, cs[1].island, 31);
        assertEq(old, 0x87427F20eEb0BD823A32E1094428c25A895dbF11);
        assertEq(IIsl(lf).ownerOf(607), old); assertEq(IIsl(lf).ownerOf(1323), old);
        address neu = f.walletOf(31);
        if (old.code.length == 0) IReg(TB_REG).createAccount(TB_PROXY, bytes32(0), 1, cs[1].island, 31);
        ITBA(old).initialize(TB_IMPL);
        TbOp[] memory ops = new TbOp[](2);
        ops[0] = TbOp(lf, 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", old, neu, uint256(607)), 0);
        ops[1] = TbOp(lf, 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", old, neu, uint256(1323)), 0);
        vm.prank(holder); vm.expectRevert(); ITBABatch(old).executeBatch(ops); // Island locked on Ethereum
        // The Island arrives on Ethereum (as the escrow does on a LayerZero move).
        vm.prank(cs[1].escrow); IIsl(cs[1].island).release(holder, 31);
        assertEq(IIsl(cs[1].island).ownerOf(31), holder);
        vm.prank(holder); uint256 g0 = gasleft(); ITBABatch(old).executeBatch(ops); console2.log("legacy sweep gas (2 NFTs)", g0 - gasleft());
        assertEq(IIsl(lf).ownerOf(607), neu); assertEq(IIsl(lf).ownerOf(1323), neu);
        // ...and now controls the new wallet directly on Ethereum.
        assertEq(f.liveOwner(31), holder);
        f.deployWallet(31);
        vm.prank(holder); IslandWallet(payable(neu)).execute(lf, 0, abi.encodeWithSignature("transferFrom(address,address,uint256)", neu, holder, uint256(607)));
        assertEq(IIsl(lf).ownerOf(607), holder);
    }
}
