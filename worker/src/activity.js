// GET /activity/<slug>: raw on-chain transfers (with Seaport sale price/currency resolved) of one static collection on
// every chain it is deployed on; the page turns them into Mint / Sent / Sale / Bridged rows (src/activitycore.ts).
// Insight covers Ethereum, Base, Abstract, ApeChain, BNB. Other EVM chains (Robinhood has no Insight indexer) are
// read here with eth_getLogs via fallback RPCs. Those RPCs 403 Cloudflare IPs, so Robinhood (and any other chain
// whose explorer is Blockscout) falls back to the public Blockscout token-transfer API, which is reachable
// without a key. A chain in `failed` or `browser` could not be read here; the page still scans those itself.
// The */5 cron precomputes each static collection into KV ('act:<slug>'). GET serves that snapshot through the
// shared stale-while-revalidate cache (60s fresh / 4 min SWR). Log cursors ('actkv:rl:…') stay in KV so later
// Robinhood scans only cover new blocks. Receipts, token symbols and block times stay in the Cache API (30 days).
import { makeRpc, rpcTransfers, annotateSales, escrowSet, isEscrowCopy, PER_CHAIN } from '../../src/activitycore.ts';
const INSIGHT = 'https://insight.thirdweb.com';
const INSIGHT_CHAINS = ['ethereum', 'base', 'abstract', 'apechain', 'bnb'];
// Blockscout hosts (Robinhood's explorer among them) sit on Cloudflare and need a same-site Referer or
// the edge serves a challenge page (HTTP 403) instead of JSON. No API key.
function blockscoutOrigin(c) {
  const ex = String(c?.explorer || '');
  try { const u = new URL(ex); if (!/\.blockscout\.com$/i.test(u.hostname)) return null; return u.origin; }
  catch { return null; }
}
const IMMUTABLE = 30 * 86400;
export const ACT_TTL = 60, ACT_SWR = 240, ACT_REWRITE_SEC = 1800, ACT_MAX_AGE_SEC = 3 * 3600;

