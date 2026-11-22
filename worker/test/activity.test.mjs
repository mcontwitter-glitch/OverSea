// Collection activity snapshot: KV + SWR serve path, Robinhood getLogs on the Worker, Solana RPC allowlist.
// Run: node --test test/activity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeActivity, ACT_MAX_AGE_SEC, ACT_REWRITE_SEC } from '../src/activity.js';
import { solAllowed, SOL_READ } from '../src/solrpc.js';
import { CORS_ALLOW_HEADERS, corsHeaders } from '../src/cors.js';
import { assemble, escrowSet, PER_CHAIN } from '../../src/activitycore.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const lc = s => String(s || '').toLowerCase();
const word = (n, hex) => (typeof hex === 'string' ? hex.replace(/^0x/, '').padStart(64, '0') : BigInt(n).toString(16).padStart(64, '0'));
const topicAddr = a => '0x' + word(0, a);
const topicId = id => '0x' + word(id);
function log(id, from, to, tx, block, logIndex) {
  return {
    topics: [T_TRANSFER, topicAddr(from), topicAddr(to), topicId(id)],
    transactionHash: tx, logIndex: '0x' + Number(logIndex).toString(16),
    blockNumber: '0x' + Number(block).toString(16),
  };
}

function memoryKv() {
  const m = new Map();
  return {
    get: async (k, t) => { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    map: m,
  };
}

const chains = {
  base: { name: 'Base', chainId: 8453, rpc: 'https://base.example', native: 'ETH' },
  robinhood: {
    name: 'Robinhood', chainId: 2020, rpc: 'https://rh-forbidden.example',
    rpcs: ['https://rh-forbidden.example', 'https://rh-ok.example'], native: 'ETH',
  },
};
const COL = {
  slug: 'islands', idStart: 1, idEnd: 10,
  deployments: [
    { chain: 'base', address: '0x' + 'aa'.repeat(20) },
    { chain: 'robinhood', address: '0x' + 'bb'.repeat(20) },
  ],
  escrow: [],
};

function stubFetch(plan) {
  return async (u, init) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : null;
    const method = body?.method || (Array.isArray(body) ? 'batch' : 'GET');
    const key = method === 'GET' ? 'GET ' + url : method + ' ' + new URL(url).origin;
    const p = plan[key] || plan[url];
    if (!p) throw new Error('unexpected fetch ' + key);
    p.calls = (p.calls || 0) + 1;
    if (typeof p.res === 'function') return p.res(body, url);
    return json(p.res, p.status || 200);
  };
}

test('assemble turns mint + transfer + escrow lock/unlock into activity rows', () => {
  const escAddr = '0x' + 'ee'.repeat(20);
  const col = { escrow: [{ chain: 'base', address: escAddr }, { chain: 'robinhood', address: escAddr }] };
  const esc = escrowSet(col);
  const raw = [
    { chain: 'base', contract: '0xaa', id: 1, from: ZERO, to: '0x' + '11'.repeat(20), tx: '0x1', log: 0, block: 10, ts: 1000 },
    { chain: 'base', contract: '0xaa', id: 1, from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), tx: '0x2', log: 0, block: 11, ts: 1100, sale: { price: 0.5, currency: 'ETH' } },
    { chain: 'base', contract: '0xaa', id: 2, from: '0x' + '11'.repeat(20), to: escAddr, tx: '0x3', log: 0, block: 12, ts: 1200 },
    { chain: 'robinhood', contract: '0xbb', id: 2, from: escAddr, to: '0x' + '33'.repeat(20), tx: '0x4', log: 0, block: 20, ts: 1300 },
  ];
  const rows = assemble(raw, esc);
  const types = rows.map(r => r.type);
  assert.ok(types.includes('mint'));
  assert.ok(types.includes('sale'));
  assert.ok(types.includes('bridge'));
  const sale = rows.find(r => r.type === 'sale');
  assert.equal(sale.price, 0.5);
  const br = rows.find(r => r.type === 'bridge');
  assert.equal(br.chain, 'base'); assert.equal(br.chain2, 'robinhood'); assert.equal(br.id, 2);
});

