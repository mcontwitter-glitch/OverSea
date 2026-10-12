import './style.css';
import CFG from '../config/collections.json';

type Chain = { name: string; chainId: number; native: string; openseaSlug: string | null; explorer: string; notice?: string; note?: string };
type Item = { id: number; name: string; image: string; attrs: [string, string][]; score: number; rank: number };
type Listing = { chain: string; id: number; price: number; currency: string; priceEth?: number | null };
type Loc = { chain: string; owner: string; also?: { chain: string; owner: string }[] };
const chains = CFG.chains as Record<string, Chain>;
const params = new URLSearchParams(location.search);
const COL = CFG.collections.find(c => c.slug === (params.get('c') || CFG.default))!;
const DATA = `./data/${COL.slug}/`;
const app = document.getElementById('app')!;
const $ = (s: string, r: ParentNode = document) => r.querySelector(s) as HTMLElement;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="./logos/${k}.svg" alt="${esc(chains[k]?.name)}" title="${esc(chains[k]?.name)}">`;
const fmt = (n: number | null | undefined, d = 4) => (n == null || isNaN(n) ? '-' : n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(d)).toString());
const gw = (COL.ipfsGateways as string[]);
const img = (p: string) => `<img loading="lazy" src="${gw[0]}${p}" data-p="${p}" data-g="0" onerror="window.__imgFallback(this)">`;
(window as any).__imgFallback = (el: HTMLImageElement) => { const g = +el.dataset.g! + 1; if (g < gw.length) { el.dataset.g = String(g); el.src = gw[g] + el.dataset.p; } else el.classList.add('broken'); };
const ago = (ts: number | null) => { if (!ts) return '-'; const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const osUrl = (chain: string, id: number) => { const dep = COL.deployments.find(d => d.chain === chain); const s = chains[chain]?.openseaSlug; return dep && s ? `https://opensea.io/item/${s}/${dep.address.toLowerCase()}/${id}` : null; };

async function j<T>(f: string, d: T): Promise<T> { try { const r = await fetch(DATA + f); return r.ok ? await r.json() : d; } catch { return d; } }
const [summary, items, traits, owners, listings, activity] = await Promise.all([
  j<any>('summary.json', null), j<Item[]>('items.json', []), j<any>('traits.json', { traits: {} }),
  j<Record<string, Loc>>('owners.json', {}), j<Listing[]>('listings.json', []), j<any[]>('activity.json', []),
]);
const listMap = new Map<number, Listing>(); listings.forEach(l => { const c = listMap.get(l.id); if (!c || (l.priceEth ?? Infinity) < (c.priceEth ?? Infinity)) listMap.set(l.id, l); });
const deployedChains = COL.deployments.map(d => d.chain);

const st = { tab: 'items', chains: new Set<string>(), traits: new Map<string, Set<string>>(), sort: 'price-asc', q: '', status: 'all', limit: 60, sidebar: window.innerWidth > 900 };

