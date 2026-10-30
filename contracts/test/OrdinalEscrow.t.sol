// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MultiSeaOrdinalEscrow} from "../src/launchpad/ordinals/MultiSeaOrdinalEscrow.sol";

contract MockUSDC is ERC20 { constructor() ERC20("USD Coin","USDC") {} function decimals() public pure override returns (uint8){return 6;} function mint(address a,uint256 v) external {_mint(a,v);} }

contract MultiSeaOrdinalEscrowTest is Test {
    MultiSeaOrdinalEscrow esc; MockUSDC usdc;
    address owner = address(0xA11CE); address fee = address(0xFEE); address artist = address(0xA27);
    address buyer = address(0xB0B);
    uint256[] pks; address[] signers;
    bytes32 constant CID = keccak256("zebra-heads-club");
    string constant BTC = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";
    uint256 constant PRICE = 25e6;

    function setUp() public {
        for (uint256 i = 1; i <= 3; i++) { pks.push(i * 1111); signers.push(vm.addr(i * 1111)); }
        esc = new MultiSeaOrdinalEscrow(owner, fee, signers, 2);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        esc.configureCollection(CID, MultiSeaOrdinalEscrow.CollectionConfig(artist, 500, 444, 0, 1 days, true, 0));
        esc.setTokenPrice(CID, address(usdc), PRICE);
        vm.stopPrank();
        usdc.mint(buyer, 1000e6);
        vm.prank(buyer); usdc.approve(address(esc), type(uint256).max);
    }

    function _order() internal returns (uint256 id) { vm.prank(buyer); id = esc.createOrder(CID, address(usdc), BTC); }

    function _sigs(uint256 id, bytes32 txid, string memory ins, uint256 dl, uint256[] memory who) internal view returns (bytes[] memory s) {
        bytes32 sh = keccak256(abi.encode(esc.ATTEST_TYPEHASH(), id, txid, keccak256(bytes(ins)), dl));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", esc.domainSeparator(), sh));
        // sort by address ascending
        for (uint256 i; i < who.length; i++) for (uint256 j = i + 1; j < who.length; j++)
            if (vm.addr(who[j]) < vm.addr(who[i])) (who[i], who[j]) = (who[j], who[i]);
        s = new bytes[](who.length);
        for (uint256 i; i < who.length; i++) { (uint8 v, bytes32 r, bytes32 ss) = vm.sign(who[i], d); s[i] = abi.encodePacked(r, ss, v); }
    }

    function _two() internal view returns (uint256[] memory w) { w = new uint256[](2); w[0] = pks[0]; w[1] = pks[1]; }

    function testHappyPath() public {
        uint256 id = _order();
        assertEq(usdc.balanceOf(address(esc)), PRICE);
        bytes32 txid = keccak256("tx"); string memory ins = "abc123i0";
        esc.attestDelivery(id, txid, ins, block.timestamp + 1 hours, _sigs(id, txid, ins, block.timestamp + 1 hours, _two()));
        esc.release(id);
        assertEq(usdc.balanceOf(fee), PRICE * 5 / 100);
        assertEq(usdc.balanceOf(artist), PRICE * 95 / 100);
    }

    function testBelowThresholdReverts() public {
        uint256 id = _order(); bytes32 txid = keccak256("tx"); uint256[] memory one = new uint256[](1); one[0] = pks[0];
        bytes[] memory s = _sigs(id, txid, "x", block.timestamp + 1, one);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadSigs.selector);
        esc.attestDelivery(id, txid, "x", block.timestamp + 1, s);
    }

    function testInscriptionReuseBlocked() public {
        uint256 a = _order(); uint256 b = _order(); bytes32 txid = keccak256("tx"); uint256 dl = block.timestamp + 1;
        esc.attestDelivery(a, txid, "same", dl, _sigs(a, txid, "same", dl, _two()));
        bytes[] memory s = _sigs(b, txid, "same", dl, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.InscriptionReused.selector);
        esc.attestDelivery(b, txid, "same", dl, s);
    }

    function testRefundAfterDeadline() public {
        uint256 id = _order();
        vm.expectRevert(MultiSeaOrdinalEscrow.TooEarly.selector); esc.refund(id);
        vm.warp(block.timestamp + 1 days + 1);
        esc.refund(id);
        assertEq(usdc.balanceOf(buyer), 1000e6);
    }

    function testNoRefundAfterAttest() public {
        uint256 id = _order(); bytes32 txid = keccak256("tx"); uint256 dl = block.timestamp + 1;
        esc.attestDelivery(id, txid, "i", dl, _sigs(id, txid, "i", dl, _two()));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadStatus.selector); esc.refund(id);
    }

    function testPauseBlocksOrdersButNotRefund() public {
        uint256 id = _order();
        vm.prank(owner); esc.pause();
        vm.prank(buyer); vm.expectRevert(); esc.createOrder(CID, address(usdc), BTC);
        vm.warp(block.timestamp + 1 days + 1); esc.refund(id);
    }

    function testDisputeRefund() public {
        uint256 id = _order();
        vm.prank(buyer); esc.dispute(id);
        vm.prank(owner); esc.resolveDispute(id, false);
        assertEq(usdc.balanceOf(buyer), 1000e6);
    }

    function testBtcNetworkPrefix() public {
        string memory rt = "bcrt1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector);
        esc.createOrder(CID, address(usdc), rt); // mainnet mode rejects regtest
        vm.prank(owner); esc.setBtcNetwork(2);
        vm.prank(buyer); esc.createOrder(CID, address(usdc), rt);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector);
        esc.createOrder(CID, address(usdc), BTC); // regtest mode rejects bc1p
    }

    // ---------------- per-wallet limit ----------------
    function _fund(address w) internal { usdc.mint(w, 10_000e6); vm.prank(w); usdc.approve(address(esc), type(uint256).max); }
    function _orders(address w, uint256 n) internal { for (uint256 i; i < n; i++) { vm.prank(w); esc.createOrder(CID, address(usdc), BTC); } }

    function testDefaultLimit50() public {
        assertEq(esc.walletLimit(CID), 50);
        _fund(buyer); _orders(buyer, 50);
        assertEq(esc.ordersBy(CID, buyer), 50);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector); esc.createOrder(CID, address(usdc), BTC);
        address other = address(0xC0C); _fund(other); _orders(other, 1); // limit is per wallet
        assertEq(esc.ordersBy(CID, other), 1);
    }

    function testCustomLimit() public {
        vm.expectEmit(true, false, false, true); emit MultiSeaOrdinalEscrow.MaxPerWalletSet(CID, 3, 3);
        vm.prank(owner); esc.setMaxPerWallet(CID, 3);
        _orders(buyer, 3);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector); esc.createOrder(CID, address(usdc), BTC);
        vm.prank(owner); esc.setMaxPerWallet(CID, 0); // back to default
        assertEq(esc.walletLimit(CID), 50);
    }

    function testHardCap100() public {
        vm.startPrank(owner);
        esc.setMaxPerWallet(CID, 100);
        assertEq(esc.walletLimit(CID), 100);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector); esc.setMaxPerWallet(CID, 101);
        vm.stopPrank();
        vm.prank(buyer); vm.expectRevert(); esc.setMaxPerWallet(CID, 10); // owner only
        _fund(buyer); _orders(buyer, 100);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector); esc.createOrder(CID, address(usdc), BTC);
    }

    function testRefundFreesSlot() public {
        vm.prank(owner); esc.setMaxPerWallet(CID, 1);
        uint256 id = _order();
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector); esc.createOrder(CID, address(usdc), BTC);
        vm.warp(block.timestamp + 1 days + 1); esc.refund(id);
        assertEq(esc.ordersBy(CID, buyer), 0);
        _order(); // slot is free again
        assertEq(esc.ordersBy(CID, buyer), 1);
    }

    function testReleasedOrderKeepsSlot() public {
        vm.prank(owner); esc.setMaxPerWallet(CID, 1);
        uint256 id = _order();
        bytes32 txid = keccak256("tx"); string memory ins = "abci0"; uint256 dl = block.timestamp + 1 hours;
        esc.attestDelivery(id, txid, ins, dl, _sigs(id, txid, ins, dl, _two()));
        esc.release(id);
        assertEq(esc.ordersBy(CID, buyer), 1);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector); esc.createOrder(CID, address(usdc), BTC);
    }
}
