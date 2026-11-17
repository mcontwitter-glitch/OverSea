// Solana copy metadata for marketplaces (Magic Eden etc.), served from api.multisea.io so it does not depend on ipfs.io.
// ME's image CDN rewrites ipfs:// to https://ipfs.io/ipfs/..., and ipfs.io answers its fetcher with a Cloudflare challenge
// ("Source image is unreachable"), so every image was blank. These routes give ME plain https URLs on our domain:
//   GET /sol/meta/<slug>/<id>.json   the collection's original JSON, with name "<Collection name> #<id>" (matches the
//                                    on-chain Core asset name), image = /sol/img/<slug>/<id>.<ext>, properties.files +
//                                    category (an animated webp stays in `image`; <img> plays it, animation_url would send it to a video player).
//   GET /sol/meta/<slug>/collection.json   collection-level JSON (name, description, image of the first id).
//   GET /sol/img/<slug>/<file>       the image bytes from the first IPFS gateway that answers (config ipfsGateways, then
//                                    filebase/pinata/ipfs-lens), immutable, edge-cached.
// The on-chain base URI becomes https://api.multisea.io/sol/meta/<slug>/ (drop owner's `reveal`, then `refresh_uris`).
// Public, read-only, cache-first, no rate limit (marketplace CDNs fetch every item in a burst from one IP).
const GW = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://gw.ipfs-lens.dev/ipfs/'];
const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ext = u => (String(u).split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

export function makeSolMeta({ CFG }) {
  const bySlug = slug => CFG.collections.find(c => c.slug === slug && /^ipfs:\/\//.test(c.metadataBase || ''));
  const gws = c => [...new Set([...(c.ipfsGateways || []), ...GW])];
  async function ipfs(c, uri, ms = 25000) {
    const path = String(uri).replace(/^ipfs:\/\/(ipfs\/)?/, '');
    let last = 'no gateway';
    for (const g of gws(c)) {
      try {
        const r = await fetch(g + path, { signal: AbortSignal.timeout(ms), cf: { cacheTtl: 86400, cacheEverything: true } });
        if (r.ok && !/text\/html/i.test(r.headers.get('content-type') || '')) return r;
        last = `${g} ${r.status}`;
      } catch (e) { last = `${g} ${e?.name || e}`; }
    }
    throw Object.assign(new Error('ipfs unreachable: ' + last), { status: 502 });
  }
  const out = (body, type, cc = IMMUTABLE, status = 200) => new Response(body, { status, headers: { 'content-type': type, 'cache-control': cc, 'access-control-allow-origin': '*' } });

  async function build(c, id, origin, req) {
    const meta = await (await ipfs(c, `${c.metadataBase}${id}${c.metadataSuffix ?? '.json'}`)).json();
    const src = meta.image || `${c.imageBase || ''}${id}.webp`;
    const e = ext(src) || 'webp', type = MIME[e] || 'image/webp';
    const image = /^ipfs:\/\//.test(src) ? `${origin}/sol/img/${c.slug}/${String(src).replace(/^ipfs:\/\/(ipfs\/)?[^/]+\//, '')}` : src;
    // warm the image cache so the marketplace CDN's first fetch is fast
    if (/^ipfs:\/\//.test(src)) await handleImg(c, String(src).replace(/^ipfs:\/\/(ipfs\/)?[^/]+\//, ''), src, req).catch(() => null);
    const j = { ...meta, name: `${c.name} #${id}`, image, external_url: meta.external_url || 'https://multisea.io',
      properties: { ...(meta.properties || {}), category: 'image', files: [{ uri: image, type }] } };
    return j;
  }
  async function handleImg(c, file, full, req) {
    const key = new Request(`https://api.multisea.io/sol/img/${c.slug}/${file}`);
    const hit = await caches.default.match(key); if (hit) return hit;
    const r = await ipfs(c, full || `${c.imageBase}${file}`, 60000);
    const e = ext(file), res = out(r.body, MIME[e] || r.headers.get('content-type') || 'application/octet-stream');
    await caches.default.put(key, res.clone());
    return res;
  }

  return async function (req, env, url, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;
    const p = url.pathname.split('/').filter(Boolean);
    if (p[0] !== 'sol' || (p[1] !== 'meta' && p[1] !== 'img') || p.length !== 4) return undefined;
    const c = bySlug(p[2]);
    if (!c) return out(JSON.stringify({ error: 'unknown collection' }), 'application/json', 'public, max-age=60', 404);
    try {
      if (p[1] === 'img') {
        if (!/^[\w.-]+$/.test(p[3]) || !MIME[ext(p[3])]) return out(JSON.stringify({ error: 'bad file' }), 'application/json', 'public, max-age=60', 400);
        return await handleImg(c, p[3], null, req);
      }
      const key = new Request(`https://api.multisea.io${url.pathname}`);
      const hit = await caches.default.match(key); if (hit) return hit;
      const origin = 'https://api.multisea.io';
      let body;
      if (p[3] === 'collection.json') {
        const first = await build(c, Number(c.idStart ?? 1), origin, req);
        body = { name: c.name, description: c.description || first.description || '', image: first.image, external_url: 'https://multisea.io',
          properties: { category: 'image', files: [{ uri: first.image, type: first.properties.files[0].type }] } };
      } else {
        const m = p[3].match(/^(\d+)\.json$/); const id = m ? Number(m[1]) : NaN;
        if (!(id >= Number(c.idStart ?? 1) && id <= Number(c.idEnd ?? c.supply))) return out(JSON.stringify({ error: 'unknown id' }), 'application/json', 'public, max-age=60', 404);
        body = await build(c, id, origin, req);
      }
      const res = out(JSON.stringify(body), 'application/json', 'public, max-age=86400');
      ctx?.waitUntil?.(caches.default.put(key, res.clone()));
      return res;
    } catch (e) {
      return out(JSON.stringify({ error: String(e?.message || e).slice(0, 200) }), 'application/json', 'no-store', e?.status || 502);
    }
  };
}
