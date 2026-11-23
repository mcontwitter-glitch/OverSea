import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = await mkdtemp(join(tmpdir(), 'rsbadge-'));
try {
  execFileSync('npx', ['tsc', 'src/rsbadge.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig'], { stdio: 'pipe' });
  await rename(join(out, 'rsbadge.js'), join(out, 'rsbadge.mjs'));
  const { revshareEnabled, revshareTip, revshareBadgeHtml, loadRevshareConfig } = await import(join(out, 'rsbadge.mjs'));

  assert.equal(revshareEnabled(null), false);
  assert.equal(revshareEnabled(undefined), false);
  assert.equal(revshareEnabled({}), false);
  assert.equal(revshareEnabled({ enabled: false, feeShareBps: 5000 }), false);
  assert.equal(revshareEnabled({ enabled: true, feeShareBps: 5000 }), true);

  assert.equal(revshareTip({ enabled: true, feeShareBps: 5000, royaltyShareBps: 0 }), "Revenue share on: holders earn 50% of MultiSea's fee");
  assert.equal(revshareTip({ enabled: true, feeShareBps: 2500, royaltyShareBps: 10000 }), "Revenue share on: holders earn 25% of MultiSea's fee and 100% of the creator royalty");

  assert.equal(revshareBadgeHtml('multi-islands', { enabled: false, feeShareBps: 5000 }), '');
  assert.equal(revshareBadgeHtml('multi-islands', null), '');
  const html = revshareBadgeHtml('multi-islands', { enabled: true, feeShareBps: 5000, royaltyShareBps: 10000 });
  assert.match(html, /class="rsbadge"/);
  assert.match(html, /href="\/revenue-share\?c=multi-islands"/);
  assert.match(html, /💰/);
  assert.match(html, /holders earn 50% of MultiSea&#39;s fee and 100% of the creator royalty/);

  const okFetch = async () => new Response(JSON.stringify({ slug: 'demo', config: { enabled: true, feeShareBps: 1000, royaltyShareBps: 0 } }), { status: 200 });
  assert.deepEqual(await loadRevshareConfig('https://api.example', 'demo', okFetch), { enabled: true, feeShareBps: 1000, royaltyShareBps: 0 });
  assert.equal(await loadRevshareConfig('https://api.example', 'demo', async () => new Response('nope', { status: 500 })), null);
  assert.equal(await loadRevshareConfig('https://api.example', 'demo', async () => { throw new Error('network'); }), null);

  console.log('PASS rsbadge: hidden when off/failed, tooltip and link when enabled');
} finally {
  await rm(out, { recursive: true, force: true });
}