test('solAllowed permits collection-page reads and rejects sends / unknown methods', () => {
  assert.equal(solAllowed([{ method: 'getAccountInfo', id: 1 }]), null);
  assert.equal(solAllowed([{ method: 'getMultipleAccounts', id: 1 }]), null);
  assert.ok(SOL_READ.has('getBalance'));
  assert.match(solAllowed([{ method: 'sendTransaction' }]), /method not allowed/);
  assert.match(solAllowed([]), /bad batch/);
  assert.match(solAllowed(null), /bad batch/);
});

test('activity.get serves a fresh KV snapshot and hides one that is missing or too old', async () => {
  const kv = memoryKv();
  const A = makeActivity({ chains, lc, STATIC: { islands: COL } });
  const env = { COLLECTIONS: kv };
  assert.equal(await A.get(env, 'islands'), null);
  kv.map.set('act:islands', JSON.stringify({ slug: 'islands', at: Math.floor(Date.now() / 1000), failed: [], browser: [], raw: [{ id: 1 }] }));
  const hit = await A.get(env, 'islands');
  assert.equal(hit.raw[0].id, 1);
  kv.map.set('act:islands', JSON.stringify({ slug: 'islands', at: Math.floor(Date.now() / 1000) - ACT_MAX_AGE_SEC - 10, failed: [], browser: [], raw: [] }));
  assert.equal(await A.get(env, 'islands'), null);
  assert.equal(await A.get(env, 'unknown'), null);
});

