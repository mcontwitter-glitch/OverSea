// MultiSea API (Cloudflare Worker).
// - OpenSea proxy for buying (fulfillment_data) + per-collection live data with caching
// - SIWE (EIP-4361) auth, collection submissions (pending queue), admin approve/reject, owner edits
// - Media uploads to R2 (images only, <=2MB; re-encoded to WebP client-side, validated here)
// Secrets: OPENSEA_API_KEY (wrangler secret put). Never in code.
import CFG from '../../config/collections.json';
import { verifyMessage, createPublicClient, http, getContractAddress, concat, encodeAbiParameters } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { makeNative, NATIVE_FEE_BPS } from './native.js';
import { makeGrowth } from './growth.js';

const OS = 'https://api.opensea.io/api/v2';
const SEAPORT = new Set([CFG.seaport.toLowerCase()]);
const ERC721_IFACE = '0x80ac58cd';
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, ID = /^\d{1,9}$/, SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'submit', 'api', 'c', 'new', 'edit', 'static']);
const chains = CFG.chains; // key -> {chainId, rpc, openseaSlug, ...}
const osToKey = Object.fromEntries(Object.entries(chains).filter(([, c]) => c.openseaSlug).map(([k, c]) => [c.openseaSlug, k]));
const STATIC = Object.fromEntries(CFG.collections.map(c => [c.slug, c]));
const lc = s => String(s || '').toLowerCase();

// ---------- helpers ----------
const hits = new Map();
function limited(ip, max = 60) {
  const now = Date.now(), w = (hits.get(ip) || []).filter(t => now - t < 60_000); w.push(now); hits.set(ip, w);
  if (hits.size > 5000) hits.clear(); return w.length > max;
}
function corsHeaders(req, env) {
  const o = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? { 'access-control-allow-origin': o, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '86400', vary: 'origin' } : null;
}
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
// LIL FOOTS foot wallets (ERC-6551 v0.3.1 registry; account bound to the Base FOOT contract and Base chain id; salt 0).
const FOOT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
const FOOT_REG = '0x000000006551c19487814612e58FE06813775758', FOOT_IMPL = '0x02e9fE944e1604160dac0fF5f35b8cE581D1e9b3', FOOT_BASE = '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e';
const footTba = id => getContractAddress({ opcode: 'CREATE2', from: FOOT_REG, salt: '0x' + '0'.repeat(64), bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', FOOT_IMPL, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], ['0x' + '0'.repeat(64), 8453n, FOOT_BASE, BigInt(id)])]) });
const osFetch = (env, path, init = {}) => fetch(OS + path, { ...init, headers: { 'x-api-key': env.OPENSEA_API_KEY, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } });
async function cached(key, ttl, fn) {
  const cache = caches.default; const req = new Request('https://cache.multisea/' + key);
  const hit = await cache.match(req); if (hit) return hit.json();
  const val = await fn(); await cache.put(req, new Response(JSON.stringify(val), { headers: { 'cache-control': `public, max-age=${ttl}` } })); return val;
}
const RPC_READ = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas', 'net_version']);
// Try each configured RPC in order (2 rounds); an HTTP error, a non-JSON body or a JSON-RPC rate-limit/internal error moves on to the next.
async function rpcFanout(c, payload) {
  const urls = c.rpcs?.length ? c.rpcs : [c.rpc]; let last = 'no rpc';
  for (let round = 0; round < 2; round++) for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      if (!r.ok) { last = u + ' HTTP ' + r.status; continue; }
      const out = await r.json(); const arr = Array.isArray(out) ? out : [out];
      if (arr.some(x => x?.error && (x.error.code === -32005 || x.error.code === -32603 || /rate|limit|capacity|timeout|unavailable/i.test(x.error.message || '')))) { last = u + ' ' + (arr.find(x => x.error).error.message || ''); continue; }
      return out;
    } catch (e) { last = u + ' ' + (e?.message || e); }
  }
  bad('all RPCs failed for ' + c.name + ': ' + last.slice(0, 160), 502);
}
async function rpcCall(chainKey, to, data) {
  const c = chains[chainKey]; if (!c) return null;
  const r = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = await r.json().catch(() => ({})); return j.result || null;
}
async function isERC721(chainKey, address) {
  const res = await rpcCall(chainKey, address, '0x01ffc9a7' + ERC721_IFACE.slice(2).padEnd(64, '0'));
  return !!res && res !== '0x' && BigInt(res) === 1n;
}
async function ownerOfContract(chainKey, address) {
  const res = await rpcCall(chainKey, address, '0x8da5cb5b');
  return res && res.length >= 66 ? '0x' + res.slice(-40).toLowerCase() : null;
}
const admins = env => (env.ADMIN_ADDRESSES || '').split(',').map(lc).filter(Boolean);
const staticEditors = (env, slug) => { try { return (JSON.parse(env.STATIC_EDITORS || '{}')[slug] || []).map(lc); } catch { return []; } };

// ---------- auth (SIWE) ----------
async function session(req, env) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const s = await env.NONCES.get('s:' + t, 'json'); return s?.address ? s : null;
}
async function requireSession(req, env) { const s = await session(req, env); if (!s) bad('sign in with your wallet first', 401); return s; }
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

