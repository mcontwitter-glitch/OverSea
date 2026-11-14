// GET /activity/<slug>: raw on-chain transfers (with Seaport sale price/currency resolved) of one static collection on
// every chain it is deployed on; the page turns them into Mint / Sent / Sale / Bridged rows (src/activitycore.ts).
// Insight covers Ethereum, Base, Abstract, ApeChain, BNB. Other chains (Robinhood) are listed in `browser`: their only
// RPC with wide eth_getLogs refuses Cloudflare Worker requests (HTTP 403), so the page reads them directly (CORS is open).
// A chain in `failed` errored here; the page reads it itself too.
// Receipts, token symbols and block times are immutable and cached 30 days; the response is cached 60s (20s if a chain failed).
import { makeRpc, annotateSales, escrowSet, isEscrowCopy, PER_CHAIN } from '../../src/activitycore.ts';
const INSIGHT = 'https://insight.thirdweb.com';
const INSIGHT_CHAINS = ['ethereum', 'base', 'abstract', 'apechain', 'bnb'];
const IMMUTABLE = 30 * 86400;

export function makeActivity({ chains, lc, STATIC }) {
  const R = makeRpc(chains); const mem = new Map();
  const kv = {
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      const hit = await caches.default.match(new Request('https://cache.multisea/' + key)).catch(() => null);
      if (!hit) return undefined; const v = await hit.json(); mem.set(key, v); return v;
    },
    async put(key, v) {
      mem.set(key, v); if (mem.size > 20000) mem.clear();
      await caches.default.put(new Request('https://cache.multisea/' + key), new Response(JSON.stringify(v), { headers: { 'cache-control': `public, max-age=${IMMUTABLE}` } })).catch(() => {});
    },
  };
  async function insightTransfers(env, k, contract) {
    const u = new URL(`${INSIGHT}/v1/nfts/transfers/${contract}`);
    for (const [a, b] of Object.entries({ chain_id: chains[k].chainId, limit: PER_CHAIN, metadata: 'false', sort_order: 'desc' })) u.searchParams.set(a, String(b));
    const r = await fetch(u, { headers: { 'x-client-id': env.THIRDWEB_CLIENT_ID || 'db9c090161e29abd52e311fef0d97aea', origin: 'https://multisea.io' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`insight ${k} ${r.status}`);
    const j = await r.json(); const d = j?.data?.data ?? j?.data ?? [];
    return d.map(x => ({ chain: k, contract: lc(contract), id: +x.token_id, from: lc(x.from_address), to: lc(x.to_address), tx: lc(x.transaction_hash), log: +x.log_index || 0, block: +x.block_number, ts: Math.floor(Date.parse(x.block_timestamp) / 1000) }));
  }
  async function build(env, col) {
    const esc = escrowSet(col); const failed = [];
    const deps = col.deployments.filter(d => chains[d.chain]);
    const per = await Promise.all(deps.filter(d => INSIGHT_CHAINS.includes(d.chain)).map(async d => {
      try {
        const rows = (await insightTransfers(env, d.chain, d.address)).filter(r => !isEscrowCopy(r, esc));
        await annotateSales(R, kv, chains, d.chain, rows, esc).catch(e => console.warn('activity sales', col.slug, d.chain, e?.message));
        return rows;
      } catch (e) { failed.push(d.chain); console.warn('activity', col.slug, d.chain, e?.message); return []; }
    }));
    return { slug: col.slug, at: Math.floor(Date.now() / 1000), failed, browser: deps.filter(d => !INSIGHT_CHAINS.includes(d.chain)).map(d => d.chain), raw: per.flat() };
  }
  async function handle(req, env, url, p, M) {
    if (!(M === 'GET' && p[0] === 'activity' && p.length === 2)) return undefined;
    const col = STATIC[p[1]]; if (!col) return { slug: p[1], failed: [], browser: [], raw: [] };
    const key = new Request('https://cache.multisea/act:' + col.slug);
    const hit = await caches.default.match(key); if (hit) return hit.json();
    const v = await build(env, col);
    await caches.default.put(key, new Response(JSON.stringify(v), { headers: { 'cache-control': `public, max-age=${v.failed.length ? 20 : 60}` } }));
    return v;
  }
  return { handle, build };
}
