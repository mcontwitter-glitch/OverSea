// Community collection page: config from the Worker (KV), live items/listings/stats via the Worker's OpenSea proxy.
import { shareBtns } from './share';
import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, apiReady, API, startBuy, readClient } from './wallet';
import { navHtml, bindNav, esc, soon, media , ethUsdRate, mcapUsd, mcapStatHtml, bestFloor } from './shell';
import { openEdit, linksHtml } from './edit';
import { openFounder, isFounder, founderBtn } from './founder';
import { logo } from './gx';
import { parseAbi, type Hex } from 'viem';
import type { LiveStats } from './liveowners';
import { imageSrc } from './datauri';
import { applyBridgeFlag, bridgeEnabled } from './bridgeflag';
import { assemble, escrowSet, type Row } from './activitycore';
import { mergeHolders } from './holdersmerge';
import { resolveProfiles } from './walletlinks';
import { addrHtml } from './names';
import { short } from './gx';
import type { Loc } from './liveowners';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; openseaSlug: string | null; explorer?: string }>;
const slug = location.pathname.split('/')[2];
let col: any = null, stats: Record<string, any> = {}, listings: any[] = [], items: any[] = [], next: string | null = null, chain = '', editable = false, founder = false, state = 'loading';
let view: 'items' | 'activity' | 'holders' | 'chains' | 'bridge' = 'items';
// Activity / Holders, as on Island's page: GET /activity/<slug> (Worker snapshot) through activitycore, and live owners
// (GET /owners/<slug> snapshot or ownerOf from chain) merged per MultiSea profile.
let activity: Row[] = [], activityState: 'idle' | 'loading' | 'ok' | 'error' = 'idle';
let owners: Record<string, Loc> = {}, holderMap: Record<string, string> = {};
const addrLink = (a?: string | null) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a) ? `<a class="ulink" href="/u/${a.toLowerCase()}">${addrHtml(a)}</a>` : addrHtml(a));
const ago = (ts: number | null) => { if (!ts) return '-'; const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
let bridgeEl: HTMLElement | null = null;
let chainStats: LiveStats | null = null, chainStatsAt: number | null = null, chainStatsFailed: string[] = [];
const fmt = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(4)).toString());
const lmap = () => { const m = new Map<string, any>(); listings.forEach(l => { const k = l.chain + ':' + l.id; const c = m.get(k); if (!c || l.price < c.price) m.set(k, l); }); return m; };
let itemStatus: 'all' | 'listed' = 'all';
let itemSort: 'price-asc' | 'price-desc' = 'price-asc';
function itemOf(l: any) {
  const it = items.find(x => x.chain === l.chain && x.id === l.id);
  if (it) return { ...it, name: it.name || l.name || '#' + l.id, image: it.image || l.image || '' };
  return { id: l.id, name: l.name || '#' + l.id, image: l.image || '', chain: l.chain };
}
function gridItems() {
  const L = lmap();
  const listed = [...L.values()].filter(l => l.chain === chain).map(itemOf);
  const keys = new Set(listed.map(it => it.chain + ':' + it.id));
  const rest = items.filter(it => it.chain === chain && !keys.has(it.chain + ':' + it.id));
  const arr = itemStatus === 'listed' ? listed : [...listed, ...rest];
  const pr = (it: any) => L.get(it.chain + ':' + it.id)?.price ?? 0;
  const listedOf = (it: any) => L.has(it.chain + ':' + it.id);
  const cmp = itemSort === 'price-desc'
    ? (a: any, b: any) => Number(listedOf(b)) - Number(listedOf(a)) || (listedOf(a) ? pr(b) - pr(a) : 0) || a.id - b.id
    : (a: any, b: any) => Number(listedOf(b)) - Number(listedOf(a)) || (listedOf(a) ? pr(a) - pr(b) : 0) || a.id - b.id;
  return arr.sort(cmp);
}
let dynUsd: number | null = null; ethUsdRate().then(r => { if (r) { dynUsd = r; render(); } });
function canBridge() { return !!(col && (col.source === 'bridge-listing' || col.source === 'launchpad' || ((col.escrow || []).length && (col.deployments || []).length > 1))); }
function render() {
  if (state !== 'ok') { app.innerHTML = `${navHtml()}<section class="page">${state === 'offline' ? soon('This collection page') : state === 'missing' ? '<h2>Collection not found</h2><p><a href="/">Back to collections</a></p>' : '<div class="spin"></div> Loading…'}</section>`; return; }
  const v = Object.values(stats); const L = lmap();
  const vol = v.reduce((a, x) => a + (x.volume || 0), 0), own = v.reduce((a, x) => a + (x.num_owners || 0), 0);
  const fl = bestFloor(listings, dynUsd);
  const avatar = media(col.logo) || imageSrc(items[0]?.image) || '';
  const shown = gridItems();
  const itemsHtml = `<div class="chips dchips">${col.deployments.map((d: any) => `<button class="chip ${chain === d.chain ? 'on' : ''}" data-chain="${d.chain}"><img class="cl" src="/logos/${d.chain}.svg" alt="">${esc(chains[d.chain]?.name)}${chainStats?.[d.chain] != null ? ` <em>${chainStats[d.chain].live.toLocaleString()}</em>` : ''}</button>`).join('')}</div>
  <div class="content"><div class="bar"><button class="chip ${itemStatus === 'all' ? 'on' : ''}" data-status="all">All</button><button class="chip ${itemStatus === 'listed' ? 'on' : ''}" data-status="listed">Listed</button><select class="sort" aria-label="Sort">${([['price-asc', 'Price: low to high', 'Price ↑'], ['price-desc', 'Price: high to low', 'Price ↓']] as const).map(([v, n, sh]) => `<option value="${v}" ${itemSort === v ? 'selected' : ''}>${window.innerWidth <= 640 ? sh : n}</option>`).join('')}</select>${L.size ? '<button class="sweepbtn" data-act="sweep" title="Buy the cheapest N listings">🧹 Sweep</button>' : ''}</div>
  <div class="grid">${shown.map(it => { const l = L.get(it.chain + ':' + it.id); return `<div class="card"><div class="ci">${imageSrc(it.image) ? `<img src="${esc(imageSrc(it.image))}" loading="lazy" width="384" height="384" alt="">` : ''}<span class="badge"><img class="cl" src="/logos/${it.chain}.svg" alt=""></span></div><div class="cb"><div class="cn">${esc(it.name || '#' + it.id)}</div><div class="cp">${l ? `<b>${fmt(l.price)} ${esc(l.currency)}</b>` : '<span class="mut">Not listed</span>'}</div>${l && chains[it.chain]?.openseaSlug ? `<button class="buy" data-buy="${it.chain}:${it.id}">Buy</button>` : ''}</div></div>`; }).join('')}</div>
  ${itemStatus !== 'listed' && next ? '<div class="more"><button data-act="more">Load more</button></div>' : ''}</div>`;
  app.innerHTML = `${navHtml()}
  <div class="banner ${col.banner ? 'has-img' : ''}" style="${col.banner ? `background-image:url(${esc(media(col.banner))})` : ''}">${col.banner ? '' : `<div class="banner-art">${items.slice(0, 12).map(i => imageSrc(i.image) ? `<span><img src="${esc(imageSrc(i.image))}" alt="" loading="lazy" fetchpriority="low"></span>` : '').join('')}</div>`}<div class="banner-fade"></div>
   <div class="hero2"><img class="avatar" src="${esc(avatar)}" alt=""><div class="hero-txt"><h1>${esc(col.name)}</h1><div class="by">${col.deployments.map((d: any) => `<img class="cl" src="/logos/${d.chain}.svg" title="${esc(chains[d.chain]?.name)}" alt="">`).join('')}<span>${col.deployments.length} chain${col.deployments.length > 1 ? 's' : ''}</span></div>${shareBtns(col.slug || slug, col.name)}</div></div>
   <div class="stats"><div class="stat"><b>${v.length ? fmt(vol) + ' ETH' : '-'}</b><span>Total volume</span></div><div class="stat"><b>${fl ? `<img class="cl" src="/logos/${fl.chain}.svg" alt=""> ${fmt(fl.price)} ${esc(fl.currency)}${!/^W?ETH$/i.test(fl.currency) && fl.priceEth ? ` <span class="mut">(≈ ${fmt(fl.priceEth)} ETH)</span>` : ''}` : '-'}</b><span>Floor price</span></div><div class="stat"><b>${v.length ? own.toLocaleString() : '-'}</b><span>Owners</span></div><div class="stat"><b>${L.size}</b><span>Listings</span></div>${(() => { const sup = Number(col.supply || (col.idEnd ? col.idEnd - (Number(col.idStart) || 1) + 1 : 0)) || Math.max(0, ...v.map((x: any) => x.total_supply || 0)); return mcapStatHtml(mcapUsd(fl?.priceEth, sup, dynUsd)); })()}</div></div>
  <div class="descrow"><p class="desc">${esc(col.description)}</p><div class="links">${linksHtml(col)}${canBridge() ? `<a class="obtn sm" href="/holders/${esc(col.slug || slug)}">💬 Holders chat</a>` : ''}${editable ? '<button class="editbtn" data-act="edit">✎ Edit collection</button>' : ''}${founderBtn(founder)}</div></div>
  <div class="tabs"><button data-tab="items" class="${view === 'items' ? 'on' : ''}">Items</button><button data-tab="activity" class="${view === 'activity' ? 'on' : ''}">Activity</button><button data-tab="holders" class="${view === 'holders' ? 'on' : ''}">Holders</button><button data-tab="chains" class="${view === 'chains' ? 'on' : ''}">Chains</button>${canBridge() ? `<button data-tab="bridge" data-bridge-flag hidden class="${view === 'bridge' ? 'on' : ''}">Bridge</button>` : ''}</div>
  ${view === 'items' ? itemsHtml : view === 'activity' ? `<div class="content">${activityView()}</div>` : view === 'holders' ? `<div class="content">${holdersView()}</div>` : view === 'chains' ? `<div class="content">${chainsBlock()}</div>` : '<div class="content"><div id="bridgebox"></div></div>'}`;
  applyBridgeFlag();
  if (view === 'bridge') {
    const box = document.getElementById('bridgebox')!;
    if (bridgeEl) { box.replaceWith(bridgeEl); return; }
    bridgeEl = box; bridgeEnabled().then(on => { if (!on) { bridgeEl = null; view = 'items'; render(); return; } import('./bridgekit').then(b => b.mountBridge(bridgeEl!, { slug: col.slug || slug })); });
  }
}
function isLiveCountsCol() { return !!(col?.escrow?.length || col?.source === 'launchpad' || col?.source === 'bridge-listing' || col?.mode === 'multichain'); }
function chainsBlock() {
  if (!col?.deployments?.length) return '';
  const at = chainStatsAt ? `; ownership and live counts read from chain (ownerOf) at ${new Date(chainStatsAt).toLocaleTimeString()}` : '';
  return `<div class="ctab">${col.deployments.map((d: any) => {
    const st = chainStats?.[d.chain]; const failed = chainStatsFailed.includes(d.chain);
    const c = chains[d.chain];
    return `<div class="cc">${logo(d.chain, 'cl lg')}<div><h3>${esc(c?.name || d.chain)}</h3>
      ${c?.explorer ? `<a class="mono" href="${c.explorer}/address/${d.address}" target="_blank" rel="noopener">${esc(d.address)}</a>` : `<span class="mono">${esc(d.address)}</span>`}
      ${st ? `<div class="kv"><span>Held (ownerOf)</span><b>${st.held}</b><span>In vault/escrow</span><b>${st.inEscrow}</b><span>Live on chain</span><b>${st.live}</b><span>Holders</span><b>${st.holders}</b></div>` : `<div class="mut">${failed ? 'Could not read this chain' : isLiveCountsCol() ? 'Reading live counts…' : ''}</div>`}
    ${c?.openseaSlug ? `<a class="os" target="_blank" rel="noopener" href="https://opensea.io/assets/${c.openseaSlug}/${d.address}">View on OpenSea ↗</a>` : ''}</div></div>`;
  }).join('')}<p class="mut small">Vault/escrow addresses excluded from holders${at}.</p></div>`;
}
function activityView() {
  const rows = [...activity].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const byKey = new Map(items.map(i => [i.chain + ':' + i.id, i]));
  const cn = (k: string) => esc(chains[k]?.name || k);
  const txUrl = (k: string, h: string) => (chains[k]?.explorer ? `${chains[k].explorer}/tx/${h}` : '');
  const label = (a: Row) => a.type === 'sale' ? 'Sale' : a.type === 'mint' ? 'Mint' : a.type === 'bridge' ? 'Bridged' : 'Sent';
  const route = (a: Row) => a.type !== 'bridge' ? '' : `<small class="mut">${a.dir === 'out' ? `from ${cn(a.chain)}` : a.dir === 'in' ? `to ${cn(a.chain2!)}` : `${cn(a.chain)} → ${cn(a.chain2!)}`}</small>`;
  return `<div class="act"><div class="acth"><span>Event</span><span>Item</span><span>Price</span><span>From</span><span>To</span><span>Time</span></div>
   ${rows.slice(0, 200).map(a => { const it = byKey.get(a.chain + ':' + a.id); const img = imageSrc(it?.image); const u = txUrl(a.chain, a.tx), u2 = a.tx2 && a.chain2 ? txUrl(a.chain2, a.tx2) : ''; return `<div class="actr"><span class="ev">${logo(a.chain)}<b class="t-${a.type}">${label(a)}</b>${route(a)}</span>
     <span class="ai">${img ? `<img src="${esc(img)}" width="40" height="40" alt="" loading="lazy">` : ''}<span>${esc(it?.name || '#' + a.id)}</span></span>
     <span>${a.type === 'sale' && a.price != null ? `${fmt(a.price)} ${esc(String(a.currency || '').startsWith('0x') ? short(a.currency) : a.currency)}` : '-'}</span><span>${addrLink(a.from)}</span><span>${addrLink(a.to)}</span>
     <span>${u ? `<a href="${u}" target="_blank" rel="noopener" title="${cn(a.chain)} transaction">${ago(a.ts)} ↗</a>` : ago(a.ts)}${u2 ? ` <a class="small mut" href="${u2}" target="_blank" rel="noopener" title="${cn(a.chain2!)} transaction">${cn(a.chain2!)} ↗</a>` : ''}</span></div>`; }).join('') || `<div class="empty">${activityState === 'loading' || activityState === 'idle' ? 'Loading on-chain activity…' : activityState === 'error' ? "Couldn't load activity. Try again in a minute." : 'No activity found'}</div>`}</div>`;
}
function holdersView() {
  const rows = mergeHolders(Object.values(owners), holderMap); const tot = rows.reduce((s, r) => s + r[1].n, 0) || 1;
  return `<div class="act hold"><div class="mut small" style="margin:0 0 8px">${rows.length.toLocaleString()} holders · ${chainStatsAt ? 'live on-chain ownership' : 'loading'} · names via ENS / Basenames</div><div class="acth"><span>#</span><span>Holder</span><span>Owned</span><span>Share</span><span>Chains</span></div>
   ${rows.slice(0, 200).map(([a, h], i) => `<div class="actr"><span>${i + 1}</span><span>${addrLink(a)}${h.wallets.size > 1 ? ` <span class="mut small" title="${h.wallets.size} linked wallets">· ${h.wallets.size} wallets</span>` : ''}</span><span><b>${h.n}</b></span><span>${((h.n / tot) * 100).toFixed(2)}%</span><span>${[...h.chains].map(c => logo(c)).join('')}</span></div>`).join('') || `<div class="empty">${chainStatsAt ? 'No holders found' : 'Reading holders from chain…'}</div>`}</div>`;
}
async function loadActivity() {
  if (activityState !== 'idle' || !col) return; activityState = 'loading';
  try { const r = await fetch(`${API}/activity/${col.slug || slug}`, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error('HTTP ' + r.status);
    activity = assemble((await r.json()).raw || [], escrowSet(col)); activityState = 'ok'; }
  catch { activityState = 'error'; }
  if (view === 'activity') render();
}
async function loadItems(reset = false) { if (reset) { items = []; next = null; } const j = await (await fetch(`${API}/os/${slug}/items?chain=${chain}${next ? '&next=' + encodeURIComponent(next) : ''}`)).json(); items.push(...(j.nfts || [])); next = j.next; render(); }
async function refreshEditable() {
  editable = false; founder = false;
  const addr = wallet.address;
  const jobs: Promise<void>[] = [];
  if (addr) jobs.push((async () => { try { editable = !!(await (await fetch(`${API}/collections/${slug}/can-edit?address=${addr}`)).json()).ok; } catch {} })());
  if (addr && col) jobs.push(isFounder({ name: col.name, deployments: col.deployments, creator: col.creator }).then(v => { founder = v; }));
  await Promise.all(jobs);
  render();
}
app.addEventListener('change', e => {
  const t = e.target as HTMLElement;
  if (t.classList.contains('sort')) { itemSort = (t as HTMLSelectElement).value as typeof itemSort; render(); }
});
app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const tab = t.closest('[data-tab]') as HTMLElement; if (tab) { view = tab.dataset.tab as typeof view; if (view === 'activity') loadActivity(); render(); return; }
  const st = t.closest('[data-status]') as HTMLElement; if (st) { itemStatus = st.dataset.status as typeof itemStatus; render(); return; }
  const c = t.closest('[data-chain]') as HTMLElement; if (c) { chain = c.dataset.chain!; view = 'items'; loadItems(true); return; }
  const a = t.closest('[data-act]') as HTMLElement;
  if (a?.dataset.act === 'more') loadItems();
  if (a?.dataset.act === 'sweep') { const L = lmap(); const me = wallet.address?.toLowerCase(); const ci = [...L.values()].filter(l => chains[l.chain]?.openseaSlug && (!l.seller || l.seller.toLowerCase() !== me)).map(l => { const dep = col.deployments.find((x: any) => x.chain === l.chain); const it = itemOf(l); return dep ? { key: `${l.chain}:${dep.address.toLowerCase()}:${l.id}`, chain: l.chain, contract: dep.address, id: l.id, name: it?.name || `${col.name} #${l.id}`, img: it?.image || '', price: l.price, currency: l.currency, source: l.source || 'opensea', orderHash: l.orderHash, protocolAddress: l.protocolAddress, slug } : null; }).filter(Boolean); import('./cart').then(c => c.openSweep(ci as any, col.name)); return; }
  if (a?.dataset.act === 'edit') openEdit(col, x => { col = { ...col, ...x }; render(); });
  if (a?.dataset.act === 'founder') openFounder({ name: col.name, slug: col.slug, deployments: col.deployments, creator: col.creator, supply: Number(col.supply || col.maxSupply || 0) || undefined });
  const b = t.closest('[data-buy]') as HTMLElement;
  if (b) { const [ch, id] = b.dataset.buy!.split(':'); const l = lmap().get(ch + ':' + id); const d = col.deployments.find((x: any) => x.chain === ch); const it = items.find(x => x.chain === ch && x.id === +id);
    if (l && d) startBuy({ id: +id, name: it?.name || l.name || '#' + id, img: it?.image || l.image || '', chain: ch, contract: d.address, listing: l }, () => { listings = listings.filter(x => !(x.chain === ch && x.id === +id)); render(); }, () => { listings = listings.filter(x => !(x.chain === ch && x.id === +id)); render(); }); }
});
bindNav(); render(); onWallet(refreshEditable);
await checkApi(); // retried with backoff; even if /health is blocked, try the real route
const r = await fetch(`${API}/collections/${slug}`).catch(() => null);
if (!r) { state = 'offline'; render(); }
else {
  if (!r.ok) { state = 'missing'; render(); }
  else { col = (await r.json()).collection; document.title = `${col.name} · MultiSea`; chain = col.deployments[0].chain; state = 'ok'; render();
    await Promise.all([loadItems(true), fetch(`${API}/os/${slug}/stats`).then(r => r.json()).then(j => { stats = j.stats || {}; }).catch(() => {}), fetch(`${API}/os/${slug}/listings`).then(r => r.json()).then(j => { listings = j.listings || []; }).catch(() => {})]);
    render(); refreshEditable(); loadLiveCounts(); }
}
async function loadLiveCounts() {
  if (!col || !isLiveCountsCol()) return;
  try {
    let idEnd = Number(col.supply || col.maxSupply || 0);
    const dep = col.deployments?.[0];
    if (!idEnd && dep) {
      const pc = readClient(dep.chain);
      try { idEnd = Number(await pc.readContract({ address: dep.address as Hex, abi: parseAbi(['function maxSupply() view returns (uint32)']), functionName: 'maxSupply' })); }
      catch { try { idEnd = Number(await pc.readContract({ address: dep.address as Hex, abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply' })); } catch { return; } }
    }
    if (!idEnd) return;
    const { liveOwners } = await import('./liveowners');
    const idStart = Number.isInteger(col.idStart) ? col.idStart : 1; if (col.idEnd) idEnd = col.idEnd;
    const r = await liveOwners({ slug: col.slug || slug, idStart, idEnd, deployments: col.deployments, escrow: col.escrow || [] }, {});
    if (r) { chainStats = r.stats; chainStatsAt = r.at; chainStatsFailed = r.failed; owners = r.owners; render();
      const addrs = [...new Set(Object.values(owners).flatMap(l => [l, ...(l.also || [])]).map(x => x.owner).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a)))];
      if (addrs.length) resolveProfiles(addrs).then(m => { holderMap = m; if (view === 'holders') render(); }).catch(() => {}); }
  } catch {}
}
