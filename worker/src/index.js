// multisea API: thin, validated proxy to OpenSea API v2 for buying LIL FOOTS listings.
// OPENSEA_API_KEY is a Worker secret (wrangler secret put) — never in code.
import CFG from '../../config/collections.json';

const OS = 'https://api.opensea.io/api/v2';
const SEAPORT = new Set([CFG.seaport.toLowerCase()]);
// chain key -> {osChain, contracts:Set}
const CHAINS = {};
for (const col of CFG.collections) for (const d of col.deployments) {
  const c = CFG.chains[d.chain]; if (!c?.openseaSlug) continue; // BNB not on OpenSea
  CHAINS[c.openseaSlug] ??= { chainId: c.chainId, contracts: new Set() };
  CHAINS[c.openseaSlug].contracts.add(d.address.toLowerCase());
}
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, ID = /^\d{1,7}$/;

// basic per-IP rate limit (per isolate): 30 req / minute
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60_000); recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 30;
}
function cors(req, env) {
  const o = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { 'access-control-allow-origin': o, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' } : null;
}
const json = (body, status, h) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });
const osFetch = (env, path, init = {}) => fetch(OS + path, { ...init, headers: { 'x-api-key': env.OPENSEA_API_KEY, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } });

const slugCache = new Map();
async function slugFor(env, chain, contract) {
  const k = chain + contract.toLowerCase(); if (slugCache.has(k)) return slugCache.get(k);
  const r = await osFetch(env, `/chain/${chain}/contract/${contract}`); const j = await r.json().catch(() => ({}));
  if (j.collection) slugCache.set(k, j.collection); return j.collection || null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ch = cors(req, env);
    if (req.headers.get('origin') && !ch) return json({ error: 'origin not allowed' }, 403, {});
    const H = ch || {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    if (limited(req.headers.get('cf-connecting-ip') || 'local')) return json({ error: 'rate limited' }, 429, H);
    if (!env.OPENSEA_API_KEY) return json({ error: 'server not configured' }, 503, H);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && parts[0] === 'health') return json({ ok: true, chains: Object.keys(CHAINS) }, 200, H);

      // GET /listings/:chain/:contract/:id -> cheapest live listing (or null)
      if (req.method === 'GET' && parts[0] === 'listings' && parts.length === 4) {
        const [, chain, contract, id] = parts;
        if (!CHAINS[chain] || !ADDR.test(contract) || !CHAINS[chain].contracts.has(contract.toLowerCase()) || !ID.test(id)) return json({ error: 'invalid chain/contract/id' }, 400, H);
        const slug = await slugFor(env, chain, contract);
        if (!slug) return json({ error: 'collection not found on OpenSea' }, 404, H);
        const r = await osFetch(env, `/listings/collection/${slug}/nfts/${id}/best`);
        const j = await r.json().catch(() => ({}));
        if (r.status === 404 || (j.errors && /No listings/i.test(String(j.errors)))) return json({ listing: null }, 200, H);
        if (!r.ok) return json({ error: 'opensea error', status: r.status }, 502, H);
        if (!j.order_hash || (j.status && j.status !== 'ACTIVE')) return json({ listing: null }, 200, H);
        const p = j.protocol_data?.parameters || {};
        const cons = p.consideration || [];
        const offer = p.offer?.[0];
        if (!offer || String(offer.token).toLowerCase() !== contract.toLowerCase()) return json({ listing: null }, 200, H);
        return json({ listing: {
          chain, contract: contract.toLowerCase(), id: Number(id), orderHash: j.order_hash, protocolAddress: j.protocol_address,
          price: j.price?.current, seller: p.offerer, endTime: Number(p.endTime) || null,
          fees: cons.slice(1).map(c => ({ recipient: c.recipient, amount: c.startAmount })),
        } }, 200, H);
      }

      // POST /fulfill {hash, chain, protocolAddress, fulfiller}
      if (req.method === 'POST' && parts[0] === 'fulfill' && parts.length === 1) {
        const b = await req.json().catch(() => null);
        if (!b || !HASH.test(b.hash || '') || !CHAINS[b.chain] || !ADDR.test(b.fulfiller || '') || !SEAPORT.has(String(b.protocolAddress).toLowerCase())) return json({ error: 'invalid input' }, 400, H);
        const r = await osFetch(env, '/listings/fulfillment_data', { method: 'POST', body: JSON.stringify({ listing: { hash: b.hash, chain: b.chain, protocol_address: b.protocolAddress }, fulfiller: { address: b.fulfiller } }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = [].concat(j.errors || j.detail || j.message || []).map(String).join('; ').slice(0, 300);
          const gone = r.status === 404 || /not found|invalid|filled|cancel|expired|no longer/i.test(msg);
          return json({ error: gone ? 'listing no longer valid' : 'opensea refused', message: msg, status: r.status }, gone ? 409 : 422, H);
        }
        const tx = j.fulfillment_data?.transaction;
        // Only allow LIL FOOTS orders and txs to Seaport
        const offer = j.fulfillment_data?.orders?.[0]?.parameters?.offer?.[0];
        if (!tx || !SEAPORT.has(String(tx.to).toLowerCase()) || !offer || !CHAINS[b.chain].contracts.has(String(offer.token).toLowerCase())) return json({ error: 'unexpected fulfillment' }, 422, H);
        return json({ transaction: tx, orders: j.fulfillment_data.orders }, 200, H);
      }
      return json({ error: 'not found' }, 404, H);
    } catch (e) { return json({ error: 'internal', message: String(e).slice(0, 200) }, 500, H); }
  },
};