function header() {
  const pc = summary?.perChain || {};
  const vol = summary?.volume || {};
  const volMain = Object.keys(vol).length ? Object.entries(vol).map(([c, v]) => `${fmt(v as number)} ${c}`).join(' + ') : '-';
  const volTip = deployedChains.map(c => `<div class="tipr">${logo(c)}<span>${chains[c].name}</span><b>${pc[c] && Object.keys(pc[c].volume).length ? Object.entries(pc[c].volume).map(([k, v]) => fmt(v as number) + ' ' + k).join(' + ') : pc[c]?.historyComplete ? '0' : '-'}</b></div>`).join('');
  const fl = summary?.floor;
  const listedPct = summary?.listedCount != null ? ((100 * summary.listedCount) / COL.supply).toFixed(1) + '%' : '-';
  const avatarSrc = COL.logo || (items[0] ? gw[0] + items[0].image : '');
  const notices = deployedChains.filter(c => chains[c].notice).map(c => `<div class="notice">${logo(c)}<span><b>${chains[c].name}:</b> ${esc(chains[c].notice)}</span></div>`).join('');
  return `${notices}
  <div class="banner" style="${COL.banner ? `background-image:url(${COL.banner})` : ''}">
    <div class="banner-art">${items.slice(0, 12).map(i => img(i.image)).join('')}</div><div class="banner-fade"></div>
    <div class="hero">
      <img class="avatar" src="${avatarSrc}" alt="">
      <div class="hero-txt">
        <h1>${esc(COL.name)} <span class="verified">✓</span></h1>
        <div class="by">${deployedChains.map(c => logo(c)).join('')}<span>${deployedChains.length} chains · ${COL.standard}</span></div>
      </div>
    </div>
    <div class="stats">
      <div class="stat tip"><b>${volMain}</b><span>Total volume ⓘ</span><div class="tipbox">${volTip}<div class="tipnote">${summary?.volumeSource === 'opensea' ? 'Source: OpenSea API' : 'On-chain Seaport 1.6 sales'}</div></div></div>
      <div class="stat"><b>${fl ? `${logo(fl.chain)} ${fmt(fl.price)} ${esc(fl.currency)}${/^W?ETH$/.test(fl.currency) ? '' : ` (≈ ${fmt(fl.priceEth)} ETH)`}` : '-'}</b><span>Floor price${summary?.listingsAvailable ? '' : ' <i class="need" title="' + esc(summary?.listingsReason) + '">needs OpenSea API key</i>'}</span></div>
      <div class="stat"><b>${COL.supply.toLocaleString()}</b><span>Items</span></div>
      <div class="stat tip"><b>${summary ? summary.owners.toLocaleString() : '-'}</b><span>Owners ⓘ</span><div class="tipbox">${deployedChains.map(c => `<div class="tipr">${logo(c)}<span>${chains[c].name}</span><b>${pc[c]?.ok ? pc[c].holders : '-'}</b></div>`).join('')}<div class="tipnote">Unique across chains, vault/escrow excluded</div></div></div>
      <div class="stat"><b>${listedPct}</b><span>Listed</span></div>
    </div>
  </div>
  <p class="desc">${esc(COL.description)}</p>
  <div class="tabs"><button data-tab="items" class="${st.tab === 'items' ? 'on' : ''}">Items</button><button data-tab="activity" class="${st.tab === 'activity' ? 'on' : ''}">Activity</button><button data-tab="chains" class="${st.tab === 'chains' ? 'on' : ''}">Chains</button></div>
  <div class="chips">${deployedChains.map(c => `<button class="chip ${st.chains.has(c) ? 'on' : ''}" data-chain="${c}">${logo(c)}${chains[c].name}${pc[c] ? ` <em>${pc[c].live}</em>` : ''}${chains[c].note ? ' <i class="need">' + esc(chains[c].note) + '</i>' : ''}</button>`).join('')}</div>`;
}

function filtered() {
  let arr = items.filter(it => {
    const loc = owners[it.id];
    if (st.chains.size && !(loc && st.chains.has(loc.chain))) return false;
    if (st.status === 'listed' && !listMap.has(it.id)) return false;
    if (st.q && !(it.name.toLowerCase().includes(st.q) || String(it.id) === st.q)) return false;
    for (const [t, vs] of st.traits) { if (!vs.size) continue; const v = it.attrs.find(a => a[0] === t)?.[1]; if (!v || !vs.has(v)) return false; }
    return true;
  });
  // Price sort: all listings by ETH equivalent (rates from summary.json), listings without a rate after by price, then unlisted by id.
  const tier = (i: Item) => { const l = listMap.get(i.id); return !l ? 2 : l.priceEth != null ? 0 : 1; };
  const pr = (i: Item) => { const l = listMap.get(i.id); return l ? l.priceEth ?? l.price : 0; };
  const s: Record<string, (a: Item, b: Item) => number> = {
    'id-asc': (a, b) => a.id - b.id, 'id-desc': (a, b) => b.id - a.id, 'rarity': (a, b) => a.rank - b.rank, 'rarity-desc': (a, b) => b.rank - a.rank,
    'price-asc': (a, b) => tier(a) - tier(b) || (tier(a) < 2 ? pr(a) - pr(b) : 0) || a.id - b.id,
    'price-desc': (a, b) => tier(a) - tier(b) || (tier(a) < 2 ? pr(b) - pr(a) : 0) || a.id - b.id,
  };
  return arr.sort(s[st.sort]);
}

