// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MultiSeaChainBadges: rare free mint for wallets that completed all 5 MultiSea chain quests.
/// @notice The MultiSea Worker signs an EIP-712 MintPass(to, deadline) once a wallet holds all 5 chain badges.
///         One mint per wallet, capped supply, free (gas only). Not deployed to mainnet.
contract MultiSeaChainBadges is ERC721, Ownable, EIP712 {
    bytes32 public constant MINTPASS_TYPEHASH = keccak256("MintPass(address to,uint256 deadline)");
    address public signer;
    uint256 public immutable maxSupply;
    uint256 public totalMinted;
    string private baseURI;
    mapping(address => bool) public minted;

    event SignerChanged(address signer);
    error Expired();
    error BadSignature();
    error AlreadyMinted();
    error SoldOut();

    constructor(address _signer, uint256 _maxSupply, string memory _baseURI, address _owner)
        ERC721("MultiSea Chain Voyager", "VOYAGER") Ownable(_owner) EIP712("MultiSeaChainBadges", "1")
    { signer = _signer; maxSupply = _maxSupply; baseURI = _baseURI; emit SignerChanged(_signer); }

    function mint(uint256 deadline, bytes calldata signature) external returns (uint256 id) {
        if (block.timestamp > deadline) revert Expired();
        if (minted[msg.sender]) revert AlreadyMinted();
        if (totalMinted >= maxSupply) revert SoldOut();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(MINTPASS_TYPEHASH, msg.sender, deadline)));
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || rec != signer || rec == address(0)) revert BadSignature();
        minted[msg.sender] = true;
        id = ++totalMinted;
        _safeMint(msg.sender, id);
    }

    function setSigner(address s) external onlyOwner { signer = s; emit SignerChanged(s); }
    function setBaseURI(string calldata u) external onlyOwner { baseURI = u; }
    function domainSeparator() external view returns (bytes32) { return _domainSeparatorV4(); }
    function _baseURI() internal view override returns (string memory) { return baseURI; }
}
