// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MultiSeaOrdinalEscrow} from "../src/launchpad/ordinals/MultiSeaOrdinalEscrow.sol";
import {Bech32m} from "../src/launchpad/ordinals/Bech32m.sol";
import {BtcSpv} from "../src/launchpad/ordinals/BtcSpv.sol";

contract MockUSDC is ERC20 { constructor() ERC20("USD Coin","USDC") {} function decimals() public pure override returns (uint8){return 6;} function mint(address a,uint256 v) external {_mint(a,v);} }

/// 1% burned on every transfer — must be rejected by createOrder (B12).
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("FoT","FOT") {}
    function mint(address a, uint256 v) external { _mint(a, v); }
    function _update(address f, address t, uint256 v) internal override {
        if (f != address(0) && t != address(0)) { uint256 burn = v / 100; super._update(f, address(0), burn); v -= burn; }
        super._update(f, t, v);
    }
}

/// Builds synthetic regtest-difficulty SPV proofs (nBits 0x207fffff) — "regtest fixtures".
library SpvFactory {
    uint256 constant REGTEST_TARGET = 0x7fffff0000000000000000000000000000000000000000000000000000000000;

    function rawTx(bytes32 program, bytes32 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"02000000", hex"01", salt, hex"00000000", hex"00", hex"ffffffff",
            hex"02", hex"2202000000000000", hex"22", hex"5120", program,
            hex"e803000000000000", hex"16", hex"0014", bytes20(salt), hex"00000000");
    }

    function header(bytes32 prev, bytes32 root, uint32 time, uint32 bits, uint256 maxTarget) internal pure returns (bytes memory h) {
        for (uint32 nonce; ; nonce++) {
            h = abi.encodePacked(hex"00000020", prev, root, _le32(time), _le32(bits), _le32(nonce));
            if (uint256(BtcSpv.reverse32(BtcSpv.hash256(h))) <= maxTarget) return h;
        }
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return bytes4(uint32((v >> 24) | ((v >> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)));
    }

    /// tx at index 1 of a 2-tx block, followed by n-1 headers.
    function proof(bytes32 program, bytes32 salt, uint32 time, uint256 n)
        internal pure returns (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txidDisplay)
    {
        p.rawTx = rawTx(program, salt);
        bytes32 txid = BtcSpv.hash256(p.rawTx);
        bytes32 sib = keccak256(abi.encode("coinbase", salt));
        p.index = 1; p.siblings = abi.encodePacked(sib);
        bytes32 root = BtcSpv.hash256(abi.encodePacked(sib, txid));
        bytes memory hs; bytes32 prev = keccak256(abi.encode("prev", salt));
        for (uint256 i; i < n; i++) {
            bytes memory h = header(prev, i == 0 ? root : keccak256(abi.encode(i, salt)), time + uint32(i * 600), 0x207fffff, REGTEST_TARGET);
            hs = abi.encodePacked(hs, h); prev = BtcSpv.hash256(h);
        }
        p.headers = hs; txidDisplay = BtcSpv.reverse32(txid);
    }
}

