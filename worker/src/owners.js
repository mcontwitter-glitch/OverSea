// Worker-computed live ownership (ownerOf via Multicall3) for the static collections, so the collection page makes one
// request (GET /owners/<slug>) instead of ~23 eth_calls per chain against public RPCs from every visitor's browser.
// Built by the */5 cron (scheduled 'owners' job) into KV 'owners:<slug>'; written only when something changed or the stored
// copy is older than OWNERS_REWRITE_SEC (keeps KV writes low). The browser falls back to its own RPC sweep for any chain
// listed in `failed`, or entirely if the endpoint is unavailable (src/liveowners.ts).
import { rpcRace } from './rpcrace.js';

export const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const OWNERS_CHUNK = 200, OWNERS_FALLBACK = 20;
export const OWNERS_REWRITE_SEC = 3600;   // rewrite an unchanged snapshot at most hourly (refreshes `at`)
export const OWNERS_MAX_AGE_SEC = 3 * 3600; // older than this: the endpoint reports 404 so browsers read chain themselves
const OWNER_OF = '6352211e', AGG3 = '82ad56cb';
const word = n => n.toString(16).padStart(64, '0');

/** aggregate3((address,bool,bytes)[]) calldata for ownerOf(id) on one token, allowFailure = true. */
export function encodeOwnerOfBatch(token, ids) {
  const t = token.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const n = ids.length, TUPLE = 192; // 3 head words + bytes length + 36 bytes padded to 64
  let head = '', tail = '';
  for (let i = 0; i < n; i++) {
    head += word(BigInt(n * 32 + i * TUPLE));
    tail += t + word(1n) + word(96n) + word(36n) + (OWNER_OF + word(BigInt(ids[i]))).padEnd(128, '0');
  }
  return '0x' + AGG3 + word(32n) + word(BigInt(n)) + head + tail;
}

/** Decode the (bool success, bytes returnData)[] result of aggregate3. Returns [{ ok, data }] (data hex without 0x). */
export function decodeAggregate3(hex) {
  const h = hex.replace(/^0x/, ''); const at = w => parseInt(h.slice(w * 2, w * 2 + 64), 16);
  const base = at(0); const n = at(base); const arr = base + 32; const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const tup = arr + at(arr + i * 32);
    const ok = at(tup) === 1; const bOff = tup + at(tup + 32); const len = at(bOff);
    out[i] = { ok, data: h.slice((bOff + 32) * 2, (bOff + 32 + len) * 2) };
  }
  return out;
}

const ZERO = '0'.repeat(40);
/** ownerOf for `ids` on one chain; Map id -> lowercase owner (missing = unminted/burned/reverted). Throws if a chunk can't be read. */
export async function ownersOnChain(urls, token, ids, { race = rpcRace, concurrency = 4 } = {}) {
  const out = new Map(); let rid = 0;
  const call = async part => {
    const res = await race(urls, { jsonrpc: '2.0', id: ++rid, method: 'eth_call', params: [{ to: MC3, data: encodeOwnerOfBatch(token, part) }, 'latest'] }, { timeoutMs: 8000, hedgeMs: 1500 });
    if (res?.error || typeof res?.result !== 'string' || res.result.length < 130) throw new Error('multicall failed: ' + (res?.error?.message || 'empty'));
    const r = decodeAggregate3(res.result); if (r.length !== part.length) throw new Error('owner read incomplete');
    r.forEach((x, i) => { if (x.ok && x.data.length >= 64) { const a = x.data.slice(24, 64); if (a !== ZERO) out.set(part[i], '0x' + a); } });
  };
  const read = async part => {
    try { await call(part); }
    catch (e) { if (part.length <= OWNERS_FALLBACK) throw e; for (let i = 0; i < part.length; i += OWNERS_FALLBACK) await call(part.slice(i, i + OWNERS_FALLBACK)); }
  };
  const parts = []; for (let i = 0; i < ids.length; i += OWNERS_CHUNK) parts.push(ids.slice(i, i + OWNERS_CHUNK));
  let k = 0; await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, async () => { while (k < parts.length) await read(parts[k++]); }));
  return out;
}

