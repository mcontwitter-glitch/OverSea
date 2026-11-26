// Bridge-listed collections (auto-published from a paid bridge listing, see bridgelink.js) get what Island's page has:
// OpenSea slug per chain (chain marketplace links), logo / banner / description, and the token id range that the
// owners snapshot, holder counts and holder chat use. Sources in order: OpenSea collection metadata for the native
// contract, then the contract's contractURI(), then a token image. Fields the owner edited are never replaced: a field is
// filled only when empty, or when it still holds the value this filled in before (col.auto[field]), or when nobody has
// edited the record (no updatedBy) and it is not an uploaded /media/ file.
import { kput } from './kvput.js';

export const isBridgedCol = c => !!c && !c.static && c.status === 'approved' && (c.source === 'bridge-listing' || ((c.escrow || []).length > 0 && (c.deployments || []).length > 1));

const ipfs = u => String(u || '').replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/');
function decodeString(hex) {
  try { const h = String(hex || '').replace(/^0x/, ''); if (h.length < 128) return '';
    const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16); if (!len || len > 100000) return '';
    const b = h.slice(off + 64, off + 64 + len * 2); return new TextDecoder().decode(Uint8Array.from(b.match(/../g).map(x => parseInt(x, 16))));
  } catch { return ''; }
}
async function jsonFrom(uri, fetchImpl) {
  if (!uri) return null;
  try {
    if (uri.startsWith('data:application/json;base64,')) return JSON.parse(atob(uri.slice(29)));
    if (uri.startsWith('data:application/json')) return JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)));
    const r = await fetchImpl(ipfs(uri), { signal: AbortSignal.timeout(10000) }); return r.ok ? await r.json() : null;
  } catch { return null; }
}

export function makeBridgeEnrich({ chains, lc, osFetch, osSlugFor, rpcCall, isStatic = () => false, fetchImpl = fetch }) {
  async function list(env) {
    const K = env.COLLECTIONS; const names = []; let cursor;
    do { const l = await K.list({ prefix: 'col:', cursor }); names.push(...l.keys.map(k => k.name)); cursor = l.list_complete ? undefined : l.cursor; } while (cursor);
    return (await Promise.all(names.map(n => K.get(n, 'json')))).filter(c => isBridgedCol(c) && !isStatic(c.slug)); // static pages (Island's) have their own config
  }
  async function meta(env, col) {
    const out = {}; const openseaSlugs = {};
    for (const d of col.deployments || []) { if (!chains[d.chain]?.openseaSlug) continue; const s = await osSlugFor(env, d.chain, d.address).catch(() => null); if (s) openseaSlugs[d.chain] = s; }
    const nat = col.deployments?.[0];
    const os = nat && openseaSlugs[nat.chain];
    if (os) { const j = await (await osFetch(env, `/collections/${os}`)).json().catch(() => ({}));
      out.logo = j.image_url || ''; out.banner = j.banner_image_url || ''; out.description = j.description || ''; }
    if (nat && (!out.logo || !out.banner || !out.description)) {
      const m = await jsonFrom(decodeString(await rpcCall(nat.chain, nat.address, '0xe8a3d485').catch(() => null)), fetchImpl); // contractURI()
      if (m) { out.logo ||= ipfs(m.image || m.image_url || ''); out.banner ||= ipfs(m.banner_image || m.banner_image_url || ''); out.description ||= String(m.description || ''); }
    }
    if (nat && !out.logo && chains[nat.chain]?.openseaSlug) {
      const j = await (await osFetch(env, `/chain/${chains[nat.chain].openseaSlug}/contract/${nat.address}/nfts?limit=1`)).json().catch(() => ({}));
      out.logo = j.nfts?.[0]?.display_image_url || j.nfts?.[0]?.image_url || '';
    }
    out.description = String(out.description || '').slice(0, 1000);
    return { openseaSlugs, ...out };
  }
  async function enrich(env, col, { force = false } = {}) {
    const K = env.COLLECTIONS;
    if (!force && col.enrichedAt && Date.now() - Date.parse(col.enrichedAt) < 24 * 3600 * 1000) return null;
    const m = await meta(env, col); const auto = { ...(col.auto || {}) }; const patch = {};
    const replaceable = f => { const v = col[f]; if (!v) return true; if (auto[f] && v === auto[f]) return true; return !col.updatedBy && !String(v).startsWith('/media/'); };
    for (const f of ['logo', 'banner', 'description']) if (m[f] && replaceable(f) && col[f] !== m[f]) { patch[f] = m[f]; auto[f] = m[f]; }
    if (Object.keys(m.openseaSlugs).length) patch.openseaSlugs = { ...(col.openseaSlugs || {}), ...m.openseaSlugs };
    if (!col.idEnd || !col.supply) {
      const job = await K.get('bjob:' + col.slug, 'json');
      if (job?.supply > 0) { const s = Number.isInteger(job.firstId) ? job.firstId : 1; if (!col.idEnd) { patch.idStart = s; patch.idEnd = s + job.supply - 1; } if (!col.supply) patch.supply = job.supply; }
    }
    if (!col.supply && !patch.supply && (col.idEnd || patch.idEnd)) {
      const start = Number(patch.idStart || col.idStart) || 1, end = Number(patch.idEnd || col.idEnd);
      if (end >= start) patch.supply = end - start + 1;
    }
    const cur = (await K.get('col:' + col.slug, 'json')) || col; // re-read: never clobber an edit made while this ran
    const v = { ...cur, ...patch, auto, enrichedAt: new Date().toISOString() };
    for (const f of ['logo', 'banner', 'description']) if (patch[f] && cur[f] !== col[f]) { v[f] = cur[f]; delete auto[f]; }
    await kput(K, 'col:' + col.slug, JSON.stringify(v));
    return { slug: col.slug, set: Object.keys(patch) };
  }
  async function enrichAll(env, opts = {}) {
    const out = [];
    for (const c of await list(env)) { if (opts.only && c.slug !== opts.only) continue; try { const r = await enrich(env, c, opts); if (r) out.push(r); } catch (e) { out.push({ slug: c.slug, err: String(e?.message || e).slice(0, 120) }); } }
    return out;
  }
  return { list, meta, enrich, enrichAll };
}