abstract contract EscrowBase is Test {
    MultiSeaOrdinalEscrow esc; MockUSDC usdc;
    address owner = address(0xA11CE); address fee = address(0xFEE); address artist = address(0xA27);
    address buyer = address(0xB0B);
    uint256[] pks; address[] signers;
    bytes32 constant CID = keccak256("zebra-heads-club");
    string constant BTC = "bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6";
    bytes32 constant PROG = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
    uint256 constant PRICE = 25e6;
    uint256 constant INS_FEE = 3e6;
    uint256 constant CAP = 25e6;

    function _deploy(uint256 nSigners, uint256 thr, uint96 feeBps) internal {
        vm.warp(1_800_000_000);
        for (uint256 i = 1; i <= nSigners; i++) { pks.push(i * 1111); signers.push(vm.addr(i * 1111)); }
        esc = new MultiSeaOrdinalEscrow(owner, fee, signers, thr);
        usdc = new MockUSDC();
        vm.startPrank(owner);
        esc.setBtcNetwork(2);
        esc.configureCollection(CID, MultiSeaOrdinalEscrow.CollectionConfig(artist, feeBps, 444, 0, 6 hours, true, 0));
        esc.setAllowedToken(address(usdc), true);
        esc.setTokenPrice(CID, address(usdc), PRICE);
        esc.setInscriptionFeeCap(CID, CAP);
        vm.stopPrank();
    }

    function _sigs(uint256 id, bytes32 txid, uint256 dl, uint256[] memory who) internal view returns (bytes[] memory s) {
        string memory ins = string.concat(_hex(txid), "i0");
        bytes32 sh = keccak256(abi.encode(esc.ATTEST_TYPEHASH(), id, txid, keccak256(bytes(ins)), dl));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", esc.domainSeparator(), sh));
        for (uint256 i; i < who.length; i++) for (uint256 j = i + 1; j < who.length; j++)
            if (vm.addr(who[j]) < vm.addr(who[i])) (who[i], who[j]) = (who[j], who[i]);
        s = new bytes[](who.length);
        for (uint256 i; i < who.length; i++) { (uint8 v, bytes32 r, bytes32 ss) = vm.sign(who[i], d); s[i] = abi.encodePacked(r, ss, v); }
    }

    function _hex(bytes32 x) internal pure returns (string memory) {
        bytes memory s = new bytes(64); bytes16 H = "0123456789abcdef";
        for (uint256 i; i < 32; i++) { s[2*i] = H[uint8(x[i]) >> 4]; s[2*i+1] = H[uint8(x[i]) & 15]; }
        return string(s);
    }

    function _one() internal view returns (uint256[] memory w) { w = new uint256[](1); w[0] = pks[0]; }
}