/** Compact snapshot: { v, slug, at, idStart, idEnd, addrs, chains: { <chain>: { address, o: [addrIndex | -1 per id] } }, failed }. */
export function packOwners(slug, idStart, idEnd, perChain, failed, at = Date.now()) {
  const addrs = [], idx = new Map(); const chains = {};
  for (const [chain, { address, map }] of Object.entries(perChain)) {
    const o = new Array(idEnd - idStart + 1);
    for (let id = idStart; id <= idEnd; id++) {
      const a = map.get(id); if (!a) { o[id - idStart] = -1; continue; }
      let j = idx.get(a); if (j == null) { j = addrs.length; addrs.push(a); idx.set(a, j); }
      o[id - idStart] = j;
    }
    chains[chain] = { address: address.toLowerCase(), o };
  }
  return { v: 1, slug, at, idStart, idEnd, addrs, chains, failed };
}

export function makeOwners({ chains, STATIC, getCollection, lc, getDyn = async () => null, listDyn = async () => [] }) {
  const urlsOf = k => { const c = chains[k]; return c ? (c.rpcs?.length ? c.rpcs : [c.rpc]) : null; };
  async function build(env, slug) {
    const st = STATIC[slug] || await getDyn(env, slug); if (!st?.idEnd) return null; // bridge-listed: idStart/idEnd set at publish
    const col = STATIC[slug] ? ((await getCollection(env, slug)) || st) : st;
    const ids = Array.from({ length: st.idEnd - st.idStart + 1 }, (_, i) => st.idStart + i);
    const perChain = {}, failed = [];
    await Promise.all((col.deployments || []).map(async d => {
      const urls = urlsOf(d.chain); if (!urls) return; // non-EVM (e.g. bitcoin): browser handles it
      try { perChain[d.chain] = { address: d.address, map: await ownersOnChain(urls, d.address, ids) }; }
      catch (e) { failed.push(d.chain); console.log('owners', slug, d.chain, e?.message); }
    }));
    if (!Object.keys(perChain).length) return null;
    return packOwners(slug, st.idStart, st.idEnd, perChain, failed);
  }
  // Cron: rebuild every static collection; write only on change (or hourly) to keep KV writes low.
  async function refreshAll(env) {
    const res = {};
    const dyn = (await listDyn(env).catch(() => [])).map(c => c.slug).filter(s => !STATIC[s]);
    for (const slug of [...Object.keys(STATIC), ...dyn]) {
      try {
        const snap = await build(env, slug); if (!snap) { res[slug] = 'skip'; continue; }
        const prev = await env.COLLECTIONS.get('owners:' + slug, 'json');
        const same = prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...snap, at: 0 });
        if (same && Date.now() - prev.at < OWNERS_REWRITE_SEC * 1000) { res[slug] = 'unchanged'; continue; }
        await env.COLLECTIONS.put('owners:' + slug, JSON.stringify(snap));
        await caches.default?.delete(new Request('https://cache.multisea/owners:' + slug)).catch(() => {});
        res[slug] = { chains: Object.keys(snap.chains).length, failed: snap.failed, addrs: snap.addrs.length };
      } catch (e) { res[slug] = 'error ' + (e?.message || e); }
    }
    return res;
  }
  function unpack(s) {
    const out = {};
    for (const [c, v] of Object.entries(s.chains)) { const map = new Map(); v.o.forEach((j, i) => { if (j >= 0) map.set(s.idStart + i, s.addrs[j]); }); out[c] = { address: v.address, map }; }
    return out;
  }
  async function get(env, slug) {
    const s = await env.COLLECTIONS.get('owners:' + slug, 'json');
    if (!s || Date.now() - s.at > OWNERS_MAX_AGE_SEC * 1000) return null;
    return s;
  }
  return { build, refreshAll, get, unpack };
}
