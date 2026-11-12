// Share cards: GET /s/c/<slug>[?item=<id>] -> small HTML page with og:/twitter: tags for X and other link crawlers.
// multisea.io is a GitHub Pages SPA (deep links 404 there), so crawlers read this page; people are sent to multisea.io.
import { renderCard } from './ogcard.js';
const SITE = 'https://multisea.io';
const API = 'https://api.multisea.io';
const FALLBACK = SITE + '/og-image.png';
const BOT = /twitterbot|facebookexternalhit|slackbot|discordbot|telegrambot|linkedinbot|whatsapp|embedly|redditbot|applebot|googlebot|bingbot|skypeuripreview|pinterest|mastodon|bluesky|iframely/i;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const abs = u => {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '');
  if (u.startsWith('/media/')) return API + u;
  if (u.startsWith('/')) return SITE + u;
  return /^https:\/\//.test(u) ? u : '';
};
const fmtFloor = n => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(2)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function makeShare({ getCollection, STATIC, osStats, cached }) {
  async function floorOf(env, slug, col) {
    if (!env.OPENSEA_API_KEY) return '';
    try {
      const per = await Promise.race([cached(`s:${slug}`, 300, () => osStats(env, col)), new Promise(r => setTimeout(() => r(null), 2500))]);
      let best = null; for (const v of Object.values(per || {})) if (v?.floor_price > 0 && (!best || v.floor_price < best.floor_price)) best = v;
      return best ? `Floor ${fmtFloor(best.floor_price)} ${best.floor_price_symbol || 'ETH'}` : '';
    } catch { return ''; }
  }
  const hash = s => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
  async function ogImage(req, env, url, p) {
    const m = p.length === 4 && /^([a-z0-9-]{1,64})\.png$/.exec(p[3]) || p.length === 5 && /^[a-z0-9-]{1,64}$/.test(p[3]) && /^(\d{1,7})\.png$/.exec(p[4]);
    if (!m) return undefined;
    const slug = p.length === 4 ? m[1] : p[3], item = p.length === 5 ? +m[1] : null;
    const cache = caches.default, key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key); if (hit) return hit;
    try {
      const col = await getCollection(env, slug); if (!col || col.status !== 'approved') throw new Error('nf');
      const st = STATIC[slug]; const s0 = st?.idStart ?? 1;
      const inRange = st && item != null && item >= s0 && item <= (st.idEnd ?? st.supply ?? Infinity);
      const chainsL = [...new Set((col.deployments || []).map(d => d.chain))];
      const png = await renderCard({
        name: col.name || slug, floor: await floorOf(env, slug, col), chains: chainsL,
        banner: abs(col.banner), avatar: abs(col.logo) || (st ? `${SITE}/img/${slug}/m/${s0}.webp` : ''),
        tiles: st && !col.banner && item == null ? Array.from({ length: 18 }, (_, i) => ({ url: `${SITE}/img/${slug}/s/${s0 + i}.webp` })) : [],
        item: item != null ? { name: `${col.name || slug} #${item}`, image: inRange ? `${SITE}/img/${slug}/m/${item}.webp` : abs(col.logo) } : null,
        partial: true, // site thumbnails can be animated (Island's): read only the first frame
      });
      const res = new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' } });
      await cache.put(key, res.clone()); return res;
    } catch { return new Response(null, { status: 302, headers: { location: FALLBACK, 'cache-control': 'public, max-age=60' } }); }
  }
  // ---- launchpad mint pages: /s/l/<slug> and /s/og/l/<slug>.png ----
  const IPFS = 'https://ipfs.filebase.io/ipfs/';
  const ipfs = u => (typeof u === 'string' && u.startsWith('ipfs://') ? IPFS + u.slice(7).replace(/^ipfs\//, '') : abs(u));
  const getDrop = async (env, slug) => { const d = await env.COLLECTIONS.get('ldrop:' + slug, 'json').catch(() => null); return d && (d.status === 'live' || d.status === 'approved') ? d : null; };
  const fmtWei = w => { try { const n = Number(BigInt(w)) / 1e18; return n === 0 ? 'Free' : fmtFloor(n < 1 ? +n.toPrecision(2) : n); } catch { return ''; } };
  function mintInfo(d) {
    const now = Date.now() / 1000, ph = d.phases || [];
    const act = ph.find(x => x.start <= now && (!x.end || x.end > now)), nxt = ph.filter(x => x.start > now).sort((a, b) => a.start - b.start)[0], p = act || nxt || ph[ph.length - 1];
    const price = p ? fmtWei(p.price) : '', mint = price ? (price === 'Free' ? 'Free mint' : `Mint ${price} ETH`) : 'Mint on MultiSea';
    const when = act ? 'Minting now' : nxt ? `Starts ${new Date(nxt.start * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET` : 'Mint ended';
    const chainsL = [...new Set((d.deployments || []).map(x => x.chain))]; const cl = chainsL.length ? chainsL : d.chains || [];
    return { mint, when, chains: cl, desc: [mint, d.maxSupply ? `${Number(d.maxSupply).toLocaleString('en-US')} supply` : '', `${cl.length} chain${cl.length === 1 ? '' : 's'}`, when].filter(Boolean).join(' · ') };
  }
  async function tokenImages(d, n) {
    if (!d.baseURI) return [];
    const base = ipfs(d.baseURI).replace(/\/?$/, '/'); const cnt = Math.min(n, Number(d.maxSupply) || n);
    return Promise.all(Array.from({ length: cnt }, async (_, i) => {
      try { const r = await Promise.race([fetch(`${base}${i + 1}.json`, { cf: { cacheTtl: 86400, cacheEverything: true } }), new Promise((_, j) => setTimeout(() => j(new Error('t')), 2500))]); if (!r.ok) return ''; const j = await r.json(); return ipfs(j.image || j.image_url || ''); } catch { return ''; }
    })).then(l => l.filter(Boolean));
  }
  const launchImg = (slug, d, mi) => `${API}/s/og/l/${slug}.png?f=${hash('l1|' + mi.mint + '|' + mi.chains.join(',') + '|' + (d.logo || '') + '|' + (d.banner || '') + '|' + (d.baseURI || ''))}`;
  async function ogLaunch(env, url, slug) {
    const cache = caches.default, key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key); if (hit) return hit;
    try {
      const d = await getDrop(env, slug); if (!d) throw new Error('nf');
      const mi = mintInfo(d); const imgs = d.banner && d.logo ? [] : await tokenImages(d, 18);
      const png = await renderCard({ name: d.name || slug, floor: mi.mint, chains: mi.chains, banner: ipfs(d.banner), avatar: ipfs(d.logo) || imgs[0] || '', tiles: d.banner ? [] : imgs.map(u => ({ url: u })), partial: true, item: null });
      const res = new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' } });
      await cache.put(key, res.clone()); return res;
    } catch { return new Response(null, { status: 302, headers: { location: FALLBACK, 'cache-control': 'public, max-age=60' } }); }
  }
  async function launchPage(req, env, url, slug, ctx) {
    const target = `${SITE}/launchpad/${slug}`;
    if (!BOT.test(req.headers.get('user-agent') || '')) return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, max-age=0' } });
    const d = await getDrop(env, slug);
    if (!d) return page({ title: 'MultiSea Launchpad', desc: 'Mint new collections on MultiSea.', image: FALLBACK, target: SITE + '/launchpad' }, 404);
    const mi = mintInfo(d); const image = launchImg(slug, d, mi);
    if (ctx?.waitUntil) ctx.waitUntil(ogLaunch(env, new URL(image), slug).catch(() => {}));
    return page({ title: `${d.name || slug} · Mint on MultiSea`, desc: mi.desc, image, target });
  }
  return async function share(req, env, url, p, ctx) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || p[0] !== 's') return undefined;
    if (p[1] === 'og' && p[2] === 'c') return ogImage(req, env, url, p);
    if (p[1] === 'og' && p[2] === 'l' && p.length === 4) { const m = /^([a-z0-9-]{1,64})\.png$/.exec(p[3]); return m ? ogLaunch(env, url, m[1]) : undefined; }
    if (p[1] === 'l' && p.length === 3 && /^[a-z0-9-]{1,64}$/.test(p[2])) return launchPage(req, env, url, p[2], ctx);
    if (p[1] !== 'c' || p.length !== 3 || !/^[a-z0-9-]{1,64}$/.test(p[2])) return undefined;
    const slug = p[2]; const itemQ = url.searchParams.get('item'); const item = /^\d{1,7}$/.test(itemQ || '') ? +itemQ : null;
    const target = `${SITE}/c/${slug}${item != null ? '?item=' + item : ''}`;
    if (!BOT.test(req.headers.get('user-agent') || '')) return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, max-age=0' } });
    const col = await getCollection(env, slug).catch(() => null);
    if (!col || col.status !== 'approved') return page({ title: 'MultiSea', desc: 'Omni chain NFT collections.', image: FALLBACK, target: SITE + '/' }, 404);
    const floor = await floorOf(env, slug, col);
    // Generated cards need more CPU than the Workers Free plan's 10 ms (measured ~200 ms), so they're opt-in: set OG_CARD = "1"
    // in wrangler.toml [vars] together with [limits] cpu_ms on a paid plan. Until then, the static token/collection image.
    const st = STATIC[slug], s0 = st?.idStart ?? 1, inRange = st && item != null && item >= s0 && item <= (st.idEnd ?? st.supply ?? Infinity);
    const image = env.OG_CARD === '1' ? `${API}/s/og/c/${slug}${item != null ? `/${item}` : ''}.png?f=${hash('v5|' + floor + '|' + (col.banner || '') + '|' + (col.logo || ''))}` : (inRange ? `${SITE}/img/${slug}/m/${item}.webp` : '') || abs(col.banner) || abs(col.logo) || (st ? `${SITE}/img/${slug}/m/${s0}.webp` : '') || FALLBACK;
    const name = col.name || slug;
    const title = item != null ? `${name} #${item}` : name;
    const desc = [floor, `${item != null ? `${name} #${item}` : name} on MultiSea${(col.deployments || []).length > 1 ? `, live on ${(col.deployments || []).length} chains` : ''}.`, item == null ? String(col.description || '').slice(0, 160) : ''].filter(Boolean).join(' · ');
    return page({ title: `${title} · MultiSea`, desc, image, target });
  };
}
function page({ title, desc, image, target }, status = 200) {
  const t = esc(title), d = esc(desc), i = esc(image), u = esc(target);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title>
<meta name="description" content="${d}"><link rel="canonical" href="${u}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MultiSea"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:image" content="${i}"><meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${i}">
<meta http-equiv="refresh" content="0;url=${u}"><script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>
</head><body><a href="${u}">${t}</a></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600', vary: 'User-Agent' } });
}