contract MultiSeaOrdinalEscrowTest is EscrowBase {
    function setUp() public {
        _deploy(3, 2, 500);
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer); usdc.approve(address(esc), type(uint256).max);
    }

    function _two() internal view returns (uint256[] memory w) { w = new uint256[](2); w[0] = pks[0]; w[1] = pks[1]; }
    function _order() internal returns (uint256 id) { vm.prank(buyer); id = esc.createOrder(CID, address(usdc), BTC, INS_FEE); }
    function _attest(uint256 id, bytes32 salt) internal returns (bytes32 txid) {
        MultiSeaOrdinalEscrow.SpvProof memory p; (p, txid) = SpvFactory.proof(PROG, salt, uint32(block.timestamp), 3);
        uint256 dl = block.timestamp + 1 hours;
        esc.attestDelivery(id, p, dl, _sigs(id, txid, dl, _two()));
    }

    function testHappyPathFeeSplit() public {
        uint256 id = _order();
        assertEq(usdc.balanceOf(address(esc)), PRICE + INS_FEE);
        bytes32 txid = _attest(id, "a");
        MultiSeaOrdinalEscrow.Order memory od = esc.getOrder(id); bytes32 storedTx = od.btcTxid; string memory ins = od.inscriptionId;
        assertEq(storedTx, txid); assertEq(ins, string.concat(_hex(txid), "i0"));
        esc.release(id);
        assertEq(usdc.balanceOf(fee), PRICE * 5 / 100 + INS_FEE); // btcOps defaults to fee wallet
        assertEq(usdc.balanceOf(artist), PRICE * 95 / 100);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function testBtcOpsRecipientSeparate() public {
        address ops = address(0x0B5);
        vm.prank(owner); esc.setBtcOpsRecipient(ops);
        uint256 id = _order(); _attest(id, "b"); esc.release(id);
        assertEq(usdc.balanceOf(ops), INS_FEE);
        assertEq(usdc.balanceOf(fee), PRICE * 5 / 100);
    }

    function testRefundReturnsPriceAndInscriptionFee() public {
        uint256 bal = usdc.balanceOf(buyer);
        uint256 id = _order();
        vm.warp(block.timestamp + 6 hours + 1); esc.refund(id);
        assertEq(usdc.balanceOf(buyer), bal);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function testInscriptionFeeCap() public {
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.InscriptionFeeTooHigh.selector);
        esc.createOrder(CID, address(usdc), BTC, CAP + 1);
    }

    function testBelowThresholdReverts() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "c", uint32(block.timestamp), 3);
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _one());
        vm.expectRevert(MultiSeaOrdinalEscrow.BadSigs.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testDuplicateSignerReverts() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "d", uint32(block.timestamp), 3);
        uint256[] memory w = new uint256[](2); w[0] = pks[0]; w[1] = pks[0];
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, w);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadSigs.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSigsForOtherTxRejected() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p,) = SpvFactory.proof(PROG, "e", uint32(block.timestamp), 3);
        bytes[] memory s = _sigs(id, keccak256("other"), block.timestamp + 1, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.BadSigs.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    // ---- SPV negatives (B2) ----
    function testSpvWrongRecipient() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(bytes32(uint256(1)), "f", uint32(block.timestamp), 3);
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.SpvWrongRecipient.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvBadMerkle() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "g", uint32(block.timestamp), 3);
        p.index = 0; // wrong side
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.SpvBadInclusion.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvIndexOutOfRange() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "g2", uint32(block.timestamp), 3);
        p.index = 3; // 3 >= 2^1
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(BtcSpv.BadMerkle.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvTooFewConfs() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "h", uint32(block.timestamp), 2);
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(BtcSpv.BadHeaders.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvBrokenChain() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "i", uint32(block.timestamp), 3);
        bytes memory h = p.headers; h[80 + 4] = bytes1(uint8(h[84]) ^ 1); // corrupt header[1].prev
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(); // LowWork (hash changes) or BadHeaders
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvBelowDifficultyFloor() public {
        vm.prank(owner); esc.setPowFloor(0x7fff00000000000000000000000000000000000000000000000000000000);
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "j", uint32(block.timestamp), 3);
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(BtcSpv.LowWork.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSpvOldPaymentRejected() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "k", uint32(block.timestamp - 3 hours), 3);
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.SpvTooOld.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testSameTxCannotSettleTwoOrders() public {
        uint256 a = _order(); uint256 b = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "l", uint32(block.timestamp), 3);
        esc.attestDelivery(a, p, block.timestamp + 1, _sigs(a, txid, block.timestamp + 1, _two()));
        bytes[] memory s = _sigs(b, txid, block.timestamp + 1, _two());
        vm.expectRevert(MultiSeaOrdinalEscrow.InscriptionReused.selector);
        esc.attestDelivery(b, p, block.timestamp + 1, s);
    }

    function testRejectsSegwitSerializedTx() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "m", uint32(block.timestamp), 3);
        bytes memory r = p.rawTx; r[4] = 0x00; // marker -> 0 inputs
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(BtcSpv.BadTx.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    function testRejectsTrailingBytes() public {
        uint256 id = _order();
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(PROG, "n", uint32(block.timestamp), 3);
        p.rawTx = abi.encodePacked(p.rawTx, hex"00");
        bytes[] memory s = _sigs(id, txid, block.timestamp + 1, _two());
        vm.expectRevert(BtcSpv.BadTx.selector);
        esc.attestDelivery(id, p, block.timestamp + 1, s);
    }

    // ---- lifecycle ----
    function testRefundAfterDeadline() public {
        uint256 id = _order();
        vm.expectRevert(MultiSeaOrdinalEscrow.TooEarly.selector); esc.refund(id);
        vm.warp(block.timestamp + 6 hours + 1); esc.refund(id);
        MultiSeaOrdinalEscrow.Status st = esc.orderStatus(id);
        assertEq(uint8(st), uint8(MultiSeaOrdinalEscrow.Status.Refunded));
    }

    function testCannotRefundAfterAttest() public {
        uint256 id = _order(); _attest(id, "o");
        vm.warp(block.timestamp + 7 hours);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadStatus.selector); esc.refund(id);
    }

    function testRefundWorksWhilePaused() public {
        uint256 id = _order();
        vm.prank(owner); esc.pause();
        vm.warp(block.timestamp + 6 hours + 1); esc.refund(id);
    }

    function testDisputeResolveRefund() public {
        uint256 bal = usdc.balanceOf(buyer);
        uint256 id = _order(); _attest(id, "p");
        vm.prank(buyer); esc.dispute(id);
        vm.prank(owner); esc.resolveDispute(id, false);
        assertEq(usdc.balanceOf(buyer), bal);
    }

    function testDisputeResolveRelease() public {
        uint256 id = _order(); _attest(id, "q");
        vm.prank(buyer); esc.dispute(id);
        vm.prank(owner); esc.resolveDispute(id, true);
        assertEq(usdc.balanceOf(artist), PRICE * 95 / 100);
        assertEq(usdc.balanceOf(fee), PRICE * 5 / 100 + INS_FEE);
    }

    function testStrangerCannotDispute() public {
        uint256 id = _order();
        vm.expectRevert(MultiSeaOrdinalEscrow.NotAuthorized.selector); esc.dispute(id);
    }

    // ---- address validation (B3) ----
    function testRejectsNonTaproot() public {
        vm.prank(buyer); vm.expectRevert(Bech32m.InvalidSegwit.selector);
        esc.createOrder(CID, address(usdc), "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", 0);
    }
    function testRejectsWrongNetworkAddress() public {
        vm.prank(buyer); vm.expectRevert(Bech32m.InvalidSegwit.selector);
        esc.createOrder(CID, address(usdc), "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", 0);
    }
    function testRejectsBadChecksum() public {
        vm.prank(buyer); vm.expectRevert(Bech32m.InvalidSegwit.selector);
        esc.createOrder(CID, address(usdc), "bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma7", 0);
    }
    function testStoresProgram() public {
        uint256 id = _order();
        bytes32 prog = esc.getOrder(id).btcProgram;
        assertEq(prog, PROG);
    }

    // ---- token allowlist (B12) ----
    function testRejectsNonAllowlistedToken() public {
        MockUSDC other = new MockUSDC();
        vm.prank(owner); vm.expectRevert(MultiSeaOrdinalEscrow.NotAccepted.selector);
        esc.setTokenPrice(CID, address(other), PRICE);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.NotAccepted.selector);
        esc.createOrder(CID, address(other), BTC, 0);
    }
    function testDelistedTokenRejected() public {
        vm.prank(owner); esc.setAllowedToken(address(usdc), false);
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.NotAccepted.selector);
        esc.createOrder(CID, address(usdc), BTC, 0);
    }
    function testFeeOnTransferRejected() public {
        FeeOnTransferToken f = new FeeOnTransferToken();
        vm.startPrank(owner); esc.setAllowedToken(address(f), true); esc.setTokenPrice(CID, address(f), PRICE); vm.stopPrank();
        f.mint(buyer, 100e6);
        vm.startPrank(buyer); f.approve(address(esc), type(uint256).max);
        vm.expectRevert(MultiSeaOrdinalEscrow.FeeOnTransfer.selector);
        esc.createOrder(CID, address(f), BTC, 0);
        vm.stopPrank();
    }

    // ---- recipients (B11) ----
    function testConstructorRejectsZeroFeeRecipient() public {
        vm.expectRevert(MultiSeaOrdinalEscrow.ZeroAddress.selector);
        new MultiSeaOrdinalEscrow(owner, address(0), signers, 1);
    }
    function testSetFeeRecipient() public {
        vm.expectRevert(); esc.setFeeRecipient(address(1));
        vm.startPrank(owner);
        vm.expectRevert(MultiSeaOrdinalEscrow.ZeroAddress.selector); esc.setFeeRecipient(address(0));
        vm.expectEmit(address(esc)); emit MultiSeaOrdinalEscrow.FeeRecipientSet(address(7));
        esc.setFeeRecipient(address(7));
        vm.expectRevert(MultiSeaOrdinalEscrow.ZeroAddress.selector); esc.setBtcOpsRecipient(address(0));
        vm.stopPrank();
        assertEq(esc.feeRecipient(), address(7));
    }

    // ---- limits / admin ----
    function testWalletLimitDefault50() public {
        vm.prank(owner); esc.setInscriptionFeeCap(CID, 0);
        for (uint256 i; i < 50; i++) { vm.prank(buyer); esc.createOrder(CID, address(usdc), BTC, 0); }
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.WalletLimit.selector);
        esc.createOrder(CID, address(usdc), BTC, 0);
    }
    function testWalletLimitMax100() public {
        vm.prank(owner); vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector); esc.setMaxPerWallet(CID, 101);
    }
    function testSoldOut() public {
        vm.prank(owner); esc.configureCollection(CID, MultiSeaOrdinalEscrow.CollectionConfig(artist, 500, 1, 0, 6 hours, true, 0));
        _order();
        vm.prank(buyer); vm.expectRevert(MultiSeaOrdinalEscrow.SoldOut.selector);
        esc.createOrder(CID, address(usdc), BTC, 0);
    }
    function testMinConfsBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector); esc.setMinBtcConfs(0);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector); esc.setMinBtcConfs(25);
        esc.setMinBtcConfs(6);
        vm.stopPrank();
    }
    function testCannotRemoveAttesterBelowThreshold() public {
        vm.startPrank(owner); esc.setAttester(signers[0], false);
        vm.expectRevert(MultiSeaOrdinalEscrow.BadConfig.selector); esc.setAttester(signers[1], false);
        vm.stopPrank();
    }

    // ---- fuzz (B1) ----
    function testFuzzFeeSplitExact(uint96 bps, uint128 price, uint128 insFee) public {
        bps = uint96(bound(bps, 0, 2000)); price = uint128(bound(price, 1, 1e15)); insFee = uint128(bound(insFee, 0, 1e15));
        vm.startPrank(owner);
        esc.configureCollection(CID, MultiSeaOrdinalEscrow.CollectionConfig(artist, bps, 444, 0, 6 hours, true, 0));
        esc.setTokenPrice(CID, address(usdc), price); esc.setInscriptionFeeCap(CID, insFee);
        esc.setBtcOpsRecipient(address(0x0B5));
        vm.stopPrank();
        usdc.mint(buyer, uint256(price) + insFee);
        uint256 id; vm.prank(buyer); id = esc.createOrder(CID, address(usdc), BTC, insFee);
        _attest(id, bytes32(uint256(price) ^ insFee)); esc.release(id);
        uint256 f = usdc.balanceOf(fee); uint256 a = usdc.balanceOf(artist); uint256 o = usdc.balanceOf(address(0x0B5));
        assertEq(f, uint256(price) * bps / 10_000);
        assertEq(f + a, price);
        assertEq(o, insFee);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function testFuzzRefundExact(uint128 insFee, uint32 dt) public {
        insFee = uint128(bound(insFee, 0, CAP));
        uint256 bal = usdc.balanceOf(buyer);
        uint256 id; vm.prank(buyer); id = esc.createOrder(CID, address(usdc), BTC, insFee);
        vm.warp(block.timestamp + bound(dt, 0, 30 days));
        if (block.timestamp <= 1_800_000_000 + 6 hours) { vm.expectRevert(MultiSeaOrdinalEscrow.TooEarly.selector); esc.refund(id); }
        else { esc.refund(id); assertEq(usdc.balanceOf(buyer), bal); }
    }
}

