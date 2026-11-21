// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @title OnchainArt
/// @notice SSTORE2 (STOP + data) image storage and on-chain data: tokenURI builder.
///         Per-image cap is 24 KiB; payloads larger than one contract are split into chunks.
library OnchainArt {
    using Strings for uint256;

    uint256 public constant MAX_IMAGE = 24 * 1024;
    uint256 public constant CHUNK = 24_000; // leaves room for the STOP prefix under the 24,576-byte code cap

    uint8 public constant MIME_SVG = 0;
    uint8 public constant MIME_PNG = 1;
    uint8 public constant MIME_WEBP = 2;
    uint8 public constant MIME_GIF = 3;

    struct Token {
        address[] chunks;
        uint8 mime;
        string name;
        string description;
        string attributes; // JSON array, inserted raw
    }

    struct Store {
        uint32 maxSupply;
        uint32 written;
        bool finalized;
        bool storeLocal; // this chain holds the bytes; otherwise tokenURI uses rendererBase
        string rendererBase; // e.g. https://api.multisea.io/onchain-uri/<cid>/
        mapping(uint256 => Token) tokens;
    }

    error ImageTooLarge(uint256 size);
    error BadMime();
    error BadId();
    error AlreadyWritten();
    error NotWritten();
    error StoreIsRemote();
    error AlreadyFinalized();
    error NotFinalized();
    error Incomplete();
    error WriteFailed();

    function init(Store storage s, uint32 maxSupply, bool storeLocal, string memory rendererBase) internal {
        s.maxSupply = maxSupply;
        s.storeLocal = storeLocal;
        s.rendererBase = rendererBase;
    }

    function write(
        Store storage s,
        uint256 id,
        uint8 mime,
        bytes calldata image,
        string calldata name,
        string calldata description,
        string calldata attributes
    ) internal {
        if (s.finalized) revert AlreadyFinalized();
        if (id == 0 || id > s.maxSupply) revert BadId();
        if (mime > MIME_GIF) revert BadMime();
        if (image.length > MAX_IMAGE) revert ImageTooLarge(image.length);
        if (s.storeLocal) {
            Token storage t = s.tokens[id];
            if (t.chunks.length != 0) {
                // overwrite allowed before finalize (resume / fix), but recount written only on first write
            } else {
                unchecked { s.written += 1; }
            }
            _clearChunks(t);
            _storeChunks(t, image);
            t.mime = mime;
            t.name = name;
            t.description = description;
            t.attributes = attributes;
        } else {
            revert StoreIsRemote();
        }
    }

    /// @notice Mark a remote (pointer) chain ready. Local chains require every id 1..maxSupply to be written.
    function finalize(Store storage s) internal {
        if (s.finalized) revert AlreadyFinalized();
        if (s.storeLocal && s.written != s.maxSupply) revert Incomplete();
        if (!s.storeLocal && bytes(s.rendererBase).length == 0) revert Incomplete();
        s.finalized = true;
    }

    function requireFinalized(Store storage s) internal view {
        if (!s.finalized) revert NotFinalized();
    }

    function tokenURI(Store storage s, uint256 id) internal view returns (string memory) {
        if (id == 0 || id > s.maxSupply) revert BadId();
        if (!s.storeLocal) {
            return string.concat(s.rendererBase, id.toString());
        }
        Token storage t = s.tokens[id];
        if (t.chunks.length == 0) revert NotWritten();
        bytes memory img = _readChunks(t);
        string memory dataImg = string.concat("data:", _mime(t.mime), ";base64,", Base64.encode(img));
        string memory json = string.concat(
            '{"name":"', _esc(t.name),
            '","description":"', _esc(t.description),
            '","image":"', dataImg, '"'
        );
        if (bytes(t.attributes).length != 0) {
            json = string.concat(json, ',"attributes":', t.attributes);
        }
        json = string.concat(json, "}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function writtenOf(Store storage s, uint256 id) internal view returns (bool) {
        return s.tokens[id].chunks.length != 0;
    }

    function _storeChunks(Token storage t, bytes calldata image) private {
        uint256 n = image.length;
        if (n == 0) revert ImageTooLarge(0);
        uint256 i;
        while (i < n) {
            uint256 end = i + CHUNK;
            if (end > n) end = n;
            t.chunks.push(_sstore2(image[i:end]));
            i = end;
        }
    }

    function _clearChunks(Token storage t) private {
        // Previous SSTORE2 contracts are left in place (immutable); we just drop the pointers.
        if (t.chunks.length != 0) delete t.chunks;
    }

    function _readChunks(Token storage t) private view returns (bytes memory out) {
        uint256 n = t.chunks.length;
        if (n == 1) return _sstore2read(t.chunks[0]);
        for (uint256 i; i < n; ++i) {
            bytes memory part = _sstore2read(t.chunks[i]);
            out = bytes.concat(out, part);
        }
    }

    function _sstore2(bytes calldata data) private returns (address ptr) {
        // Initcode returns STOP || data as runtime (cannot use the payload itself as
        // initcode: STOP would halt with empty return data and deploy a blank contract).
        uint256 len = data.length + 1; // runtime size
        bytes memory creation = new bytes(10 + len);
        assembly {
            let c := add(creation, 32)
            mstore8(c, 0x61)            // PUSH2
            mstore8(add(c, 1), shr(8, len))
            mstore8(add(c, 2), and(len, 0xff))
            mstore8(add(c, 3), 0x80)    // DUP1
            mstore8(add(c, 4), 0x60)    // PUSH1
            mstore8(add(c, 5), 0x0a)    // 10 (runtime offset)
            mstore8(add(c, 6), 0x3d)    // RETURNDATASIZE
            mstore8(add(c, 7), 0x39)    // CODECOPY
            mstore8(add(c, 8), 0x3d)    // RETURNDATASIZE
            mstore8(add(c, 9), 0xf3)    // RETURN
            mstore8(add(c, 10), 0x00)   // STOP
            calldatacopy(add(c, 11), data.offset, data.length)
            ptr := create(0, c, add(10, len))
        }
        if (ptr == address(0)) revert WriteFailed();
    }

    function _sstore2read(address ptr) private view returns (bytes memory data) {
        uint256 size = ptr.code.length;
        if (size <= 1) return "";
        data = new bytes(size - 1);
        assembly {
            extcodecopy(ptr, add(data, 0x20), 1, sub(size, 1))
        }
    }

    function _mime(uint8 m) private pure returns (string memory) {
        if (m == MIME_SVG) return "image/svg+xml";
        if (m == MIME_PNG) return "image/png";
        if (m == MIME_WEBP) return "image/webp";
        return "image/gif";
    }

    function _esc(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 extra;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c == 0x22 || c == 0x5c) extra += 1;
            else if (c < 0x20) extra += 5;
        }
        if (extra == 0) return s;
        bytes memory o = new bytes(b.length + extra);
        uint256 j;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c == 0x22 || c == 0x5c) { o[j++] = "\\"; o[j++] = bytes1(c); }
            else if (c < 0x20) {
                o[j++] = "\\"; o[j++] = "u"; o[j++] = "0"; o[j++] = "0";
                o[j++] = _hex(c >> 4); o[j++] = _hex(c & 0x0f);
            } else o[j++] = bytes1(c);
        }
        return string(o);
    }

    function _hex(uint8 n) private pure returns (bytes1) {
        return bytes1(n < 10 ? n + 0x30 : n + 0x57);
    }
}
