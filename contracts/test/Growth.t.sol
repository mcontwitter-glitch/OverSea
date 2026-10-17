// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { MultiSeaRevenueSplitter } from "../src/MultiSeaRevenueSplitter.sol";
import { MultiSeaChainBadges } from "../src/MultiSeaChainBadges.sol";

contract NFT is ERC721 { constructor() ERC721("T", "T") {} function mint(address to, uint256 id) external { _mint(to, id); } }
contract Tok is ERC20 { constructor() ERC20("U", "U") { _mint(msg.sender, 1e30); } }
contract Greedy { MultiSeaRevenueSplitter s; uint256[] ids; bool hit;
  constructor(MultiSeaRevenueSplitter _s) { s = _s; }
  function go(uint256 id) external { ids = [id]; s.claim(address(0), ids); }
  receive() external payable { if (!hit) { hit = true; s.claim(address(0), ids); } } }

contract SplitterTest is Test {
    NFT nft; MultiSeaRevenueSplitter s; address a = address(0xA11CE); address b = address(0xB0B);
    function setUp() public { nft = new NFT(); s = new MultiSeaRevenueSplitter(nft, 4, 1); nft.mint(a, 1); nft.mint(a, 2); nft.mint(b, 3); nft.mint(b, 4); }

    function testProRataNative() public {
        (bool ok,) = address(s).call{ value: 1 ether + 3 }(""); assertTrue(ok);
        assertEq(s.claimable(address(0), 1), 0.25 ether); assertEq(s.dust(address(0)), 3);
        uint256[] memory ids = new uint256[](2); ids[0] = 1; ids[1] = 2;
        vm.prank(a); uint256 got = s.claim(address(0), ids); assertEq(got, 0.5 ether); assertEq(a.balance, 0.5 ether);
        vm.prank(a); vm.expectRevert(MultiSeaRevenueSplitter.ZeroAmount.selector); s.claim(address(0), ids);
        s.depositNative{ value: 1 }(); // 3 dust + 1 => +1 per token
        assertEq(s.claimable(address(0), 1), 1); assertEq(s.claimable(address(0), 3), 0.25 ether + 1);
    }
    function testOnlyHolderAndFollowsToken() public {
        s.depositNative{ value: 4 ether }();
        uint256[] memory ids = new uint256[](1); ids[0] = 3;
        vm.prank(a); vm.expectRevert(abi.encodeWithSelector(MultiSeaRevenueSplitter.NotHolder.selector, 3)); s.claim(address(0), ids);
        vm.prank(b); nft.transferFrom(b, a, 3); // unclaimed revenue moves with the token
        vm.prank(a); assertEq(s.claim(address(0), ids), 1 ether);
        ids[0] = 9; vm.prank(a); vm.expectRevert(abi.encodeWithSelector(MultiSeaRevenueSplitter.BadToken.selector, 9)); s.claim(address(0), ids);
    }
    function testERC20() public {
        Tok t = new Tok(); t.approve(address(s), 400); s.depositToken(t, 400);
        uint256[] memory ids = new uint256[](2); ids[0] = 3; ids[1] = 4;
        vm.prank(b); assertEq(s.claim(address(t), ids), 200); assertEq(t.balanceOf(b), 200);
        assertEq(s.claimable(address(0), 3), 0);
    }
    function testReentrancyBlocked() public {
        Greedy g = new Greedy(s); nft.mint(address(g), 5); // id 5 out of range -> use transfer of id 4
        vm.prank(b); nft.transferFrom(b, address(g), 4);
        s.depositNative{ value: 4 ether }();
        vm.expectRevert(MultiSeaRevenueSplitter.TransferFailed.selector); g.go(4);
    }
    function testFuzzConservation(uint96 x, uint96 y) public {
        vm.assume(x > 0 && y > 0); vm.deal(address(this), uint256(x) + y);
        s.depositNative{ value: x }(); s.depositNative{ value: y }();
        assertEq(s.accPerToken(address(0)) * 4 + s.dust(address(0)), uint256(x) + y);
    }
}

contract BadgesTest is Test {
    MultiSeaChainBadges c; uint256 pk = 0xBADD1E; address signer; address user = address(0xCAFE);
    function setUp() public { signer = vm.addr(pk); c = new MultiSeaChainBadges(signer, 2, "ipfs://voyager/", address(this)); }
    function pass(uint256 key, address to, uint256 deadline) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(c.MINTPASS_TYPEHASH(), to, deadline));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", c.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d); return abi.encodePacked(r, s, v);
    }
    function testMintWithWorkerSignature() public {
        uint256 dl = block.timestamp + 1 days; bytes memory sig = pass(pk, user, dl);
        vm.prank(user); uint256 id = c.mint(dl, sig); assertEq(id, 1); assertEq(c.ownerOf(1), user);
        assertEq(c.tokenURI(1), "ipfs://voyager/1");
        vm.prank(user); vm.expectRevert(MultiSeaChainBadges.AlreadyMinted.selector); c.mint(dl, sig);
    }
    function testRejects() public {
        uint256 dl = block.timestamp + 1 days;
        bytes memory forUser = pass(pk, user, dl); bytes memory wrongSigner = pass(0xBEEF, user, dl);
        vm.prank(address(0xD00D)); vm.expectRevert(MultiSeaChainBadges.BadSignature.selector); c.mint(dl, forUser); // pass bound to another wallet
        vm.prank(user); vm.expectRevert(MultiSeaChainBadges.BadSignature.selector); c.mint(dl, wrongSigner);
        vm.warp(dl + 1); vm.prank(user); vm.expectRevert(MultiSeaChainBadges.Expired.selector); c.mint(dl, forUser);
    }
    function testSupplyCapAndSignerRotation() public {
        uint256 dl = block.timestamp + 1 days;
        bytes memory s1 = pass(pk, address(0x1001), dl); bytes memory s2 = pass(pk, address(0x1002), dl); bytes memory s3 = pass(pk, address(0x1003), dl);
        vm.prank(address(0x1001)); c.mint(dl, s1); vm.prank(address(0x1002)); c.mint(dl, s2);
        vm.prank(address(0x1003)); vm.expectRevert(MultiSeaChainBadges.SoldOut.selector); c.mint(dl, s3);
        vm.prank(user); vm.expectRevert(); c.setSigner(user);
        c.setSigner(address(0x1234)); assertEq(c.signer(), address(0x1234));
    }
    /// Signature produced by the Worker code path (viem signTypedData in worker/src/growth.js) for key 0xBADD1E.
    function testAcceptsWorkerSignedPass() public {
        assertEq(address(c), 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f); assertEq(block.chainid, 31337);
        vm.prank(address(0xCAFE)); c.mint(4102444800, hex"a532ef21499dc173a5c4dad74366cdc3a5e6cff3fee9a3e9539e45d1c9e78ab47b8afcaf3c2cd2c6cd73fe3a852ab35a862ec30005d0285fa6537cb68e1ba9b91b");
        assertEq(c.ownerOf(1), address(0xCAFE));
    }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC721Received.selector; }
}