async function getCollection(env, slug) {
  if (STATIC[slug]) { const ovr = await env.COLLECTIONS.get('ovr:' + slug, 'json'); return { ...publicStatic(STATIC[slug]), ...(ovr || {}), static: true }; }
  return env.COLLECTIONS.get('col:' + slug, 'json');
}
const publicStatic = c => ({ slug: c.slug, name: c.name, description: c.description, deployments: c.deployments.map(d => ({ chain: d.chain, address: d.address })), escrow: c.escrow, status: 'approved' });
async function canEdit(env, slug, address) {
  const a = lc(address); if (!a) return { ok: false };
  if (admins(env).includes(a)) return { ok: true, why: 'admin' };
  if (staticEditors(env, slug).includes(a)) return { ok: true, why: 'collection editor' };
  const col = await getCollection(env, slug); if (!col) return { ok: false };
  if (!col.static && col.status === 'approved' && lc(col.submitter) === a) return { ok: true, why: 'approved submitter' };
  for (const d of col.deployments || []) { if ((await ownerOfContract(d.chain, d.address)) === a) return { ok: true, why: `owner() on ${d.chain}` }; }
  return { ok: false };
}
async function allowedContract(env, osChain, contract) {
  const key = osToKey[osChain]; if (!key) return false; const c = lc(contract);
  for (const col of CFG.collections) if (col.deployments.some(d => d.chain === key && lc(d.address) === c)) return true;
  const idx = await env.COLLECTIONS.get('idx:' + key + ':' + c); return !!idx;
}

// ---------- validation ----------
const str = (v, max, re) => { if (v == null || v === '') return ''; v = String(v).trim(); if (v.length > max) bad('field too long'); if (re && v && !re.test(v)) bad('invalid field: ' + v.slice(0, 40)); return v; };
const URLRE = /^https:\/\/[^\s<>"']+$/i, MEDIA = /^\/media\/[0-9a-f]{64}\.(webp|png|jpg|gif)$/;
function cleanLinks(b) { return { website: str(b.website, 200, URLRE), x: str(b.x, 200, /^(https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?|@?[A-Za-z0-9_]{1,15})$/), discord: str(b.discord, 200, /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+\/?$/) }; }

// ---------- media ----------
function sniff(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', type: 'image/png', w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]); let w = 0, h = 0;
    if (fmt === 'VP8X') { w = 1 + (b[24] | b[25] << 8 | b[26] << 16); h = 1 + (b[27] | b[28] << 8 | b[29] << 16); }
    else if (fmt === 'VP8 ') { w = dv.getUint16(26, true) & 0x3fff; h = dv.getUint16(28, true) & 0x3fff; }
    else if (fmt === 'VP8L') { const bits = dv.getUint32(21, true); w = 1 + (bits & 0x3fff); h = 1 + ((bits >> 14) & 0x3fff); }
    return { ext: 'webp', type: 'image/webp', w, h };
  }
  if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < b.length) { if (b[i] !== 0xff) break; const m = b[i + 1], len = dv.getUint16(i + 2); if (m >= 0xc0 && m <= 0xc3) return { ext: 'jpg', type: 'image/jpeg', h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) }; i += 2 + len; } return { ext: 'jpg', type: 'image/jpeg', w: 0, h: 0 }; }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', type: 'image/gif', w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  return null;
}

// ---------- OpenSea per-collection proxy ----------
const slugCache = new Map();
async function osSlugFor(env, chainKey, contract) {
  const os = chains[chainKey]?.openseaSlug; if (!os) return null;
  const k = os + lc(contract); if (slugCache.has(k)) return slugCache.get(k);
  const r = await osFetch(env, `/chain/${os}/contract/${contract}`); const j = await r.json().catch(() => ({}));
  if (j.collection) slugCache.set(k, j.collection); return j.collection || null;
}
async function osListings(env, col) {
  const out = [];
  for (const d of col.deployments || []) {
    const s = await osSlugFor(env, d.chain, d.address); if (!s) continue;
    const j = await (await osFetch(env, `/listings/collection/${s}/all?limit=100`)).json().catch(() => ({}));
    for (const l of j.listings || []) {
      const offer = l.protocol_data?.parameters?.offer?.[0]; const p = l.price?.current; if (!offer || !p) continue;
      if (lc(offer.token) !== lc(d.address)) continue;
      out.push({ chain: d.chain, id: Number(offer.identifierOrCriteria), price: Number(p.value) / 10 ** p.decimals, currency: p.currency, orderHash: l.order_hash, protocolAddress: l.protocol_address, seller: lc(l.protocol_data?.parameters?.offerer) || undefined });
    }
  }
  return out;
}
async function osStats(env, col) {
  const per = {};
  for (const d of col.deployments || []) {
    const s = await osSlugFor(env, d.chain, d.address); if (!s) continue;
    const j = await (await osFetch(env, `/collections/${s}/stats`)).json().catch(() => ({}));
    if (j.total) per[d.chain] = { slug: s, ...j.total };
  }
  return per;
}
async function osItems(env, col, chainKey, next) {
  const d = (col.deployments || []).find(x => x.chain === chainKey) || col.deployments?.[0]; if (!d) return { nfts: [] };
  const os = chains[d.chain]?.openseaSlug; if (!os) return { nfts: [], next: null, chain: d.chain };
  const j = await (await osFetch(env, `/chain/${os}/contract/${d.address}/nfts?limit=50${next ? '&next=' + encodeURIComponent(next) : ''}`)).json().catch(() => ({}));
  return { chain: d.chain, next: j.next || null, nfts: (j.nfts || []).map(n => ({ id: Number(n.identifier), name: n.name, image: n.display_image_url || n.image_url, chain: d.chain })) };
}

