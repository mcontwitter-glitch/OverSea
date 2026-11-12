import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const out = await mkdtemp(join(tmpdir(), 'growth-art-'));
try {
 execFileSync('npx', ['tsc', 'src/growthart.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig', '--rewriteRelativeImportExtensions'], { stdio: 'pipe' });
 const { gatewaySvg, WORLD_ID, inheritedAttribution, contractLayeredSvg } = await import('file://' + join(out, 'growthart.js'));
 // Byte-exact against AgentGrowthArt output captured from forge (test/fixtures/contract-layered.json).
 const fx = JSON.parse(readFileSync(new URL('./fixtures/contract-layered.json', import.meta.url), 'utf8'));
 for (const c of fx.cases) assert.equal(contractLayeredSvg(c.base, c.arts), 'data:image/svg+xml;base64,' + Buffer.from(c.svg).toString('base64'), c.test);
 assert.equal(contractLayeredSvg('ipfs://base.png', ['', '']), 'ipfs://base.png');
 const esc = Buffer.from(contractLayeredSvg('ipfs://a?x=1&y="2"<>', ['b']).split(',')[1], 'base64').toString();
 assert(esc.includes('href="ipfs://a?x=1&amp;y=&quot;2&quot;&lt;&gt;"'));
 const meta = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ image: 'data:image/svg+xml,' + encodeURIComponent('<svg><image href="ipfs://base/1.png"/><image href="ipfs://a/1.png"/></svg>') })).toString('base64');
 const decoded = decodeURIComponent(gatewaySvg(meta).split(',')[1]);
 assert(decoded.includes('https://w3s.link/ipfs/base/1.png'));
 assert(decoded.indexOf('base/1.png') < decoded.indexOf('a/1.png'));
 const meta64 = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ image: 'data:image/svg+xml;base64,' + Buffer.from('<svg><image href="ipfs://base.png"/><image href="ipfs://layer.png"/></svg>').toString('base64') })).toString('base64');
 const decoded64 = decodeURIComponent(gatewaySvg(meta64).split(',')[1]);
 assert(decoded64.indexOf('w3s.link/ipfs/base.png') < decoded64.indexOf('w3s.link/ipfs/layer.png'));
 assert.equal(WORLD_ID((1n << 128n) | 42n), '42');
 assert.deepEqual(inheritedAttribution([2,1], [1,3], [2,3]).map(x => x.parent), ['Father','Shared / rolled']);
 console.log('agent growth metadata, gateway conversion, child attribution: exact contract SVG fixtures + 8 assertions passed');
} finally { rm(out, { recursive: true, force: true }); }
