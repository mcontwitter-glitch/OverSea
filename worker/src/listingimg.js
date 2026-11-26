// Attach image (and name) to OpenSea listings for dyn collection pages.
// Lookup order per token: KV cache, OpenSea NFT endpoint (rate-capped), then tokenURI metadata.
// Images are cached in KV for 14 days so later listing fetches do not hit OpenSea again.
import { kput } from './kvput.js';

const TTL = 14 * 24 * 3600;
const OS_BUDGET = 12; // leave room in the 60/min OpenSea budget for the listings pages themselves
const CONCURRENCY = 10;
const GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];

const ipfs = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('ipfs://')) return GATEWAYS[0] + s.slice(7).replace(/^ipfs\//, '');
  return s;
};
function decodeString(hex) {
  try {
    const h = String(hex || '').replace(/^0x/, ''); if (h.length < 128) return '';
    const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16); if (!len || len > 100000) return '';
    const b = h.slice(off + 64, off + 64 + len * 2);
    return new TextDecoder().decode(Uint8Array.from(b.match(/../g).map(x => parseInt(x, 16))));
  } catch { return ''; }
}
async function jsonFrom(uri, fetchImpl) {
  if (!uri) return null;
  try {
    if (uri.startsWith('data:application/json;base64,')) return JSON.parse(atob(uri.slice(29)));
    if (uri.startsWith('data:application/json')) return JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)));
    const path = String(uri).replace(/^ipfs:\/\//, '').replace(/^https?:\/\/[^/]+\/ipfs\//, '');
    const urls = /^https?:\/\//.test(uri) && !/\/ipfs\//.test(uri)
      ? [uri]
      : [/\/ipfs\//.test(uri) ? uri : null, ...GATEWAYS.map(g => g + path)].filter(Boolean);
    for (const u of urls) {
      try {
        const r = await fetchImpl(u, { signal: AbortSignal.timeout(10000) });
        if (r.ok) return await r.json();
      } catch {}
    }
  } catch {}
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) || 0 }, async () => {
    for (;;) { const j = i++; if (j >= items.length) return; out[j] = await fn(items[j], j); }
  }));
  return out;
}

export function makeListingImages({ chains, lc, osFetch, rpcCall, fetchImpl = fetch }) {
  const keyOf = (chain, contract, id) => `nftimg:${chain}:${lc(contract)}:${id}`;

  async function fromOS(env, chain, contract, id) {
    const os = chains[chain]?.openseaSlug; if (!os) return null;
    const r = await osFetch(env, `/chain/${os}/contract/${contract}/nfts/${id}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    const n = j.nft || j;
    const image = n.display_image_url || n.image_url || '';
    const name = n.name || '';
    return image ? { image, name } : null;
  }
  async function tokenURI(chain, contract, id, prefix) {
    if (prefix) return prefix + id + (prefix.endsWith('.json') ? '' : '');
    const hex = await rpcCall(chain, contract, '0xc87b56dd' + BigInt(id).toString(16).padStart(64, '0'));
    return decodeString(hex) || '';
  }
  function prefixOf(uri) {
    const m = String(uri || '').match(/^(.*\/)\d+(\.json)?$/);
    return m ? m[1] + (m[2] && !m[1].endsWith('.json') ? '' : '') : '';
  }
  async function fromURI(chain, contract, id, prefix) {
    const uri = await tokenURI(chain, contract, id, prefix);
    if (!uri) return null;
    const meta = await jsonFrom(uri, fetchImpl);
    if (!meta) return { uri };
    const image = ipfs(meta.image || meta.image_url || '');
    const name = meta.name || '';
    return { image, name, uri, prefix: prefixOf(uri) };
  }

  async function enrich(env, col, listings, ctx) {
    if (!listings?.length) return listings || [];
    const seen = new Map(); // chain:id -> {chain, contract, id}
    for (const l of listings) {
      const k = l.chain + ':' + l.id; if (seen.has(k)) continue;
      const dep = (col.deployments || []).find(d => d.chain === l.chain); if (!dep) continue;
      seen.set(k, { chain: l.chain, contract: dep.address, id: l.id, k });
    }
    const jobs = [...seen.values()];
    const cached = await Promise.all(jobs.map(j => env.COLLECTIONS.get(keyOf(j.chain, j.contract, j.id), 'json').catch(() => null)));
    const have = new Map(); // k -> {image,name}
    const miss = [];
    jobs.forEach((j, i) => { if (cached[i]?.image) have.set(j.k, { image: cached[i].image, name: cached[i].name || '' }); else miss.push(j); });

    // Learn a tokenURI prefix (…/id) from one RPC, then fetch metadata for the rest without more eth_calls.
    // OpenSea is the fallback, capped, so a listings page does not burn the 60/min budget.
    const prefixBy = {};
    const byContract = new Map();
    for (const j of miss) { const pk = j.chain + ':' + lc(j.contract); (byContract.get(pk) || byContract.set(pk, []).get(pk)).push(j); }
    for (const [pk, js] of byContract) {
      const rec = await fromURI(js[0].chain, js[0].contract, js[0].id, '').catch(() => null);
      if (rec?.prefix) prefixBy[pk] = rec.prefix;
    }
    let osLeft = OS_BUDGET;
    const writes = [];
    await pool(miss, CONCURRENCY, async (j) => {
      const pk = j.chain + ':' + lc(j.contract);
      let rec = await fromURI(j.chain, j.contract, j.id, prefixBy[pk] || '').catch(() => null);
      if (rec?.prefix) prefixBy[pk] = rec.prefix;
      if (!rec?.image && osLeft > 0) { osLeft--; rec = await fromOS(env, j.chain, j.contract, j.id).catch(() => null); }
      if (!rec?.image) return;
      rec = { image: ipfs(rec.image), name: rec.name || '' };
      have.set(j.k, rec);
      writes.push(kput(env.COLLECTIONS, keyOf(j.chain, j.contract, j.id), JSON.stringify({ ...rec, at: Date.now() }), { expirationTtl: TTL }).catch(() => {}));
    });
    const done = Promise.all(writes);
    if (ctx?.waitUntil) ctx.waitUntil(done); else await done;

    for (const l of listings) {
      const rec = have.get(l.chain + ':' + l.id);
      if (rec?.image) { l.image = rec.image; if (rec.name) l.name = rec.name; }
    }
    return listings;
  }

  return { enrich, ipfs, jsonFrom, decodeString };
}
