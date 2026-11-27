// Public IPFS image proxy: GET /img/ipfs/<cid>[/path]
// Tries several gateways with a timeout, then edge-caches the first real image. Used so collection grids
// do not depend on a single gateway (filebase) that often times out on phones.
export const GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://gw.ipfs-lens.dev/ipfs/',
  'https://nftstorage.link/ipfs/',
];
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[kmiy][a-z2-7]{50,}|bae[a-z2-7]{50,})(\/.*)?$/i;
const PROXY = 'https://api.multisea.io/img/ipfs/';

/** Path inside /ipfs/... if `u` is ipfs:// or a known public gateway URL; otherwise ''. */
export function ipfsPath(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  const m = s.match(/^(?:ipfs:\/\/(?:ipfs\/)?|https?:\/\/[^/]+\/(?:ipfs\/)+)(.+?)(?:\?.*)?$/i);
  if (!m) return '';
  const path = m[1].replace(/^ipfs\//, '').replace(/\/+$/, '');
  return CID.test(path) ? path : '';
}

/** Browser-facing URL: IPFS content goes through this Worker; other https URLs pass through. */
export function publicImage(u, origin = 'https://api.multisea.io') {
  const path = ipfsPath(u);
  if (path) return `${String(origin).replace(/\/$/, '')}/img/ipfs/${path}`;
  const s = String(u || '').trim();
  return /^https:\/\//i.test(s) || s.startsWith('data:image/') ? s : '';
}

export function makeIpfsImg({ fetchImpl = fetch } = {}) {
  async function fetchFromGateways(path, ms = 12000) {
    let last = 'no gateway';
    for (const g of GATEWAYS) {
      try {
        const r = await fetchImpl(g + path, { signal: AbortSignal.timeout(ms), cf: { cacheTtl: 86400, cacheEverything: true } });
        const t = r.headers.get('content-type') || '';
        if (r.ok && !/text\/html/i.test(t) && (t.startsWith('image/') || t.includes('octet-stream') || t === 'application/octet-stream' || !t)) return r;
        last = `${g} ${r.status} ${t}`.trim();
      } catch (e) { last = `${g} ${e?.name || e}`; }
    }
    throw Object.assign(new Error('ipfs unreachable: ' + last), { status: 502 });
  }

  async function handle(req, url, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method', { status: 405 });
    const path = decodeURIComponent(url.pathname.replace(/^\/img\/ipfs\//, '')).replace(/^\/+/, '');
    if (!path || path.includes('..') || !CID.test(path)) return new Response('bad path', { status: 400 });
    const key = new Request('https://api.multisea.io/img/ipfs/' + path);
    const hit = await caches.default.match(key).catch(() => null);
    if (hit) return hit;
    try {
      const up = await fetchFromGateways(path);
      const type = (up.headers.get('content-type') || '').startsWith('image/') ? up.headers.get('content-type') : 'image/png';
      const buf = await up.arrayBuffer();
      if (!buf.byteLength) return new Response('empty', { status: 502 });
      const headers = {
        'content-type': type,
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
        'access-control-allow-origin': '*',
        'timing-allow-origin': '*',
      };
      const out = new Response(buf, { status: 200, headers });
      if (ctx?.waitUntil) ctx.waitUntil(caches.default.put(key, out.clone()).catch(() => {}));
      else await caches.default.put(key, out.clone()).catch(() => {});
      return out;
    } catch (e) {
      return new Response(e?.message || 'ipfs unreachable', { status: e?.status || 502, headers: { 'access-control-allow-origin': '*' } });
    }
  }
  return { handle, fetchFromGateways, ipfsPath, publicImage };
}
export { PROXY };