/// Real Bitcoin mainnet fixture (block 973775): proves the SPV path against real PoW, real merkle branch.
contract OrdinalEscrowMainnetSpvTest is EscrowBase {
    function setUp() public {
        _deploy(1, 1, 50);
        vm.prank(owner); esc.setBtcNetwork(0);
    }

    function _fixture() internal view returns (string memory addr, MultiSeaOrdinalEscrow.SpvProof memory p, uint256 time, bytes32 txid) {
        string memory j = vm.readFile("test/fixtures/btc-mainnet-973775.json");
        addr = vm.parseJsonString(j, ".address");
        p.rawTx = vm.parseJsonBytes(j, ".rawTx");
        p.index = vm.parseJsonUint(j, ".index");
        p.siblings = vm.parseJsonBytes(j, ".siblings");
        p.headers = vm.parseJsonBytes(j, ".headers");
        time = vm.parseJsonUint(j, ".headerTime");
        txid = vm.parseJsonBytes32(j, ".txidDisplay");
    }

    function testMainnetFixtureAttestAndRelease() public {
        (string memory addr, MultiSeaOrdinalEscrow.SpvProof memory p, uint256 time, bytes32 txid) = _fixture();
        vm.warp(time); // order created at block time
        address b = address(0xB0B); usdc.mint(b, PRICE + INS_FEE);
        vm.startPrank(b); usdc.approve(address(esc), type(uint256).max);
        uint256 id = esc.createOrder(CID, address(usdc), addr, INS_FEE); vm.stopPrank();
        (bytes32 got,) = esc.verifySpv(id, p);
        assertEq(got, txid);
        esc.attestDelivery(id, p, block.timestamp + 1, _sigs(id, txid, block.timestamp + 1, _one()));
        esc.release(id);
        assertEq(usdc.balanceOf(artist), PRICE - PRICE * 50 / 10_000);
        assertEq(usdc.balanceOf(fee), PRICE * 50 / 10_000 + INS_FEE);
    }

    function testMainnetFixtureFloorRejectsWeakerChainSetting() public {
        (string memory addr, MultiSeaOrdinalEscrow.SpvProof memory p, uint256 time,) = _fixture();
        vm.warp(time);
        address b = address(0xB0B); usdc.mint(b, PRICE);
        vm.startPrank(b); usdc.approve(address(esc), type(uint256).max);
        uint256 id = esc.createOrder(CID, address(usdc), addr, 0); vm.stopPrank();
        // floor at 1/1000 of the fixture's own target -> real mainnet headers must fail
        vm.prank(owner); esc.setPowFloor(uint256(0x1e5ac0000000000000000000000000000000000000000) / 1000);
        vm.expectRevert(BtcSpv.LowWork.selector); esc.verifySpv(id, p);
    }

    function testMainnetRegtestProofRejectedOnMainnet() public {
        (string memory addr,, uint256 time,) = _fixture();
        vm.warp(time);
        address b = address(0xB0B); usdc.mint(b, PRICE);
        vm.startPrank(b); usdc.approve(address(esc), type(uint256).max);
        uint256 id = esc.createOrder(CID, address(usdc), addr, 0); vm.stopPrank();
        bytes32 prog = esc.getOrder(id).btcProgram;
        (MultiSeaOrdinalEscrow.SpvProof memory p,) = SpvFactory.proof(prog, "x", uint32(time), 3);
        vm.expectRevert(BtcSpv.LowWork.selector); esc.verifySpv(id, p);
    }
}