test('build reads Insight chains and Robinhood getLogs on the Worker (no browser fallback)', async () => {
  const prev = globalThis.fetch;
  const plan = {};
  const rhHead = 25_000_000;
  const rhLogs = [log(3, '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0xabc', rhHead - 10, 1)];
  globalThis.fetch = stubFetch({
    ['GET ' + `https://insight.thirdweb.com/v1/nfts/transfers/${COL.deployments[0].address}?chain_id=8453&limit=${PER_CHAIN}&metadata=false&sort_order=desc`]: {
      res: { data: { data: [{ token_id: '1', from_address: ZERO, to_address: '0x' + '11'.repeat(20), transaction_hash: '0xaaa', log_index: 0, block_number: 99, block_timestamp: '2026-01-01T00:00:00.000Z' }] } },
    },
    'eth_blockNumber https://rh-forbidden.example': { res: {}, status: 403 },
    'eth_getLogs https://rh-forbidden.example': { res: {}, status: 403 },
    'eth_blockNumber https://rh-ok.example': { res: { result: '0x' + rhHead.toString(16) } },
    'eth_getLogs https://rh-ok.example': { res: { result: rhLogs } },
    'batch https://rh-ok.example': { res: (body) => json(body.map(c => ({ jsonrpc: '2.0', id: c.id, result: { timestamp: '0x' + (1_700_000_000).toString(16) } }))) },
  });
  // makeRpc posts to the RPC URL; keys above use method + origin. Hook a smarter stub:
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url.startsWith('https://insight.thirdweb.com')) {
      return json({ data: { data: [{ token_id: '1', from_address: ZERO, to_address: '0x' + '11'.repeat(20), transaction_hash: '0xaaa', log_index: 0, block_number: 99, block_timestamp: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url === 'https://rh-forbidden.example') return new Response('no', { status: 403 });
    if (url === 'https://rh-ok.example') {
      if (Array.isArray(body)) {
        return json(body.map(c => ({ jsonrpc: '2.0', id: c.id, result: { timestamp: '0x' + (1_700_000_000).toString(16) } })));
      }
      if (body?.method === 'eth_blockNumber') return json({ result: '0x' + rhHead.toString(16) });
      if (body?.method === 'eth_getLogs') return json({ result: rhLogs });
      if (body?.method === 'eth_getTransactionReceipt') return json({ result: { logs: [] } });
    }
    throw new Error('unexpected fetch ' + url + ' ' + (body?.method || ''));
  };
  try {
    const kv = memoryKv();
    const A = makeActivity({ chains, lc, STATIC: { islands: COL } });
    const snap = await A.build({ COLLECTIONS: kv, THIRDWEB_CLIENT_ID: 'test' }, COL);
    assert.equal(snap.slug, 'islands');
    assert.deepEqual(snap.failed, []);
    assert.deepEqual(snap.browser, []);
    assert.ok(snap.raw.some(r => r.chain === 'base' && r.id === 1));
    assert.ok(snap.raw.some(r => r.chain === 'robinhood' && r.id === 3));
    assert.ok(kv.map.has('actkv:rl:robinhood:' + COL.deployments[1].address.toLowerCase()), 'log cursor persisted');
  } finally { globalThis.fetch = prev; }
});

test('refreshAll writes act:<slug> and getOrBuild returns it without rebuilding', async () => {
  const prev = globalThis.fetch;
  let insightCalls = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.startsWith('https://insight.thirdweb.com')) {
      insightCalls++;
      return json({ data: { data: [{ token_id: '7', from_address: ZERO, to_address: '0x' + '11'.repeat(20), transaction_hash: '0xbbb', log_index: 0, block_number: 1, block_timestamp: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url.includes('rh-forbidden')) return new Response('no', { status: 403 });
    if (url.includes('rh-ok')) {
      return json({ result: '0x1' }); // blockNumber; getLogs will get a string and fail or empty
    }
    throw new Error('unexpected ' + url);
  };
  // For this test use a base-only collection so we don't need a full Robinhood scan.
  const onlyBase = { ...COL, deployments: [COL.deployments[0]] };
  try {
    const kv = memoryKv();
    const A = makeActivity({ chains, lc, STATIC: { islands: onlyBase } });
    const env = { COLLECTIONS: kv, THIRDWEB_CLIENT_ID: 'test' };
    const r = await A.refreshAll(env);
    assert.equal(r.islands.raw, 1);
    assert.equal(insightCalls, 1);
    const got = await A.get(env, 'islands');
    assert.equal(got.raw[0].id, 7);
    const again = await A.getOrBuild(env, onlyBase);
    assert.equal(again.raw[0].id, 7);
    assert.equal(insightCalls, 1, 'getOrBuild used the KV snapshot, no second Insight call');
  } finally { globalThis.fetch = prev; }
});

test('refreshAll skips an unchanged snapshot younger than the rewrite window', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).startsWith('https://insight.thirdweb.com')) {
      return json({ data: { data: [] } });
    }
    throw new Error('unexpected ' + u);
  };
  const onlyBase = { ...COL, deployments: [COL.deployments[0]] };
  try {
    const kv = memoryKv();
    const A = makeActivity({ chains, lc, STATIC: { islands: onlyBase } });
    const env = { COLLECTIONS: kv, THIRDWEB_CLIENT_ID: 'test' };
    const first = await A.refreshAll(env);
    assert.equal(first.islands.raw, 0);
    const second = await A.refreshAll(env);
    assert.equal(second.islands, 'unchanged');
    assert.ok(ACT_REWRITE_SEC > 0);
  } finally { globalThis.fetch = prev; }
});

test('handle serves the snapshot as JSON (or empty raw for an unknown slug)', async () => {
  const kv = memoryKv();
  const snap = { slug: 'islands', at: Math.floor(Date.now() / 1000), failed: [], browser: [], raw: [{ id: 9, chain: 'base' }] };
  kv.map.set('act:islands', JSON.stringify(snap));
  const A = makeActivity({ chains, lc, STATIC: { islands: COL } });
  const miss = await A.handle(new Request('https://api.multisea.io/activity/nope'), { COLLECTIONS: kv }, new URL('https://api.multisea.io/activity/nope'), ['activity', 'nope'], 'GET');
  assert.deepEqual(miss, { slug: 'nope', failed: [], browser: [], raw: [] });
  const res = await A.handle(new Request('https://api.multisea.io/activity/islands'), { COLLECTIONS: kv }, new URL('https://api.multisea.io/activity/islands'), ['activity', 'islands'], 'GET');
  assert.ok(res instanceof Response);
  const body = await res.json();
  assert.equal(body.raw[0].id, 9);
  assert.match(res.headers.get('cache-control') || '', /stale-while-revalidate/);
});


test('CORS allows the solana-client preflight header @solana/web3.js sends', () => {
  assert.match(CORS_ALLOW_HEADERS, /solana-client/);
  assert.match(CORS_ALLOW_HEADERS, /content-type/);
  const env = { ALLOWED_ORIGINS: 'https://multisea.io' };
  const h = corsHeaders(new Request('https://api.multisea.io/rpc/solana', { headers: { origin: 'https://multisea.io' } }), env);
  assert.ok(h);
  assert.equal(h['access-control-allow-origin'], 'https://multisea.io');
  assert.match(h['access-control-allow-headers'], /solana-client/);
  assert.match(h['access-control-allow-methods'], /POST/);
  const local = corsHeaders(new Request('https://api.multisea.io/rpc/solana', { headers: { origin: 'http://127.0.0.1:4173' } }), env);
  assert.equal(local['access-control-allow-origin'], 'http://127.0.0.1:4173');
  assert.equal(corsHeaders(new Request('https://api.multisea.io/rpc/solana', { headers: { origin: 'https://evil.example' } }), env), null);
});

test('build falls back to Blockscout token transfers when every Robinhood RPC returns 403', async () => {
  const prev = globalThis.fetch;
  const addr = COL.deployments[1].address;
  const col = { ...COL };
  const chainsBs = {
    ...chains,
    robinhood: { ...chains.robinhood, explorer: 'https://robinhoodchain.blockscout.com' },
  };
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    if (url.startsWith('https://insight.thirdweb.com')) {
      return json({ data: { data: [{ token_id: '1', from_address: ZERO, to_address: '0x' + '11'.repeat(20), transaction_hash: '0xaaa', log_index: 0, block_number: 99, block_timestamp: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url.includes('rh-forbidden') || url.includes('rh-ok')) return new Response('no', { status: 403 });
    if (url.startsWith('https://robinhoodchain.blockscout.com/api/v2/tokens/')) {
      const ref = init?.headers?.referer || init?.headers?.Referer;
      assert.match(String(ref || ''), /robinhoodchain\.blockscout\.com/);
      return json({
        items: [{
          block_number: 118423464, log_index: 22, timestamp: '2026-11-19T18:18:10.000000Z',
          transaction_hash: '0xccc',
          from: { hash: '0x' + '11'.repeat(20) },
          to: { hash: '0x' + '22'.repeat(20) },
          total: { token_id: '11' },
        }],
        next_page_params: null,
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const kv = memoryKv();
    const A = makeActivity({ chains: chainsBs, lc, STATIC: { islands: col } });
    const snap = await A.build({ COLLECTIONS: kv, THIRDWEB_CLIENT_ID: 'test' }, col);
    assert.deepEqual(snap.failed, []);
    assert.deepEqual(snap.browser, []);
    assert.ok(snap.raw.some(r => r.chain === 'base' && r.id === 1));
    const rh = snap.raw.find(r => r.chain === 'robinhood' && r.id === 11);
    assert.ok(rh, 'robinhood transfer came from Blockscout');
    assert.equal(rh.tx, '0xccc');
    assert.equal(rh.block, 118423464);
    assert.ok(rh.ts > 1_700_000_000);
  } finally { globalThis.fetch = prev; }
});
