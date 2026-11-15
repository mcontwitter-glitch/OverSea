// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";
import { MultiSeaOmniDrop } from "../src/launchpad/MultiSeaOmniDrop.sol";
import { MultiSeaOmniDropV2 } from "../src/launchpad/MultiSeaOmniDropV2.sol";
import { MultiSeaOmniEscrowV2 } from "../src/launchpad/MultiSeaOmniEscrowV2.sol";
import { MultiSeaLaunchpadFactory } from "../src/launchpad/MultiSeaLaunchpadFactory.sol";

/// Stands in for the MultiSea Solana program on its own mock endpoint: records what it receives and sends the
/// same 192-byte payloads the Rust program sends (REQUEST to the hub, MOVE out). The Rust side is exercised for real
/// against these exact payloads in solana/tests (local validator with the real LayerZero endpoint + Metaplex Core).
contract SolanaStub is OApp {
    using OptionsBuilder for bytes;
    bytes32 public last; uint32 public lastSrc; // keccak of the last payload (cheap: the mock executor uses the Solana CU number as gas)
    constructor(address ep, address o) OApp(ep, o) Ownable(o) {}
    function _lzReceive(Origin calldata o, bytes32, bytes calldata m, address, bytes calldata) internal override { last = keccak256(m); lastSrc = o.srcEid; }
    function send(uint32 dst, bytes calldata m, uint128 gas, uint128 value) external payable {
        bytes memory opt = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas, value);
        _lzSend(dst, m, opt, MessagingFee(msg.value, 0), payable(msg.sender));
    }
    function quote(uint32 dst, bytes calldata m, uint128 gas, uint128 value) external view returns (uint256) {
        return _quote(dst, m, OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas, value), false).nativeFee;
    }
}