function sidebar() {
  const T = traits.traits as Record<string, { value: string; count: number; pct: number }[]>;
  return `<aside class="side ${st.sidebar ? 'open' : ''}">
   <div class="side-h"><b>Filters</b><button class="x" data-act="close-side">✕</button></div>
   <div class="grp"><div class="gh">Status</div><label><input type="radio" name="status" value="all" ${st.status === 'all' ? 'checked' : ''}> All</label><label><input type="radio" name="status" value="listed" ${st.status === 'listed' ? 'checked' : ''} ${summary?.listingsAvailable ? '' : 'disabled'}> Listed ${summary?.listingsAvailable ? '' : '<i class="need">needs API key</i>'}</label></div>
   <div class="grp"><div class="gh">Chains</div>${deployedChains.map(c => `<label><input type="checkbox" data-chain-cb="${c}" ${st.chains.has(c) ? 'checked' : ''}> ${logo(c)} ${chains[c].name}<em>${summary?.perChain?.[c]?.live ?? '-'}</em></label>`).join('')}</div>
   <div class="gh pad">Traits</div>
   ${Object.entries(T).map(([t, vals]) => `<details class="grp" ${st.traits.get(t)?.size ? 'open' : ''}><summary>${esc(t)}<em>${vals.length}</em></summary>${vals.map(v => `<label><input type="checkbox" data-trait="${esc(t)}" value="${esc(v.value)}" ${st.traits.get(t)?.has(v.value) ? 'checked' : ''}> ${esc(v.value)}<em>${v.count}</em></label>`).join('')}</details>`).join('')}
  </aside>`;
}

const eq = (l: Listing) => (!/^W?ETH$/.test(l.currency) && l.priceEth != null ? ` <span class="mut eq">≈ ${fmt(l.priceEth)} ETH</span>` : '');
function card(it: Item) {
  const loc = owners[it.id]; const l = listMap.get(it.id);
  return `<div class="card" data-id="${it.id}"><div class="ci">${img(it.image)}${loc ? `<span class="badge">${logo(loc.chain)}</span>` : `<span class="badge none" title="Not located on any chain (unminted or in vault)">?</span>`}<span class="rank" title="Rarity rank (statistical, out of 4404)">Rank ${it.rank}</span></div>
   <div class="cb"><div class="cn">${esc(it.name)}</div><div class="cp">${l ? `<b>${fmt(l.price)} ${esc(l.currency)}</b>${eq(l)}` : '<span class="mut">Not listed</span>'}</div></div></div>`;
}

function itemsView() {
  const arr = filtered();
  const activeTraits = [...st.traits].flatMap(([t, vs]) => [...vs].map(v => `<button class="pill" data-rm-trait="${esc(t)}" data-v="${esc(v)}">${esc(t)}: ${esc(v)} ✕</button>`)).join('');
  return `<div class="bar"><button class="fbtn" data-act="toggle-side">☰ Filters</button><input class="search" placeholder="Search by name or ID" value="${esc(st.q)}"><select class="sort">
    ${[['id-asc', 'Token ID: low to high'], ['id-desc', 'Token ID: high to low'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['rarity', 'Rarity: rarest first'], ['rarity-desc', 'Rarity: common first']].map(([v, n]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
   <div class="layout">${sidebar()}<section class="main"><div class="count">${arr.length.toLocaleString()} items ${activeTraits ? `<span class="pills">${activeTraits}<button class="pill clr" data-act="clear">Clear all</button></span>` : ''}</div>
   <div class="grid">${arr.slice(0, st.limit).map(card).join('')}</div>${arr.length > st.limit ? '<div class="more"><button data-act="more">Load more</button></div>' : ''}</section></div>`;
}