// ---------- selling helpers ----------
const OS_FEE = '0x0000a26b00c1f0df003000390027140000faa719';
const ZERO = '0x0000000000000000000000000000000000000000';
const U256 = /^\d{1,78}$/;
async function sellConfig(env, chain, contract) {
  const key = osToKey[chain]; const c = chains[key];
  if (!c?.conduit) bad('selling not supported on this chain');
  const slug = await osSlugFor(env, key, contract); if (!slug) bad('collection not found on OpenSea', 404);
  const fees = await cached(`fees:${slug}`, 600, async () => {
    const j = await (await osFetch(env, `/collections/${slug}`)).json().catch(() => ({}));
    return (j.fees || []).map(f => ({ recipient: lc(f.recipient), bps: Math.round(Number(f.fee) * 100), required: !!f.required, kind: lc(f.recipient) === OS_FEE ? 'opensea' : 'creator' }));
  });
  return { chain, chainKey: key, chainId: c.chainId, native: c.native, slug, fees, conduitKey: c.conduit.key, conduit: c.conduit.address, zone: CFG.seaportZone };
}
function cleanOrder(o) {
  if (!o || typeof o !== 'object') bad('missing parameters');
  const now = Math.floor(Date.now() / 1000);
  const num = (v, re = U256) => { v = String(v ?? ''); if (!re.test(v)) bad('invalid number'); return v; };
  if (!ADDR.test(o.offerer || '') || !ADDR.test(o.zone || '') || !HASH.test(o.zoneHash || '') || !HASH.test(o.conduitKey || '')) bad('invalid order fields');
  if (!Array.isArray(o.offer) || o.offer.length !== 1) bad('exactly one offer item');
  const f = o.offer[0];
  if (Number(f.itemType) !== 2 || !ADDR.test(f.token || '') || !ID.test(String(f.identifierOrCriteria)) || String(f.startAmount) !== '1' || String(f.endAmount) !== '1') bad('offer must be one ERC-721');
  if (!Array.isArray(o.consideration) || o.consideration.length < 1 || o.consideration.length > 6) bad('bad consideration');
  const cons = o.consideration.map(c => {
    if (Number(c.itemType) !== 0 || lc(c.token) !== ZERO || String(c.identifierOrCriteria) !== '0' || !ADDR.test(c.recipient || '')) bad('consideration must be native currency');
    const a = num(c.startAmount); if (String(c.endAmount) !== a || BigInt(a) === 0n) bad('fixed, non-zero amounts only');
    return { itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: a, endAmount: a, recipient: c.recipient };
  });
  const st = Number(num(o.startTime, /^\d{1,12}$/)), et = Number(num(o.endTime, /^\d{1,12}$/));
  if (st > now + 600 || et <= now || et > now + 31 * 86400 + 600 || et <= st) bad('bad start/end time');
  const ot = Number(o.orderType); if (![0, 1, 2, 3].includes(ot)) bad('bad orderType');
  if (Number(o.totalOriginalConsiderationItems) !== cons.length) bad('bad consideration count');
  return { offerer: o.offerer, zone: o.zone, offer: [{ itemType: 2, token: f.token, identifierOrCriteria: String(f.identifierOrCriteria), startAmount: '1', endAmount: '1' }], consideration: cons, orderType: ot, startTime: String(st), endTime: String(et), zoneHash: o.zoneHash, salt: num(o.salt), conduitKey: o.conduitKey, totalOriginalConsiderationItems: cons.length, counter: num(o.counter) };
}
async function bustListings(contract, key) {
  const slugs = CFG.collections.filter(c => c.deployments.some(d => d.chain === key && lc(d.address) === lc(contract))).map(c => c.slug);
  for (const s of slugs) await caches.default.delete(new Request('https://cache.multisea/l:' + s)).catch(() => {});
}

// ---------- fees helpers ----------
const RELAY_API = 'https://api.relay.link';
const feeWallet = env => lc(env.FEE_WALLET || '0x25411039F77529A543344603bD8acdd65fABA4d0');
// RELAY_API_KEY is an optional Worker secret (`wrangler secret put RELAY_API_KEY`); sent only when set.
const relayFetch = (env, path, init = {}) => fetch(RELAY_API + path, { ...init, headers: { 'content-type': 'application/json', ...(env.RELAY_API_KEY ? { 'x-api-key': env.RELAY_API_KEY } : {}), ...(init.headers || {}) } });
async function rpcBalance(chainKey, addr) {
  const c = chains[chainKey]; if (!c) return null;
  const r = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {}; return j.result ? BigInt(j.result).toString() : null;
}

let _native; const native = () => (_native ??= makeNative({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet, cached, hooks: { onSale: (env, s) => growth().recordSale(env, s), onList: (env, a, k) => growth().questEvent(env, a, k, 'list') } }));
let _growth; const growth = () => (_growth ??= makeGrowth({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet, admins, requireSession, canEdit, relayFetch }));

