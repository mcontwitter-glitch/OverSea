// Share cards: GET /s/c/<slug>[?item=<id>] -> small HTML page with og:/twitter: tags for X and other link crawlers.
// multisea.io is a GitHub Pages SPA (deep links 404 there), so crawlers read this page; people are sent to multisea.io.
const SITE = 'https://multisea.io';
const FALLBACK = SITE + '/og-image.png';
const BOT = /twitterbot|facebookexternalhit|slackbot|discordbot|telegrambot|linkedinbot|whatsapp|embedly|redditbot|applebot|googlebot|bingbot|skypeuripreview|pinterest|mastodon|bluesky|iframely/i;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const abs = u => {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '');
  if (u.startsWith('/media/')) return 'https://api.multisea.io' + u;
  if (u.startsWith('/')) return SITE + u;
  return /^https:\/\//.test(u) ? u : '';
};
const fmtFloor = n => (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(2)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function makeShare({ getCollection, STATIC, osStats, cached }) {
  return async function share(req, env, url, p) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || p[0] !== 's' || p[1] !== 'c' || p.length !== 3 || !/^[a-z0-9-]{1,64}$/.test(p[2])) return undefined;
    const slug = p[2]; const itemQ = url.searchParams.get('item'); const item = /^\d{1,7}$/.test(itemQ || '') ? +itemQ : null;
    const target = `${SITE}/c/${slug}${item != null ? '?item=' + item : ''}`;
    if (!BOT.test(req.headers.get('user-agent') || '')) return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, max-age=0' } });
    const col = await getCollection(env, slug).catch(() => null);
    if (!col || col.status !== 'approved') return page({ title: 'MultiSea', desc: 'Omni chain NFT collections.', image: FALLBACK, target: SITE + '/' }, 404);
    const st = STATIC[slug];
    let floor = '';
    if (env.OPENSEA_API_KEY) {
      try {
        const per = await Promise.race([cached(`s:${slug}`, 300, () => osStats(env, col)), new Promise(r => setTimeout(() => r(null), 2500))]);
        let best = null; for (const v of Object.values(per || {})) if (v?.floor_price > 0 && (!best || v.floor_price < best.floor_price)) best = v;
        if (best) floor = `Floor ${fmtFloor(best.floor_price)} ${best.floor_price_symbol || 'ETH'}`;
      } catch {}
    }
    const inRange = st && item != null && item >= (st.idStart ?? 0) && item <= (st.idEnd ?? st.supply ?? Infinity);
    const colImg = abs(col.banner) || abs(col.logo) || (st ? `${SITE}/img/${slug}/m/${st.idStart ?? 1}.webp` : '');
    const image = (inRange ? `${SITE}/img/${slug}/m/${item}.webp` : '') || colImg || FALLBACK;
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