/// V2 escrow + drop with a Solana chain (S) in the drop: A = hub (Base), B = another EVM chain, S = Solana (stub).
contract LaunchpadOmniSolanaTest is TestHelperOz5 {
    uint32 constant A = 1; uint32 constant B = 2; uint32 constant S = 3;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address timelock = address(0x71);
    address creator = address(0xC0FFEE);
    address alice = address(0xA1); address bob = address(0xB0B);
    bytes32 constant SOL_ALICE = keccak256("alice's phantom");
    uint256 apk = 0xA11CE; address approver;
    bytes32 constant CID = keccak256("solana-omni");
    uint256 constant MOVE_FEE = 0.0001 ether;
    mapping(uint32 => MultiSeaOmniEscrowV2) esc;
    mapping(uint32 => MultiSeaLaunchpadFactory) fac;
    mapping(uint32 => MultiSeaOmniDropV2) drop;
    SolanaStub sol;

    function setUp() public override {
        vm.warp(1_800_000_000);
        super.setUp();
        setUpEndpoints(3, LibraryType.UltraLightNode);
        approver = vm.addr(apk);
        uint32[2] memory evm = [A, B];
        for (uint256 i; i < 2; ++i) {
            uint32 e = evm[i];
            esc[e] = new MultiSeaOmniEscrowV2(address(endpoints[e]), timelock, FEE, MOVE_FEE);
            fac[e] = new MultiSeaLaunchpadFactory(timelock, address(new MultiSeaDrop()), FEE, approver, 50);
            address impl = address(new MultiSeaOmniDropV2());
            vm.startPrank(timelock);
            esc[e].setFactory(address(fac[e])); fac[e].setOmni(impl, address(esc[e])); esc[e].setSolana(S, true);
            vm.stopPrank();
        }
        sol = new SolanaStub(address(endpoints[S]), address(this));
        vm.startPrank(timelock);
        esc[A].setPeer(B, addressToBytes32(address(esc[B]))); esc[B].setPeer(A, addressToBytes32(address(esc[A])));
        esc[A].setPeer(S, addressToBytes32(address(sol))); esc[B].setPeer(S, addressToBytes32(address(sol)));
        vm.stopPrank();
        sol.setPeer(A, addressToBytes32(address(esc[A]))); sol.setPeer(B, addressToBytes32(address(esc[B])));
        drop[A] = deploy(A, params(1)); drop[B] = deploy(B, params(1));
        vm.deal(alice, 1000 ether); vm.deal(bob, 1000 ether); vm.deal(address(this), 1000 ether);
    }

    function params(uint8 mode) internal view returns (MultiSeaOmniDrop.OmniInit memory p) {
        p.name = "SOL ISLANDS"; p.symbol = "SISL"; p.owner = creator; p.payout = creator; p.maxSupply = 20;
        p.royaltyReceiver = creator; p.royaltyBps = 500; p.baseURI = "ipfs://bafyFINAL/";
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 5, 0, bytes32(0)); // 5 per wallet, all chains
        p.eids = new uint32[](3); p.eids[0] = A; p.eids[1] = B; p.eids[2] = S; p.hubEid = A;
        p.prices = new uint128[](3); p.prices[0] = 0.003 ether; p.prices[1] = 0.003 ether; p.prices[2] = 0.07 ether; // S price is informational on EVM
        p.copyMode = mode;
    }
    function cfg(MultiSeaOmniDrop.OmniInit memory p) public pure returns (bytes32) { p.feeWallet = address(0); p.platformFeeBps = 0; return keccak256(abi.encode(p)); }
    function sign(uint32 e, MultiSeaOmniDrop.OmniInit memory p, bytes32 cid) internal view returns (uint256 dl, bytes memory sig) {
        dl = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, fac[e].omniDigest(p.owner, cfg(p), cid, dl));
        sig = abi.encodePacked(r, s, v);
    }
    function deploy(uint32 e, MultiSeaOmniDrop.OmniInit memory p) internal returns (MultiSeaOmniDropV2) {
        (uint256 dl, bytes memory sig) = sign(e, p, CID);
        return MultiSeaOmniDropV2(fac[e].createOmniDrop(p, CID, dl, sig));
    }
    function b32(address a) internal pure returns (bytes32) { return bytes32(uint256(uint160(a))); }
    function pl(uint8 k, uint256 a, uint256 b, uint256 c, bytes32 to) internal pure returns (bytes memory) { return abi.encode(k, CID, a, b, c, to); }
    function deliver(uint32 e) internal { verifyPackets(e, addressToBytes32(e == S ? address(sol) : address(esc[e]))); }
    function mint(uint32 e, address who, uint256 q) internal {
        uint128 hv = e == A ? 0 : uint128(esc[A].quoteFanout(CID, e, q) * 11 / 10);
        (uint256 price, uint256 lz) = drop[e].quoteMint(0, q, who, hv);
        vm.prank(who); drop[e].mint{ value: price + lz }(who, 0, q, new bytes32[](0), hv);
    }

    // ---------------------------------------------------------------- tests
    function test_v2CloneFromExistingFactory() public view {
        assertEq(drop[A].version(), 2); assertTrue(drop[A].hasSolana()); assertEq(drop[A].maxQty(), 8);
        assertEq(esc[A].dropOf(CID), address(drop[A]));
    }

    function test_solanaDropMustBeAtMint() public {
        MultiSeaOmniDrop.OmniInit memory p = params(0); p.batchK = 10; p.batchT = 300;
        (uint256 dl, bytes memory sig) = sign(A, p, keccak256("other"));
        vm.expectRevert(MultiSeaOmniDropV2.BadParams.selector);
        fac[A].createOmniDrop(p, keccak256("other"), dl, sig);
    }

    function test_maxEightPerMint() public {
        (uint256 price, uint256 lz) = drop[A].quoteMint(0, 8, alice, 0);
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDropV2.BadParams.selector);
        drop[A].mint{ value: price * 2 + lz * 2 }(alice, 0, 9, new bytes32[](0), 0);
    }

    function test_solanaOptions_carryRentLamports() public view {
        bytes memory o = esc[A].optionsTo(S, 5, 3, 0); // COPY of 3 ids to Solana
        bytes memory want = OptionsBuilder.addExecutorLzReceiveOption(OptionsBuilder.newOptions(), 90_000 + 60_000 * 3, uint128(3 * esc[A].solRentPerId()));
        assertEq(o, want);
        assertEq(esc[A].optionsTo(B, 5, 3, 0), esc[A].optionsFor(5, 3, 0)); // EVM unchanged
    }

    function test_hubMint_copyToSolana() public {
        mint(A, alice, 2);
        deliver(B); deliver(S);
        assertEq(drop[B].ownerOf(1), address(esc[B]));
        assertEq(sol.last(), keccak256(pl(5, 1, 2, 0, bytes32(0))), "COPY ids 1-2 to Solana");
        assertEq(sol.lastSrc(), A);
    }

    function test_solanaMint_requestConfirmAndCopies() public {
        mint(A, alice, 1); deliver(B); deliver(S);
        // Solana minter asks for 3 (the Rust program sends exactly this payload: rid, qty, phase, to = Solana key)
        bytes memory req = pl(2, 1, 3, 0, SOL_ALICE);
        uint128 hv = uint128(esc[A].quoteFanout(CID, S, 3) * 11 / 10);
        uint256 f = sol.quote(A, req, 2_400_000 + 60_000 * 3, hv);
        sol.send{ value: f }(A, req, 2_400_000 + 60_000 * 3, hv);
        deliver(A); // hub assigns 2-4, escrow copies on A, CONFIRM -> S, COPY -> B
        assertEq(drop[A].totalAssigned(), 4);
        assertEq(drop[A].mintedInPhase(0, SOL_ALICE), 3, "global wallet limit keyed by the Solana key");
        for (uint256 id = 2; id <= 4; ++id) assertEq(drop[A].ownerOf(id), address(esc[A]));
        deliver(S); deliver(B);
        assertEq(sol.last(), keccak256(pl(3, 1, 2, 3, SOL_ALICE)), "CONFIRM carries the minter");
        for (uint256 id = 2; id <= 4; ++id) assertEq(drop[B].ownerOf(id), address(esc[B]));
        // unspent buffer of a Solana minter: claimable by the MultiSea fee wallet on the hub
        assertGt(esc[A].refundOf(FEE), 0);
        // wallet limit (5) holds across chains for the Solana key: 3 more -> REJECT
        sol.send{ value: f }(A, pl(2, 2, 3, 0, SOL_ALICE), 2_400_000 + 60_000 * 3, hv);
        deliver(A); deliver(S);
        assertEq(sol.last(), keccak256(pl(4, 2, 2, 0, bytes32(0))), "REJECT wallet limit");
    }

    function test_moveEvmToSolana_andBack() public {
        mint(B, alice, 1); deliver(A); deliver(B); deliver(S); // id 1 Active on B
        assertEq(drop[B].ownerOf(1), alice);
        (uint256 pf, uint256 lz) = esc[B].quoteMove(CID, S, 1, SOL_ALICE);
        uint256 fee0 = FEE.balance;
        vm.prank(alice); drop[B].moveTo{ value: pf + lz }(S, 1, SOL_ALICE);
        assertEq(drop[B].ownerOf(1), address(esc[B]), "locked on B");
        assertEq(FEE.balance - fee0, MOVE_FEE);
        deliver(S);
        assertEq(sol.last(), keccak256(pl(1, 1, 0, 0, SOL_ALICE)), "MOVE to the Solana key");
        // back from Solana to A for bob (the Rust program locks the Core asset, then sends this)
        bytes memory mv = pl(1, 1, 0, 0, b32(bob));
        sol.send{ value: sol.quote(A, mv, 150_000, 0) }(A, mv, 150_000, 0);
        deliver(A);
        assertEq(drop[A].ownerOf(1), bob, "released on the hub");
    }

    function test_moveToEvm_rejectsSolanaSizedRecipient() public {
        mint(A, alice, 1);
        vm.prank(alice); vm.expectRevert(MultiSeaOmniDropV2.BadParams.selector);
        drop[A].moveTo{ value: 1 ether }(B, 1, SOL_ALICE);
    }

    function test_releaseRejectsNonEvmRecipient() public {
        mint(A, alice, 1); deliver(B); deliver(S);
        bytes memory mv = pl(1, 1, 0, 0, SOL_ALICE); // a bad MOVE to an EVM chain with a 32-byte key: never delivered
        sol.send{ value: sol.quote(B, mv, 150_000, 0) }(B, mv, 150_000, 0);
        vm.expectRevert();
        this.deliverExt(B);
    }
    function deliverExt(uint32 e) external { deliver(e); }
}