function activityView() {
  const rows = activity.filter(a => !st.chains.size || st.chains.has(a.chain));
  const byId = new Map(items.map(i => [i.id, i]));
  return `<div class="act"><div class="acth"><span>Event</span><span>Item</span><span>Price</span><span>From</span><span>To</span><span>Time</span></div>
   ${rows.slice(0, 200).map(a => { const it = byId.get(a.id); const ex = chains[a.chain]?.explorer; return `<div class="actr"><span class="ev">${logo(a.chain)}<b class="t-${a.type}">${a.type === 'sale' ? 'Sale' : a.type === 'mint' ? 'Mint' : 'Transfer'}</b></span>
     <span class="ai" data-id="${a.id}">${it ? img(it.image) : ''}<span>${esc(it?.name || '#' + a.id)}${a.ids?.length > 1 ? ` +${a.ids.length - 1}` : ''}</span></span>
     <span>${a.type === 'sale' ? `${fmt(a.price)} ${esc(a.currency.startsWith('0x') ? short(a.currency) : a.currency)}` : '-'}</span><span class="mono">${short(a.from)}</span><span class="mono">${short(a.to)}</span>
     <span>${ex ? `<a href="${ex}/tx/${a.tx}" target="_blank" rel="noopener">${ago(a.ts)} ↗</a>` : ago(a.ts)}</span></div>`; }).join('') || '<div class="empty">No activity found</div>'}</div>`;
}

function chainsView() {
  const pc = summary?.perChain || {};
  return `<div class="ctab">${COL.deployments.map(d => { const p = pc[d.chain]; const c = chains[d.chain]; return `<div class="cc">${logo(d.chain, 'cl lg')}<div><h3>${c.name} ${(d as any).original ? '<i class="tag">original</i>' : ''} ${c.note ? `<i class="need">${esc(c.note)}</i>` : ''}</h3>
    <a class="mono" href="${c.explorer}/address/${d.address}" target="_blank" rel="noopener">${d.address}</a>
    ${p?.ok ? `<div class="kv"><span>Held (ownerOf)</span><b>${p.minted}</b><span>In vault/escrow</span><b>${p.inEscrow}</b><span>Live on chain</span><b>${p.live}</b><span>Holders</span><b>${p.holders}</b><span>Transfers indexed</span><b>${p.transfers ?? '-'}${p.historyComplete ? '' : ' (partial)'}</b><span>Seaport sales</span><b>${p.sales}</b></div>` : `<div class="mut">${esc(p?.error || 'no data')}</div>`}
    ${c.openseaSlug ? `<a class="os" target="_blank" rel="noopener" href="https://opensea.io/assets/${c.openseaSlug}/${d.address}">View on OpenSea ↗</a>` : ''}</div></div>`; }).join('')}
    <p class="mut small">Data generated ${summary ? new Date(summary.generatedAt).toLocaleString() : '-'}. Vault/escrow addresses excluded: ${COL.escrow.map(e => `${esc(e.label)} ${short(e.address)}`).join(', ')}.</p></div>`;
}

