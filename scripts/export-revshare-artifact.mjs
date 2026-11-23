#!/usr/bin/env node
// Rebuild config/revshare-artifact.json from forge out/ (run `forge build` in contracts/ first).
import fs from 'node:fs';
const EIP170 = 24_576, EIP3860 = 49_152;
const load = n => JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8'));
const hb = h => (String(h).length - 2) / 2;
const f = load('RevShareVaultFactory'), v = load('RevShareVault');
const sizes = { factory: { init: hb(f.bytecode.object), runtime: hb(f.deployedBytecode.object) }, vault: { init: hb(v.bytecode.object), runtime: hb(v.deployedBytecode.object) } };
for (const [k, s] of Object.entries(sizes)) if (s.init > EIP3860 || s.runtime > EIP170) throw new Error(`${k} exceeds size limit ${JSON.stringify(s)}`);
const art = {
  note: 'RevShareVaultFactory (deploys the vault implementation in its constructor). MC deploys it per EVM chain from /deploy-revshare-factory; founders then create one EIP-1167 vault per collection per chain from the Founder box. No keys.',
  factoryBytecode: f.bytecode.object, factoryAbi: f.abi, vaultAbi: v.abi, sizes,
};
fs.writeFileSync('config/revshare-artifact.json', JSON.stringify(art, null, 2) + '\n');
console.log('wrote config/revshare-artifact.json', sizes);
