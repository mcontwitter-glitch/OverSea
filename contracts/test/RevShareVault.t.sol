// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { RevShareVault } from "../src/revshare/RevShareVault.sol";
import { RevShareVaultFactory } from "../src/revshare/RevShareVaultFactory.sol";

contract RSNft is ERC721, Ownable {
    constructor(address o) ERC721("Isles", "ISL") Ownable(o) {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}
/// holder whose receive() tries to claim again (re-entrancy)
contract Reenter {
    RevShareVault v; uint256[] ids; uint256 public hits; bool public reverted;
    constructor(RevShareVault _v) { v = _v; }
    function go(uint256 id) external { ids = [id]; v.claim(ids); }
    receive() external payable { if (hits++ == 0) { try v.claim(ids) {} catch { reverted = true; } } }
}
contract RejectEth { function claim(RevShareVault v, uint256 id) external { uint256[] memory ids = new uint256[](1); ids[0] = id; v.claim(ids); } }

contract RevShareVaultTest is Test {
    RSNft nft; RevShareVaultFactory fac; RevShareVault v;
    address founder = address(0xF00D); address a = address(0xA11CE); address b = address(0xB0B); address c = address(0xC0DE);
    uint256 constant N = 4; // supply 4, ids 1..4

    function setUp() public {
        nft = new RSNft(founder);
        fac = new RevShareVaultFactory();
        vm.prank(founder); v = RevShareVault(payable(fac.createVault(address(nft), N, 1)));
        nft.mint(a, 1); nft.mint(a, 2); nft.mint(b, 3); // id 4 stays unminted on purpose
        vm.deal(founder, 100 ether); vm.deal(address(this), 100 ether);
    }
    function _ids(uint256 x) internal pure returns (uint256[] memory r) { r = new uint256[](1); r[0] = x; }
    function _ids(uint256 x, uint256 y) internal pure returns (uint256[] memory r) { r = new uint256[](2); r[0] = x; r[1] = y; }

    // ---------------- split ----------------
    function testEqualSplitAcrossTokens() public {
        (bool ok,) = address(v).call{ value: 4 ether }(""); assertTrue(ok);
        for (uint256 i = 1; i <= 4; i++) assertEq(v.pendingOf(i), 1 ether);
        assertEq(v.pending(_ids(1, 2)), 2 ether);
        assertEq(v.totalDeposited(), 4 ether);
        assertEq(v.accRewardPerToken(), 1 ether);
        vm.prank(a); uint256 got = v.claim(_ids(1, 2)); assertEq(got, 2 ether); assertEq(a.balance, 2 ether);
        vm.prank(b); got = v.claim(_ids(3)); assertEq(got, 1 ether);
        assertEq(v.totalClaimed(), 3 ether);
        assertEq(v.totalPending(), 1 ether); // token 4 (not minted on this chain) keeps its share
        assertEq(address(v).balance, 1 ether);
    }
    function testMultipleDeposits() public {
        v.deposit{ value: 4 ether }();
        vm.prank(a); v.claim(_ids(1));                       // a takes token 1 early
        (bool ok,) = address(v).call{ value: 8 ether }(""); assertTrue(ok);
        assertEq(v.pendingOf(1), 2 ether);                   // only the second deposit
        assertEq(v.pendingOf(2), 3 ether);                   // both deposits
        vm.prank(a); assertEq(v.claim(_ids(1, 2)), 5 ether);
        vm.prank(b); assertEq(v.claim(_ids(3)), 3 ether);
        assertEq(v.totalDeposited(), 12 ether); assertEq(v.totalClaimed(), 9 ether);
    }
    function testTransferInheritsUnclaimed() public {
        v.deposit{ value: 4 ether }();
        vm.prank(a); nft.transferFrom(a, c, 1);
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(RevShareVault.NotHolder.selector, 1)); v.claim(_ids(1));
        vm.prank(c); assertEq(v.claim(_ids(1)), 1 ether);   // buyer collects what accrued before the sale
        v.deposit{ value: 4 ether }();
        vm.prank(c); assertEq(v.claim(_ids(1)), 1 ether);
        vm.prank(a); assertEq(v.claim(_ids(2)), 2 ether);   // a still gets token 2's full history
    }
    function testNonOwnerClaimReverts() public {
        v.deposit{ value: 4 ether }();
        vm.prank(c); vm.expectRevert(abi.encodeWithSelector(RevShareVault.NotHolder.selector, 1)); v.claim(_ids(1));
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(RevShareVault.NotHolder.selector, 3)); v.claim(_ids(1, 3)); // one foreign id sinks the batch
        assertEq(v.pendingOf(1), 1 ether);                   // nothing was consumed
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(RevShareVault.NotHolder.selector, 4)); v.claim(_ids(4)); // unminted: ownerOf reverts
    }
    function testBadTokenIdReverts() public {
        v.deposit{ value: 1 ether }();
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(RevShareVault.BadToken.selector, 0)); v.claim(_ids(0));
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(RevShareVault.BadToken.selector, 5)); v.claim(_ids(5));
        assertEq(v.pendingOf(0), 0); assertEq(v.pendingOf(5), 0);
    }
    function testDoubleClaimPaysZero() public {
        v.deposit{ value: 4 ether }();
        vm.prank(a); assertEq(v.claim(_ids(1)), 1 ether);
        vm.prank(a); assertEq(v.claim(_ids(1)), 0);          // no revert, no payout
        vm.prank(a); assertEq(v.claim(_ids(1, 1)), 0);       // duplicates in one call can't double-pay either
        assertEq(a.balance, 1 ether); assertEq(v.totalClaimed(), 1 ether);
        // duplicate ids before any claim only pay once
        vm.prank(a); assertEq(v.claim(_ids(2, 2)), 1 ether);
    }

    // ---------------- dust ----------------
    function testDustCarriesAndNeverOverpays() public {
        v.deposit{ value: 10 }();                            // 10 wei / 4 = 2 each, 2 dust
        assertEq(v.pendingOf(1), 2); assertEq(v.dust(), 2);
        v.deposit{ value: 3 }();                             // 3 + 2 = 5 => +1 each, dust 1
        assertEq(v.pendingOf(1), 3); assertEq(v.dust(), 1); assertEq(v.accRewardPerToken(), 3);
        assertEq(v.totalDeposited(), 13);
        assertEq(address(v).balance, 13);
        assertEq(v.totalPending(), 12);                      // 4 tokens * 3 wei
        vm.prank(a); assertEq(v.claim(_ids(1, 2)), 6);
        vm.prank(b); assertEq(v.claim(_ids(3)), 3);
        assertEq(address(v).balance, 4);                     // token 4's 3 wei + 1 wei dust, nothing leaked
        v.deposit{ value: 3 }();                             // dust 1 + 3 = 4 => +1 each
        assertEq(v.dust(), 0); assertEq(v.pendingOf(1), 1);
    }
    function testOneWeiDepositOnlyBecomesDust() public {
        v.deposit{ value: 1 }();
        assertEq(v.accRewardPerToken(), 0); assertEq(v.dust(), 1); assertEq(v.pendingOf(1), 0);
        vm.prank(a); assertEq(v.claim(_ids(1)), 0);
    }
    function testFuzzSolvency(uint96 d1, uint96 d2, uint96 d3) public {
        vm.assume(d1 > 0 && d2 > 0 && d3 > 0);
        vm.deal(address(this), uint256(d1) + d2 + d3);
        v.deposit{ value: d1 }();
        vm.prank(a); v.claim(_ids(1));
        (bool ok,) = address(v).call{ value: d2 }(""); assertTrue(ok);
        vm.prank(b); v.claim(_ids(3));
        v.deposit{ value: d3 }();
        vm.prank(a); v.claim(_ids(1, 2));
        // the vault always holds exactly what is owed plus the carried dust
        assertEq(address(v).balance, v.totalPending() + v.dust());
        assertEq(v.totalDeposited() - v.totalClaimed(), address(v).balance);
        assertLt(v.dust(), N);
    }

    // ---------------- pause / owner ----------------
    function testPauseClaims() public {
        v.deposit{ value: 4 ether }();
        vm.prank(a); vm.expectRevert(); v.setClaimsPaused(true);                // only owner
        vm.prank(founder); v.setClaimsPaused(true);
        vm.prank(a); vm.expectRevert(RevShareVault.Paused.selector); v.claim(_ids(1));
        (bool ok,) = address(v).call{ value: 1 ether }(""); assertTrue(ok);     // plain transfers still accepted
        assertEq(v.pendingOf(1), 1.25 ether);
        vm.prank(founder); v.setClaimsPaused(false);
        vm.prank(a); assertEq(v.claim(_ids(1)), 1.25 ether);
    }
    function testPauseDepositsDoesNotBlockPlainTransfers() public {
        vm.prank(founder); v.setDepositsPaused(true);
        vm.expectRevert(RevShareVault.Paused.selector); v.deposit{ value: 1 ether }();
        (bool ok,) = address(v).call{ value: 1 ether }(""); assertTrue(ok);     // a royalty payment can never be bricked
        assertEq(v.pendingOf(1), 0.25 ether);
        vm.prank(founder); v.setDepositsPaused(false);
        v.deposit{ value: 1 ether }(); assertEq(v.pendingOf(1), 0.5 ether);
    }
    function testZeroDepositReverts() public {
        vm.expectRevert(RevShareVault.ZeroAmount.selector); v.deposit();
        (bool ok,) = address(v).call{ value: 0 }(""); assertTrue(ok); assertEq(v.totalDeposited(), 0);
    }
    function testOwnerHasNoWithdrawPath() public {
        v.deposit{ value: 4 ether }();
        // the only owner-gated selectors are pause toggles + ownership; try raw calls with common withdraw names
        bytes4[5] memory sel = [bytes4(keccak256("withdraw()")), bytes4(keccak256("withdraw(uint256)")), bytes4(keccak256("sweep()")), bytes4(keccak256("rescue(address)")), bytes4(keccak256("emergencyWithdraw()"))];
        for (uint256 i; i < sel.length; i++) { vm.prank(founder); (bool ok,) = address(v).call(abi.encodeWithSelector(sel[i])); assertFalse(ok); }
        uint256 before_ = founder.balance;
        vm.startPrank(founder); v.setClaimsPaused(true); v.setClaimsPaused(false); v.setDepositsPaused(true); v.transferOwnership(c); vm.stopPrank();
        assertEq(founder.balance, before_); assertEq(address(v).balance, 4 ether); assertEq(v.owner(), c);
        vm.prank(c); v.renounceOwnership(); assertEq(v.owner(), address(0));
        vm.expectRevert(RevShareVault.NotOwner.selector); v.setClaimsPaused(true);
    }

    // ---------------- safety ----------------
    function testReentrancyBlocked() public {
        Reenter r = new Reenter(v); nft.mint(address(r), 4);
        v.deposit{ value: 4 ether }();
        r.go(4);
        assertEq(address(r).balance, 1 ether); assertEq(r.hits(), 1); assertTrue(r.reverted());
        assertEq(v.totalClaimed(), 1 ether);
    }
    function testClaimToContractThatRejectsEthReverts() public {
        RejectEth rj = new RejectEth(); nft.mint(address(rj), 4);
        v.deposit{ value: 4 ether }();
        vm.expectRevert(RevShareVault.TransferFailed.selector); rj.claim(v, 4);
        assertEq(v.pendingOf(4), 1 ether);                   // state rolled back
    }
    function testReceiveWorksWithCloneGasAndSeaportStyleCall() public {
        uint256 g = gasleft();
        (bool ok,) = address(v).call{ value: 1 ether, gas: 100_000 }(""); assertTrue(ok);
        assertLt(g - gasleft(), 100_000);
    }

    // ---------------- factory ----------------
    function testFactoryOnlyCollectionOwnerAndOnePerCollection() public {
        RSNft n2 = new RSNft(founder);
        vm.prank(a); vm.expectRevert(RevShareVaultFactory.NotCollectionOwner.selector); fac.createVault(address(n2), 10, 0);
        address predicted = fac.predict(address(n2));
        vm.prank(founder); address vv = fac.createVault(address(n2), 10, 0);
        assertEq(vv, predicted); assertEq(fac.vaultOf(address(n2)), vv); assertEq(fac.vaultCount(), 2);
        RevShareVault x = RevShareVault(payable(vv));
        assertEq(x.owner(), founder); assertEq(address(x.collection()), address(n2)); assertEq(x.totalSupply(), 10); assertEq(x.firstId(), 0);
        vm.prank(founder); vm.expectRevert(abi.encodeWithSelector(RevShareVaultFactory.VaultExists.selector, vv)); fac.createVault(address(n2), 10, 0);
        vm.prank(founder); vm.expectRevert(RevShareVaultFactory.BadConfig.selector); fac.createVault(address(n2), 0, 0);
        assertEq(fac.predict(address(nft)), address(v));
    }
    function testCannotReinitialize() public {
        vm.expectRevert(RevShareVault.AlreadyInitialized.selector); v.initialize(address(nft), a, 4, 1);
        RevShareVault impl = RevShareVault(payable(fac.implementation()));
        vm.expectRevert(RevShareVault.AlreadyInitialized.selector); impl.initialize(address(nft), a, 4, 1);
    }
    function testCloneIsMinimalProxy() public view {
        assertEq(address(v).code.length, 45);
    }
}
