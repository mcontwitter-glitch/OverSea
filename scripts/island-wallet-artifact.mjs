// Writes config/island-wallet-artifact.json (factory creation code + ABIs + predicted addresses) from the Foundry build.
// Run after `forge build` in contracts/. Any change to src/island/*.sol changes the bytecode and so the address.
import fs from 'node:fs';
import { concat, encodeAbiParameters, getContractAddress, keccak256, toBytes } from 'viem';
const out = n => JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8'));
const F = out('IslandWalletFactory'), W = out('IslandWallet');
const create2Factory = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const owner = '0xb19F00e095B1387061d73751C772bbA848D196b1';
const salt = keccak256(toBytes('MultiSea.IslandWalletFactory.v1'));
const init = concat([F.bytecode.object, encodeAbiParameters([{ type: 'address' }], [owner])]);
const factory = getContractAddress({ opcode: 'CREATE2', from: create2Factory, salt, bytecode: init });
const implementation = getContractAddress({ opcode: 'CREATE', from: factory, nonce: 1n });
const saltTag = keccak256(toBytes('multi-islands'));
const walletOf = id => getContractAddress({ opcode: 'CREATE2', from: factory, salt: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [saltTag, BigInt(id)])), bytecode: concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']) });
const art = { _note: 'IslandWalletFactory (contracts/src/island). Deployed by MC from /deploy-island-wallets through the deterministic deployer; same address on all 5 chains.', create2Factory, owner, salt, factory, implementation, saltTag, wallet31: walletOf(31), initCodeHash: keccak256(init), factoryAbi: F.abi, walletAbi: W.abi, bytecode: F.bytecode.object };
fs.writeFileSync('config/island-wallet-artifact.json', JSON.stringify(art));
fs.writeFileSync('config/island-wallet.json', JSON.stringify({ _note: art._note, factory, implementation, saltTag, wallet31: art.wallet31 }, null, 1) + '\n');
console.log({ factory, implementation, wallet31: art.wallet31, bytes: (F.bytecode.object.length - 2) / 2 });
