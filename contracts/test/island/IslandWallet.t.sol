// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import { IslandWalletFactory, LzLibConfig } from "../../src/island/IslandWalletFactory.sol";
import { IslandWallet, IslandCall } from "../../src/island/IslandWallet.sol";
import { Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { MockIslandDrop, MockEndpoint, MockERC20, MockERC721, MockERC1155 } from "./IslandMocks.sol";

contract IslandWalletTest is Test {
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant MC = 0xb19F00e095B1387061d73751C772bbA848D196b1;
    bytes32 constant SALT = keccak256("MultiSea.IslandWalletFactory.v1");
    uint32 constant LOCAL = 30184; uint32 constant REMOTE = 30416;
    IslandWalletFactory f; MockIslandDrop isl; MockEndpoint ep; address escrow = address(0xE5C);
    address alice = address(0xA11CE); address bob = address(0xB0B);

    function setUp() public {
        // Arachnid deterministic deployer runtime (same code as on mainnet)
        vm.etch(ARACHNID, hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3");
        bytes memory init = abi.encodePacked(type(IslandWalletFactory).creationCode, abi.encode(MC));
        (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(SALT, init));
        require(ok, "deploy");
        f = IslandWalletFactory(address(bytes20(ret)));
        assertEq(address(f), vm.computeCreate2Address(SALT, keccak256(init), ARACHNID));
        isl = new MockIslandDrop(escrow); ep = new MockEndpoint(LOCAL);
        uint32[] memory r = new uint32[](1); r[0] = REMOTE;
        vm.prank(MC); f.setChainConfig(address(isl), address(ep), r, address(0), new LzLibConfig[](0));
        isl.mint(alice, 7);
        vm.deal(alice, 10 ether);
    }

    function _calls(address to, uint256 v, bytes memory d) internal pure returns (IslandCall[] memory c) { c = new IslandCall[](1); c[0] = IslandCall(to, v, d); }
    function _peer() internal view returns (bytes32) { return bytes32(uint256(uint160(address(f)))); }

    /// The site's config/island-wallet.json (written by scripts/island-wallet-artifact.mjs) matches this build.
    function test_site_artifact_matches_build() public view {
        string memory j = vm.readFile("../config/island-wallet.json");
        assertEq(vm.parseJsonAddress(j, ".factory"), address(f), "re-run node scripts/island-wallet-artifact.mjs");
        assertEq(vm.parseJsonAddress(j, ".implementation"), f.implementation());
        assertEq(vm.parseJsonAddress(j, ".wallet31"), f.walletOf(31));
    }

    function test_config_once_and_owner_only() public {
        assertEq(f.owner(), MC); assertEq(ep.delegate(), MC); assertEq(f.localEid(), LOCAL); assertTrue(f.remoteEnabled(REMOTE));
        uint32[] memory r = new uint32[](0);
        vm.prank(MC); vm.expectRevert(IslandWalletFactory.AlreadyConfigured.selector); f.setChainConfig(address(isl), address(ep), r, address(0), new LzLibConfig[](0));
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.NotOwner.selector); f.addRemote(30101);
        vm.prank(MC); vm.expectRevert(IslandWalletFactory.BadConfig.selector); f.addRemote(LOCAL);
        vm.prank(MC); f.addRemote(30101); assertTrue(f.remoteEnabled(30101)); assertEq(f.remotes().length, 2);
    }

    function test_lz_config_owner_only() public {
        LzLibConfig[] memory c = new LzLibConfig[](2);
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.NotOwner.selector); f.setLzConfig(c);
        vm.prank(MC); f.setLzConfig(c); assertEq(ep.configCalls(), 2);
    }

    function test_unconfigured_factory_controls_nothing() public {
        bytes memory init = abi.encodePacked(type(IslandWalletFactory).creationCode, abi.encode(MC));
        (, bytes memory ret) = ARACHNID.call(abi.encodePacked(keccak256("other"), init));
        IslandWalletFactory g = IslandWalletFactory(address(bytes20(ret)));
        assertEq(g.liveOwner(7), address(0));
        address w = g.deployWallet(7);
        vm.prank(alice); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(bob, 0, "");
    }

    function test_address_deterministic_and_receive_before_deploy() public {
        address w = f.walletOf(7);
        assertEq(w, vm.computeCreate2Address(f.saltOf(7), keccak256(abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", f.implementation(), hex"5af43d82803e903d91602b57fd5bf3")), address(f)));
        assertFalse(f.isDeployed(7));
        vm.prank(alice); (bool ok,) = w.call{ value: 1 ether }(""); assertTrue(ok);
        MockERC20 t = new MockERC20(); t.mint(w, 5e18);
        MockERC721 n = new MockERC721(); n.mint(alice, 1); vm.prank(alice); n.transferFrom(alice, w, 1);
        assertEq(w.balance, 1 ether); assertEq(t.balanceOf(w), 5e18); assertEq(n.ownerOf(1), w);
        // deploy keeps everything
        assertEq(f.deployWallet(7), w); assertTrue(f.isDeployed(7)); assertEq(f.deployWallet(7), w);
        assertEq(IslandWallet(payable(w)).tokenId(), 7); assertEq(w.balance, 1 ether);
        // safe transfers work once deployed
        n.mint(alice, 2); vm.prank(alice); n.safeTransferFrom(alice, w, 2); assertEq(n.ownerOf(2), w);
        MockERC1155 m = new MockERC1155(); m.mint(alice, 3, 4); vm.prank(alice); m.safeTransferFrom(alice, w, 3, 4, ""); assertEq(m.balanceOf(w, 3), 4);
    }

    function test_implementation_and_clone_cannot_be_reinitialized() public {
        address w = f.deployWallet(7);
        vm.expectRevert(IslandWallet.NotFactory.selector); IslandWallet(payable(w)).initialize(8);
        vm.prank(address(f)); vm.expectRevert(IslandWallet.AlreadyInitialized.selector); IslandWallet(payable(w)).initialize(8);
        IslandWallet impl = IslandWallet(payable(f.implementation()));
        assertEq(impl.factory(), address(f));
        vm.prank(address(f)); vm.expectRevert(IslandWallet.AlreadyInitialized.selector); impl.initialize(8);
    }

    function test_direct_control_by_live_owner_only() public {
        address w = f.deployWallet(7); vm.deal(w, 2 ether);
        MockERC20 t = new MockERC20(); t.mint(w, 5e18);
        vm.prank(bob); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(bob, 1 ether, "");
        vm.prank(alice); IslandWallet(payable(w)).execute(bob, 1 ether, "");
        assertEq(bob.balance, 1 ether);
        IslandCall[] memory c = new IslandCall[](2);
        c[0] = IslandCall(address(t), 0, abi.encodeCall(t.transfer, (bob, 2e18))); c[1] = IslandCall(bob, 0.5 ether, "");
        vm.prank(alice); IslandWallet(payable(w)).executeBatch(c);
        assertEq(t.balanceOf(bob), 2e18); assertEq(bob.balance, 1.5 ether); assertEq(IslandWallet(payable(w)).state(), 2);
        // new holder takes over immediately
        vm.prank(alice); isl.transferFrom(alice, bob, 7);
        vm.prank(alice); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(alice, 0.1 ether, "");
        vm.prank(bob); IslandWallet(payable(w)).execute(bob, 0.1 ether, "");
        // locked in escrow here: nobody controls it directly (not even the escrow)
        isl.lock(7);
        assertEq(IslandWallet(payable(w)).owner(), address(0));
        vm.prank(bob); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(bob, 0.1 ether, "");
        vm.prank(escrow); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(bob, 0.1 ether, "");
        vm.prank(MC); vm.expectRevert(IslandWallet.NotOwner.selector); IslandWallet(payable(w)).execute(bob, 0.1 ether, "");
    }

    function test_failed_call_reverts_whole_batch() public {
        address w = f.deployWallet(7); vm.deal(w, 1 ether);
        IslandCall[] memory c = new IslandCall[](2);
        c[0] = IslandCall(bob, 0.5 ether, ""); c[1] = IslandCall(bob, 5 ether, "");
        vm.prank(alice); vm.expectRevert(); IslandWallet(payable(w)).executeBatch(c);
        assertEq(bob.balance, 0);
    }

    function test_refuses_own_island() public {
        address w = f.deployWallet(7);
        vm.prank(alice); vm.expectRevert(); isl.safeTransferFrom(alice, w, 7);
        isl.mint(alice, 8); vm.prank(alice); isl.safeTransferFrom(alice, w, 8); assertEq(isl.ownerOf(8), w);
    }

    function test_erc1271() public {
        (address signer, uint256 pk) = makeAddrAndKey("holder");
        vm.prank(alice); isl.transferFrom(alice, signer, 7);
        address w = f.deployWallet(7); bytes32 h = keccak256("hi");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        assertEq(IslandWallet(payable(w)).isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        isl.lock(7);
        assertEq(IslandWallet(payable(w)).isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    // ---------------------------------------------------------------- LayerZero path
    function _send(address from, IslandCall[] memory c, uint64 dl) internal returns (bytes memory m, bytes32 guid, uint64 nonce) {
        uint256 fee = f.quoteRemote(7, REMOTE, c, dl, hex"0003");
        assertEq(fee, 0.01 ether);
        vm.prank(from); (guid, nonce) = f.remoteExecute{ value: 0.02 ether }(7, REMOTE, c, dl, hex"0003");
        m = ep.lastMessage();
    }

    function test_remote_send_only_by_live_owner() public {
        IslandCall[] memory c = _calls(bob, 1 ether, "");
        uint64 dl = uint64(block.timestamp + 1 hours);
        vm.deal(bob, 1 ether);
        vm.prank(bob); vm.expectRevert(IslandWalletFactory.NotLiveOwner.selector); f.remoteExecute{ value: 0.01 ether }(7, REMOTE, c, dl, "");
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(IslandWalletFactory.UnknownRemote.selector, uint32(30102))); f.remoteExecute{ value: 0.01 ether }(7, 30102, c, dl, "");
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.BadDeadline.selector); f.remoteExecute{ value: 0.01 ether }(7, REMOTE, c, uint64(block.timestamp + 2 days), "");
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.BadDeadline.selector); f.remoteExecute{ value: 0.01 ether }(7, REMOTE, c, uint64(block.timestamp), "");
        uint256 b0 = alice.balance;
        (, , uint64 nonce) = _send(alice, c, dl);
        assertEq(nonce, 1); assertEq(ep.lastDst(), REMOTE); assertEq(ep.lastReceiver(), _peer()); assertEq(ep.lastRefund(), alice);
        assertEq(b0 - alice.balance, 0.01 ether); // excess refunded
        isl.lock(7);
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.NotLiveOwner.selector); f.remoteExecute{ value: 0.01 ether }(7, REMOTE, c, dl, "");
    }

    function test_remote_receive_executes_with_replay_and_peer_checks() public {
        address w = f.walletOf(7); vm.deal(w, 3 ether);
        uint64 dl = uint64(block.timestamp + 1 hours);
        (bytes memory m, bytes32 guid, uint64 nonce) = _send(alice, _calls(bob, 1 ether, ""), dl);
        // Here the Island is still live -> a message for it is refused (only the local holder controls it).
        vm.expectRevert(IslandWalletFactory.LiveHere.selector); ep.deliver(address(f), REMOTE, _peer(), nonce, guid, m);
        isl.lock(7); // now this chain is the "other chain" (Island live elsewhere)
        // only the endpoint, only from the peer (this same address), only from an enabled chain
        vm.expectRevert(IslandWalletFactory.NotEndpoint.selector); f.lzReceive(_origin(REMOTE, _peer(), nonce), guid, m, address(0), "");
        vm.expectRevert(IslandWalletFactory.BadPeer.selector); ep.deliver(address(f), REMOTE, bytes32(uint256(uint160(bob))), nonce, guid, m);
        vm.expectRevert(IslandWalletFactory.BadPeer.selector); ep.deliver(address(f), 30102, _peer(), nonce, guid, m);
        assertFalse(f.isDeployed(7));
        ep.deliver(address(f), REMOTE, _peer(), nonce, guid, m);
        assertTrue(f.isDeployed(7)); assertEq(bob.balance, 1 ether); assertTrue(f.usedNonce(REMOTE, 7, nonce));
        vm.expectRevert(IslandWalletFactory.Replayed.selector); ep.deliver(address(f), REMOTE, _peer(), nonce, guid, m);
        assertEq(bob.balance, 1 ether);
    }

    function test_remote_message_expires() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        (bytes memory m, bytes32 guid, uint64 nonce) = _send(alice, _calls(bob, 0, ""), dl);
        isl.lock(7);
        vm.warp(dl + 1);
        vm.expectRevert(IslandWalletFactory.Expired.selector); ep.deliver(address(f), REMOTE, _peer(), nonce, guid, m);
    }

    function test_forged_message_cannot_act_and_bad_version() public {
        isl.lock(7);
        IslandCall[] memory c = _calls(bob, 0, "");
        bytes memory bad = abi.encode(uint8(2), uint256(7), uint64(1), uint64(block.timestamp + 100), alice, c);
        vm.expectRevert(IslandWalletFactory.BadVersion.selector); ep.deliver(address(f), REMOTE, _peer(), 1, bytes32(0), bad);
        // a random contract can't impersonate the endpoint
        bytes memory good = abi.encode(uint8(1), uint256(7), uint64(1), uint64(block.timestamp + 100), alice, c);
        MockEndpoint fake = new MockEndpoint(REMOTE);
        vm.expectRevert(IslandWalletFactory.NotEndpoint.selector); fake.deliver(address(f), REMOTE, _peer(), 1, bytes32(0), good);
    }

    function test_wallet_executeFromFactory_only_factory() public {
        address w = f.deployWallet(7);
        vm.prank(alice); vm.expectRevert(IslandWallet.NotFactory.selector); IslandWallet(payable(w)).executeFromFactory(_calls(bob, 0, ""));
    }

    function test_allowInitializePath_and_nextNonce() public view {
        assertTrue(f.allowInitializePath(_origin(REMOTE, _peer(), 1)));
        assertFalse(f.allowInitializePath(_origin(REMOTE, bytes32(uint256(1)), 1)));
        assertFalse(f.allowInitializePath(_origin(30102, _peer(), 1)));
        assertEq(f.nextNonce(REMOTE, _peer()), 0);
    }

    function test_ownership_two_step() public {
        vm.prank(MC); f.transferOwnership(bob);
        assertEq(f.owner(), MC);
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.NotOwner.selector); f.acceptOwnership();
        vm.prank(bob); f.acceptOwnership(); assertEq(f.owner(), bob);
        vm.prank(bob); f.renounceOwnership(); assertEq(f.owner(), address(0));
    }

    function test_too_many_calls() public {
        IslandCall[] memory c = new IslandCall[](17);
        vm.prank(alice); vm.expectRevert(IslandWalletFactory.TooManyCalls.selector); f.remoteExecute{ value: 0.01 ether }(7, REMOTE, c, uint64(block.timestamp + 60), "");
    }

    function _origin(uint32 e, bytes32 s, uint64 n) internal pure returns (Origin memory) { return Origin(e, s, n); }
}
