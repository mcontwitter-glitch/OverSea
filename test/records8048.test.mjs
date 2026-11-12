import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = await mkdtemp(join(tmpdir(), 'records-'));
try {
 execFileSync('npx', ['tsc', 'src/records8048.ts', '--outDir', out, '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', '--skipLibCheck', '--ignoreConfig'], { stdio: 'pipe' });
 const m = await import('file://' + join(out, 'records8048.js'));
 // ERC-8048 / ERC-7930 spec examples
 assert.equal(m.chainIdentifier(1), '0x00010000010100');
 assert.equal(m.chainIdentifier(8453), '0x0001000002210500');
 assert.equal(m.addressKey(8453), 'address[0x0001000002210500]');
 const w = '0x' + 'ab'.repeat(20);
 assert.equal(m.decodeRecord('address[0x0001000002210500]', w), w);
 assert.equal(m.decodeRecord('level', '0x' + '0'.repeat(63) + '2'), 2n);
 assert.equal(m.decodeRecord('alive', '0x' + '0'.repeat(63) + '1'), true);
 assert.equal(m.decodeRecord('skill[Zombie]', '0x' + '0'.repeat(64)), false);
 assert.equal(m.decodeRecord('endpoint[mcp]', '0x' + Buffer.from('https://x/mcp').toString('hex')), 'https://x/mcp');
 assert.equal(m.decodeRecord('context', '0x'), null);
 const keys = m.keysFor(1, ['Background']);
 assert(keys.includes('trait[Background]') && keys.includes('endpoint[x402]') && keys.includes('address[0x00010000010100]'));
 const html = m.recordsHtml({ contract: w, chainId: 8453, values: { context: '<script>x</script>', 'endpoint[web]': 'javascript:alert(1)' } });
 assert(!html.includes('<script>') && !html.includes('href="javascript'));
 console.log('records8048: ERC-7930 spec examples, decoding, escaping: 13 assertions passed');
} finally { rm(out, { recursive: true, force: true }); }
