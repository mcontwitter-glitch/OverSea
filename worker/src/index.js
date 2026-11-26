// MultiSea API (Cloudflare Worker).
// - OpenSea proxy for buying (fulfillment_data) + per-collection live data with caching
// - SIWE (EIP-4361) auth, collection submissions (pending queue), admin approve/reject, owner edits
// - Media uploads to R2 (images only, <=2MB; re-encoded to WebP client-side, validated here)
// Secrets: OPENSEA_API_KEY (wrangler secret put). Never in code.
import CFG from '../../config/collections.json';
import { verifyMessage, createPublicClient, http, fallback, getContractAddress, concat, encodeAbiParameters } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { makeNative, NATIVE_FEE_BPS } from './native.js';
import { makeOffers } from './offers.js';
import { makeGrowth } from './growth.js';
import { makeLaunchpad } from './launchpad.js';
import { makeHolderAllow } from './holderallow.js';
import { verifySolanaSetup } from './solswitch.js';
import { makeBridgeAuto } from './bridgeauto.js';
import { kput } from './kvput.js';
import { makeLinkBridge, makePublishBridged } from './bridgelink.js';
import { makeBridgeEnrich, isBridgedCol } from './bridgeenrich.js';
import { makeBtcRoutes } from './btc.js';
import { makeHolderChat } from './holderchat.js';
import { makeProfiles } from './profiles.js';
import { makeSolanaLink } from './solanalink.js';
import { makeWalletLink } from './walletlink.js';
import { makeShare } from './share.js';
import { makeActivity } from './activity.js';
import { solAllowed, solFanout, solRpcError } from './solrpc.js';
import { corsHeaders } from './cors.js';
import { makeLzLegs } from './lzlegs.js';
import { makeIslandNfts } from './islandnfts.js';
import { makeSolMeta } from './solmeta.js';
import { handleOnchainUri } from './onchainuri.js';
import { edgeTtl, edgeCacheKey, floodBlock } from './flood.js';
import { rpcRace } from './rpcrace.js';
import { makeOwners } from './owners.js';
import { rpcCacheTtl, rpcCacheKey } from './rpccache.js';
import LP from '../../config/launchpad.json';
import LPT0 from '../../config/launchpad.testnet.json'; // STAGING only (env.LP_NETWORK = 'testnet'); the live Worker never sets it