contract B32Harness {
    function dec(string memory s) external pure returns (uint8 enc) { (enc,,) = Bech32m.decode(s); }
    function decBytes(bytes memory s) external pure returns (uint8 enc) { (enc,,) = Bech32m.decode(string(s)); }
    function seg(string memory s, bytes memory hrp) external pure returns (uint8 v, bytes memory p) { return Bech32m.decodeSegwit(s, hrp); }
}

/// BIP-350 test vectors (B3).
contract Bech32mVectorsTest is Test {
    B32Harness h = new B32Harness();

    function testValidBech32m() public view {
        string[7] memory v = ["A1LQFN3A", "a1lqfn3a",
            "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
            "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
            "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
            "split1checkupstagehandshakeupstreamerranterredcaperredlc445v", "?1v759aa"];
        for (uint256 i; i < v.length; i++) assertEq(h.dec(v[i]), 2, v[i]);
    }

    function testInvalidBech32m() public view {
        assertEq(h.decBytes(hex"20316a3070686b"), 0); // 0x20 + 1xj0phk
        assertEq(h.decBytes(hex"7f3167367a787a79"), 0);
        assertEq(h.decBytes(hex"803176637463333334"), 0);
        string[11] memory v = [
            "an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4",
            "qyrz8wqd2c9m", "1qyrz8wqd2c9m", "y1b0jsk6g", "lt1igcx5c0", "in1muywd", "mm1crxm3i", "au1s5cgom",
            "M1VUXWEZ", "16plkw9", "1p2gdwpf"];
        for (uint256 i; i < v.length; i++) assertEq(h.dec(v[i]), 0, v[i]);
    }

    function _spk(uint8 v, bytes memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(v == 0 ? uint8(0) : uint8(0x50 + v), uint8(p.length), p);
    }

    function testValidSegwitAddresses() public view {
        string[8] memory a = ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
            "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
            "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
            "BC1SW50QGDZ25J", "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
            "tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy",
            "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"];
        bytes[8] memory s = [bytes(hex"0014751e76e8199196d454941c45d1b3a323f1433bd6"),
            hex"00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
            hex"5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6",
            hex"6002751e", hex"5210751e76e8199196d454941c45d1b3a323",
            hex"0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
            hex"5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
            hex"512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"];
        bytes[8] memory hrp = [bytes("bc"), "tb", "bc", "bc", "bc", "tb", "tb", "bc"];
        for (uint256 i; i < 8; i++) {
            (uint8 v, bytes memory p) = h.seg(a[i], hrp[i]);
            assertEq(_spk(v, p), s[i], a[i]);
        }
    }

    function testInvalidSegwitAddresses() public {
        string[15] memory a = ["tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
            "tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf",
            "BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL",
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
            "tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47",
            "bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4",
            "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
            "bc1pw5dgrnzv",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav",
            "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",
            "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
            "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j",
            "bc1gmk9yu"];
        for (uint256 i; i < a.length; i++) {
            // try both network hrps so only the address itself can be at fault
            vm.expectRevert(Bech32m.InvalidSegwit.selector); h.seg(a[i], "bc");
            vm.expectRevert(Bech32m.InvalidSegwit.selector); h.seg(a[i], "tb");
        }
    }

    function testTaprootOnly() public {
        vm.expectRevert(Bech32m.InvalidSegwit.selector);
        this.tap("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y"); // v1 but 40 bytes
        assertEq(this.tap("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"),
                 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798);
    }
    function tap(string memory s) external pure returns (bytes32) { return Bech32m.decodeTaproot(s, "bc"); }
}

