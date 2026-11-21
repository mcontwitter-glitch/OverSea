// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { MultiSeaOnchainDrop } from "../src/onchain/MultiSeaOnchainDrop.sol";
import { MultiSeaOnchainFactory } from "../src/onchain/MultiSeaOnchainFactory.sol";
import { MultiSeaOnchainOmniDrop } from "../src/onchain/MultiSeaOnchainOmniDrop.sol";
import { OnchainArt } from "../src/onchain/OnchainArt.sol";
import { MultiSeaDrop } from "../src/launchpad/MultiSeaDrop.sol";

contract MockOmniEscrow {
    uint32 public localEid;
    constructor(uint32 e) { localEid = e; }
    function isSolana(uint32) external pure returns (bool) { return false; }
    function register(bytes32, address) external {}
    function quoteFanout(bytes32, uint32, uint256) external pure returns (uint256) { return 0; }
    function quoteRequest(bytes32, uint256, bytes32, uint128) external pure returns (uint256) { return 0; }
    function fanoutCopies(bytes32, uint256, uint256, address) external payable {}
    function queueCopies(bytes32, uint256, uint256, address) external payable {}
    function quoteBatchShare(bytes32, uint256) external pure returns (uint256) { return 0; }
    function sendRequest(bytes32, uint256, bytes32, uint256, uint256, uint128, address) external payable {}
    function sendMove(bytes32, uint32, uint256, bytes32, address) external payable {}
}