const OS = 'https://api.opensea.io/api/v2';
const SEAPORT = new Set([CFG.seaport.toLowerCase()]);
const ERC721_IFACE = '0x80ac58cd';
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, ID = /^\d{1,9}$/, SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'submit', 'api', 'c', 'new', 'edit', 'static', 'launchpad']);
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
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
// LIL FOOTS foot wallets (ERC-6551 v0.3.1 registry; account bound to the Base FOOT contract and Base chain id; salt 0).
const FOOT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
const FOOT_REG = '0x000000006551c19487814612e58FE06813775758', FOOT_IMPL = '0x02e9fE944e1604160dac0fF5f35b8cE581D1e9b3', FOOT_BASE = '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e';
const footTba = id => getContractAddress({ opcode: 'CREATE2', from: FOOT_REG, salt: '0x' + '0'.repeat(64), bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', FOOT_IMPL, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], ['0x' + '0'.repeat(64), 8453n, FOOT_BASE, BigInt(id)])]) });
const osFetch = (env, path, init = {}) => fetch(OS + path, { ...init, headers: { 'x-api-key': env.OPENSEA_API_KEY, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } });
// Foot wallet NFT list cache (seconds); see GET /foot/<id>/nfts.
const FW_TTL = 30, FW_TTL_PARTIAL = 10, FW_MIN_AGE = 10;
// Listing GETs: 60s fresh, then serve stale up to 4 min more while refreshing in the background (stale bound ~5 min).
// Writes (list / remove / cancel / fill) purge the cache, and buying re-validates the order on-chain, so stale is safe.
const LISTING_TTL = 60, LISTING_SWR = 240;
const listingCC = `public, max-age=${LISTING_TTL}, stale-while-revalidate=${LISTING_SWR}`;
function listingJson(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': listingCC } });
}
// Edge-cache memo with stale-while-revalidate: fresh for `ttl`s; then for `swrTtl`s more the stored copy is returned at once
// and refreshed in the background (ctx.waitUntil). If a refresh fails, a copy up to STALE_IF_ERROR old is still served.
// Concurrent misses in one isolate share one fn() call. Default stale window when a ctx is given: 4 x ttl.
const STALE_IF_ERROR = 3600; const inflight = new Map();
async function cached(key, ttl, fn, swrTtl, ctx) {
  const swr = swrTtl ?? (ctx ? ttl * 4 : 0);
  const cache = caches.default; const req = new Request('https://cache.multisea/' + key);
  const put = val => cache.put(req, new Response(JSON.stringify(val), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl + swr + STALE_IF_ERROR}`, 'x-ms-cached-at': String(Date.now()) } })).catch(() => {});
  const run = () => {
    let pr = inflight.get(key);
    if (!pr) { pr = (async () => { const v = await fn(); await put(v); return v; })().finally(() => inflight.delete(key)); inflight.set(key, pr); }
    return pr;
  };
  const hit = await cache.match(req).catch(() => null);
  if (hit) {
    const at = Number(hit.headers.get('x-ms-cached-at') || 0);
    const age = at ? (Date.now() - at) / 1000 : 0;
    if (!at || age < ttl) return hit.json();
    if (swr > 0 && age < ttl + swr) { const bg = run().catch(() => {}); if (ctx?.waitUntil) ctx.waitUntil(bg); return hit.json(); }
    try { return await run(); } catch (e) { if (age < ttl + swr + STALE_IF_ERROR) return hit.json(); throw e; }
  }
  return run();
}
const RPC_READ = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas', 'net_version']);
// Hedged across the configured RPCs (src/rpcrace.js): the next URL starts if one hasn't answered in ~400ms or fails;
// each attempt times out after 3s (8s for big batches); 2 passes over the list. An HTTP error, non-JSON body or rate-limit error moves on.
async function rpcFanout(c, payload) {
  const urls = c.rpcs?.length ? c.rpcs : [c.rpc];
  // Big payloads (multicall batches from the Worker itself) get the old 8s per attempt; browser-sized reads 3s.
  const big = JSON.stringify(payload).length > 4000;
  try { return await rpcRace(urls, payload, big ? { timeoutMs: 8000, hedgeMs: 1500 } : {}); }
  catch (e) { bad('all RPCs failed for ' + c.name + ': ' + String(e?.message || e).slice(0, 160), 502); }
}
const isHex = v => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);
const isHexWord1 = v => isHex(v) && BigInt(v) === 1n;
const isHexWord = v => isHex(v) && v.length >= 66;
async function rpcExec(chainKey, method, params) {
  const c = chains[chainKey]; if (!c) return { rpcErr: true, result: null };
  try {
    const j = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method, params });
    if (j?.error) return { revert: true, result: null };
    return { result: j?.result ?? null };
  } catch { return { rpcErr: true, result: null }; }
}
async function rpcCall(chainKey, to, data) {
  const r = await rpcExec(chainKey, 'eth_call', [{ to, data }, 'latest']);
  return r.result || null;
}
async function isERC721(chainKey, address) {
  const c = chains[chainKey]; if (!c) return false;
  const s721 = await rpcExec(chainKey, 'eth_call', [{ to: address, data: '0x01ffc9a7' + ERC721_IFACE.slice(2).padEnd(64, '0') }, 'latest']);
  if (s721.rpcErr) bad('Could not reach ' + c.name + ' RPC to verify the contract. Please try again.', 502);
  if (isHexWord1(s721.result)) return true;
  // Explicit ERC-165 false? Check if contract supports ERC-165 itself or ERC-1155, while still allowing legacy
  // non-ERC165 ERC-721 contracts (e.g. CryptoKitties, which returns supportsInterface(0x01ffc9a7)=true, 0x80ac58cd=false).
  const s1155 = await rpcCall(chainKey, address, '0x01ffc9a7d9b67a26' + '0'.repeat(56));
  if (isHexWord1(s1155)) return false;
  const code = await rpcExec(chainKey, 'eth_getCode', [address, 'latest']);
  if (code.rpcErr) bad('Could not reach ' + c.name + ' RPC to verify the contract. Please try again.', 502);
  if (!code.result || code.result === '0x') return false;
  // Rule out ERC-20 (has decimals()) and catch-all fallback contracts (respond with 32 bytes to nonsense selector).
  const [dec, dead, bal, own1, own0, appAll, allow] = await Promise.all([
    rpcCall(chainKey, address, '0x313ce567'),
    rpcCall(chainKey, address, '0xdeadbeef'),
    rpcCall(chainKey, address, '0x70a08231' + '0'.repeat(63) + '1'),
    rpcCall(chainKey, address, '0x6352211e' + '0'.repeat(63) + '1'),
    rpcCall(chainKey, address, '0x6352211e' + '0'.repeat(64)),
    rpcCall(chainKey, address, '0xe985e9c5' + '0'.repeat(63) + '1' + '0'.repeat(63) + '2'),
    rpcCall(chainKey, address, '0xdd62ed3e' + '0'.repeat(63) + '1' + '0'.repeat(63) + '2'),
  ]);
  if (isHexWord(dec) || isHexWord(dead) || isHexWord(allow)) return false;
  const hasBal = isHexWord(bal);
  const validOwnerWord = w => isHexWord(w) && BigInt(w) !== 0n && BigInt(w) < (1n << 160n);
  if (hasBal && (validOwnerWord(own1) || validOwnerWord(own0))) return true;
  if (hasBal && isHexWord(appAll) && BigInt(appAll) <= 1n) {
    // Unminted / non-1-indexed non-ERC165 ERC-721: confirm getApproved(1) does not silently return non-address garbage and decimals/allowance stayed absent.
    const ga = await rpcCall(chainKey, address, '0x081812fc' + '0'.repeat(63) + '1');
    if (ga === null || validOwnerWord(ga) || (isHexWord(ga) && BigInt(ga) === 0n)) return true;
  }
  return false;
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
// Persist a patch onto a collection record (static collections keep overrides under ovr:<slug>, dynamic ones under col:<slug>).
async function saveCollectionPatch(env, slug, patch) {
  const stamp = { ...patch, updatedAt: new Date().toISOString() };
  if (STATIC[slug]) { const cur = (await env.COLLECTIONS.get('ovr:' + slug, 'json')) || {}; const v = { ...cur, ...stamp }; await env.COLLECTIONS.put('ovr:' + slug, JSON.stringify(v)); return v; }
  const cur = await env.COLLECTIONS.get('col:' + slug, 'json'); if (!cur) bad('not found', 404);
  const v = { ...cur, ...stamp }; await kput(env.COLLECTIONS, 'col:' + slug, JSON.stringify(v)); return v;
}
async function allowedContract(env, osChain, contract) {
  const key = osToKey[osChain]; if (!key) return false; const c = lc(contract);
  for (const col of CFG.collections) if (col.deployments.some(d => d.chain === key && lc(d.address) === c)) return true;
  const idx = await env.COLLECTIONS.get('idx:' + key + ':' + c); return !!idx;
}

// ---------- validation ----------
const str = (v, max, re) => { if (v == null || v === '') return ''; v = String(v).trim(); if (v.length > max) bad('field too long'); if (re && v && !re.test(v)) bad('invalid field: ' + v.slice(0, 40)); return v; };
const MEDIA = /^\/media\/[0-9a-f]{64}\.(webp|png|jpg|gif)$/;
function cleanWebsite(raw) {
  let v = str(raw, 200); if (!v) return '';
  if (/[\s<>"']/.test(v)) bad('Website must be a valid https:// URL');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v) && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/.*)?$/.test(v)) v = 'https://' + v;
  let u; try { u = new URL(v); } catch { bad('Website must be a valid https:// URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || !u.hostname.includes('.')) bad('Website must be a valid https:// URL');
  return u.toString();
}
function cleanX(raw) {
  let v = str(raw, 200); if (!v) return '';
  if (/[\s<>"']/.test(v)) bad('X link must be an x.com/handle URL or @handle');
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(v)) return 'https://x.com/' + v.replace(/^@/, '');
  if (/^(?:www\.)?(x|twitter)\.com\//i.test(v)) v = 'https://' + v;
  let u; try { u = new URL(v); } catch { bad('X link must be an x.com/handle URL or @handle'); }
  if (!['https:', 'http:'].includes(u.protocol) || !/^(?:www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) bad('X link must be an x.com/handle URL or @handle');
  const seg = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!seg) bad('X link must include a handle or page path');
  const m = seg.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (m) return 'https://x.com/' + m[1];
  return 'https://x.com/' + seg;
}
function cleanDiscord(raw) {
  let v = str(raw, 200); if (!v) return '';
  if (/[\s<>"']/.test(v)) bad('Discord link must be a discord.gg or discord.com URL');
  if (/^(?:www\.)?(discord\.gg|discord\.com|discordapp\.com)\//i.test(v)) v = 'https://' + v;
  let u; try { u = new URL(v); } catch { bad('Discord link must be a discord.gg or discord.com URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || !/^(?:www\.)?(discord\.gg|discord\.com|discordapp\.com)$/i.test(u.hostname)) bad('Discord link must be a discord.gg or discord.com URL');
  if (u.pathname === '/' || !u.pathname) bad('Discord link must include an invite code');
  return 'https://' + u.hostname.replace(/^www\./i, '').toLowerCase() + u.pathname;
}
function cleanLinks(b) { return { website: cleanWebsite(b.website), x: cleanX(b.x), discord: cleanDiscord(b.discord) }; }

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
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const r = await osFetch(env, `/listings/collection/${s}/all?limit=100${cursor ? '&next=' + encodeURIComponent(cursor) : ''}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) break;
      for (const l of j.listings || []) {
        const offer = l.protocol_data?.parameters?.offer?.[0]; const p = l.price?.current; if (!offer || !p) continue;
        if (lc(offer.token) !== lc(d.address)) continue;
        const row = { chain: d.chain, id: Number(offer.identifierOrCriteria), price: Number(p.value) / 10 ** p.decimals, currency: p.currency, orderHash: l.order_hash, protocolAddress: l.protocol_address, seller: lc(l.protocol_data?.parameters?.offerer) || undefined };
        const img = l.display_image_url || l.image_url || l.asset?.display_image_url || l.asset?.image_url;
        const name = l.asset?.name || l.item?.name;
        if (img) row.image = img;
        if (name) row.name = name;
        out.push(row);
      }
      cursor = j.next || '';
      if (!cursor) break;
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
  for (const s of slugs) {
    await caches.default.delete(new Request('https://cache.multisea/l:' + s)).catch(() => {});
    await caches.default.delete(new Request('https://cache.multisea/l2:' + s)).catch(() => {});
  }
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
let _offers; const offers = () => (_offers ??= makeOffers({ CFG, chains, bad, HASH, getCollection, feeWallet, cached, royaltyFor: (env, slug, chain) => native().royaltyFor(env, slug, chain), hooks: { onSale: (env, s) => growth().recordSale(env, s) } }));
// Launchpad: factory isDrop() check runs on the chain's public RPC; approvals need the LAUNCHPAD_APPROVER_KEY secret.
const isDropOnChain = async (k, factory, drop) => { const c = chains[k]; if (!c) return false; const pc = createPublicClient({ transport: http(c.rpc) });
  const abi = (name) => [{ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }];
  if (await pc.readContract({ address: factory, abi: abi('isDrop'), functionName: 'isDrop', args: [drop] }).catch(() => false)) return true;
  return pc.readContract({ address: factory, abi: abi('isPacks'), functionName: 'isPacks', args: [drop] }).catch(() => false); };
let _launchpad; let _launchpadT;
// Staging Worker (multisea-api-staging): LP_NETWORK = 'testnet' swaps in the testnet factories / escrows / chains.
const TCH = Object.fromEntries(Object.entries(LPT0.chains).map(([k, c]) => [k, { chainId: c.chainId, rpc: c.rpc, name: c.name, native: c.native, explorer: c.explorer }]));
const isDropOnTestnet = async (k, factory, drop) => { const c = TCH[k]; if (!c) return false; const pc = createPublicClient({ transport: http(c.rpc) });
  const abi = (name) => [{ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }];
  if (await pc.readContract({ address: factory, abi: abi('isDrop'), functionName: 'isDrop', args: [drop] }).catch(() => false)) return true;
  return pc.readContract({ address: factory, abi: abi('isPacks'), functionName: 'isPacks', args: [drop] }).catch(() => false); };
const launchpad = env => env?.LP_NETWORK === 'testnet'
  ? (_launchpadT ??= makeLaunchpad({ LP: { ...LP, ...LPT0.worker, approver: LPT0.worker.approver ?? LPT0.approver ?? null, platformFeeBps: LPT0.platformFeeBps }, chains: TCH, lc, bad, ADDR, admins, requireSession, isDropOnChain: isDropOnTestnet, resnapAuto }))
  : (_launchpad ??= makeLaunchpad({ LP, chains, lc, bad, ADDR, admins, requireSession, isDropOnChain, verifySolana: programId => verifySolanaSetup({ programId, LP, chains }), onDeployed: (env, d, chain, addr) => bridgeAuto().enqueue(env, d, chain, addr), resnapAuto }));
const linkBridge = (...a) => makeLinkBridge({ chains, lc, saveCollectionPatch })(...a);
const publishBridged0 = (...a) => makePublishBridged({ lc, linkBridge })(...a);
let _be; const bridgeEnrich = () => (_be ??= makeBridgeEnrich({ chains, lc, osFetch, osSlugFor, rpcCall, isStatic: s => !!STATIC[s] }));
// Publish finished bridge listings, then fill what Island's-style pages need (OpenSea slugs, logo/banner/description, id range).
const publishBridged = async (env, only) => { const r = await publishBridged0(env, only); await bridgeEnrich().enrichAll(env, { only, force: !!only || r.length > 0 }).catch(e => console.log('bridge enrich', e?.message)); return r; };
// Bridge-listed KV collection (not a static one) for activity / owners / holder chat.
const bridgedCol = async (env, slug) => (STATIC[slug] ? null : (c => (isBridgedCol(c) ? c : null))(await env.COLLECTIONS.get('col:' + slug, 'json')));
const bridgedCols = env => bridgeEnrich().list(env);
let _ba; const bridgeAuto = () => (_ba ??= makeBridgeAuto({ rpcsFor: k => chains[k]?.rpcs, onPublish: async (env, job) => { const slug = await env.COLLECTIONS.get('idx:' + job.native + ':' + job.nft); if (slug) await linkBridge(env, slug); else await publishBridged(env, job.slug); } }));
// EVM message check shared with SIWE: EOA first, then ERC-1271 smart wallets on each chain.
async function verifyEvmMessage(address, message, signature) {
  if (await verifyMessage({ address, message, signature }).catch(() => false)) return true;
  for (const k of ['base', 'ethereum', 'apechain', 'bnb', 'robinhood']) if (chains[k] && await createPublicClient({ transport: http(chains[k].rpc) }).verifyMessage({ address, message, signature }).catch(() => false)) return true;
  return false;
}
let _wl; const walletLink = () => (_wl ??= makeWalletLink({ lc, bad, ADDR, rand, verifyEvm: verifyEvmMessage }));
let _ha; const holderAllow = () => (_ha ??= makeHolderAllow({ CFG, chains, lc, bad, ADDR, rpcFanout, LP, getCollection, walletLink: walletLink() }));
const resnapAuto = (env, d) => holderAllow().resnapDrop(env, d);
let _sollink; const solanaLink = () => (_sollink ??= makeSolanaLink({ lc, bad, ADDR, rand, verifyEvm: verifyEvmMessage, wl: walletLink() }));
let _profiles; const profiles = () => (_profiles ??= makeProfiles({ CFG, lc, bad, ADDR, requireSession, rpcFanout, osFetch, wl: walletLink() }));
let _chat; const holderChat = () => (_chat ??= makeHolderChat({ CFG, lc, bad, ADDR, admins, requireSession, getCollection, rpcFanout, canEdit, getDyn: bridgedCol }));
let _btc; const btcRoutes = () => (_btc ??= makeBtcRoutes({ bad }));
let _activity; const activity = () => (_activity ??= makeActivity({ chains, lc, STATIC, cached, getDyn: bridgedCol, listDyn: bridgedCols }));
let _lzlegs; const lzLegs = () => (_lzlegs ??= makeLzLegs({ LP, chains }));
let _inft; const islandNfts = () => (_inft ??= makeIslandNfts({ CFG, chains, lc, rpcFanout, cached }));
let _owners; const owners = () => (_owners ??= makeOwners({ chains, STATIC, getCollection, lc, getDyn: bridgedCol, listDyn: bridgedCols }));
let _solmeta; const solMeta = () => (_solmeta ??= makeSolMeta({ CFG }));
let _growth; const growth = () => (_growth ??= makeGrowth({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet, admins, requireSession, canEdit, relayFetch, saveCollectionPatch }));

// ---------- router ----------
async function handle(req, env, url, ctx) {
  const p = url.pathname.split('/').filter(Boolean); const M = req.method;
  if (p[0] === 's' || (p[0] === 'r' && p.length === 2)) { const r = await makeShare({ getCollection, STATIC, osStats, cached })(req, env, url, p, ctx); if (r) return r; }
  const body = async () => { const b = await req.json().catch(() => null); if (!b || typeof b !== 'object') bad('invalid JSON'); return b; };

  if (M === 'GET' && p[0] === 'health') return { ok: true, chains: Object.keys(chains), lpNetwork: env.LP_NETWORK || 'mainnet', features: ['buy', 'siwe', 'submit', 'admin', 'edit', 'sell', 'native', 'offers', 'growth', 'launchpad', 'packs', 'btc', 'holder-chat', 'profiles', ...(env.MEDIA ? ['media'] : [])] };
  { const a = await lzLegs()(req, env, url, p, M); if (a !== undefined) return a; }
  { const a = await activity().handle(req, env, url, p, M, ctx); if (a !== undefined) return a; }
  { const n = await islandNfts()(req, env, url, p, M, ctx); if (n !== undefined) return n; }
  // Live owners per static collection, built by the */5 cron (src/owners.js). 404 = not built / too old: the browser reads chain itself.
  if (M === 'GET' && p[0] === 'owners' && p.length === 2) {
    const snap = await owners().get(env, p[1]); if (!snap) bad('no owner snapshot', 404);
    return new Response(JSON.stringify(snap), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60, stale-while-revalidate=240' } });
  }
  // Profiles before growth so GET /profile/nfts is not swallowed by growth's GET /profile/:address.
  { const wr = await walletLink().handle(req, env, url, p, M, body); if (wr !== undefined) return wr; }
  { const sl = await solanaLink().handle(req, env, url, p, M, body); if (sl !== undefined) return sl; }
  { const pr = await profiles().handle(req, env, url, p, M, body); if (pr !== undefined) return pr; }
  { const g = await growth().handle(req, env, url, p, M, body, native()); if (g !== undefined) return g; }
  { const h = await holderChat().handle(req, env, url, p, M, body); if (h !== undefined) return h; }
  { const b = await btcRoutes().handle(req, env, url, p, M, body); if (b !== undefined) return b; }
  // MultiSea bridge auto-listing (see bridgeauto.js). Public: listed collections. Admin: status / run now / retry a failed job.
  if (M === 'GET' && p[0] === 'bridge' && p[1] === 'collections' && p.length === 2) return { collections: await bridgeAuto().collections(env) };
  // Direct listings: after factory.list the site posts the tx; the Worker verifies the Listed event on-chain and queues the mirror job.
  if (M === 'POST' && p[0] === 'bridge' && p[1] === 'direct' && p.length === 2) {
    const b = await body(); let st;
    try { st = await bridgeAuto().enqueueDirect(env, { chain: String(b.chain || ''), tx: String(b.tx || '') }); } catch (e) { if (e.perm) bad(e.message, e.status || 400); throw e; }
    if (env.BRIDGE_OPERATOR_PK && env.LP_NETWORK !== 'testnet' && st.known) ctx?.waitUntil?.(bridgeAuto().run(env).then(r => console.log('bridge run (direct)', JSON.stringify(r))).then(() => publishBridged(env)).catch(e => console.log('bridge run error', e?.message)));
    return st;
  }
  if (M === 'GET' && p[0] === 'bridge' && p[1] === 'direct' && p.length === 4) { if (!ADDR.test(p[3])) bad('bad address'); return bridgeAuto().directStatus(env, p[2], p[3]); }
  if (p[0] === 'admin' && p[1] === 'bridge') {
    const s = await requireSession(req, env); if (!admins(env).includes(s.address)) bad('admin only', 403);
    if (M === 'GET' && p[2] === 'status') return bridgeAuto().status(env);
    if (M === 'POST' && p[2] === 'run') return { results: await bridgeAuto().run(env) };
    if (M === 'POST' && p[2] === 'scan') return { scan: await bridgeAuto().scan(env), results: await bridgeAuto().run(env) };
    if (M === 'POST' && p[2] === 'retry' && p[3]) { const ov = await req.json().catch(() => ({})); const j = await bridgeAuto().retry(env, p[3], ov && typeof ov === 'object' ? ov : {}); if (!j) bad('no job', 404); return { job: j.step }; }
  }
  if (p[0] === 'launchpad' && (p[1] === 'holder-allowlist' || p[1] === 'holder-collections')) {
    if (M === 'POST' && limited('ha:' + (req.headers.get('cf-connecting-ip') || 'local'), 20)) bad('rate limited', 429);
    const h = await holderAllow().handle(req, env, url, p, M, body); if (h !== undefined) return h;
  }
  { const l = await launchpad(env).handle(req, env, url, p, M, body); if (l !== undefined) return l; }

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
    if (!valid) { // ERC-1271 smart wallets (fallback across configured RPCs)
      const key = Object.keys(chains).find(k => chains[k].chainId === f.chainId);
      const tryKeys = key ? [key] : ['base', 'ethereum', 'abstract', 'apechain', 'robinhood', 'bnb'];
      for (const k of tryKeys) {
        const c = chains[k]; if (!c) continue;
        const urls = c.rpcs?.length ? c.rpcs : [c.rpc];
        valid = await createPublicClient({ transport: fallback(urls.map(u => http(u))) }).verifyMessage({ address: f.address, message, signature }).catch(() => false);
        if (valid) break;
      }
    }
    if (!valid) bad('bad signature', 401);
    await holderChat().verifyHolderSignature(env, f);
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
    const cols = (await Promise.all(list.keys.map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(Boolean).map(c => ({ ...c, creator: c.creator || c.submitter || undefined, submitter: undefined }));
    const ovr = Object.fromEntries(await Promise.all(Object.keys(STATIC).map(async s => [s, await env.COLLECTIONS.get('ovr:' + s, 'json')])));
    return { collections: cols, overrides: ovr };
  }
  if (M === 'GET' && p[0] === 'collections' && p.length === 2) { const c = await getCollection(env, p[1]); if (!c) bad('not found', 404); return { collection: { ...c, creator: c.creator || c.submitter || undefined, submitter: undefined } }; }
  if (M === 'GET' && p[0] === 'collections' && p[2] === 'can-edit') { const a = url.searchParams.get('address'); if (!ADDR.test(a || '')) bad('address required'); return await canEdit(env, p[1], a); }

  if (M === 'POST' && p[0] === 'submit') {
    const s = await requireSession(req, env); const b = await body();
    const slug = str(b.slug, 40).toLowerCase();
    if (!slug || !SLUG.test(slug) || RESERVED.has(slug) || STATIC[slug]) bad('Slug must be 3-40 lowercase letters, digits, or dashes (start and end with a letter or digit), and not reserved');
    if ((await env.COLLECTIONS.get('col:' + slug)) || (await env.COLLECTIONS.get('pending:' + slug))) bad('slug already used');
    const name = str(b.name, 60); if (!name) bad('Project name is required');
    const deployments = Array.isArray(b.deployments) ? b.deployments.slice(0, 10) : []; if (!deployments.length) bad('Add at least one chain and contract address');
    const checked = [];
    for (const d of deployments) {
      const addr = String(d?.address || '').trim();
      if (!chains[d?.chain] || !ADDR.test(addr)) bad(`Unsupported chain or invalid contract address${addr ? ': ' + addr.slice(0, 42) : ''}`);
      if (!(await isERC721(d.chain, addr))) bad(`${addr} on ${chains[d.chain].name} is not an ERC-721 contract`);
      checked.push({ chain: d.chain, address: addr.toLowerCase() });
    }
    const escrow = [];
    for (const e of (Array.isArray(b.escrow) ? b.escrow.slice(0, 20) : [])) {
      const addr = String(e?.address || '').trim();
      if (!addr) continue;
      if (!chains[e?.chain] || !ADDR.test(addr)) bad('Invalid escrow address' + (addr ? ': ' + addr.slice(0, 42) : ''));
      escrow.push({ chain: e.chain, address: addr.toLowerCase(), label: str(e.label, 40) });
    }
    const logo = str(b.logo, 120); if (logo && !MEDIA.test(logo)) bad('Invalid logo upload reference — please re-upload');
    const banner = str(b.banner, 120); if (banner && !MEDIA.test(banner)) bad('Invalid banner upload reference — please re-upload');
    const rec = { slug, name, description: str(b.description, 1000), ...cleanLinks(b), logo, banner, deployments: checked, escrow, submitter: s.address, status: 'pending', submittedAt: new Date().toISOString() };
    const key = 'pending:' + slug;
    await env.COLLECTIONS.put(key, JSON.stringify(rec));
    const saved = await env.COLLECTIONS.get(key);
    if (!saved) bad('Submission could not be saved. Please try again.', 503);
    console.log(JSON.stringify({ ev: 'collection-submit', slug, key, submitter: s.address }));
    return { ok: true, status: 'pending', slug, key };
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
    if (M === 'GET' && p.length === 3 && p[2] === 'listings') return listingJson({ listings: await N.listings(env, p[1], ctx) });
    if (M === 'GET' && p[1] === 'order' && p.length === 4) { if (!chains[p[2]] || !HASH.test(p[3])) bad('invalid input'); return await N.getOrder(env, p[2], p[3]); }
    if (M === 'POST' && p[1] === 'list' && p.length === 2) return await N.list(env, await body());
    if (M === 'POST' && p[1] === 'cancelled' && p.length === 2) { const b = await body(); if (!chains[b.chain] || !HASH.test(b.orderHash || '') || (b.txHash && !HASH.test(b.txHash))) bad('invalid input'); return await N.cancelled(env, b.chain, b.orderHash, b.txHash); }
    if (M === 'POST' && p[1] === 'counter' && p.length === 2) { const b = await body(); if (!chains[b.chain] || !ADDR.test(b.seller || '') || (b.txHash && !HASH.test(b.txHash))) bad('invalid input'); return await N.counterBumped(env, b.chain, b.seller, b.txHash); }
    if (M === 'POST' && p[1] === 'remove' && p.length === 2) { const s = await requireSession(req, env); const b = await body(); if (!chains[b.chain] || !HASH.test(b.orderHash || '')) bad('invalid input'); return await N.remove(env, b.chain, b.orderHash, s.address); }
  }


  // --- Collection offers (native-coin escrow; empty until contracts are configured) ---
  if (p[0] === 'offers') {
    const O = offers();
    if (M === 'GET' && p[1] === 'config' && p.length === 3) {
      const col = await getCollection(env, p[2]); if (!col) bad('not found', 404);
      return { feeRecipient: feeWallet(env), feeBps: NATIVE_FEE_BPS, royalty: await native().royaltyFor(env, p[2]), contracts: O.contracts(), chains: Object.fromEntries(Object.entries(chains).map(([k, c]) => [k, { chainId: c.chainId, native: c.native }])), maxExpiryDays: 180 };
    }
    if (M === 'GET' && p.length === 3 && p[2] === 'best') return listingJson(await O.best(env, p[1], ctx));
    if (M === 'GET' && p.length === 2) return listingJson(await O.list(env, p[1], ctx));
    if (M === 'POST' && p[1] === 'sync' && p.length === 2) {
      const b = await body(); if (!chains[b.chain] || !HASH.test(b.txHash || '')) bad('invalid input');
      return await O.sync(env, b.chain, b.txHash);
    }
    bad('not found', 404);
  }

  // --- Chain RPC proxy for browser reads: POST /rpc/:chain, read-only allowlist, fallback across public RPCs. ---
  if (p[0] === 'rpc' && p.length === 2) {
    if (M !== 'POST') bad('method not allowed', 405);
    if (!corsHeaders(req, env)) bad('origin not allowed', 403);
    if (limited('rpc:' + (req.headers.get('cf-connecting-ip') || 'x'), 300)) bad('rate limited', 429);
    const txt = await req.text(); if (txt.length > 64_000) bad('too large', 413);
    let j; try { j = JSON.parse(txt); } catch { bad('bad json'); }
    const calls = Array.isArray(j) ? j : [j]; if (!calls.length || calls.length > 20) bad('bad batch');
    if (p[1] === 'solana') {
      const why = solAllowed(calls); if (why) bad(why, why.startsWith('method') ? 403 : 400);
      try { return new Response(JSON.stringify(await solFanout(j)), { headers: { 'content-type': 'application/json' } }); }
      // Upstream timeout/HTTP errors: JSON-RPC error on 200 so Chrome does not log "Failed to load resource: 500"
      // and the collection page can retry the public RPC from the browser.
      catch (e) { return new Response(JSON.stringify(solRpcError(j, e)), { headers: { 'content-type': 'application/json' } }); }
    }
    const c = chains[p[1]]; if (!c) bad('unknown chain', 404);
    for (const x of calls) if (!RPC_READ.has(x?.method)) bad('method not allowed: ' + String(x?.method).slice(0, 40), 403);
    // Rarely-changing contract reads (phases(), supply counters, name...) are cached briefly per call (src/rpccache.js).
    const ttls = calls.map(rpcCacheTtl);
    if (ttls.every(t => t > 0)) {
      const out = await Promise.all(calls.map(async (x, i) => {
        const res = await cached(await rpcCacheKey(p[1], x), ttls[i], async () => { const r = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: x.method, params: x.params }); if (r?.error && !(r.error.code === 3 || /revert/i.test(r.error.message || ''))) throw new Error('rpc error'); return r?.error ? { error: r.error } : { result: r.result }; }, ttls[i], ctx)
          .catch(() => null);
        return res ? { jsonrpc: '2.0', id: x.id ?? null, ...(res.error ? { error: res.error } : { result: res.result }) } : null;
      }));
      if (out.every(Boolean)) return new Response(JSON.stringify(Array.isArray(j) ? out : out[0]), { headers: { 'content-type': 'application/json', 'x-ms-rpc-cache': '1' } });
    }
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
      const linked = await linkBridge(env, p[2], col).catch(e => { console.log('bridge link failed', e?.message); return null; }); // mirrors of a direct listing that finished before approval
      return { ok: true, status: 'approved', collection: linked || col };
    }
  }

  // --- owner edits ---
  if (M === 'POST' && p[0] === 'collections' && p[2] === 'update') {
    const s = await requireSession(req, env); const slug = p[1];
    const perm = await canEdit(env, slug, s.address); if (!perm.ok) bad('only the collection owner can edit', 403);
    const b = await body();
    const patch = { ...(b.description != null ? { description: str(b.description, 1000) } : {}), ...cleanLinks(b), ...(b.logo != null ? { logo: str(b.logo, 120, MEDIA) } : {}), ...(b.banner != null ? { banner: str(b.banner, 120, MEDIA) } : {}), updatedBy: s.address, updatedAt: new Date().toISOString() };
    for (const k of ['website', 'x', 'discord']) if (b[k] == null) delete patch[k];
    if (b.royalty !== undefined) {
      const r = b.royalty; const keep = (await getCollection(env, slug))?.royalty?.vaults; // RevShareVault routing survives royalty edits
      if (r === null || !r.bps) patch.royalty = keep && Object.keys(keep).length ? { recipient: lc(r?.recipient && ADDR.test(r.recipient) ? r.recipient : ''), bps: 0, vaults: keep } : null;
      else { if (!ADDR.test(r.recipient || '') || !Number.isFinite(+r.bps) || +r.bps < 0 || +r.bps > 1000) bad('royalty: recipient address and 0-10% required'); patch.royalty = { recipient: lc(r.recipient), bps: Math.floor(+r.bps), ...(keep && Object.keys(keep).length ? { vaults: keep } : {}) }; }
    }
    if (STATIC[slug]) { const cur = (await env.COLLECTIONS.get('ovr:' + slug, 'json')) || {}; const v = { ...cur, ...patch }; await env.COLLECTIONS.put('ovr:' + slug, JSON.stringify(v)); return { ok: true, collection: v, via: perm.why }; }
    const cur = await env.COLLECTIONS.get('col:' + slug, 'json'); if (!cur) bad('not found', 404);
    const v = { ...cur, ...patch }; await env.COLLECTIONS.put('col:' + slug, JSON.stringify(v)); return { ok: true, collection: { ...v, creator: v.creator || v.submitter || undefined, submitter: undefined }, via: perm.why };
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
    // Edge cache: FW_TTL s for a full answer, FW_TTL_PARTIAL s when a chain failed (was 120 / 15). `?fresh=1` (the page's
    // Refresh button) skips the cache, but only once the cached copy is FW_MIN_AGE s old, so a foot costs at most one
    // OpenSea fan-out per FW_MIN_AGE s however often it is clicked (plus the per-IP 60/min API limit).
    const key = `fw:${id}`; const cache = caches.default; const creq = new Request('https://cache.multisea/' + key);
    const fresh = url.searchParams.get('fresh') === '1';
    const hit = await cache.match(creq);
    if (hit) { const v = await hit.json(); if (!fresh || Date.now() - (v.at || 0) < FW_MIN_AGE * 1000) return { ...v, cached: true }; }
    const parts = await Promise.all(FOOT_CHAINS.map(k => (chains[k]?.openseaSlug ? one(k, chains[k].openseaSlug) : [])));
    const nfts = parts.flat(); const failed = nfts.filter(n => n.error).map(n => n.chain);
    const val = { id, account: tba, nfts: nfts.filter(n => !n.error), failed, unsupported: FOOT_CHAINS.filter(k => !chains[k]?.openseaSlug), at: Date.now() };
    await cache.put(creq, new Response(JSON.stringify(val), { headers: { 'cache-control': `public, max-age=${failed.length ? FW_TTL_PARTIAL : FW_TTL}` } }));
    return val;
  }

  // --- per-collection live data (OpenSea, cached) ---
  if (M === 'GET' && p[0] === 'os' && p.length === 3) {
    if (!env.OPENSEA_API_KEY) bad('server not configured', 503);
    const col = await getCollection(env, p[1]); if (!col || col.status !== 'approved') bad('not found', 404);
    if (p[2] === 'listings') return listingJson({ listings: await cached(`l2:${p[1]}`, LISTING_TTL, () => osListings(env, col), LISTING_SWR, ctx) });
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
  async scheduled(event, env, ctx) {
    // '*/5 * * * *': live owner snapshots (GET /owners/<slug>), Island wallet NFT counts, and collection activity (GET /activity/<slug>).
    if (event?.cron === '*/5 * * * *') {
      ctx.waitUntil(owners().refreshAll(env).then(r => console.log('owners', JSON.stringify(r))).catch(e => console.log('owners error', e?.message)));
      ctx.waitUntil(islandNfts().warm?.(env, ctx)?.then(r => console.log('island nfts warm', r)).catch(e => console.log('island nfts warm error', e?.message)));
      ctx.waitUntil(activity().refreshAll(env).then(r => console.log('activity', JSON.stringify(r))).catch(e => console.log('activity error', e?.message)));
      return;
    }
    // '*/15 * * * *' (and any other trigger): re-validate native listings, then precompute each collection's listings into KV.
    ctx.waitUntil(native().sweep(env).then(r => console.log('native sweep', JSON.stringify(r)))
      .then(() => native().precompute(env, Object.keys(STATIC))).then(r => console.log('native precompute', JSON.stringify(r))).catch(e => console.log('native sweep error', e?.message)));
    ctx.waitUntil(offers().sweep(env).then(r => console.log('offers sweep', JSON.stringify(r))).catch(e => console.log('offers sweep error', e?.message)));
    if (env.BRIDGE_OPERATOR_PK && env.LP_NETWORK !== 'testnet') ctx.waitUntil(bridgeAuto().scan(env).then(r => console.log('bridge scan', JSON.stringify(r))).catch(e => console.log('bridge scan error', e?.message)).then(() => bridgeAuto().run(env)).then(r => console.log('bridge auto', JSON.stringify(r))).then(() => publishBridged(env)).then(r => r.length && console.log('bridge published', JSON.stringify(r))).catch(e => console.log('bridge auto error', e?.message)));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url); const ch = corsHeaders(req, env); const H = ch || {};
    // Flood cap first (~200 req/s per IP via the FLOOD ratelimit binding). CORS headers stay on 429.
    const blocked = await floodBlock(env, req, H); if (blocked) return blocked;
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    // Public marketplace metadata/images (solmeta.js): any origin, no per-minute IP budget (edge-cached, immutable; ME's CDN fetches in bursts). Still counted in FLOOD.
    if (url.pathname.startsWith('/sol/meta/') || url.pathname.startsWith('/sol/img/')) { const r = await solMeta()(req, env, url, ctx); if (r) return r; }
    if (url.pathname.startsWith('/onchain-uri/')) { const r = await handleOnchainUri(req, env, url, { chains: { ...chains, ...(LP.mainnet?.chains || {}) }, kv: env.COLLECTIONS }); if (r) return r; }
    if (req.headers.get('origin') && !ch) return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers: { 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    // Separate buckets: RPC/media/owner-snapshot traffic (300/min) must not use up the 60/min budget of listings, buy and API routes.
    const heavy = url.pathname.startsWith('/media/') || url.pathname.startsWith('/rpc/') || url.pathname.startsWith('/owners/'); // /owners replaces ~140 browser RPC calls
    if (limited((heavy ? 'h:' : 'a:') + ip, heavy ? 300 : 60)) return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '10', ...H } });
    const ttl = edgeTtl(url, req);
    const cache = globalThis.caches?.default;
    if (ttl && cache) {
      const hit = await cache.match(edgeCacheKey(url)).catch(() => null);
      if (hit) { const r = new Response(hit.body, hit); r.headers.set('cache-control', `public, max-age=${ttl}`); for (const [k, v] of Object.entries(H)) r.headers.set(k, v); return r; }
    }
    try {
      const out = await handle(req, env, url, ctx);
      const res = out instanceof Response ? out : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
      for (const [k, v] of Object.entries(H)) res.headers.set(k, v);
      if (ttl && res.ok && !res.headers.has('cache-control')) res.headers.set('cache-control', `public, max-age=${ttl}`);
      if (ttl && res.ok && cache) {
        const store = new Response(res.clone().body, { headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': `public, max-age=${ttl}`, 'x-ms-cached-at': String(Date.now()) } });
        const put = cache.put(edgeCacheKey(url), store).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
      }
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return new Response(JSON.stringify({ error: e instanceof HttpError ? e.message : 'internal', ...(e.extra || {}), ...(status === 500 ? { message: String(e).slice(0, 200) } : {}) }), { status, headers: { 'content-type': 'application/json', ...H } });
    }
  },
};
