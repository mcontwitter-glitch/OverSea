// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { ICopyNFT } from "./MultiSeaCopyEscrow.sol";

/// @title BatchMinter
/// @notice Owner-only helper that batches mintWithURI calls (e.g. a Base airdrop). Needs MINTER_ROLE on the copy
///         contract; revoke it when done.
contract BatchMinter {
    using Strings for uint256;
    address public immutable owner;
    error NotOwner();
    error LengthMismatch();
    constructor(address _owner) { owner = _owner; }

    function mintBatch(ICopyNFT nft, address[] calldata to, uint256[] calldata ids, string calldata base) external {
        if (msg.sender != owner) revert NotOwner();
        if (to.length != ids.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) nft.mintWithURI(to[i], ids[i], string.concat(base, ids[i].toString()));
    }
}
