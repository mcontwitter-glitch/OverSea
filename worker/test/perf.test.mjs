// Perf helpers: hedged RPC, owner multicall codec + snapshot, rpc read cache, edge TTLs. Run: node --test test/perf.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcRace } from '../src/rpcrace.js';
import { encodeOwnerOfBatch, decodeAggregate3, ownersOnChain, packOwners, makeOwners } from '../src/owners.js';
import { rpcCacheTtl, rpcCacheKey } from '../src/rpccache.js';
import { edgeTtl } from '../src/flood.js';
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';

const MC = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
const OWN = parseAbi(['function ownerOf(uint256) view returns (address)']);
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// fetch stub: per-URL delay + response, honours AbortSignal
const stub = plan => async (u, init) => {
  const p = plan[u]; p.calls = (p.calls || 0) + 1;
  await new Promise((res, rej) => { const t = setTimeout(res, p.ms); init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
  return typeof p.res === 'function' ? p.res() : json(p.res, p.status);
};

test('rpcRace hedges to the next RPC when the first is slow, and returns the first good answer', async () => {
  const plan = { a: { ms: 2000, res: { result: 'slow' } }, b: { ms: 50, res: { result: 'fast' } } };
  const t = Date.now(); const out = await rpcRace(['a', 'b'], { id: 1 }, { hedgeMs: 100, timeoutMs: 3000, fetchImpl: stub(plan) });
  assert.equal(out.result, 'fast'); assert.ok(Date.now() - t < 600, 'answered via hedge');
});

test('rpcRace moves on immediately after an error / rate limit and fails after all rounds', async () => {
  const plan = { a: { ms: 5, res: { error: { code: -32005, message: 'rate limited' } } }, b: { ms: 5, res: {}, status: 503 }, c: { ms: 5, res: { result: 'ok' } } };
  assert.equal((await rpcRace(['a', 'b', 'c'], {}, { hedgeMs: 1000, fetchImpl: stub(plan) })).result, 'ok');
  const bad = { a: { ms: 5, res: {}, status: 500 } };
  await assert.rejects(rpcRace(['a'], {}, { hedgeMs: 1000, rounds: 2, fetchImpl: stub(bad) }), /HTTP 500/); assert.equal(bad.a.calls, 2);
});

test('rpcRace times out a hung RPC', async () => {
  const plan = { a: { ms: 10_000, res: { result: 'never' } } };
  const t = Date.now(); await assert.rejects(rpcRace(['a'], {}, { hedgeMs: 50, timeoutMs: 150, rounds: 1, fetchImpl: stub(plan) }), /timeout/); assert.ok(Date.now() - t < 1000);
});

test('aggregate3 ownerOf calldata matches viem; result decoding matches viem encoding', () => {
  const tok = '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e', ids = [1, 2, 4404, 99999];
  const ref = encodeFunctionData({ abi: MC, functionName: 'aggregate3', args: [ids.map(i => ({ target: tok, allowFailure: true, callData: encodeFunctionData({ abi: OWN, functionName: 'ownerOf', args: [BigInt(i)] }) }))] });
  assert.equal(encodeOwnerOfBatch(tok, ids).toLowerCase(), ref.toLowerCase());
  const owner = '0x00000000000000000000000000000000000000aa';
  const res = encodeFunctionResult({ abi: MC, functionName: 'aggregate3', result: [{ success: true, returnData: '0x' + owner.slice(2).padStart(64, '0') }, { success: false, returnData: '0x08c379a0' }] });
  const d = decodeAggregate3(res); assert.equal(d.length, 2); assert.equal(d[0].ok, true); assert.equal('0x' + d[0].data.slice(24), owner); assert.equal(d[1].ok, false);
});

test('ownersOnChain chunks ids, skips reverted/zero owners and packs a compact snapshot', async () => {
  const a1 = '0x' + '11'.repeat(20), a2 = '0x' + '22'.repeat(20); let calls = 0;
  const race = async (urls, payload) => {
    calls++; const data = payload.params[0].data; const n = parseInt(data.slice(10 + 64, 10 + 128), 16);
    const ids = Array.from({ length: n }, (_, i) => parseInt(data.slice(10 + 128 + n * 64 + i * 384 + 256 + 8, 10 + 128 + n * 64 + i * 384 + 256 + 8 + 64), 16));
    return { result: encodeFunctionResult({ abi: MC, functionName: 'aggregate3', result: ids.map(id => id % 3 === 0 ? { success: false, returnData: '0x' } : { success: true, returnData: '0x' + (id % 2 ? a1 : a2).slice(2).padStart(64, '0') }) }) };
  };
  const ids = Array.from({ length: 450 }, (_, i) => i + 1);
  const m = await ownersOnChain(['x'], '0x' + 'ab'.repeat(20), ids, { race });
  assert.equal(calls, 3); assert.equal(m.get(1), a1); assert.equal(m.get(2), a2); assert.equal(m.has(3), false); assert.equal(m.size, 300);
  const snap = packOwners('demo', 1, 450, { base: { address: '0xAB', map: m } }, ['bnb'], 123);
  assert.deepEqual(snap.addrs.sort(), [a1, a2].sort()); assert.equal(snap.chains.base.o.length, 450); assert.equal(snap.chains.base.o[2], -1);
  assert.deepEqual(snap.failed, ['bnb']); assert.equal(snap.chains.base.address, '0xab');
});

test('owners.get serves a fresh snapshot and hides one that is missing or too old', async () => {
  const kv = new Map(); const env = { COLLECTIONS: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null) } };
  const O = makeOwners({ chains: {}, STATIC: { demo: { idStart: 1, idEnd: 2 } }, getCollection: async () => null, lc: s => s.toLowerCase() });
  assert.equal(await O.get(env, 'demo'), null);
  kv.set('owners:demo', JSON.stringify({ v: 1, at: Date.now(), addrs: [], chains: {} })); assert.ok(await O.get(env, 'demo'));
  kv.set('owners:demo', JSON.stringify({ v: 1, at: Date.now() - 4 * 3600_000, addrs: [], chains: {} })); assert.equal(await O.get(env, 'demo'), null);
  assert.equal(await O.get(env, 'not-static'), null);
});

