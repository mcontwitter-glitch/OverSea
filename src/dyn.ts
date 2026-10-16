// Community collection page: config from the Worker (KV), live items/listings/stats via the Worker's OpenSea proxy.
import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, apiReady, API, startBuy } from './wallet';
import { navHtml, bindNav, esc, soon, media , ethUsdRate, mcapUsd, mcapStatHtml } from './shell';
import { openEdit, linksHtml } from './edit';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; openseaSlug: string | null }>;
const slug = location.pathname.split('/')[2];
let col: any = null, stats: Record<string, any> = {}, listings: any[] = [], items: any[] = [], next: string | null = null, chain = '', editable = false, state = 'loading';
const fmt = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(4)).toString());
const lmap = () => { const m = new Map<string, any>(); listings.forEach(l => { const k = l.chain + ':' + l.id; const c = m.get(k); if (!c || l.price < c.price) m.set(k, l); }); return m; };
let dynUsd: number | null = null; ethUsdRate().then(r => { if (r) { dynUsd = r; render(); } });
function render() {
  if (state !== 'ok') { app.innerHTML = `${navHtml()}<section class="page">${state === 'offline' ? soon('This collection page') : state === 'missing' ? '<h2>Collection not found</h2><p><a href="/">Back to collections</a></p>' : '<div class="spin"></div> Loading…'}</section>`; return; }
  const v = Object.values(stats); const L = lmap();
  const vol = v.reduce((a, x) => a + (x.volume || 0), 0), own = v.reduce((a, x) => a + (x.num_owners || 0), 0);
  const fl = listings.filter(l => /^W?ETH$/.test(l.currency)).sort((a, b) => a.price - b.price)[0];
  app.innerHTML = `${navHtml()}
  <div class="banner ${col.banner ? 'has-img' : ''}" style="${col.banner ? `background-image:url(${esc(media(col.banner))})` : ''}"><div class="banner-fade"></div>
   <div class="hero2"><img class="avatar" src="${esc(media(col.logo))}" alt=""><div class="hero-txt"><h1>${esc(col.name)}</h1><div class="by">${col.deployments.map((d: any) => `<img class="cl" src="/logos/${d.chain}.svg" title="${esc(chains[d.chain]?.name)}" alt="">`).join('')}<span>${col.deployments.length} chain${col.deployments.length > 1 ? 's' : ''}</span></div></div></div>
   <div class="stats"><div class="stat"><b>${v.length ? fmt(vol) + ' ETH' : '-'}</b><span>Total volume</span></div><div class="stat"><b>${fl ? `<img class="cl" src="/logos/${fl.chain}.svg" alt=""> ${fmt(fl.price)} ${esc(fl.currency)}` : '-'}</b><span>Floor price</span></div><div class="stat"><b>${v.length ? own.toLocaleString() : '-'}</b><span>Owners</span></div><div class="stat"><b>${listings.length}</b><span>Listings</span></div>${(() => { const sup = v.reduce((a, x) => a + (x.total_supply || 0), 0) || col.supply || 0; return mcapStatHtml(mcapUsd(fl?.price, sup, dynUsd)); })()}</div></div>
  <div class="descrow"><p class="desc">${esc(col.description)}</p><div class="links">${linksHtml(col)}${editable ? '<button class="editbtn" data-act="edit">✎ Edit collection</button>' : ''}</div></div>
  <div class="chips">${col.deployments.map((d: any) => `<button class="chip ${chain === d.chain ? 'on' : ''}" data-chain="${d.chain}"><img class="cl" src="/logos/${d.chain}.svg" alt="">${esc(chains[d.chain]?.name)}</button>`).join('')}</div>
  <div class="content"><div class="grid">${items.map(it => { const l = L.get(it.chain + ':' + it.id); return `<div class="card"><div class="ci">${it.image ? `<img src="${esc(it.image)}" loading="lazy" width="384" height="384" alt="">` : ''}<span class="badge"><img class="cl" src="/logos/${it.chain}.svg" alt=""></span></div><div class="cb"><div class="cn">${esc(it.name || '#' + it.id)}</div><div class="cp">${l ? `<b>${fmt(l.price)} ${esc(l.currency)}</b>` : '<span class="mut">Not listed</span>'}</div>${l && chains[it.chain]?.openseaSlug ? `<button class="buy" data-buy="${it.chain}:${it.id}">Buy</button>` : ''}</div></div>`; }).join('')}</div>
  ${next ? '<div class="more"><button data-act="more">Load more</button></div>' : ''}</div>`;
}
async function loadItems(reset = false) { if (reset) { items = []; next = null; } const j = await (await fetch(`${API}/os/${slug}/items?chain=${chain}${next ? '&next=' + encodeURIComponent(next) : ''}`)).json(); items.push(...(j.nfts || [])); next = j.next; render(); }
async function refreshEditable() { editable = false; if (wallet.address) { try { editable = !!(await (await fetch(`${API}/collections/${slug}/can-edit?address=${wallet.address}`)).json()).ok; } catch {} } render(); }
app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const c = t.closest('[data-chain]') as HTMLElement; if (c) { chain = c.dataset.chain!; loadItems(true); return; }
  const a = t.closest('[data-act]') as HTMLElement;
  if (a?.dataset.act === 'more') loadItems();
  if (a?.dataset.act === 'edit') openEdit(col, x => { col = { ...col, ...x }; render(); });
  const b = t.closest('[data-buy]') as HTMLElement;
  if (b) { const [ch, id] = b.dataset.buy!.split(':'); const l = lmap().get(ch + ':' + id); const d = col.deployments.find((x: any) => x.chain === ch); const it = items.find(x => x.chain === ch && x.id === +id);
    if (l && d) startBuy({ id: +id, name: it?.name || '#' + id, img: it?.image || '', chain: ch, contract: d.address, listing: l }, () => { listings = listings.filter(x => !(x.chain === ch && x.id === +id)); render(); }, () => { listings = listings.filter(x => !(x.chain === ch && x.id === +id)); render(); }); }
});
bindNav(); render(); onWallet(refreshEditable);
await checkApi(); // retried with backoff; even if /health is blocked, try the real route
const r = await fetch(`${API}/collections/${slug}`).catch(() => null);
if (!r) { state = 'offline'; render(); }
else {
  if (!r.ok) { state = 'missing'; render(); }
  else { col = (await r.json()).collection; document.title = `${col.name} · MultiSea`; chain = col.deployments[0].chain; state = 'ok'; render();
    await Promise.all([loadItems(true), fetch(`${API}/os/${slug}/stats`).then(r => r.json()).then(j => { stats = j.stats || {}; }).catch(() => {}), fetch(`${API}/os/${slug}/listings`).then(r => r.json()).then(j => { listings = j.listings || []; }).catch(() => {})]);
    render(); refreshEditable(); }
}