/// Invariant handler (B1): random create / attest / release / refund / dispute / warp across 3 buyers.
contract EscrowHandler is Test {
    MultiSeaOrdinalEscrow esc; MockUSDC usdc; uint256 pk; bytes32 cid; bytes32 prog; string btc;
    address[3] public buyers = [address(0xB1), address(0xB2), address(0xB3)];
    uint256[] public ids;
    uint256 public ghostOpen;                 // sum(amount + inscriptionFee) over unsettled orders
    mapping(uint256 => uint8) public settleCount; // # of terminal transitions per order
    uint256 public maxSettle;
    uint256 salt;

    constructor(MultiSeaOrdinalEscrow e, MockUSDC u, uint256 pk_, bytes32 c, bytes32 p, string memory b) {
        esc = e; usdc = u; pk = pk_; cid = c; prog = p; btc = b;
        for (uint256 i; i < 3; i++) { usdc.mint(buyers[i], 1e15); vm.prank(buyers[i]); usdc.approve(address(esc), type(uint256).max); }
    }
    function idsLength() external view returns (uint256) { return ids.length; }

    function create(uint256 who, uint256 fee) external {
        address b = buyers[who % 3]; fee = bound(fee, 0, 25e6);
        vm.prank(b);
        try esc.createOrder(cid, address(usdc), btc, fee) returns (uint256 id) { ids.push(id); ghostOpen += 25e6 + fee; } catch {}
    }
    function _status(uint256 id) internal view returns (MultiSeaOrdinalEscrow.Status s) { s = esc.orderStatus(id); }
    function _total(uint256 id) internal view returns (uint256) { MultiSeaOrdinalEscrow.Order memory o = esc.getOrder(id); return uint256(o.amount) + o.inscriptionFee; }
    function _settled(uint256 id) internal {
        ghostOpen -= _total(id); settleCount[id]++; if (settleCount[id] > maxSettle) maxSettle = settleCount[id];
    }

    function attest(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        if (_status(id) != MultiSeaOrdinalEscrow.Status.Pending) return;
        uint64 created = esc.getOrder(id).createdAt;
        (MultiSeaOrdinalEscrow.SpvProof memory p, bytes32 txid) = SpvFactory.proof(prog, bytes32(++salt), uint32(created), 3);
        string memory ins = string.concat(_hex(txid), "i0");
        bytes32 sh = keccak256(abi.encode(esc.ATTEST_TYPEHASH(), id, txid, keccak256(bytes(ins)), block.timestamp + 1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", esc.domainSeparator(), sh)));
        bytes[] memory sigs = new bytes[](1); sigs[0] = abi.encodePacked(r, s, v);
        esc.attestDelivery(id, p, block.timestamp + 1, sigs);
    }
    function release(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        try esc.release(id) { _settled(id); } catch {}
    }
    function refund(uint256 i) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        uint256 t = _total(id);
        try esc.refund(id) { ghostOpen -= t; settleCount[id]++; if (settleCount[id] > maxSettle) maxSettle = settleCount[id]; } catch {}
    }
    function disputeAndResolve(uint256 i, bool toArtist) external {
        if (ids.length == 0) return; uint256 id = ids[i % ids.length];
        address b = esc.getOrder(id).buyer;
        vm.prank(b); try esc.dispute(id) {} catch { return; }
        vm.prank(esc.owner()); esc.resolveDispute(id, toArtist); _settled(id);
    }
    function warp(uint256 dt) external { vm.warp(block.timestamp + bound(dt, 0, 8 hours)); }

    function _hex(bytes32 x) internal pure returns (string memory) {
        bytes memory s = new bytes(64); bytes16 H = "0123456789abcdef";
        for (uint256 i; i < 32; i++) { s[2*i] = H[uint8(x[i]) >> 4]; s[2*i+1] = H[uint8(x[i]) & 15]; }
        return string(s);
    }
}

contract OrdinalEscrowInvariantTest is EscrowBase {
    EscrowHandler handler;
    function setUp() public {
        _deploy(1, 1, 50);
        vm.prank(owner); esc.setMaxPerWallet(CID, 5);
        handler = new EscrowHandler(esc, usdc, pks[0], CID, PROG, BTC);
        targetContract(address(handler));
    }
    /// escrow USDC balance == sum of open (unsettled) orders
    function invariant_balanceEqualsOpenOrders() public view { assertEq(usdc.balanceOf(address(esc)), handler.ghostOpen()); }
    /// no order is both released and refunded (at most one terminal transition)
    function invariant_singleSettlement() public view { assertLe(handler.maxSettle(), 1); }
    /// per-wallet count never exceeds the limit; and equals live orders
    function invariant_walletLimit() public view {
        for (uint256 i; i < 3; i++) assertLe(esc.ordersBy(CID, handler.buyers(i)), esc.walletLimit(CID));
    }
    /// fee split: everything that left the escrow went to buyer/artist/fee wallet exactly
    function invariant_conservation() public view {
        uint256 out = usdc.balanceOf(artist) + usdc.balanceOf(fee) + usdc.balanceOf(address(esc));
        for (uint256 i; i < 3; i++) out += usdc.balanceOf(handler.buyers(i));
        assertEq(out, 3e15);
    }
}