test('rpc read cache: only plain latest eth_calls of known view selectors', async () => {
  const to = '0x' + '12'.repeat(20);
  assert.equal(rpcCacheTtl({ method: 'eth_call', params: [{ to, data: '0xb76b8ced' }, 'latest'] }), 60); // phases()
  assert.equal(rpcCacheTtl({ method: 'eth_call', params: [{ to, data: '0x18160ddd' }] }), 15); // totalSupply()
  assert.equal(rpcCacheTtl({ method: 'eth_call', params: [{ to, data: '0x70a08231' + '0'.repeat(64) }, 'latest'] }), 0); // balanceOf: not cached
  assert.equal(rpcCacheTtl({ method: 'eth_call', params: [{ to, data: '0xb76b8ced', from: to }, 'latest'] }), 0);
  assert.equal(rpcCacheTtl({ method: 'eth_call', params: [{ to, data: '0xb76b8ced' }, '0x10'] }), 0);
  assert.equal(rpcCacheTtl({ method: 'eth_getBalance', params: [to, 'latest'] }), 0);
  const k1 = await rpcCacheKey('base', { params: [{ to, data: '0xb76b8ced' }] }), k2 = await rpcCacheKey('bnb', { params: [{ to, data: '0xb76b8ced' }] });
  assert.match(k1, /^rpc:[0-9a-f]{64}$/); assert.notEqual(k1, k2);
});

test('edge TTLs for the owner snapshot and the ord inscription proxy', () => {
  const get = p => edgeTtl(new URL('https://api.multisea.io' + p), { method: 'GET' });
  assert.equal(get('/owners/lil-foots'), 60);
  assert.equal(get('/btc/ord/mainnet/r/inscription/' + 'a'.repeat(64) + 'i0'), 60);
  assert.equal(get('/btc/ord/mainnet/r/inscription/nope'), 0);
});
