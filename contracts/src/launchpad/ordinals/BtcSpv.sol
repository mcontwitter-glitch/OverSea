// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Minimal Bitcoin SPV verification (pattern of summa-tx/bitcoin-spv "ViewBTC/ValidateSPV").
/// @notice Parses a non-witness serialized tx, proves merkle inclusion against a header, checks header PoW
///         against a configurable max target (difficulty floor) and that the following headers chain to it.
///         Byte order: all hashes are internal (little-endian) order unless named "display".
library BtcSpv {
    error BadTx();
    error BadMerkle();
    error BadHeaders();
    error LowWork();

    uint256 internal constant MAX_HEADERS = 24;
    uint256 internal constant MAX_INPUTS = 64;
    uint256 internal constant MAX_OUTPUTS = 64;

    function hash256(bytes memory b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(b)));
    }

    function reverse32(bytes32 x) internal pure returns (bytes32) {
        uint256 v = uint256(x);
        v = ((v & 0xFF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00) >> 8)
          | ((v & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        v = ((v & 0xFFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000) >> 16)
          | ((v & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        v = ((v & 0xFFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000) >> 32)
          | ((v & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        v = ((v & 0xFFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF0000000000000000) >> 64)
          | ((v & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        return bytes32((v >> 128) | (v << 128));
    }

    function _le(bytes calldata b, uint256 o, uint256 len) private pure returns (uint256 v) {
        for (uint256 i; i < len; i++) v |= uint256(uint8(b[o + i])) << (8 * i);
    }

    /// @dev Bitcoin CompactSize; rejects non-canonical encodings.
    function _varint(bytes calldata b, uint256 o) private pure returns (uint256 v, uint256 next) {
        uint8 f = uint8(b[o]);
        if (f < 0xfd) return (f, o + 1);
        uint256 len = f == 0xfd ? 2 : f == 0xfe ? 4 : 8;
        v = _le(b, o + 1, len);
        if ((len == 2 && v < 0xfd) || (len == 4 && v <= 0xffff) || (len == 8 && v <= 0xffffffff)) revert BadTx();
        next = o + 1 + len;
    }

    /// @notice Parse a legacy (non-witness) serialized tx and return output 0's P2TR program (0 if output 0 is not P2TR).
    /// @dev Rejects 64-byte txs (merkle second-preimage ambiguity) and segwit-marker serialization (0 inputs).
    function output0Taproot(bytes calldata rtx) internal pure returns (bytes32 program) {
        if (rtx.length < 60 || rtx.length == 64) revert BadTx();
        uint256 o = 4;
        uint256 nIn; (nIn, o) = _varint(rtx, o);
        if (nIn == 0 || nIn > MAX_INPUTS) revert BadTx();
        for (uint256 i; i < nIn; i++) {
            o += 36;
            uint256 sl; (sl, o) = _varint(rtx, o);
            o += sl + 4;
        }
        uint256 nOut; (nOut, o) = _varint(rtx, o);
        if (nOut == 0 || nOut > MAX_OUTPUTS) revert BadTx();
        for (uint256 i; i < nOut; i++) {
            o += 8;
            uint256 sl; (sl, o) = _varint(rtx, o);
            if (i == 0 && sl == 34 && rtx[o] == 0x51 && rtx[o + 1] == 0x20) program = bytes32(rtx[o + 2:o + 34]);
            o += sl;
        }
        o += 4;
        if (o != rtx.length) revert BadTx();
    }

    /// @notice Merkle root from leaf (internal order), concatenated 32-byte siblings and leaf index.
    function merkleRoot(bytes32 leaf, bytes calldata siblings, uint256 index) internal pure returns (bytes32 h) {
        if (siblings.length % 32 != 0) revert BadMerkle();
        uint256 depth = siblings.length / 32;
        if (depth > 32 || (index >> depth) != 0) revert BadMerkle();
        h = leaf;
        for (uint256 i; i < depth; i++) {
            bytes32 s = bytes32(siblings[i * 32:(i + 1) * 32]);
            h = (index & 1) == 1 ? hash256(abi.encodePacked(s, h)) : hash256(abi.encodePacked(h, s));
            index >>= 1;
        }
    }

    function targetFromBits(uint256 bits) internal pure returns (uint256) {
        uint256 exp = bits >> 24;
        uint256 mant = bits & 0xffffff;
        if (mant > 0x7fffff || exp < 3 || exp > 32) revert BadHeaders(); // negative / out of range compact
        return mant << (8 * (exp - 3));
    }

    /// @notice Verify `headers` (n * 80 bytes): each hash <= its nBits target, each target <= maxTarget
    ///         (difficulty floor), header[i].prev == hash(header[i-1]). Returns header[0]'s merkle root and time.
    function verifyHeaders(bytes calldata headers, uint256 minCount, uint256 maxTarget)
        internal pure returns (bytes32 root, uint256 time)
    {
        if (headers.length % 80 != 0) revert BadHeaders();
        uint256 n = headers.length / 80;
        if (n < minCount || n == 0 || n > MAX_HEADERS) revert BadHeaders();
        bytes32 prev;
        for (uint256 i; i < n; i++) {
            bytes calldata h = headers[i * 80:(i + 1) * 80];
            uint256 target = targetFromBits(_le(h, 72, 4));
            if (target == 0 || target > maxTarget) revert LowWork();
            bytes32 hh = hash256(h);
            if (uint256(reverse32(hh)) > target) revert LowWork();
            if (i > 0 && bytes32(h[4:36]) != prev) revert BadHeaders();
            prev = hh;
        }
        root = bytes32(headers[36:68]);
        time = _le(headers, 68, 4);
    }
}
