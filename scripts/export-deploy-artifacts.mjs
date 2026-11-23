#!/usr/bin/env node
// Rebuild config/pack-artifact.json and config/onchain-artifact.json from forge out/.
// Run from the repo root after `forge build` in contracts/.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join('contracts', 'out');
const EIP170 = 24_576;
const EIP3860 = 49_152;

function load(sol, name) {
  const p = path.join(OUT, sol, `${name}.json`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const init = j.bytecode?.object;
  const runtime = j.deployedBytecode?.object;
  if (!init || !runtime) throw new Error(`missing bytecode in ${p}`);
  if (String(init).includes('__$') && name !== 'MultiSeaOnchainDrop' && name !== 'MultiSeaOnchainOmniDrop') {
    throw new Error(`${name} still has unlinked library placeholders`);
  }
  return { abi: j.abi, init, runtime, initBytes: hexBytes(init), runtimeBytes: hexBytes(runtime) };
}

function hexBytes(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2) throw new Error('odd hex length');
  return s.length / 2;
}

function assertFit(name, rec) {
  const problems = [];
  if (rec.runtimeBytes > EIP170) problems.push(`runtime ${rec.runtimeBytes} > ${EIP170}`);
  if (rec.initBytes > EIP3860) problems.push(`initcode ${rec.initBytes} > ${EIP3860}`);
  if (problems.length) throw new Error(`${name} exceeds size limit: ${problems.join(', ')}`);
}

const packs = {
  ops: load('MultiSeaPacksOps.sol', 'MultiSeaPacksOps'),
  pack: load('MultiSeaPacks.sol', 'MultiSeaPacks'),
  card: load('MultiSeaPackCards.sol', 'MultiSeaPackCards'),
  escrow: load('MultiSeaPackEscrow.sol', 'MultiSeaPackEscrow'),
  factory: load('MultiSeaPackFactory.sol', 'MultiSeaPackFactory'),
};
const onchain = {
  art: load('OnchainArt.sol', 'OnchainArt'),
  drop: load('MultiSeaOnchainDrop.sol', 'MultiSeaOnchainDrop'),
  omni: load('MultiSeaOnchainOmniDrop.sol', 'MultiSeaOnchainOmniDrop'),
  factory: load('MultiSeaOnchainFactory.sol', 'MultiSeaOnchainFactory'),
};

for (const [n, r] of Object.entries({ ...packs, ...onchain })) assertFit(n, r);

const artPlaceholder = [...new Set(String(onchain.drop.init).match(/__\$[0-9a-fA-F]+\$__/g) || [])];
const omniPh = [...new Set(String(onchain.omni.init).match(/__\$[0-9a-fA-F]+\$__/g) || [])];
if (artPlaceholder.length !== 1 || omniPh[0] !== artPlaceholder[0]) {
  throw new Error(`expected a single OnchainArt placeholder, drop=${artPlaceholder} omni=${omniPh}`);
}

const packArt = {
  note: 'Compiled MultiSea pack contracts for MC to deploy from /deploy-pack-factories. No keys. Deploy MultiSeaPacksOps first, then MultiSeaPacks(ops) — the packs implementation is a thin delegatecall facade so runtime stays under the EIP-170 24,576-byte cap.',
  opsBytecode: packs.ops.init,
  packBytecode: packs.pack.init,
  cardBytecode: packs.card.init,
  escrowBytecode: packs.escrow.init,
  factoryBytecode: packs.factory.init,
  factoryAbi: packs.factory.abi,
  escrowAbi: packs.escrow.abi,
  sizes: Object.fromEntries(Object.entries(packs).map(([k, v]) => [k, { init: v.initBytes, runtime: v.runtimeBytes }])),
};

const onchainArt = {
  note: 'Compiled MultiSea on-chain art contracts for MC to deploy from /deploy-onchain-factories. Not broadcast by the agent. Existing IPFS factories are unchanged. Deploy the OnchainArt library first, link its address into the drop/omni implementation bytecode, then deploy the implementations and factory. After deploy, record addresses in config/launchpad.json onchainDrops.',
  artLibraryBytecode: onchain.art.init,
  artLibraryPlaceholder: artPlaceholder[0],
  dropBytecode: onchain.drop.init,
  omniBytecode: onchain.omni.init,
  factoryBytecode: onchain.factory.init,
  factoryAbi: onchain.factory.abi,
  sizes: Object.fromEntries(Object.entries(onchain).map(([k, v]) => [k, { init: v.initBytes, runtime: v.runtimeBytes }])),
};

fs.writeFileSync('config/pack-artifact.json', JSON.stringify(packArt, null, 2) + '\n');
fs.writeFileSync('config/onchain-artifact.json', JSON.stringify(onchainArt, null, 2) + '\n');
console.log('wrote config/pack-artifact.json', packArt.sizes);
console.log('wrote config/onchain-artifact.json', onchainArt.sizes);
