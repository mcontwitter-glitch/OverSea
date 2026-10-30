// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Bech32 / Bech32m decoder (BIP-173 + BIP-350) and segwit address parser.
/// @notice Full checksum validation. Used to derive the 32-byte taproot witness program from a bc1p/tb1p/bcrt1p address.
library Bech32m {
    error InvalidSegwit();

    uint32 internal constant BECH32_CONST = 1;
    uint32 internal constant BECH32M_CONST = 0x2bc830a3;
    uint8 internal constant ENC_NONE = 0;
    uint8 internal constant ENC_BECH32 = 1;
    uint8 internal constant ENC_BECH32M = 2;

    // ASCII -> 5-bit value for "qpzry9x8gf2tvdw0s3jn54khce6mua7l" (both cases), 0xff = invalid.
    bytes internal constant REV =
        hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0fff0a1115141a1e0705ffffffffffffff1dff180d19090817ff12161f1b13ff010003100b1c0c0e060402ffffffffffff1dff180d19090817ff12161f1b13ff010003100b1c0c0e060402ffffffffff";

    function _polymodStep(uint32 chk, uint32 v) private pure returns (uint32) {
        uint32 b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        if (b & 1 != 0) chk ^= 0x3b6a57b2;
        if (b & 2 != 0) chk ^= 0x26508e6d;
        if (b & 4 != 0) chk ^= 0x1ea119fa;
        if (b & 8 != 0) chk ^= 0x3d4233dd;
        if (b & 16 != 0) chk ^= 0x2a1462b3;
        return chk;
    }

    /// @notice Decode any bech32/bech32m string. Returns encoding (0 = invalid), lowercase HRP and the data part
    ///         (5-bit values, checksum stripped). Never reverts on bad input.
    function decode(string memory s) internal pure returns (uint8 enc, bytes memory hrp, uint8[] memory data) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        if (n < 8 || n > 90) return (ENC_NONE, hrp, data);
        bool lower; bool upper; uint256 sep = type(uint256).max;
        for (uint256 i; i < n; i++) {
            uint8 c = uint8(b[i]);
            if (c < 33 || c > 126) return (ENC_NONE, hrp, data);
            if (c >= 97 && c <= 122) lower = true;
            else if (c >= 65 && c <= 90) upper = true;
            if (c == 0x31) sep = i;
        }
        if (lower && upper) return (ENC_NONE, hrp, data);
        if (sep == type(uint256).max || sep == 0 || sep + 7 > n) return (ENC_NONE, hrp, data);

        hrp = new bytes(sep);
        uint32 chk = 1;
        for (uint256 i; i < sep; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 65 && c <= 90) c += 32;
            hrp[i] = bytes1(c);
            chk = _polymodStep(chk, uint32(c >> 5));
        }
        chk = _polymodStep(chk, 0);
        for (uint256 i; i < sep; i++) chk = _polymodStep(chk, uint32(uint8(hrp[i]) & 31));

        uint256 dl = n - sep - 1;
        data = new uint8[](dl - 6);
        for (uint256 i; i < dl; i++) {
            uint8 v = uint8(REV[uint8(b[sep + 1 + i])]);
            if (v == 0xff) return (ENC_NONE, hrp, new uint8[](0));
            chk = _polymodStep(chk, v);
            if (i < dl - 6) data[i] = v;
        }
        if (chk == BECH32_CONST) enc = ENC_BECH32;
        else if (chk == BECH32M_CONST) enc = ENC_BECH32M;
        else return (ENC_NONE, hrp, new uint8[](0));
    }

    /// @notice Parse a segwit address (BIP-173 v0 / BIP-350 v1+) for `expectedHrp`. Reverts InvalidSegwit.
    function decodeSegwit(string memory addr, bytes memory expectedHrp)
        internal pure returns (uint8 version, bytes memory program)
    {
        (uint8 enc, bytes memory hrp, uint8[] memory d) = decode(addr);
        if (enc == ENC_NONE || keccak256(hrp) != keccak256(expectedHrp) || d.length < 1) revert InvalidSegwit();
        version = d[0];
        if (version > 16) revert InvalidSegwit();
        if (version == 0 ? enc != ENC_BECH32 : enc != ENC_BECH32M) revert InvalidSegwit();
        // 5 -> 8 bit conversion, no padding allowed beyond 4 zero bits
        program = new bytes(((d.length - 1) * 5) / 8);
        uint256 acc; uint256 bits; uint256 k;
        for (uint256 i = 1; i < d.length; i++) {
            acc = ((acc << 5) | d[i]) & 0xfff;
            bits += 5;
            if (bits >= 8) { bits -= 8; program[k++] = bytes1(uint8(acc >> bits)); }
        }
        if (bits >= 5 || ((acc << (8 - bits)) & 0xff) != 0) revert InvalidSegwit();
        if (program.length < 2 || program.length > 40) revert InvalidSegwit();
        if (version == 0 && program.length != 20 && program.length != 32) revert InvalidSegwit();
    }

    /// @notice Taproot (P2TR, witness v1, 32-byte program) only.
    function decodeTaproot(string memory addr, bytes memory expectedHrp) internal pure returns (bytes32 program) {
        (uint8 v, bytes memory p) = decodeSegwit(addr, expectedHrp);
        if (v != 1 || p.length != 32) revert InvalidSegwit();
        assembly { program := mload(add(p, 32)) }
    }
}
