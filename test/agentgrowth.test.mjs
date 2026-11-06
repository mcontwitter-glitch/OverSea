import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = await mkdtemp(join(tmpdir(), 'growth-art-'));
try {
 execFileSync('npx', ['tsc', 'src/growthart.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig', '--rewriteRelativeImportExtensions'], { stdio: 'pipe' });
 const { gatewaySvg, WORLD_ID, inheritedAttribution } = await import('file://' + join(out, 'growthart.js'));
 const meta = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ image: 'data:image/svg+xml,' + encodeURIComponent('<svg><image href="ipfs://base/1.png"/><image href="ipfs://a/1.png"/></svg>') })).toString('base64');
 const decoded = decodeURIComponent(gatewaySvg(meta).split(',')[1]);
 assert(decoded.includes('https://w3s.link/ipfs/base/1.png'));
 assert(decoded.indexOf('base/1.png') < decoded.indexOf('a/1.png'));
 assert.equal(WORLD_ID((1n << 128n) | 42n), '42');
 assert.deepEqual(inheritedAttribution([2,1], [1,3], [2,3]).map(x => x.parent), ['Father','Shared / rolled']);
 console.log('agent growth metadata, gateway conversion, child attribution: 4 assertions passed');
} finally { rm(out, { recursive: true, force: true }); }