// Bridge-listed collections (KV col: records, see bridgeenrich.js) are served and precomputed the same way via getDyn / listDyn.
export function makeActivity({ chains, lc, STATIC, cached, getDyn = async () => null, listDyn = async () => [] }) {
  const R = makeRpc(chains);

  function makeKv(env) {
    const mem = new Map();
    const cache = globalThis.caches?.default;
    const ck = key => new Request('https://cache.multisea/' + key);
    return {
      async get(key) {
        if (mem.has(key)) return mem.get(key);
        if (key.startsWith('rl:') && env?.COLLECTIONS) {
          const v = await env.COLLECTIONS.get('actkv:' + key, 'json');
          if (v != null) { mem.set(key, v); return v; }
        }
        const hit = await cache?.match(ck(key)).catch(() => null);
        if (!hit) return undefined;
        const v = await hit.json(); mem.set(key, v); return v;
      },
      async put(key, v) {
        mem.set(key, v); if (mem.size > 20000) mem.clear();
        if (key.startsWith('rl:') && env?.COLLECTIONS) await env.COLLECTIONS.put('actkv:' + key, JSON.stringify(v)).catch(() => {});
        await cache?.put(ck(key), new Response(JSON.stringify(v), { headers: { 'cache-control': `public, max-age=${IMMUTABLE}` } })).catch(() => {});
      },
    };
  }

  async function insightTransfers(env, k, contract) {
    const u = new URL(`${INSIGHT}/v1/nfts/transfers/${contract}`);
    for (const [a, b] of Object.entries({ chain_id: chains[k].chainId, limit: PER_CHAIN, metadata: 'false', sort_order: 'desc' })) u.searchParams.set(a, String(b));
    const r = await fetch(u, { headers: { 'x-client-id': env.THIRDWEB_CLIENT_ID || 'db9c090161e29abd52e311fef0d97aea', origin: 'https://multisea.io' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`insight ${k} ${r.status}`);
    const j = await r.json(); const d = j?.data?.data ?? j?.data ?? [];
    return d.map(x => ({ chain: k, contract: lc(contract), id: +x.token_id, from: lc(x.from_address), to: lc(x.to_address), tx: lc(x.transaction_hash), log: +x.log_index || 0, block: +x.block_number, ts: Math.floor(Date.parse(x.block_timestamp) / 1000) }));
  }

  async function blockscoutTransfers(k, contract) {
    const origin = blockscoutOrigin(chains[k]);
    if (!origin) throw new Error('no blockscout for ' + k);
    const headers = {
      accept: 'application/json',
      referer: origin + '/',
      origin,
    };
    const rows = [];
    let path = '/api/v2/tokens/' + contract + '/transfers';
    for (let page = 0; page < 8 && rows.length < PER_CHAIN; page++) {
      const r = await fetch(origin + path, { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('blockscout ' + k + ' ' + r.status);
      const j = await r.json();
      for (const it of j.items || []) {
        const id = Number(it.total?.token_id ?? it.total?.token_instance?.id);
        if (!Number.isFinite(id)) continue;
        rows.push({
          chain: k, contract: lc(contract), id,
          from: lc(it.from?.hash || it.from), to: lc(it.to?.hash || it.to),
          tx: lc(it.transaction_hash), log: Number(it.log_index) || 0,
          block: Number(it.block_number) || 0,
          ts: Math.floor(Date.parse(it.timestamp) / 1000) || 0,
        });
        if (rows.length >= PER_CHAIN) break;
      }
      const n = j.next_page_params;
      if (!n || !(j.items || []).length) break;
      const qs = new URLSearchParams();
      if (n.block_number != null) qs.set('block_number', String(n.block_number));
      if (n.index != null) qs.set('index', String(n.index));
      path = '/api/v2/tokens/' + contract + '/transfers?' + qs.toString();
    }
    return rows;
  }

  async function chainRows(env, kv, esc, d) {
    let rows;
    if (INSIGHT_CHAINS.includes(d.chain)) rows = await insightTransfers(env, d.chain, d.address);
    else {
      try { rows = await rpcTransfers(R, kv, d.chain, d.address); }
      catch (e) {
        if (!blockscoutOrigin(chains[d.chain])) throw e;
        console.warn('activity', d.chain, 'rpc failed, trying blockscout', e?.message);
        rows = await blockscoutTransfers(d.chain, d.address);
      }
    }
    const kept = rows.filter(r => !isEscrowCopy(r, esc));
    await annotateSales(R, kv, chains, d.chain, kept, esc).catch(e => console.warn('activity sales', d.chain, e?.message));
    return kept;
  }

  async function build(env, col) {
    const esc = escrowSet(col); const failed = []; const browser = [];
    const deps = (col.deployments || []).filter(d => chains[d.chain]);
    const kv = makeKv(env);
    const per = await Promise.all(deps.map(async d => {
      try { return await chainRows(env, kv, esc, d); }
      catch (e) {
        console.warn('activity', col.slug, d.chain, e?.message);
        if (INSIGHT_CHAINS.includes(d.chain)) failed.push(d.chain);
        else browser.push(d.chain);
        return [];
      }
    }));
    return { slug: col.slug, at: Math.floor(Date.now() / 1000), failed, browser, raw: per.flat() };
  }

  async function get(env, slug) {
    if (!env?.COLLECTIONS) return null;
    const s = await env.COLLECTIONS.get('act:' + slug, 'json');
    if (!s || Date.now() / 1000 - s.at > ACT_MAX_AGE_SEC) return null;
    return s;
  }

  async function getOrBuild(env, col) {
    const snap = await get(env, col.slug); if (snap) return snap;
    const v = await build(env, col);
    if (env?.COLLECTIONS) await env.COLLECTIONS.put('act:' + col.slug, JSON.stringify(v)).catch(() => {});
    return v;
  }

  async function refreshAll(env) {
    const res = {};
    const targets = { ...Object.fromEntries((await listDyn(env).catch(() => [])).map(c => [c.slug, c])), ...STATIC };
    for (const slug of Object.keys(targets)) {
      try {
        const snap = await build(env, targets[slug]);
        const prev = await env.COLLECTIONS.get('act:' + slug, 'json');
        const same = prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...snap, at: 0 });
        if (same && Date.now() / 1000 - prev.at < ACT_REWRITE_SEC) { res[slug] = 'unchanged'; continue; }
        await env.COLLECTIONS.put('act:' + slug, JSON.stringify(snap));
        await globalThis.caches?.default?.delete(new Request('https://cache.multisea/act:' + slug)).catch(() => {});
        res[slug] = { raw: (snap.raw || []).length, failed: snap.failed, browser: snap.browser };
      } catch (e) { res[slug] = 'error ' + (e?.message || e); }
    }
    return res;
  }

  async function handle(req, env, url, p, M, ctx) {
    if (!(M === 'GET' && p[0] === 'activity' && p.length === 2)) return undefined;
    const col = STATIC[p[1]] || await getDyn(env, p[1]); if (!col) return { slug: p[1], failed: [], browser: [], raw: [] };
    const load = () => getOrBuild(env, col);
    const v = cached ? await cached('act:' + col.slug, ACT_TTL, load, ACT_SWR, ctx) : await load();
    return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ACT_TTL}, stale-while-revalidate=${ACT_SWR}` } });
  }

  return { handle, build, get, getOrBuild, refreshAll };
}