function modal(id: number) {
  const it = items.find(i => i.id === id); if (!it) return;
  const loc = owners[id]; const l = listMap.get(id);
  const T = traits.traits as Record<string, { value: string; count: number; pct: number }[]>;
  const osLinks = deployedChains.filter(c => chains[c].openseaSlug).map(c => `<a class="osl ${loc?.chain === c ? 'cur' : ''}" href="${osUrl(c, id)}" target="_blank" rel="noopener">${logo(c)} ${chains[c].name}</a>`).join('');
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="mbox"><button class="x mx">✕</button><div class="mimg">${img(it.image)}</div><div class="minfo">
    <div class="mcol">${esc(COL.name)}</div><h2>${esc(it.name)}</h2>
    <div class="mrow"><span>Owned by <b class="mono">${short(loc?.owner)}</b></span>${loc ? `<span>${logo(loc.chain)} ${chains[loc.chain].name}</span>` : '<span class="mut">Not live on any chain</span>'}<span>Rarity rank ${it.rank} / ${items.length}</span></div>
    ${loc?.also ? `<div class="mut small">Also held on: ${loc.also.map(a => chains[a.chain].name + ' ' + short(a.owner)).join(', ')}</div>` : ''}
    <div class="pricebox"><div class="mut">Current price</div><div class="big">${l ? `${logo(l.chain)} ${fmt(l.price)} ${esc(l.currency)}` : '-'}</div>${l ? `<div>${eq(l)}</div>` : ''}${!summary?.listingsAvailable ? '<div class="need">Listings need an OpenSea API key</div>' : ''}<div class="osls">${osLinks}</div></div>
    <div class="gh">Traits</div><div class="tgrid">${it.attrs.map(([t, v]) => { const x = T[t]?.find(e => e.value === v); return `<div class="trait"><span>${esc(t)}</span><b>${esc(v)}</b><em>${x ? x.pct + '% have this' : ''}</em></div>`; }).join('')}</div>
  </div></div>`;
  m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) m.remove(); });
  document.body.appendChild(m);
}

function render() {
  const y = window.scrollY;
  app.innerHTML = `<nav class="top"><div class="brand">◆ multichain<span>.view</span></div><select class="colsel">${CFG.collections.map(c => `<option value="${c.slug}" ${c.slug === COL.slug ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></nav>
  ${header()}<div class="content">${st.tab === 'items' ? itemsView() : st.tab === 'activity' ? activityView() : chainsView()}</div>`;
  window.scrollTo(0, y);
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const tab = t.closest('[data-tab]') as HTMLElement; if (tab) { st.tab = tab.dataset.tab!; render(); return; }
  const chip = t.closest('[data-chain]') as HTMLElement; if (chip) { const c = chip.dataset.chain!; st.chains.has(c) ? st.chains.delete(c) : st.chains.add(c); render(); return; }
  const act = t.closest('[data-act]') as HTMLElement;
  if (act) { const a = act.dataset.act; if (a === 'more') st.limit += 60; if (a === 'toggle-side') st.sidebar = !st.sidebar; if (a === 'close-side') st.sidebar = false; if (a === 'clear') st.traits.clear(); render(); return; }
  const rm = t.closest('[data-rm-trait]') as HTMLElement; if (rm) { st.traits.get(rm.dataset.rmTrait!)?.delete(rm.dataset.v!); render(); return; }
  const c = t.closest('.card,.ai') as HTMLElement; if (c) modal(+c.dataset.id!);
});
app.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.classList.contains('sort')) st.sort = t.value;
  else if (t.classList.contains('colsel')) { location.search = '?c=' + t.value; return; }
  else if (t.name === 'status') st.status = t.value;
  else if (t.dataset.chainCb) { const c = t.dataset.chainCb; t.checked ? st.chains.add(c) : st.chains.delete(c); }
  else if (t.dataset.trait) { const k = t.dataset.trait; if (!st.traits.has(k)) st.traits.set(k, new Set()); t.checked ? st.traits.get(k)!.add(t.value) : st.traits.get(k)!.delete(t.value); }
  else return;
  st.limit = 60; render();
});
let qt: any; app.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (!t.classList.contains('search')) return; clearTimeout(qt); qt = setTimeout(() => { st.q = t.value.trim().toLowerCase(); render(); const s = $('.search') as HTMLInputElement; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250); });
render();
if (params.get('item')) modal(+params.get('item')!);
if (params.get('tab')) { st.tab = params.get('tab')!; render(); }
