import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = await mkdtemp(join(tmpdir(), 'holders-'));
try {
  execFileSync('npx', ['tsc', 'src/holdersmerge.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig'], { stdio: 'pipe' });
  await rename(join(out, 'holdersmerge.js'), join(out, 'holdersmerge.mjs'));
  const { mergeHolders, mergedAway } = await import(join(out, 'holdersmerge.mjs'));
  const P = '0x' + 'a'.repeat(40), W2 = '0x' + 'B'.repeat(40), W3 = '0x' + 'c'.repeat(40), X = '0x' + 'd'.repeat(40), SOL = 'HeD3GA1aRCZpG1sLQP4heqh8PHyAramxCuqpY39yZkvf';
  const locs = [
    { chain: 'base', owner: P }, { chain: 'robinhood', owner: W2 }, { chain: 'robinhood', owner: W2 },
    { chain: 'ethereum', owner: W3, also: [{ chain: 'solana', owner: SOL }] }, { chain: 'base', owner: X }, { chain: 'base', owner: X }, { chain: 'base', owner: X },
  ];
  const map = { [P]: P, [W2.toLowerCase()]: P, [W3]: P, [SOL]: P };
  // unmerged: 5 wallet holders
  assert.equal(mergeHolders(locs).length, 5);
  const rows = mergeHolders(locs, map);
  assert.equal(rows.length, 2, 'profile wallets merged into one holder');
  const [k, h] = rows[0];
  assert.equal(k, P); assert.equal(h.n, 5); assert.deepEqual([...h.chains].sort(), ['base', 'ethereum', 'robinhood', 'solana']); assert.equal(h.wallets.size, 4);
  assert.equal(rows[1][0], X); assert.equal(rows[1][1].n, 3);
  assert.equal(mergedAway(locs, map), 3, 'Owners stat drops by 3');
  // chain filter: only robinhood -> the merged row shows the linked wallet under the profile
  const rh = mergeHolders(locs, map, new Set(['robinhood']));
  assert.deepEqual(rh.map(r => [r[0], r[1].n]), [[P, 2]]);
  // profile wallet holding nothing itself still heads the row
  const r2 = mergeHolders([{ chain: 'base', owner: W3 }], { [W3]: P }); assert.equal(r2[0][0], P);
  console.log('PASS holders merge: linked wallets -> one row, counts summed, chains combined, owner count reduced, chain filter');
} finally { await rm(out, { recursive: true, force: true }); }
