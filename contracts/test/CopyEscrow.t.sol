// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC721URIStorage } from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { MultiSeaEscrow } from "../src/MultiSeaEscrow.sol";
import { MultiSeaCopyEscrow, ICopyNFT } from "../src/MultiSeaCopyEscrow.sol";
import { BatchMinter } from "../src/BatchMinter.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

contract Feed {
    uint8 public decimals = 8;
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, 2500e8, block.timestamp, block.timestamp, 1); }
}

/// @dev Mirrors the deployed LIL FOOTS copy contract interface (AccessControl + MINTER_ROLE + mintWithURI).
contract CopyNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    constructor(address admin) ERC721("LIL FOOTS", "FOOT") { _grantRole(DEFAULT_ADMIN_ROLE, admin); }
    function mintWithURI(address to, uint256 id, string calldata uri) external onlyRole(MINTER_ROLE) { _mint(to, id); _setTokenURI(id, uri); }
    function supportsInterface(bytes4 i) public view override(ERC721URIStorage, AccessControl) returns (bool) { return super.supportsInterface(i); }
}

contract Original is ERC721 { constructor() ERC721("LIL FOOTS", "BIG") {} function mint(address to, uint256 id) external { _mint(to, id); } }

contract CopyEscrowTest is TestHelperOz5 {
    using OptionsBuilder for bytes;
    uint32 constant A = 1; uint32 constant B = 2;
    address constant ADMIN = 0xCa89AE48a5C61D13E78236DAA4Ac29EE588ea475;
    address constant FEE = 0x25411039F77529A543344603bD8acdd65fABA4d0;
    address roleAdmin = address(0xB19F);
    address holder = address(0xA11CE);
    string constant URI = "ipfs://QmeY3guj7YMSDLbByqhU7ESDCXSsXenJtUAaxKKtkerChd/";
    Original orig; CopyNFT copy; MultiSeaEscrow escA; MultiSeaCopyEscrow escB; bytes opts;

    function setUp() public override {
        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);
        Feed f = new Feed();
        orig = new Original(); copy = new CopyNFT(roleAdmin);
        escA = new MultiSeaEscrow(address(endpoints[A]), ADMIN, address(orig), false, FEE, address(f), 3600);
        escB = new MultiSeaCopyEscrow(address(endpoints[B]), ADMIN, address(copy), FEE, address(f), 3600, URI, 1, 4404);
        vm.startPrank(ADMIN);
        escA.setPeer(B, addressToBytes32(address(escB)));
        escB.setPeer(A, addressToBytes32(address(escA)));
        vm.stopPrank();
        bytes32 minter = copy.MINTER_ROLE();
        vm.prank(roleAdmin); copy.grantRole(minter, address(escB));
        orig.mint(holder, 7); orig.mint(holder, 3004);
        opts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(300_000, 0);
        vm.deal(holder, 10 ether);
    }

    function _send(MultiSeaEscrow e, uint32 dst, uint256 id, address to) internal {
        (uint256 p, uint256 lz) = e.quote(dst, to, id, opts);
        vm.startPrank(holder); ERC721(address(e.nft())).approve(address(e), id); e.bridge{ value: p + lz }(dst, to, id, opts); vm.stopPrank();
    }

    function test_mintIfMissingThenRoundTrip() public {
        assertFalse(escB.exists(7));
        _send(escA, B, 7, holder);
        verifyPackets(B, addressToBytes32(address(escB)));
        assertEq(copy.ownerOf(7), holder);
        assertEq(copy.tokenURI(7), string.concat(URI, "7"));
        // back to A: copy is locked (not burned) in escB, original released
        _send(MultiSeaEscrow(escB), A, 7, holder);
        verifyPackets(A, addressToBytes32(address(escA)));
        assertEq(copy.ownerOf(7), address(escB));
        assertEq(orig.ownerOf(7), holder);
        // out again: transfer from escrow, no second mint
        _send(escA, B, 7, holder);
        verifyPackets(B, addressToBytes32(address(escB)));
        assertEq(copy.ownerOf(7), holder);
    }

    function test_existingCopyHeldElsewhereReverts() public {
        // id already minted to someone else on B (e.g. by the old bridge) and not in escrow -> NotHeld, original stays locked
        bytes32 mr = copy.MINTER_ROLE(); vm.prank(roleAdmin); copy.grantRole(mr, roleAdmin);
        vm.prank(roleAdmin); copy.mintWithURI(address(0xDEAD), 3004, "x");
        (address to, uint256 id) = (holder, uint256(3004));
        bytes memory msg_ = abi.encode(to, id);
        vm.prank(address(endpoints[B]));
        vm.expectRevert(abi.encodeWithSelector(MultiSeaEscrow.NotHeld.selector, 3004));
        escB.lzReceive(_origin(), bytes32(uint256(1)), msg_, address(0), "");
    }

    function _origin() internal view returns (Origin memory o) { o = Origin(A, addressToBytes32(address(escA)), 1); }

    function test_withoutMinterRoleReverts() public {
        bytes32 mr = copy.MINTER_ROLE(); vm.prank(roleAdmin); copy.revokeRole(mr, address(escB));
        uint256[] memory ids = new uint256[](1); ids[0] = 5;
        vm.prank(ADMIN);
        vm.expectRevert();
        escB.preMint(ids);
    }

    function test_preMintIntoEscrowOnlyOwner() public {
        uint256[] memory ids = new uint256[](3); ids[0] = 1; ids[1] = 2; ids[2] = 4404;
        vm.expectRevert();
        escB.preMint(ids);
        vm.prank(ADMIN); escB.preMint(ids);
        assertEq(copy.ownerOf(2), address(escB));
        assertEq(copy.balanceOf(address(escB)), 3);
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaCopyEscrow.AlreadyExists.selector, 1));
        escB.preMint(ids);
        // pre-minted id bridged in is released, not re-minted
        orig.mint(holder, 2);
        _send(escA, B, 2, holder);
        verifyPackets(B, addressToBytes32(address(escB)));
        assertEq(copy.ownerOf(2), holder);
    }

    function test_preMintOutOfRange() public {
        uint256[] memory ids = new uint256[](1); ids[0] = 4405;
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(MultiSeaCopyEscrow.OutOfRange.selector, 4405));
        escB.preMint(ids);
    }

    function test_batchMinter() public {
        BatchMinter bm = new BatchMinter(ADMIN);
        bytes32 mr = copy.MINTER_ROLE(); vm.prank(roleAdmin); copy.grantRole(mr, address(bm));
        address[] memory to = new address[](2); to[0] = holder; to[1] = ADMIN;
        uint256[] memory ids = new uint256[](2); ids[0] = 10; ids[1] = 3004;
        vm.expectRevert(BatchMinter.NotOwner.selector);
        bm.mintBatch(ICopyNFT(address(copy)), to, ids, URI);
        uint256[] memory bad = new uint256[](1);
        vm.prank(ADMIN); vm.expectRevert(BatchMinter.LengthMismatch.selector);
        bm.mintBatch(ICopyNFT(address(copy)), to, bad, URI);
        vm.prank(ADMIN); bm.mintBatch(ICopyNFT(address(copy)), to, ids, URI);
        assertEq(copy.ownerOf(3004), ADMIN);
        assertEq(copy.tokenURI(10), string.concat(URI, "10"));
    }

    function test_onlyPeerCanDeliver() public {
        vm.prank(address(endpoints[B]));
        vm.expectRevert();
        escB.lzReceive(Origin(A, bytes32(uint256(0xBAD)), 1), bytes32(uint256(1)), abi.encode(holder, uint256(7)), address(0), "");
    }
}