// ---------- router ----------
async function handle(req, env, url) {
  const p = url.pathname.split('/').filter(Boolean); const M = req.method;
  const body = async () => { const b = await req.json().catch(() => null); if (!b || typeof b !== 'object') bad('invalid JSON'); return b; };

  if (M === 'GET' && p[0] === 'health') return { ok: true, chains: Object.keys(chains), features: ['buy', 'siwe', 'submit', 'admin', 'edit', 'sell', 'native', 'growth', ...(env.MEDIA ? ['media'] : [])] };
  { const g = await growth().handle(req, env, url, p, M, body, native()); if (g !== undefined) return g; }

  // --- SIWE ---
  if (M === 'GET' && p[0] === 'auth' && p[1] === 'nonce') { const n = rand(12); await env.NONCES.put('n:' + n, '1', { expirationTtl: 600 }); return { nonce: n }; }
  if (M === 'POST' && p[0] === 'auth' && p[1] === 'verify') {
    const { message, signature } = await body();
    if (typeof message !== 'string' || message.length > 2000 || !/^0x[0-9a-fA-F]+$/.test(signature || '')) bad('invalid input');
    const f = parseSiweMessage(message);
    const domains = (env.SIWE_DOMAINS || '').split(',').map(s => s.trim());
    const okDomain = domains.includes(f.domain) || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(f.domain || '');
    if (!okDomain) bad('wrong domain', 401);
    if (!f.nonce || !(await env.NONCES.get('n:' + f.nonce))) bad('nonce expired or unknown', 401);
    if (!f.expirationTime) bad('message must have an expiration time', 401);
    if (!validateSiweMessage({ message: f, domain: f.domain, nonce: f.nonce, time: new Date() })) bad('message expired or invalid', 401);
    let valid = await verifyMessage({ address: f.address, message, signature }).catch(() => false);
    if (!valid && chains[Object.keys(chains).find(k => chains[k].chainId === f.chainId)]) { // ERC-1271 smart wallets
      const key = Object.keys(chains).find(k => chains[k].chainId === f.chainId);
      valid = await createPublicClient({ transport: http(chains[key].rpc) }).verifyMessage({ address: f.address, message, signature }).catch(() => false);
    }
    if (!valid) bad('bad signature', 401);
    await env.NONCES.delete('n:' + f.nonce);
    const token = rand(32); const address = lc(f.address);
    const ttl = Math.max(60, Math.min(86400, Math.floor((f.expirationTime.getTime() - Date.now()) / 1000)));
    await env.NONCES.put('s:' + token, JSON.stringify({ address }), { expirationTtl: ttl });
    return { token, address, isAdmin: admins(env).includes(address), isFee: address === feeWallet(env), expiresIn: ttl };
  }
  if (M === 'GET' && p[0] === 'auth' && p[1] === 'me') { const s = await requireSession(req, env); return { address: s.address, isAdmin: admins(env).includes(s.address) }; }

  // --- media ---
  if (p[0] === 'media' && !env.MEDIA) bad('image uploads are coming soon (storage not enabled yet)', 503);
  if (M === 'POST' && p[0] === 'media' && p.length === 1) {
    await requireSession(req, env);
    const len = +(req.headers.get('content-length') || 0); if (len > 2 * 1024 * 1024) bad('max 2MB', 413);
    const buf = await req.arrayBuffer(); if (buf.byteLength > 2 * 1024 * 1024) bad('max 2MB', 413); if (buf.byteLength < 64) bad('empty file');
    const t = sniff(buf); if (!t) bad('images only (webp, png, jpeg, gif)', 415);
    if (!t.w || !t.h || t.w > 3000 || t.h > 3000) bad('image dimensions must be 1..3000px', 415);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `${hash}.${t.ext}`;
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: t.type, cacheControl: 'public, max-age=31536000, immutable' } });
    return { url: `/media/${key}`, width: t.w, height: t.h, bytes: buf.byteLength };
  }
  if (M === 'GET' && p[0] === 'media' && p.length === 2) {
    if (!/^[0-9a-f]{64}\.(webp|png|jpg|gif)$/.test(p[1])) bad('not found', 404);
    const o = await env.MEDIA.get(p[1]); if (!o) bad('not found', 404);
    return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  // --- collections ---
  if (M === 'GET' && p[0] === 'collections' && p.length === 1) {
    const list = await env.COLLECTIONS.list({ prefix: 'col:' });
    const cols = (await Promise.all(list.keys.map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(Boolean).map(c => ({ ...c, submitter: undefined }));
    const ovr = Object.fromEntries(await Promise.all(Object.keys(STATIC).map(async s => [s, await env.COLLECTIONS.get('ovr:' + s, 'json')])));
    return { collections: cols, overrides: ovr };
  }
  if (M === 'GET' && p[0] === 'collections' && p.length === 2) { const c = await getCollection(env, p[1]); if (!c) bad('not found', 404); return { collection: { ...c, submitter: undefined } }; }
  if (M === 'GET' && p[0] === 'collections' && p[2] === 'can-edit') { const a = url.searchParams.get('address'); if (!ADDR.test(a || '')) bad('address required'); return await canEdit(env, p[1], a); }

  if (M === 'POST' && p[0] === 'submit') {
    const s = await requireSession(req, env); const b = await body();
    const slug = str(b.slug, 40, SLUG); if (!slug || RESERVED.has(slug) || STATIC[slug]) bad('slug invalid or taken');
    if ((await env.COLLECTIONS.get('col:' + slug)) || (await env.COLLECTIONS.get('pending:' + slug))) bad('slug already used');
    const name = str(b.name, 60); if (!name) bad('name required');
    const deployments = Array.isArray(b.deployments) ? b.deployments.slice(0, 10) : []; if (!deployments.length) bad('add at least one chain + contract');
    const checked = [];
    for (const d of deployments) {
      if (!chains[d.chain] || !ADDR.test(d.address || '')) bad('unsupported chain or bad address');
      if (!(await isERC721(d.chain, d.address))) bad(`${d.address} on ${chains[d.chain].name} is not an ERC-721 (supportsInterface 0x80ac58cd)`);
      checked.push({ chain: d.chain, address: d.address.toLowerCase() });
    }
    const escrow = (Array.isArray(b.escrow) ? b.escrow.slice(0, 20) : []).map(e => { if (!chains[e.chain] || !ADDR.test(e.address || '')) bad('bad escrow'); return { chain: e.chain, address: e.address.toLowerCase(), label: str(e.label, 40) }; });
    const rec = { slug, name, description: str(b.description, 1000), ...cleanLinks(b), logo: str(b.logo, 120, MEDIA), banner: str(b.banner, 120, MEDIA), deployments: checked, escrow, submitter: s.address, status: 'pending', submittedAt: new Date().toISOString() };
    await env.COLLECTIONS.put('pending:' + slug, JSON.stringify(rec));
    return { ok: true, status: 'pending', slug };
  }

  // --- fees (Relay app fees + fee wallet balances): admins and the fee wallet only ---
  if (p[0] === 'fees') {
    const s = await requireSession(req, env); const fee = feeWallet(env);
    const isAdmin = admins(env).includes(s.address), isFee = s.address === fee;
    if (!isAdmin && !isFee) bad('admin or fee wallet only', 403);
    if (M === 'GET' && p[1] === 'summary') {
      const [relay, natives, claims] = await Promise.all([
        relayFetch(env, `/app-fees/${fee}/balances`).then(async r => (r.ok ? r.json() : { error: `relay ${r.status}` })).catch(e => ({ error: String(e).slice(0, 120) })),
        Promise.all(Object.entries(chains).map(async ([k, c]) => ({ chain: k, native: c.native, balance: await rpcBalance(k, fee) }))),
        env.COLLECTIONS.list({ prefix: 'feeclaim:' }).then(l => Promise.all(l.keys.slice(-50).map(k => env.COLLECTIONS.get(k.name, 'json')))).catch(() => []),
      ]);
      const nativeFills = await native().fills(env).catch(() => []);
      return { nativeFills, feeWallet: fee, you: s.address, canClaim: isFee, relayKey: !!env.RELAY_API_KEY, relay, natives, claims: claims.filter(Boolean).reverse() };
    }
    if (M === 'POST' && p[1] === 'claim' && p.length === 2) {
      if (!isFee) bad('connect and sign in with the fee wallet to claim', 403);
      const b = await body(); if (!Number.isInteger(b.chainId) || !ADDR.test(b.currency || '')) bad('invalid input');
      const r = await relayFetch(env, `/app-fees/${fee}/claim`, { method: 'POST', body: JSON.stringify({ chainId: b.chainId, currency: b.currency, recipient: fee }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new HttpError(r.status === 401 ? 503 : 422, j.message || 'relay refused', { relayStatus: r.status });
      return j;
    }
    if (M === 'POST' && p[1] === 'claim' && p[2] === 'submit') {
      if (!isFee) bad('fee wallet only', 403);
      const b = await body();
      if (typeof b.endpoint !== 'string' || !/^\/execute\/[a-z0-9/_-]+$/i.test(b.endpoint) || !['POST', 'post'].includes(b.method || 'POST') || !/^0x[0-9a-fA-F]{130,4096}$/.test(b.signature || '')) bad('invalid input');
      const r = await relayFetch(env, `${b.endpoint}?signature=${b.signature}`, { method: 'POST', body: JSON.stringify(b.body ?? {}) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new HttpError(422, j.message || 'relay refused claim', { relayStatus: r.status });
      const rec = { at: new Date().toISOString(), by: s.address, chainId: Number(b.chainId) || null, currency: str(b.currency, 42), amountUsd: Number(b.amountUsd) || null, relay: JSON.stringify(j).slice(0, 500) };
      await env.COLLECTIONS.put('feeclaim:' + Date.now(), JSON.stringify(rec));
      return { ok: true, result: j };
    }
    bad('not found', 404);
  }



  // --- MultiSea native marketplace (Seaport 1.6, orders in KV) ---
  if (p[0] === 'native') {
    const N = native();
    if (M === 'GET' && p[1] === 'config' && p.length === 3) { const col = await getCollection(env, p[2]); if (!col) bad('not found', 404); return { seaport: CFG.seaport, feeRecipient: feeWallet(env), feeBps: NATIVE_FEE_BPS, royalty: await N.royaltyFor(env, p[2]), chains: Object.fromEntries(Object.entries(chains).map(([k, c]) => [k, { chainId: c.chainId, native: c.native }])) }; }
    if (M === 'GET' && p.length === 3 && p[2] === 'listings') return { listings: await N.listings(env, p[1]) };
    if (M === 'GET' && p[1] === 'order' && p.length === 4) { if (!chains[p[2]] || !HASH.test(p[3])) bad('invalid input'); return await N.getOrder(env, p[2], p[3]); }
    if (M === 'POST' && p[1] === 'list' && p.length === 2) return await N.list(env, await body());
    if (M === 'POST' && p[1] === 'cancelled' && p.length === 2) { const b = await body(); if (!chains[b.chain] || !HASH.test(b.orderHash || '') || (b.txHash && !HASH.test(b.txHash))) bad('invalid input'); return await N.cancelled(env, b.chain, b.orderHash, b.txHash); }
    if (M === 'POST' && p[1] === 'counter' && p.length === 2) { const b = await body(); if (!chains[b.chain] || !ADDR.test(b.seller || '') || (b.txHash && !HASH.test(b.txHash))) bad('invalid input'); return await N.counterBumped(env, b.chain, b.seller, b.txHash); }
    if (M === 'POST' && p[1] === 'remove' && p.length === 2) { const s = await requireSession(req, env); const b = await body(); if (!chains[b.chain] || !HASH.test(b.orderHash || '')) bad('invalid input'); return await N.remove(env, b.chain, b.orderHash, s.address); }
  }

  // --- Chain RPC proxy for browser reads: POST /rpc/:chain, read-only allowlist, fallback across public RPCs. ---
  if (p[0] === 'rpc' && p.length === 2) {
    if (M !== 'POST') bad('method not allowed', 405);
    if (!corsHeaders(req, env)) bad('origin not allowed', 403);
    if (limited('rpc:' + (req.headers.get('cf-connecting-ip') || 'x'), 300)) bad('rate limited', 429);
    const c = chains[p[1]]; if (!c) bad('unknown chain', 404);
    const txt = await req.text(); if (txt.length > 64_000) bad('too large', 413);
    let j; try { j = JSON.parse(txt); } catch { bad('bad json'); }
    const calls = Array.isArray(j) ? j : [j]; if (!calls.length || calls.length > 20) bad('bad batch');
    for (const x of calls) if (!RPC_READ.has(x?.method)) bad('method not allowed: ' + String(x?.method).slice(0, 40), 403);
    return new Response(JSON.stringify(await rpcFanout(c, j)), { headers: { 'content-type': 'application/json' } });
  }

  // --- Relay proxy (quote / status / chains / token price). Key stays server-side. ---
  if (p[0] === 'relay') {
    if (!['GET', 'POST'].includes(M)) bad('method not allowed', 405);
    if (!corsHeaders(req, env)) bad('origin not allowed', 403); // browser calls from MultiSea origins only
    const rest = '/' + p.slice(1).join('/');
    // Allowlist: quotes, status polling, chain/price metadata, permit submission (gasless ERC20 deposits). App-fee claim stays on /fees/*.
    const ok = (
      (M === 'POST' && /^\/quote(\/v2)?$/.test(rest)) ||
      (M === 'POST' && rest === '/execute/permits' && /^0x[0-9a-fA-F]{130,}$/.test(url.searchParams.get('signature') || '')) ||
      (M === 'GET' && /^\/intents\/status(\/v\d+)?$/.test(rest) && url.searchParams.has('requestId') && /^0x[0-9a-fA-F]{64}$/.test(url.searchParams.get('requestId') || '')) ||
      (M === 'GET' && /^\/(?:chains|currencies\/token\/price)$/.test(rest))
    );
    if (!ok) bad('not found', 404);
    if (limited(req.headers.get('cf-connecting-ip') || 'local', 30)) bad('rate limited', 429);
    // Cap quote bodies; status/metadata have none.
    let init = { method: M };
    if (M === 'POST') {
      const raw = await req.text(); if (raw.length > 80_000) bad('body too large');
      try { JSON.parse(raw); } catch { bad('invalid JSON'); }
      init.body = raw;
    }
    const qs = url.search; // carries requestId for status
    const r = await relayFetch(env, rest + qs, init);
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' } });
  }

  // --- admin ---
  if (p[0] === 'admin') {
    const s = await requireSession(req, env); if (!admins(env).includes(s.address)) bad('admin only', 403);
    if (M === 'GET' && p[1] === 'pending') { const l = await env.COLLECTIONS.list({ prefix: 'pending:' }); return { pending: (await Promise.all(l.keys.map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(Boolean) }; }
    if (M === 'POST' && (p[1] === 'approve' || p[1] === 'reject') && SLUG.test(p[2] || '')) {
      const rec = await env.COLLECTIONS.get('pending:' + p[2], 'json'); if (!rec) bad('no such pending submission', 404);
      await env.COLLECTIONS.delete('pending:' + p[2]);
      if (p[1] === 'reject') { const b = await req.json().catch(() => ({})); await env.COLLECTIONS.put('rejected:' + p[2], JSON.stringify({ ...rec, status: 'rejected', reason: str(b?.reason, 300), reviewedBy: s.address, reviewedAt: new Date().toISOString() })); return { ok: true, status: 'rejected' }; }
      const col = { ...rec, status: 'approved', approvedBy: s.address, approvedAt: new Date().toISOString() };
      await env.COLLECTIONS.put('col:' + p[2], JSON.stringify(col));
      for (const d of col.deployments) await env.COLLECTIONS.put('idx:' + d.chain + ':' + d.address, p[2]);
      return { ok: true, status: 'approved', collection: col };
    }
  }

  // --- owner edits ---
  if (M === 'POST' && p[0] === 'collections' && p[2] === 'update') {
    const s = await requireSession(req, env); const slug = p[1];
    const perm = await canEdit(env, slug, s.address); if (!perm.ok) bad('only the collection owner can edit', 403);
    const b = await body();
    const patch = { ...(b.description != null ? { description: str(b.description, 1000) } : {}), ...cleanLinks(b), ...(b.logo != null ? { logo: str(b.logo, 120, MEDIA) } : {}), ...(b.banner != null ? { banner: str(b.banner, 120, MEDIA) } : {}), updatedBy: s.address, updatedAt: new Date().toISOString() };
    for (const k of ['website', 'x', 'discord']) if (b[k] == null) delete patch[k];
    if (b.royalty !== undefined) { const r = b.royalty; if (r === null || !r.bps) patch.royalty = null; else { if (!ADDR.test(r.recipient || '') || !Number.isFinite(+r.bps) || +r.bps < 0 || +r.bps > 1000) bad('royalty: recipient address and 0-10% required'); patch.royalty = { recipient: lc(r.recipient), bps: Math.floor(+r.bps) }; } }
    if (STATIC[slug]) { const cur = (await env.COLLECTIONS.get('ovr:' + slug, 'json')) || {}; const v = { ...cur, ...patch }; await env.COLLECTIONS.put('ovr:' + slug, JSON.stringify(v)); return { ok: true, collection: v, via: perm.why }; }
    const cur = await env.COLLECTIONS.get('col:' + slug, 'json'); if (!cur) bad('not found', 404);
    const v = { ...cur, ...patch }; await env.COLLECTIONS.put('col:' + slug, JSON.stringify(v)); return { ok: true, collection: { ...v, submitter: undefined }, via: perm.why };
  }

  // --- LIL FOOTS foot wallets: NFTs held by a foot's token-bound account (ERC-6551), all OpenSea chains in scope ---
  // Only foot TBAs (computed here from the id), so this is not a generic address lookup on our OpenSea key.
  if (M === 'GET' && p[0] === 'foot' && p[2] === 'nfts' && p.length === 3) {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    const id = +p[1]; if (!ID.test(p[1]) || id < 1 || id > 4404) bad('invalid id');
    const tba = footTba(id);
    // Per-chain isolation: one chain's OpenSea timeout/throw/429 must not fail the whole list (it used to reject the
    // Promise.all -> 500 -> "NFT list unavailable"). Each chain gets 8s + one retry; partial results are cached briefly.
    const one = async (k, os) => {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await osFetch(env, `/chain/${os}/account/${tba}/nfts?limit=50`, { signal: AbortSignal.timeout(8000) });
          if (r.ok) { const j = await r.json(); return (j.nfts || []).map(n => ({ chain: k, contract: lc(n.contract), id: String(n.identifier), name: n.name || null, collection: n.collection || null, image: n.display_image_url || n.image_url || null, standard: n.token_standard || null })); }
          if (r.status !== 429 && r.status < 500) return [{ chain: k, error: 'opensea ' + r.status }];
          if (i) return [{ chain: k, error: 'opensea ' + r.status }];
        } catch (e) { if (i) return [{ chain: k, error: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 60) }]; }
        await new Promise(r => setTimeout(r, 600));
      }
      return [];
    };
    const key = `fw:${id}`; const cache = caches.default; const creq = new Request('https://cache.multisea/' + key);
    const hit = await cache.match(creq); if (hit) return hit.json();
    const parts = await Promise.all(FOOT_CHAINS.map(k => (chains[k]?.openseaSlug ? one(k, chains[k].openseaSlug) : [])));
    const nfts = parts.flat(); const failed = nfts.filter(n => n.error).map(n => n.chain);
    const val = { id, account: tba, nfts: nfts.filter(n => !n.error), failed, unsupported: FOOT_CHAINS.filter(k => !chains[k]?.openseaSlug) };
    await cache.put(creq, new Response(JSON.stringify(val), { headers: { 'cache-control': `public, max-age=${failed.length ? 15 : 120}` } }));
    return val;
  }

  // --- per-collection live data (OpenSea, cached) ---
  if (M === 'GET' && p[0] === 'os' && p.length === 3) {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    const col = await getCollection(env, p[1]); if (!col || col.status !== 'approved') bad('not found', 404);
    if (p[2] === 'listings') return { listings: await cached(`l:${p[1]}`, 120, () => osListings(env, col)) };
    if (p[2] === 'stats') return { stats: await cached(`s:${p[1]}`, 300, () => osStats(env, col)) };
    if (p[2] === 'items') { const ch = url.searchParams.get('chain') || ''; const nx = url.searchParams.get('next') || ''; if (nx.length > 400) bad('bad cursor'); return await cached(`i:${p[1]}:${ch}:${nx}`, 600, () => osItems(env, col, ch, nx)); }
  }

  // --- buying (existing) ---
  if (M === 'GET' && p[0] === 'listings' && p.length === 4) {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    const [, chain, contract, id] = p;
    if (!osToKey[chain] || !ADDR.test(contract) || !ID.test(id) || !(await allowedContract(env, chain, contract))) bad('invalid chain/contract/id');
    const s = await osSlugFor(env, osToKey[chain], contract); if (!s) bad('collection not found on OpenSea', 404);
    const r = await osFetch(env, `/listings/collection/${s}/nfts/${id}/best`); const j = await r.json().catch(() => ({}));
    if (r.status === 404 || (j.errors && /No listings/i.test(String(j.errors)))) return { listing: null };
    if (!r.ok) bad('opensea error ' + r.status, 502);
    if (!j.order_hash || (j.status && j.status !== 'ACTIVE')) return { listing: null };
    const prm = j.protocol_data?.parameters || {}; const offer = prm.offer?.[0];
    if (!offer || lc(offer.token) !== lc(contract)) return { listing: null };
    return { listing: { chain, contract: lc(contract), id: Number(id), orderHash: j.order_hash, protocolAddress: j.protocol_address, price: j.price?.current, seller: prm.offerer, endTime: Number(prm.endTime) || null, fees: (prm.consideration || []).slice(1).map(c => ({ recipient: c.recipient, amount: c.startAmount })) } };
  }
  if (M === 'POST' && p[0] === 'fulfill' && p.length === 1) {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    const b = await body();
    if (!HASH.test(b.hash || '') || !osToKey[b.chain] || !ADDR.test(b.fulfiller || '') || !SEAPORT.has(lc(b.protocolAddress))) bad('invalid input');
    const r = await osFetch(env, '/listings/fulfillment_data', { method: 'POST', body: JSON.stringify({ listing: { hash: b.hash, chain: b.chain, protocol_address: b.protocolAddress }, fulfiller: { address: b.fulfiller } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const msg = [].concat(j.errors || j.detail || j.message || []).map(String).join('; ').slice(0, 300); const gone = r.status === 404 || /not found|invalid|filled|cancel|expired|no longer/i.test(msg); throw new HttpError(gone ? 409 : 422, gone ? 'listing no longer valid' : 'opensea refused', { message: msg }); }
    const tx = j.fulfillment_data?.transaction; const offer = j.fulfillment_data?.orders?.[0]?.parameters?.offer?.[0];
    if (!tx || !SEAPORT.has(lc(tx.to)) || !offer || !(await allowedContract(env, b.chain, offer.token))) bad('unexpected fulfillment', 422);
    return { transaction: tx, orders: j.fulfillment_data.orders };
  }
  // --- selling (list / cancel via OpenSea; key stays server-side) ---
  if (p[0] === 'sell') {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    if (M === 'GET' && p[1] === 'config' && p.length === 4) {
      const [, , chain, contract] = p;
      if (!osToKey[chain] || !ADDR.test(contract) || !(await allowedContract(env, chain, contract))) bad('invalid chain/contract');
      return { ...(await sellConfig(env, chain, contract)), seaport: CFG.seaport };
    }
    if (M === 'POST' && p[1] === 'list' && p.length === 2) {
      const b = await body(); const chain = b.chain;
      if (!osToKey[chain] || !SEAPORT.has(lc(b.protocolAddress)) || !/^0x[0-9a-fA-F]{128,4096}$/.test(b.signature || '')) bad('invalid input');
      const prm = cleanOrder(b.parameters);
      const nft = prm.offer[0];
      if (!(await allowedContract(env, chain, nft.token))) bad('collection not allowed');
      const cfg = await sellConfig(env, chain, nft.token);
      if (lc(prm.conduitKey) !== lc(cfg.conduitKey)) bad('wrong conduit for this chain');
      if (lc(prm.consideration[0].recipient) !== lc(prm.offerer)) bad('first consideration must pay the seller');
      const total = prm.consideration.reduce((a, c) => a + BigInt(c.startAmount), 0n);
      for (const f of cfg.fees.filter(f => f.required)) {
        const need = total * BigInt(f.bps) / 10000n;
        const got = prm.consideration.slice(1).filter(c => lc(c.recipient) === lc(f.recipient)).reduce((a, c) => a + BigInt(c.startAmount), 0n);
        if (got + 1n < need) bad(`missing required fee to ${f.recipient}`);
      }
      const owner = await rpcCall(osToKey[chain], nft.token, '0x6352211e' + BigInt(nft.identifierOrCriteria).toString(16).padStart(64, '0'));
      if (!owner || '0x' + owner.slice(-40).toLowerCase() !== lc(prm.offerer)) bad('offerer does not own this NFT', 403);
      const payload = { parameters: prm, protocol_address: lc(b.protocolAddress), signature: b.signature };
      if (env.ALLOW_DRY_RUN === '1' && req.headers.get('x-dry-run') === '1') return { dryRun: true, wouldPost: `/orders/${chain}/seaport/listings`, payload };
      const r = await osFetch(env, `/orders/${chain}/seaport/listings`, { method: 'POST', body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new HttpError(422, 'opensea refused', { message: [].concat(j.errors || j.detail || j.message || []).map(String).join('; ').slice(0, 300) });
      await bustListings(nft.token, osToKey[chain]);
      await growth().questEvent(env, prm.offerer, osToKey[chain], 'list').catch(() => {});
      return { ok: true, orderHash: j.order?.order_hash || null };
    }
    if (M === 'POST' && p[1] === 'cancel' && p.length === 2) {
      const b = await body();
      if (!osToKey[b.chain] || !HASH.test(b.orderHash || '') || !SEAPORT.has(lc(b.protocolAddress)) || !/^0x[0-9a-fA-F]{128,4096}$/.test(b.signature || '')) bad('invalid input');
      const r = await osFetch(env, `/orders/chain/${b.chain}/protocol/${lc(b.protocolAddress)}/${b.orderHash}/cancel`, { method: 'POST', body: JSON.stringify({ offererSignature: b.signature }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new HttpError(422, 'opensea refused', { message: [].concat(j.errors || j.detail || j.message || []).map(String).join('; ').slice(0, 300) });
      if (ADDR.test(b.contract || '')) await bustListings(b.contract, osToKey[b.chain]);
      return { ok: true, ...j };
    }
    if (M === 'GET' && p[1] === 'order' && p.length === 4) {
      const [, , chain, hash] = p;
      if (!osToKey[chain] || !HASH.test(hash)) bad('invalid input');
      const r = await osFetch(env, `/orders/chain/${chain}/protocol/${CFG.seaport}/${hash}`); const j = await r.json().catch(() => ({}));
      if (!r.ok) bad('order not found', 404);
      const o = j.order || j; const prm = o.protocol_data?.parameters; if (!prm) bad('order not found', 404);
      if (!(await allowedContract(env, chain, prm.offer?.[0]?.token))) bad('collection not allowed');
      return { parameters: prm, protocolAddress: o.protocol_address || CFG.seaport };
    }
  }
  bad('not found', 404);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(native().sweep(env).then(r => console.log('native sweep', JSON.stringify(r)))); },
  async fetch(req, env) {
    const url = new URL(req.url); const ch = corsHeaders(req, env);
    if (req.headers.get('origin') && !ch) return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers: { 'content-type': 'application/json' } });
    const H = ch || {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    if (limited(ip, url.pathname.startsWith('/media/') || url.pathname.startsWith('/rpc/') ? 300 : 60)) return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', ...H } });
    try {
      const out = await handle(req, env, url);
      if (out instanceof Response) { for (const [k, v] of Object.entries(H)) out.headers.set(k, v); return out; }
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', ...H } });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return new Response(JSON.stringify({ error: e instanceof HttpError ? e.message : 'internal', ...(e.extra || {}), ...(status === 500 ? { message: String(e).slice(0, 200) } : {}) }), { status, headers: { 'content-type': 'application/json', ...H } });
    }
  },
};
