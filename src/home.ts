import AV from './assetv.json';
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
const tnum = (x?: string) => { const m = (x || '').replace(/[$,]/g, '').match(/[\d.]+/); return m ? +m[0] : -1; };
let q = '', sort = 'featured', showAll = false; const LIMIT = 10;
function card(c: Card) {
  const img = c.banner ? esc(media(c.banner)) : c.thumb ? `${c.thumb}2396.webp` : esc(media(c.logo));
  return `<a class="ccard2" href="/c/${esc(c.slug)}"><div class="cc2img"><img src="${img}" alt="" loading="lazy" width="384" height="384">${c.featured ? '<span class="ftag">Featured</span>' : ''}</div>
   <div class="cc2body"><div class="ccname">${esc(c.name)}</div>
   <div class="ccchains">${c.chains.map(k => `<img class="cl" src="/logos/${k}.svg" title="${esc(chains[k]?.name)}" alt="">`).join('')}</div>
   <div class="cc2stats"><div><span>Floor</span><b>${esc(c.floor ?? '-')}</b></div><div><span>Volume</span><b>${esc(c.volume ?? '-')}</b></div><div><span>Owners</span><b>${esc(c.owners ?? '-')}</b></div><div title="Floor price × total supply"><span>Market cap</span><b>${esc(c.mcap ?? '-')}</b></div></div></div></a>`;
}
function visible() {
  let l = cards.map((c, i) => ({ c, i })).filter(({ c }) => c.name.toLowerCase().includes(q.toLowerCase()));
  if (sort === 'volume') l.sort((a, b) => tnum(b.c.volume) - tnum(a.c.volume));
  else if (sort === 'floor') l.sort((a, b) => tnum(b.c.floor) - tnum(a.c.floor));
  else if (sort === 'newest') l.sort((a, b) => b.i - a.i);
  else l.sort((a, b) => (+!!b.c.featured - +!!a.c.featured) || a.i - b.i);
  return l.map(x => x.c);
}
function gridHtml() {
  const l = visible(); const shown = showAll ? l : l.slice(0, LIMIT);
  return `<div class="cgrid2">${shown.length ? shown.map(card).join('') : '<p class="mut">No collections match your search.</p>'}</div>${l.length > shown.length ? '<div class="vall"><button class="obtn" data-act="all">View all collections →</button></div>' : ''}`;
}
function render() {
  app.innerHTML = `${navHtml('home')}
  <header class="mshero"><picture><source srcset="${AV['brand/banner-900.webp']} 900w, ${AV['brand/banner-1500.webp']} 1500w, ${AV['brand/banner-2048.webp']} 2048w" type="image/webp" sizes="100vw"><img src="${AV['brand/banner-1500.jpg']}" alt="MultiSea" width="1500" height="502" fetchpriority="high"></picture></header>
  <section class="hero3"><p class="h3k">ONE PLATFORM</p><h1 class="h3t"><span>OMNI CHAIN</span><span class="grad">COLLECTIONS</span></h1>
   <p class="h3s">Browse, discover and trade NFT collections across all major blockchains in one place.</p>
   <div class="h3b"><a class="bbtn big" href="#collections" data-act="explore">Explore collections</a><a class="obtn big" href="/submit">Submit a collection</a></div></section>
  <section class="home2" id="collections">${is404 ? '<p class="soon">Page not found. Here are our collections:</p>' : ''}
   <div class="h2row"><div><h2>Collections</h2><p class="mut">Discover omni chain NFT collections from across all supported networks.</p></div><a class="obtn pill" href="/submit">+ Submit a collection</a></div>
   <div class="ctools"><label class="csearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="cq" type="search" placeholder="Search collections..." value="${esc(q)}"></label>
    <select id="csort" aria-label="Sort collections">${[['featured', 'Featured'], ['volume', 'Volume'], ['floor', 'Floor'], ['newest', 'Newest']].map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
   <div id="cgridwrap">${gridHtml()}</div>
   ${apiReady ? '' : '<p class="mut small">Community collections will appear here once the MultiSea API is online.</p>'}
  </section>
  <section class="chains"><p class="sechk">SUPPORTED CHAINS</p><h2 class="sech2">ALL MAJOR NETWORKS</h2><div class="chrow"><div class="chb"><span class="chc"><img src="/logos/abstract.svg" alt="" width="34" height="34"></span><span>Abstract</span></div><div class="chb"><span class="chc"><img src="/logos/ethereum.svg" alt="" width="34" height="34"></span><span>Ethereum</span></div><div class="chb"><span class="chc"><img src="/logos/base.svg" alt="" width="34" height="34"></span><span>Base</span></div><div class="chb"><span class="chc"><img src="/logos/bnb.svg" alt="" width="34" height="34"></span><span>BNB Chain</span></div><div class="chb"><span class="chc"><img src="/logos/apechain.svg" alt="" width="34" height="34"></span><span>ApeChain</span></div><div class="chb"><span class="chc"><img src="/logos/robinhood.svg" alt="" width="34" height="34"></span><span>Robinhood</span></div><a class="chb" href="/submit"><span class="chc more">···</span><span>… and more</span></a></div></section>
  <section class="feats2"><div class="feat"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="17"/><ellipse cx="24" cy="24" rx="7.5" ry="17"/><path d="M7 24h34M9.5 15h29M9.5 33h29M24 7v34"/></svg><h3>Omni Chain</h3><p>Access collections across all major blockchains in one place.</p></div><div class="feat"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 8 41 17 24 26 7 17Z"/><path d="M7 24l17 9 17-9"/><path d="M7 31l17 9 17-9"/></svg><h3>All Collections</h3><p>Browse, search and trade from multiple collections without leaving the platform.</p></div><div class="feat"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M27 5 11 27h12l-3 16 17-23H25Z"/></svg><h3>Fast &amp; Simple</h3><p>A seamless cross chain trading experience designed for collectors and traders.</p></div><div class="feat"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5 39 11v11c0 10-6.5 17-15 21C15.5 39 9 32 9 22V11Z"/></svg><h3>Secure</h3><p>Powered by trusted blockchain technology and smart contracts across all supported networks.</p></div></section>
  <footer class="foot2"><a class="fbrand" href="/"><img src="${AV['brand/icon-64.webp']}" width="40" height="40" alt=""><span><b>Multi<i>Sea</i></b><small>multichain NFT collections</small></span></a><nav class="flinks"><a href="/#collections">Collections</a><a href="/submit">Submit</a></nav></footer>`;
  bindHome();
}
function regrid() { const w = document.getElementById('cgridwrap'); if (w) w.innerHTML = gridHtml(); }
function bindHome() {
  const qi = document.getElementById('cq') as HTMLInputElement | null; qi?.addEventListener('input', () => { q = qi.value; regrid(); });
  const so = document.getElementById('csort') as HTMLSelectElement | null; so?.addEventListener('change', () => { sort = so.value; regrid(); });
  app.querySelector('.home2')?.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-act="all"]')) { showAll = true; regrid(); } });
  app.querySelector('[data-act="explore"]')?.addEventListener('click', e => { e.preventDefault(); document.getElementById('collections')?.scrollIntoView({ behavior: 'smooth' }); });
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