contract OnchainArtTest is Test {
    using stdJson for string;

    MultiSeaOnchainFactory f;
    MultiSeaOnchainDrop impl;
    address timelock = address(0x71);
    address feeWallet = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    uint256 apk = 0xA11CE; address approver;
    address creator = address(0xC0FFEE);
    address alice = address(0xA1);

    function setUp() public {
        vm.warp(1_800_000_000);
        approver = vm.addr(apk);
        impl = new MultiSeaOnchainDrop();
        f = new MultiSeaOnchainFactory(timelock, address(impl), feeWallet, approver, 50);
        vm.deal(alice, 10 ether);
        vm.deal(creator, 10 ether);
    }

    function params(uint32 supply, bool storeLocal) internal view returns (MultiSeaOnchainDrop.InitParams memory p) {
        p.name = "ONCHAIN"; p.symbol = "OC"; p.owner = creator; p.payout = creator;
        p.maxSupply = supply; p.creatorReserve = 0; p.royaltyReceiver = creator; p.royaltyBps = 500;
        p.phases = new MultiSeaOnchainDrop.Phase[](1);
        p.phases[0] = MultiSeaOnchainDrop.Phase(uint64(block.timestamp), 0, 0.001 ether, 10, 0, bytes32(0));
        p.storeLocal = storeLocal;
        if (!storeLocal) p.rendererBase = "https://api.multisea.io/onchain-uri/abc/";
    }

    function sign(address who, MultiSeaOnchainDrop.InitParams memory p, bytes32 salt, uint256 dl) internal view returns (bytes memory) {
        bytes32 d = f.approvalDigest(who, this.cfgHash(p), salt, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, d); return abi.encodePacked(r, s, v);
    }
    function cfgHash(MultiSeaOnchainDrop.InitParams calldata p) external view returns (bytes32) { return f.configHash(p); }

    function deploy(uint32 supply, bool storeLocal, bytes32 salt) internal returns (MultiSeaOnchainDrop d) {
        MultiSeaOnchainDrop.InitParams memory p = params(supply, storeLocal);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = sign(creator, p, salt, dl);
        vm.prank(creator); d = MultiSeaOnchainDrop(f.createDrop(p, salt, dl, sig));
    }

    function writeOne(MultiSeaOnchainDrop d, uint256 id, uint8 mime, bytes memory img, string memory name) internal {
        vm.prank(creator);
        d.writeArt(id, mime, img, name, "desc", '[{"trait_type":"t","value":"v"}]');
    }

    function testWriteFinalizeAndMint() public {
        MultiSeaOnchainDrop d = deploy(2, true, keccak256("wf"));
        vm.prank(alice);
        vm.expectRevert(OnchainArt.NotFinalized.selector);
        d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0));

        writeOne(d, 1, OnchainArt.MIME_PNG, bytes("png-one"), "One");
        vm.prank(creator);
        vm.expectRevert(OnchainArt.Incomplete.selector);
        d.finalizeArt();

        writeOne(d, 2, OnchainArt.MIME_PNG, bytes("png-two"), "Two");
        vm.prank(creator); d.finalizeArt();
        assertTrue(d.artFinalized());
        assertEq(d.artWritten(), 2);

        vm.prank(creator);
        vm.expectRevert(OnchainArt.AlreadyFinalized.selector);
        d.writeArt(1, OnchainArt.MIME_PNG, bytes("x"), "n", "d", "");

        vm.prank(alice);
        d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0));
        assertEq(d.ownerOf(1), alice);
        assertEq(d.balanceOf(alice), 1);
    }

    function testImageCap() public {
        MultiSeaOnchainDrop d = deploy(1, true, keccak256("cap"));
        bytes memory over = new bytes(24 * 1024 + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(OnchainArt.ImageTooLarge.selector, over.length));
        d.writeArt(1, OnchainArt.MIME_WEBP, over, "n", "d", "");

        bytes memory ok = new bytes(24 * 1024);
        ok[0] = 0x52; // 'R' of RIFF
        vm.prank(creator); d.writeArt(1, OnchainArt.MIME_WEBP, ok, "Full", "d", "");
        vm.prank(creator); d.finalizeArt();
    }

    function testTokenURIEachMime() public {
        MultiSeaOnchainDrop d = deploy(4, true, keccak256("mime"));
        writeOne(d, 1, OnchainArt.MIME_SVG, bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"), "Svg");
        writeOne(d, 2, OnchainArt.MIME_PNG, hex"89504e470d0a1a0a", "Png");
        writeOne(d, 3, OnchainArt.MIME_WEBP, bytes("RIFF....WEBP"), "Webp");
        writeOne(d, 4, OnchainArt.MIME_GIF, bytes("GIF89a"), "Gif");
        vm.prank(creator); d.finalizeArt();
        vm.startPrank(alice);
        d.mint{value: 0.004 ether}(alice, 0, 4, new bytes32[](0));
        vm.stopPrank();

        _assertMime(d.tokenURI(1), "image/svg+xml", "Svg");
        _assertMime(d.tokenURI(2), "image/png", "Png");
        _assertMime(d.tokenURI(3), "image/webp", "Webp");
        _assertMime(d.tokenURI(4), "image/gif", "Gif");
    }

    function testWriteGas10kAnd24k() public {
        MultiSeaOnchainDrop d = deploy(2, true, keccak256("gas"));
        bytes memory img10 = new bytes(10 * 1024);
        bytes memory img24 = new bytes(24 * 1024);
        vm.prank(creator);
        uint256 g10 = gasleft();
        d.writeArt(1, OnchainArt.MIME_PNG, img10, "Ten", "d", "");
        uint256 used10 = g10 - gasleft();
        emit log_named_uint("writeArt 10 KiB gas", used10);

        vm.prank(creator);
        uint256 g24 = gasleft();
        d.writeArt(2, OnchainArt.MIME_PNG, img24, "TwentyFour", "d", "");
        uint256 used24 = g24 - gasleft();
        emit log_named_uint("writeArt 24 KiB gas", used24);

        // sanity: 24k uses more gas than 10k, both exceed a "cheap" storage floor
        assertGt(used24, used10);
        assertGt(used10, 1_000_000);
    }

    function testRemotePointerFinalize() public {
        MultiSeaOnchainDrop d = deploy(2, false, keccak256("remote"));
        vm.prank(creator);
        vm.expectRevert(OnchainArt.StoreIsRemote.selector);
        d.writeArt(1, OnchainArt.MIME_PNG, bytes("x"), "n", "d", "");
        vm.prank(creator); d.finalizeArt();
        assertTrue(d.artFinalized());
        vm.prank(alice); d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0));
        assertEq(d.tokenURI(1), "https://api.multisea.io/onchain-uri/abc/1");
    }

    function testBadIdAndMimeAndOverwrite() public {
        MultiSeaOnchainDrop d = deploy(1, true, keccak256("bad"));
        vm.prank(creator);
        vm.expectRevert(OnchainArt.BadId.selector);
        d.writeArt(0, 0, bytes("x"), "n", "d", "");
        vm.prank(creator);
        vm.expectRevert(OnchainArt.BadId.selector);
        d.writeArt(2, 0, bytes("x"), "n", "d", "");
        vm.prank(creator);
        vm.expectRevert(OnchainArt.BadMime.selector);
        d.writeArt(1, 4, bytes("x"), "n", "d", "");
        writeOne(d, 1, OnchainArt.MIME_SVG, bytes("<svg/>"), "A");
        writeOne(d, 1, OnchainArt.MIME_SVG, bytes("<svg>b</svg>"), "B"); // overwrite before finalize
        assertEq(d.artWritten(), 1);
        vm.prank(creator); d.finalizeArt();
        vm.prank(alice); d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0));
        _assertMime(d.tokenURI(1), "image/svg+xml", "B");
    }

    function testOmniMintBlockedUntilFinalizedAndRendererURI() public {
        MultiSeaOnchainOmniDrop oimpl = new MultiSeaOnchainOmniDrop();
        MockOmniEscrow esc = new MockOmniEscrow(30184);
        MultiSeaOnchainOmniDrop.OmniInit memory p;
        p.name = "OMNI"; p.symbol = "OM"; p.owner = creator; p.payout = creator;
        p.maxSupply = 2; p.royaltyReceiver = creator; p.royaltyBps = 0;
        p.phases = new MultiSeaDrop.Phase[](1);
        p.phases[0] = MultiSeaDrop.Phase(uint64(block.timestamp), 0, 0, 10, 0, bytes32(0));
        p.eids = new uint32[](2); p.eids[0] = 30184; p.eids[1] = 30101;
        p.hubEid = 30184;
        p.prices = new uint128[](2); p.prices[0] = 0.001 ether; p.prices[1] = 0.001 ether;
        p.copyMode = 1; p.batchK = 0; p.batchT = 0;
        p.storeLocal = false;
        p.rendererBase = "https://api.multisea.io/onchain-uri/cid/";
        // initialize implementation is locked? Omni uses Initializable, constructor may not lock.
        // Deploy a clone-like instance by initializing the impl if allowed, else use factory.
        // Implementation is not constructor-locked for OZ Initializable. Use a fresh clone via factory.
        vm.prank(timelock); f.setOmni(address(oimpl), address(esc));
        uint256 dl = block.timestamp + 1 hours;
        bytes32 cid = keccak256("omni-art");
        MultiSeaOnchainOmniDrop.OmniInit memory q = p; // config hash needs calldata wrapper
        bytes32 cfg = this.omniCfg(q);
        bytes32 digest = f.omniDigest(creator, cfg, cid, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(apk, digest);
        vm.prank(creator);
        MultiSeaOnchainOmniDrop d = MultiSeaOnchainOmniDrop(f.createOmniDrop(q, cid, dl, abi.encodePacked(r, s, v)));

        vm.prank(alice);
        vm.expectRevert(OnchainArt.NotFinalized.selector);
        d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0), 0);

        vm.prank(creator); d.finalizeArt();
        vm.prank(alice); d.mint{value: 0.001 ether}(alice, 0, 1, new bytes32[](0), 0);
        assertEq(d.tokenURI(1), "https://api.multisea.io/onchain-uri/cid/1");
    }

    function omniCfg(MultiSeaOnchainOmniDrop.OmniInit calldata p) external view returns (bytes32) { return f.omniConfigHash(p); }

    function _assertMime(string memory uri, string memory mime, string memory name) internal {
        bytes memory b = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        assertTrue(b.length > prefix.length);
        for (uint256 i; i < prefix.length; ++i) assertEq(uint8(b[i]), uint8(prefix[i]));
        bytes memory enc = new bytes(b.length - prefix.length);
        for (uint256 i; i < enc.length; ++i) enc[i] = b[i + prefix.length];
        string memory json = string(_b64decode(enc));
        assertEq(json.readString(".name"), name);
        string memory image = json.readString(".image");
        string memory want = string.concat("data:", mime, ";base64,");
        bytes memory img = bytes(image);
        bytes memory w = bytes(want);
        assertTrue(img.length > w.length);
        for (uint256 i; i < w.length; ++i) assertEq(uint8(img[i]), uint8(w[i]));
    }

    function _b64decode(bytes memory input) internal pure returns (bytes memory output) {
        // strip padding
        uint256 len = input.length;
        uint256 pad;
        if (len > 0 && input[len - 1] == "=") pad++;
        if (len > 1 && input[len - 2] == "=") pad++;
        output = new bytes((len * 3) / 4 - pad);
        uint256 j;
        for (uint256 i; i < len; ) {
            uint256 n = (_val(input[i]) << 18) | (_val(input[i + 1]) << 12);
            if (i + 2 < len && input[i + 2] != "=") n |= _val(input[i + 2]) << 6;
            if (i + 3 < len && input[i + 3] != "=") n |= _val(input[i + 3]);
            if (j < output.length) output[j++] = bytes1(uint8(n >> 16));
            if (j < output.length) output[j++] = bytes1(uint8(n >> 8));
            if (j < output.length) output[j++] = bytes1(uint8(n));
            unchecked { i += 4; }
        }
    }
    function _val(bytes1 c) internal pure returns (uint256) {
        uint8 x = uint8(c);
        if (x >= 0x41 && x <= 0x5a) return x - 0x41;
        if (x >= 0x61 && x <= 0x7a) return x - 0x47;
        if (x >= 0x30 && x <= 0x39) return x + 4;
        if (c == "+") return 62;
        if (c == "/") return 63;
        return 0;
    }
}
