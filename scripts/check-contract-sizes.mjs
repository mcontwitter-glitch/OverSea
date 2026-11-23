#!/usr/bin/env node
// Fail if a deployable artifact's runtime exceeds EIP-170 (24,576) or initcode exceeds EIP-3860 (49,152).
// Checks the frontend deploy artifacts and, when present, the matching forge out/ bytecode.
import fs from 'node:fs';
import path from 'node:path';

const EIP170 = 24_576;
const EIP3860 = 49_152;

function hexBytes(h) {
  const s = String(h || '').replace(/^0x/i, '');
  if (!s) return 0;
  if (s.length % 2) throw new Error('odd hex length');
  return s.length / 2;
}

function loadJson(p) {
  if (!fs.existsSync(p)) throw new Error('missing ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const failures = [];
const rows = [];

function check(name, { init, runtime }, src) {
  const initB = hexBytes(init);
  const runB = runtime != null && runtime !== '' ? hexBytes(runtime) : null;
  rows.push({ name, src, init: initB, runtime: runB });
  if (init && initB > EIP3860) failures.push(`${name} (${src}): initcode ${initB} > ${EIP3860}`);
  if (runB != null && runB > EIP170) failures.push(`${name} (${src}): runtime ${runB} > ${EIP170}`);
}

const pack = loadJson('config/pack-artifact.json');
const onchain = loadJson('config/onchain-artifact.json');
const island = loadJson('config/island-wallet-artifact.json');

const packMap = {
  ops: 'opsBytecode',
  pack: 'packBytecode',
  card: 'cardBytecode',
  escrow: 'escrowBytecode',
  factory: 'factoryBytecode',
};
for (const [k, field] of Object.entries(packMap)) {
  const init = pack[field];
  if (!init) failures.push(`pack-artifact.json missing ${field}`);
  else check(`pack.${k}`, { init, runtime: pack.sizes?.[k]?.runtime ? undefined : undefined }, 'pack-artifact.json');
  // init always; runtime from sizes if recorded (bytes, not hex)
  if (pack.sizes?.[k]) {
    const s = pack.sizes[k];
    rows.push({ name: `pack.${k}.sizes`, src: 'pack-artifact.json', init: s.init, runtime: s.runtime });
    if (s.init > EIP3860) failures.push(`pack.${k} sizes.init ${s.init} > ${EIP3860}`);
    if (s.runtime > EIP170) failures.push(`pack.${k} sizes.runtime ${s.runtime} > ${EIP170}`);
    if (s.init !== hexBytes(init)) failures.push(`pack.${k} sizes.init ${s.init} != bytecode ${hexBytes(init)}`);
  }
}

const onchainMap = {
  art: 'artLibraryBytecode',
  drop: 'dropBytecode',
  omni: 'omniBytecode',
  factory: 'factoryBytecode',
};
for (const [k, field] of Object.entries(onchainMap)) {
  const init = onchain[field];
  if (!init) failures.push(`onchain-artifact.json missing ${field}`);
  else check(`onchain.${k}`, { init }, 'onchain-artifact.json');
  if (onchain.sizes?.[k]) {
    const s = onchain.sizes[k];
    rows.push({ name: `onchain.${k}.sizes`, src: 'onchain-artifact.json', init: s.init, runtime: s.runtime });
    if (s.init > EIP3860) failures.push(`onchain.${k} sizes.init ${s.init} > ${EIP3860}`);
    if (s.runtime > EIP170) failures.push(`onchain.${k} sizes.runtime ${s.runtime} > ${EIP170}`);
    if (s.init !== hexBytes(init)) failures.push(`onchain.${k} sizes.init ${s.init} != bytecode ${hexBytes(init)}`);
  }
}
if (!onchain.artLibraryPlaceholder || !String(onchain.dropBytecode || '').includes(onchain.artLibraryPlaceholder)) {
  failures.push('onchain drop bytecode is missing the OnchainArt placeholder (cannot link at deploy)');
}
if (!String(onchain.omniBytecode || '').includes(onchain.artLibraryPlaceholder || '___')) {
  failures.push('onchain omni bytecode is missing the OnchainArt placeholder (cannot link at deploy)');
}

check('island.factory', { init: island.bytecode }, 'island-wallet-artifact.json');

const OUT = path.join('contracts', 'out');
const forgeTargets = [
  ['src/packs/MultiSeaPacksOps.sol', 'MultiSeaPacksOps'],
  ['src/packs/MultiSeaPacks.sol', 'MultiSeaPacks'],
  ['src/packs/MultiSeaPackCards.sol', 'MultiSeaPackCards'],
  ['src/packs/MultiSeaPackEscrow.sol', 'MultiSeaPackEscrow'],
  ['src/packs/MultiSeaPackFactory.sol', 'MultiSeaPackFactory'],
  ['src/onchain/OnchainArt.sol', 'OnchainArt'],
  ['src/onchain/MultiSeaOnchainDrop.sol', 'MultiSeaOnchainDrop'],
  ['src/onchain/MultiSeaOnchainOmniDrop.sol', 'MultiSeaOnchainOmniDrop'],
  ['src/onchain/MultiSeaOnchainFactory.sol', 'MultiSeaOnchainFactory'],
  ['src/island/IslandWalletFactory.sol', 'IslandWalletFactory'],
  ['src/island/IslandWallet.sol', 'IslandWallet'],
];
if (fs.existsSync(OUT)) {
  for (const [sol, name] of forgeTargets) {
    const file = path.join(OUT, path.basename(sol), `${name}.json`);
    if (!fs.existsSync(file)) {
      // Island contracts may live under a slightly different out path
      const alt = path.join(OUT, `${name}.sol`, `${name}.json`);
      const p = fs.existsSync(alt) ? alt : file;
      if (!fs.existsSync(p)) {
        failures.push(`forge out missing for ${name} (${file})`);
        continue;
      }
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      check(name, { init: j.bytecode?.object, runtime: j.deployedBytecode?.object }, p);
      continue;
    }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(name, { init: j.bytecode?.object, runtime: j.deployedBytecode?.object }, file);
  }
}

for (const r of rows) {
  const run = r.runtime == null ? '—' : String(r.runtime);
  const mark = (r.runtime != null && r.runtime > EIP170) || r.init > EIP3860 ? ' FAIL' : '';
  console.log(`${r.name.padEnd(36)} init ${String(r.init).padStart(6)}  runtime ${String(run).padStart(6)}  (${r.src})${mark}`);
}

if (failures.length) {
  console.error('\nContract size check failed:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nAll deployable artifacts are under EIP-170 (24,576 runtime) and EIP-3860 (49,152 initcode).');
