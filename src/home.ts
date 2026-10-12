import CFG from '../config/collections.json';
import { checkApi, onWallet, API, apiReady } from './wallet';
import { navHtml, bindNav, esc, media , ethUsdRate, mcapUsd, mcapStatHtml } from './shell';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string }>;
type Card = { slug: string; name: string; description?: string; logo?: string; banner?: string; chains: string[]; floor?: string; volume?: string; owners?: string; mcap?: string; featured?: boolean; thumb?: string };
const fmt = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(4)).toString());
let cards: Card[] = []; let is404 = false;
export function notFound() { is404 = true; render(); }
async function staticCards() {
  return Promise.all(CFG.collections.map(async c => {
    const s = await fetch(`/data/${c.slug}/summary.json`).then(r => r.json()).catch(() => null);
    const vol = s?.volume ? Object.entries(s.volume).map(([k, v]) => `${fmt(v as number)} ${k}`).join(' + ') : '-';
    return { slug: c.slug, name: c.name, description: c.description, logo: c.logo || `/img/${c.slug}/s/1.webp`, banner: c.banner || undefined, thumb: `/img/${c.slug}/s/`, chains: c.deployments.map(d => d.chain), floor: s?.floor ? `${fmt(s.floor.priceEth ?? s.floor.price)} ETH` : '-', mcap: mcapUsd(s?.floor ? (s.floor.priceEth ?? s.floor.price) : null, c.supply, JSON.stringify(s ?? {}).match(/"ethUsd":([\d.]+)/)?.[1] ? +JSON.stringify(s).match(/"ethUsd":([\d.]+)/)![1] : await ethUsdRate()), volume: vol, owners: s ? s.owners.toLocaleString() : '-', featured: c.slug === CFG.default } as Card;
  }));
}
function card(c: Card) {
  const art = c.banner ? `<img src="${esc(media(c.banner))}" alt="" loading="lazy">` : c.thumb ? `<div class="ccart">${[2396, 1295, 1789, 2394].map(i => `<img src="${c.thumb}${i}.webp" alt="" loading="lazy" width="96" height="96">`).join('')}</div>` : '<div class="ccart blank"></div>';
  return `<a class="ccard ${c.featured ? 'feat' : ''}" href="/c/${esc(c.slug)}"><div class="ccb">${art}${c.featured ? '<span class="ftag">Featured</span>' : ''}</div>
   <div class="ccbody"><img class="cclogo" src="${esc(media(c.logo))}" alt="" width="56" height="56"><div class="ccname">${esc(c.name)}</div>
   <div class="ccchains">${c.chains.map(k => `<img class="cl" src="/logos/${k}.svg" title="${esc(chains[k]?.name)}" alt="">`).join('')}</div>
   <div class="ccstats"><div><span>Floor</span><b>${esc(c.floor ?? '-')}</b></div><div><span>Volume</span><b>${esc(c.volume ?? '-')}</b></div><div><span>Owners</span><b>${esc(c.owners ?? '-')}</b></div><div title="Floor price × total supply"><span>Market cap</span><b>${esc(c.mcap ?? '-')}</b></div></div></div></a>`;
}
function render() {
  app.innerHTML = `${navHtml('home')}
  <header class="mshero"><picture><source srcset="/brand/banner-900.webp 900w, /brand/banner-1500.webp 1500w" type="image/webp" sizes="100vw"><img src="/brand/banner-1500.png" alt="Multisea.io" width="1500" height="500" fetchpriority="high"></picture></header>
  <section class="home">${is404 ? '<p class="soon">Page not found. Here are our collections:</p>' : ''}
   <div class="homeh"><h2>Collections</h2><a class="bbtn sm" href="/submit">+ Submit a collection</a></div>
   <p class="mut">One collection, every chain. MultiSea combines multichain NFT collections into a single view: items, owners, floor and activity, across chains.</p>
   <div class="cgrid">${cards.map(card).join('')}</div>
   ${apiReady ? '' : '<p class="mut small">Community collections will appear here once the MultiSea API is online.</p>'}
  </section><footer class="foot"><img src="/brand/logo-64.webp" width="20" height="20" alt=""> MultiSea · multichain NFT collections</footer>`;
}
bindNav();
cards = await staticCards(); render();
onWallet(render);
checkApi().then(async ok => {
  if (!ok) return;
  try {
    const j = await (await fetch(API + '/collections')).json();
    for (const [slug, o] of Object.entries(j.overrides || {})) { const c = cards.find(x => x.slug === slug); if (c && o) Object.assign(c, { logo: (o as any).logo || c.logo, banner: (o as any).banner || c.banner }); }
    const dyn: Card[] = (j.collections || []).map((c: any) => ({ slug: c.slug, name: c.name, logo: c.logo, banner: c.banner, chains: c.deployments.map((d: any) => d.chain) }));
    cards.push(...dyn); render();
    await Promise.all(dyn.map(async c => { try { const s = (await (await fetch(`${API}/os/${c.slug}/stats`)).json()).stats || {}; const v = Object.values(s) as any[];
      c.owners = v.length ? v.reduce((a, x) => a + (x.num_owners || 0), 0).toLocaleString() : '-'; const vol = v.reduce((a, x) => a + (x.volume || 0), 0); c.volume = v.length ? fmt(vol) + ' ETH' : '-';
      const fl = v.filter(x => x.floor_price && x.floor_price_symbol === 'ETH').map(x => x.floor_price); c.floor = fl.length ? fmt(Math.min(...fl)) + ' ETH' : '-'; } catch {} }));
    render();
  } catch {}
});
