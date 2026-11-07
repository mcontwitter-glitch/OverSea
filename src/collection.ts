import { applyBridgeFlag, bridgeEnabled } from './bridgeflag';
import './style.css';
import CFG from '../config/collections.json';
import { wallet, onWallet, checkApi, onApiUp, startBuy, apiReady, apiFeatures, API } from './wallet';
import { navHtml, bindNav, media , ethUsdRate, usdRates, type UsdRates, mcapUsd, mcapStatHtml } from './shell';
import { openEdit, linksHtml } from './edit';
import { addrHtml } from './names';
import { collectionTransfers, insightOn } from './insight';
const perf: Record<string, number> = ((window as any).__msPerf ??= {}); const t0 = performance.now();

type Chain = { name: string; chainId: number; native: string; openseaSlug: string | null; explorer: string; note?: string };
type Item = { id: number; name: string; image: string; attrs: [string, string][]; score: number; rank: number; color?: string };
type Listing = { chain: string; id: number; price: number; currency: string; priceEth?: number | null; orderHash: string; protocolAddress: string; seller?: string; source?: 'opensea' | 'multisea' };
type Loc = { chain: string; owner: string; also?: { chain: string; owner: string }[] };
const chains = { ...CFG.chains } as Record<string, Chain>; // own copy: the Bitcoin entry added below must not leak into the shared EVM chain list (checkout, balances)
const params = new URLSearchParams(location.search);
const pathSlug = location.pathname.match(/^\/c\/([a-z0-9-]+)/)?.[1] || CFG.default;
const COL = CFG.collections.find(c => c.slug === pathSlug)!;
const DATA = `/data/${COL.slug}/`;
// Owner-editable overrides (logo, banner, description, links) served by the Worker when online.
let ovr: any = {}; let editable = false;
document.title = `${COL.name} · MultiSea`;
const app = document.getElementById('app')!;
const $ = (s: string, r: ParentNode = document) => r.querySelector(s) as HTMLElement;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const short = (a?: string) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="/logos/${k}.svg" alt="${esc(chains[k]?.name)}" title="${esc(chains[k]?.name)}">`;
const fmt = (n: number | null | undefined, d = 4) => (n == null || isNaN(n) ? '-' : n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(d)).toString());
const gw = (COL.ipfsGateways as string[]);
const img = (p: string) => `<img loading="lazy" decoding="async" src="${gw[0]}${p}" data-p="${p}" data-g="0" onerror="window.__imgFallback(this)">`;
// Local WebP thumbnails served by the site (scripts/thumbs.mjs). Falls back to IPFS if a thumb is missing.
const BASE = import.meta.env.BASE_URL;
const thumbUrl = (id: number, tier: 's' | 'm' = 's') => `${BASE}img/${COL.slug}/${tier}/${id}.webp`;
const thumb = (it: Item, eager = false, size = 384) => `<img src="${thumbUrl(it.id)}" width="${size}" height="${size}" alt="${esc(it.name)}" decoding="async" ${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} data-p="${it.image}" data-g="-1" onerror="window.__imgFallback(this)">`;
(window as any).__imgFallback = (el: HTMLImageElement) => { const g = +el.dataset.g! + 1; if (g === 0 && el.dataset.hi) { el.removeAttribute('data-hi'); } if (g < gw.length) { el.dataset.g = String(g); el.src = gw[g] + el.dataset.p; } else el.classList.add('broken'); };
const ago = (ts: number | null) => { if (!ts) return '-'; const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const osUrl = (chain: string, id: number) => { const dep = COL.deployments.find(d => d.chain === chain); const s = chains[chain]?.openseaSlug; return dep && s ? `https://opensea.io/item/${s}/${dep.address.toLowerCase()}/${id}` : null; };

async function j<T>(f: string, d: T): Promise<T> { try { const r = await fetch(DATA + f); return r.ok ? await r.json() : d; } catch { return d; } }
// First paint loads only compact data; activity is fetched when its tab is opened.
type ItemsMin = { types: string[]; vals: string[][]; namePrefix: string | null; imgBase: string | null; i: any[][] };
const decodeItems = (m: ItemsMin | null): Item[] => !m ? [] : m.i.map(r => ({ id: r[0], rank: r[1], score: r[2], color: '#' + r[3],
  attrs: (r[4] as number[]).map((v, k) => (v < 0 ? null : [m.types[k], m.vals[k][v]])).filter(Boolean) as [string, string][],
  name: m.namePrefix != null ? m.namePrefix + r[0] : r[5], image: m.imgBase != null ? m.imgBase + r[0] : r[m.namePrefix != null ? 5 : 6] }));
const decodeOwners = (m: any): Record<string, Loc> => { const o: Record<string, Loc> = {}; if (!m) return o;
  for (const [id, a] of Object.entries(m.d as Record<string, number[]>)) { o[id] = { chain: m.chains[a[0]], owner: m.addrs[a[1]] }; for (let k = 2; k < a.length; k += 2) (o[id].also ??= []).push({ chain: m.chains[a[k]], owner: m.addrs[a[k + 1]] }); }
  return o; };
const [summary, itemsMin, traits, ownersMin, listings] = await Promise.all([
  j<any>('summary.json', null), j<ItemsMin | null>('items.min.json', null), j<any>('traits.json', { traits: {} }),
  j<any>('owners.min.json', null), j<Listing[]>('listings.json', []),
]);
const items = itemsMin ? decodeItems(itemsMin) : await j<Item[]>('items.json', []);
const owners = ownersMin ? decodeOwners(ownersMin) : await j<Record<string, Loc>>('owners.json', {});
// The snapshot above is from build time; overlay live ownerOf reads so bridged / transferred items show on their current chain.
let ownersLiveAt: number | null = null;
async function loadLiveOwners() {
  try {
    const tl = performance.now(); const r = await (await import('./liveowners')).liveOwners(COL as any, owners); perf.liveOwnersMs = performance.now() - tl; perf.liveOwnersSinceLoadMs = performance.now() - t0;
    if (r) {
      for (const k of Object.keys(owners)) if (+k >= 0) delete owners[k]; Object.assign(owners, r.owners); ownersLiveAt = r.at;
      if (summary?.perChain) for (const c of deployedChains) { if (c === 'bitcoin' || r.failed.includes(c) || !summary.perChain[c]) continue;
        const held = Object.values(owners).flatMap(l => [l, ...(l.also || [])]).filter(l => l.chain === c);
        summary.perChain[c].live = held.length; summary.perChain[c].holders = new Set(held.map(l => l.owner.toLowerCase())).size; }
      render(); // an open item modal is rebuilt so owner, chain and the buy/list button follow the live data
      const mr = document.querySelector<HTMLElement>('.modal [data-mrow]'); if (mr) { const id = +mr.dataset.mrow!; mr.closest('.modal')!.remove(); modal(id); }
    }
  } catch {}
  document.documentElement.dataset.ownersLive = ownersLiveAt ? '1' : '0';
}
let activity: any[] = []; let activityLoaded = false;
// Activity: the build-time snapshot paints first (instant, but frozen at build); thirdweb Insight then merges the latest
// mints / transfers / sales from every Insight-covered chain (Robinhood isn't covered: snapshot only there).
let activitySrc = 'snapshot';
async function loadActivity() {
  if (activityLoaded) return; activityLoaded = true; const t = performance.now();
  activity = [...await j<any[]>('activity.json', []), ...ordActivity()]; perf.activitySnapshotMs = performance.now() - t; render();
  const deps = COL.deployments.filter(d => insightOn(d.chain)); if (!deps.length) return;
  const seen = new Set(activity.map(a => `${a.chain}:${a.tx}:${a.id}`)); let n = 0;
  await Promise.all(deps.map(d => collectionTransfers(d.chain, d.address, 200).then(xs => {
    const add = xs.filter(x => !COL.escrow.some(e => e.chain === x.chain && [x.from, x.to].some(a => a.toLowerCase() === e.address.toLowerCase())) || x.type === 'mint')
      .filter(x => !seen.has(`${x.chain}:${x.tx}:${x.id}`)).map(x => ({ type: x.type === 'burn' ? 'transfer' : x.type, chain: x.chain, id: x.id, from: x.from, to: x.to, tx: x.tx, block: x.block, ts: x.ts, price: null, currency: '' }));
    add.forEach(a => seen.add(`${a.chain}:${a.tx}:${a.id}`)); activity.push(...add); n++; perf.activityAdded = (perf.activityAdded || 0) + add.length; (perf as any)['added_' + d.chain] = add.length;
    if (perf.activityInsightFirstMs == null) perf.activityInsightFirstMs = performance.now() - t; activitySrc = 'insight'; if (st.tab === 'activity') render();
  }).catch(e => console.warn('[insight activity]', d.chain, e?.message))));
  perf.activityInsightAllMs = performance.now() - t; perf.activityInsightChains = n; perf.newestTs = Math.max(...activity.map(a => +a.ts || 0)); document.documentElement.dataset.activityInsight = String(n);
}
const listMap = new Map<number, Listing>();
const fillMap = (ls: Listing[]) => { listMap.clear(); ls.forEach(l => { const c = listMap.get(l.id); if (!c || (l.priceEth ?? Infinity) < (c.priceEth ?? Infinity)) listMap.set(l.id, l); }); };
fillMap(listings);
// Live listings from the Worker (OpenSea, ~2 min cache) replace the static snapshot so new listings/cancels show after a refresh.
async function loadLiveListings() {
  try {
    // OpenSea (live, else static snapshot) + MultiSea native listings; cheapest per item wins.
    const [osr, nr] = await Promise.all([fetch(`${API}/os/${COL.slug}/listings`).catch(() => null), fetch(`${API}/native/${COL.slug}/listings`).catch(() => null)]);
    const os: Listing[] = osr?.ok ? (await osr.json()).listings || [] : []; const nat: Listing[] = nr?.ok ? (await nr.json()).listings || [] : [];
    const rate: Record<string, number> = {}; listings.forEach(l => { if (l.priceEth && l.price) rate[l.currency] = l.priceEth / l.price; });
    if (rates?.ETH) for (const [c, v] of Object.entries(rates)) if (v && c !== 'ETH') rate[c] ??= v / rates.ETH;
    const eth = (l: Listing) => ({ ...l, priceEth: /^W?ETH$/.test(l.currency) ? l.price : rate[l.currency] ? l.price * rate[l.currency] : null });
    fillMap([...(os.length ? os : listings).map(l => eth({ ...l, source: 'opensea' as const })), ...nat.map(l => eth({ ...l, source: 'multisea' as const }))]);
    ordById.forEach((o, id) => { if (o.priceSats != null) addOrdListing(id, o); });
  } catch {}
}
const deployedChains = COL.deployments.map(d => d.chain);
// ---- Bitcoin Ordinals as one more chain (only for collections whose config/override marks `ordinals`; see src/ordlayer.ts) ----
// Ordinals items get negative synthetic ids so the existing grid/filters/sort treat them like any other chain's items.
type OL = import('./ordlayer').OrdLayer; let ORD: OL | null = null; const ordById = new Map<number, import('./ordlayer').OrdItem>();
let ordKit: typeof import('./ordlayer') | null = null; let btcUsdR: number | null = null;
const isOrd = (id: number) => id < 0;
const ordCfg = () => (ovr.ordinals ?? (COL as any).ordinals) || null;
// `ordinals.comingSoon` (and not enabled): a Bitcoin chip labelled Coming soon + an empty state; nothing is fetched or mocked.
// A `bridge` source turns the chip on by itself once the delivery Worker lists >= 1 delivered inscription.
let bridgedN = 0; const onBtc = new Map<number, import('./ordlayer').OrdItem>(); // EVM token id -> its Ordinal
const ordSoon = () => { const c = ordCfg(); return !!(c?.comingSoon && !c.enabled && !bridgedN); };
let soonOn = false;
const btcSoonChip = () => ordSoon() ? `<button class="chip soonchip ${soonOn ? 'on' : ''}" data-btcsoon>${logo('bitcoin')}Bitcoin <i class="soon">Coming soon</i></button>` : '';
const btcSoonView = () => `<div class="btcsoon"><img src="/logos/bitcoin.svg" alt="" width="56" height="56"><h3>Bitcoin Ordinals coming soon</h3><p>${esc(COL.name)} on Bitcoin is on the way. When inscriptions go live you'll browse, buy and list them right here, next to every other chain.</p><button class="obtn sm" data-btcsoon>Back to all chains</button></div>`;
async function loadOrdinals() {
  const c = ordCfg(); if (!c || (ordSoon() && !c.bridge)) return; ordKit ??= await import('./ordlayer');
  const br = c.bridge && !c.enabled ? await ordKit.loadBridged(c.bridge) : [];
  if (!br.length && ordSoon()) return; bridgedN = br.length;
  const L = await ordKit.loadOrdLayer(c, br).catch(() => null); if (!L || ORD) return; ORD = L; btcUsdR = L.btcUsd;
  chains.bitcoin = { name: 'Bitcoin', chainId: 0, native: 'BTC', openseaSlug: null, explorer: ordKit.D.explorer(L.net), note: L.demo ? 'DEMO' : undefined };
  if (!deployedChains.includes('bitcoin')) deployedChains.push('bitcoin');
  const tr = traits.traits as Record<string, { value: string; count: number; pct: number }[]>;
  L.items.forEach((o, k) => { const id = -(k + 1); ordById.set(id, o);
    if (o.tokenId) { const t = +o.tokenId; onBtc.set(t, o); const evm = items.find(x => x.id === t); if (evm) { o.name = evm.name; if (!o.attrs.length) o.attrs = evm.attrs; (o as any).rank = evm.rank; } }
    items.push({ id, name: o.name, image: '', attrs: o.attrs, score: 0, rank: (o as any).rank ?? o.num ?? 0, color: '#111' });
    owners[id] = { chain: 'bitcoin', owner: o.owner };
    for (const [t, v] of o.attrs) { const a = (tr[t] ??= []); const e = a.find(x => x.value === v); e ? e.count++ : a.push({ value: v, count: 1, pct: 0 }); }
    if (o.priceSats != null) addOrdListing(id, o); });
  const listed = L.items.filter(o => o.priceSats != null).map(o => o.priceSats!);
  if (summary) { (summary.perChain ??= {}).bitcoin = { ok: true, live: L.items.length, holders: new Set(L.items.map(o => o.owner)).size, minted: L.items.length, inEscrow: 0, sales: 0, volume: {}, historyComplete: false, floorSats: listed.length ? Math.min(...listed) : null };
    if (summary.listedCount != null) summary.listedCount += listed.length; }
  if (activityLoaded) activity.push(...ordActivity());
  render();
}
// BTC listings carry priceEth (via USD) so the mixed-chain price sort works like APE/BNB do.
function addOrdListing(id: number, o: import('./ordlayer').OrdItem) {
  const btc = o.priceSats! / 1e8; const pe = btcUsdR && rates?.ETH ? (btc * btcUsdR) / rates.ETH : null;
  listMap.set(id, { chain: 'bitcoin', id, price: btc, currency: 'BTC', priceEth: pe, orderHash: o.iid, protocolAddress: '', seller: o.owner, source: 'multisea' });
}
const ordActivity = () => !ORD ? [] : ORD.items.filter(o => o.priceSats != null).map(o => ({ type: 'list', chain: 'bitcoin', id: [...ordById].find(([, x]) => x === o)![0], price: o.priceSats! / 1e8, currency: 'BTC', from: o.owner, to: '', tx: o.txid, ts: Math.floor((o.createdAt || Date.now()) / 1000) }));
const ordHref = (id: number) => `/btc/i/${encodeURIComponent(ordById.get(id)!.iid)}`;

// Always open on 'Price: low to high': never restore a sort from URL or storage; clear any old saved values.
try { Object.keys(localStorage).filter(k => /sort/i.test(k)).forEach(k => localStorage.removeItem(k)); } catch {}
if (params.has('sort')) { params.delete('sort'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); }
const st = { tab: 'items', chains: new Set<string>(), traits: new Map<string, Set<string>>(), sort: 'price-asc', q: '', status: 'all', limit: 60, sidebar: window.innerWidth > 900 };

let rates: UsdRates | null = null; usdRates().then(r => { if (r.ETH || r.APE) { rates = r; ordById.forEach((o, id) => { if (o.priceSats != null) addOrdListing(id, o); }); render(); } });
// "≈ $9.32" from the listing's own currency (APE converts from APE); falls back to the ETH equivalent.
const usdOf = (l: Listing) => { if (l.currency === 'BTC') return btcUsdR ? l.price * btcUsdR : null; if (!rates) return null; const c = l.currency.replace(/^W/, ''); const r = (rates as any)[c]; const v = r ? l.price * r : l.priceEth != null && rates.ETH ? l.priceEth * rates.ETH : null; return v == null ? null : v; };
const usdTxt = (v: number) => '$' + v.toLocaleString(undefined, { minimumFractionDigits: v < 1000 ? 2 : 0, maximumFractionDigits: v < 1000 ? 2 : 0 });
// "Cancel all my listings" (per chain) in My items, for chains where I have MultiSea listings.
function myNative() { const me = wallet.address?.toLowerCase(); const by: Record<string, number> = {}; if (!me) return by; listMap.forEach(l => { if (l.source === 'multisea' && l.seller?.toLowerCase() === me) by[l.chain] = (by[l.chain] || 0) + 1; }); return by; }
function cancelAllBar() {
  if (st.status !== 'mine') return ''; const by = myNative(); const ks = Object.keys(by); if (!ks.length) return '';
  return `<div class="cabar"><span>Your MultiSea listings: ${ks.map(k => `${logo(k)} ${by[k]}`).join(' · ')}</span>${ks.map(k => `<button class="obtn sm" data-cancelall="${k}">Cancel all on ${esc(chains[k]?.name)}</button>`).join('')}</div>`;
}
const srcBadge = (l: Listing) => l.source === 'multisea' ? ' <span class="src ms" title="Listed on MultiSea">MultiSea</span>' : ' <span class="src os" title="Listed on OpenSea">OpenSea</span>';
const usd = (l: Listing) => { const v = usdOf(l); return v == null ? '' : ` <span class="usd">≈ ${usdTxt(v)}</span>`; };
let liveUsd: number | null = null; ethUsdRate().then(r => { if (r && !findEthUsd(summary)) { liveUsd = r; document.querySelectorAll('.mcap b').forEach(e => e.textContent = mcapUsd(summary?.floor?.priceEth ?? null, COL.supply, r)); } });
function findEthUsd(o: any): number | null { if (!o || typeof o !== 'object') return null; if (typeof o.ethUsd === 'number') return o.ethUsd; for (const v of Object.values(o)) { const r = findEthUsd(v); if (r) return r; } return null; }
function mcapStat(floorEth: number | null | undefined, supply: number, usd: number | null) { return mcapStatHtml(mcapUsd(floorEth, supply, usd)); }
function header() {
  const pc = summary?.perChain || {};
  const vol = summary?.volume || {};
  const volMain = Object.keys(vol).length ? Object.entries(vol).map(([c, v]) => `${fmt(v as number)} ${c}`).join(' + ') : '-';
  const volTip = deployedChains.map(c => `<div class="tipr">${logo(c)}<span>${chains[c].name}</span><b>${pc[c] && Object.keys(pc[c].volume).length ? Object.entries(pc[c].volume).map(([k, v]) => fmt(v as number) + ' ' + k).join(' + ') : pc[c]?.historyComplete ? '0' : '-'}</b></div>`).join('');
  const fl = summary?.floor;
  const listedPct = summary?.listedCount != null ? ((100 * summary.listedCount) / COL.supply).toFixed(1) + '%' : '-';
  const avatarSrc = media(ovr.logo) || COL.logo || (items[0] ? thumbUrl(items[0].id) : '');
  return `
  <div class="banner ${ovr.banner || COL.banner ? 'has-img' : ''}" style="${ovr.banner || COL.banner ? `background-image:url(${media(ovr.banner) || COL.banner})` : ''}">
    ${ovr.banner || COL.banner ? '' : `<div class="banner-art">${items.slice(0, 12).map(i => `<span style="background:${i.color}">${thumb(i).replace('loading="lazy"', 'loading="lazy" fetchpriority="low"')}</span>`).join('')}</div>`}<div class="banner-fade"></div>
    <div class="hero">
      <img class="avatar" src="${avatarSrc}" alt="">
      <div class="hero-txt">
        <h1>${esc(COL.name)} <span class="verified">✓</span></h1>
        <div class="by">${deployedChains.map(c => logo(c)).join('')}<span>${ordSoon() ? `${deployedChains.length} chains · Bitcoin coming soon` : ORD?.demo ? `${deployedChains.length - 1} chains + Bitcoin (demo)` : `${deployedChains.length} chains`} · ${COL.standard}</span></div>
      </div>
    </div>
    <div class="stats">
      <div class="stat tip"><b>${volMain}</b><span>Total volume ⓘ</span><div class="tipbox">${volTip}${pc.bitcoin ? `<div class="tipr">${logo('bitcoin')}<span>Bitcoin floor</span><b>${pc.bitcoin.floorSats ? ordKit!.D.fmtBtc(pc.bitcoin.floorSats) : '-'}</b></div>` : ''}<div class="tipnote">${summary?.volumeSource === 'opensea' ? 'Source: OpenSea API' : 'On-chain Seaport 1.6 sales'}</div></div></div>
      <div class="stat"><b>${fl ? `${logo(fl.chain)} ${fmt(fl.price)} ${esc(fl.currency)}${/^W?ETH$/.test(fl.currency) ? '' : ` (≈ ${fmt(fl.priceEth)} ETH)`}` : '-'}</b><span>Floor price${summary?.listingsAvailable ? '' : ' <i class="need" title="' + esc(summary?.listingsReason) + '">needs OpenSea API key</i>'}</span></div>
      <div class="stat"><b>${COL.supply.toLocaleString()}</b><span>Items</span></div>
      <div class="stat tip"><b>${summary ? summary.owners.toLocaleString() : '-'}</b><span>Owners ⓘ</span><div class="tipbox">${deployedChains.map(c => `<div class="tipr">${logo(c)}<span>${chains[c].name}</span><b>${pc[c]?.ok ? pc[c].holders : '-'}</b></div>`).join('')}<div class="tipnote">Unique across chains, vault/escrow excluded</div></div></div>
      <div class="stat"><b>${listedPct}</b><span>Listed</span></div>
      ${mcapStat(fl?.priceEth ?? (fl && /^W?ETH$/.test(fl.currency) ? fl.price : null), COL.supply, findEthUsd(summary) ?? liveUsd)}
    </div>
  </div>
  <div class="descrow"><p class="desc">${esc(ovr.description || COL.description)}</p><div class="links">${linksHtml(ovr)}${editable ? '<button class="editbtn" data-act="edit">✎ Edit collection</button>' : ''}</div></div>
  <div class="tabs"><button data-tab="items" class="${st.tab === 'items' ? 'on' : ''}">Items</button><button data-tab="activity" class="${st.tab === 'activity' ? 'on' : ''}">Activity</button><button data-tab="holders" class="${st.tab === 'holders' ? 'on' : ''}">Holders</button><button data-tab="chains" class="${st.tab === 'chains' ? 'on' : ''}">Chains</button><button data-tab="bridge" data-bridge-flag hidden class="${st.tab === 'bridge' ? 'on' : ''}">Bridge</button></div>
  <div class="chips"><button class="chip allchip ${st.chains.size ? '' : 'on'}" data-chain="">All <em>${items.length.toLocaleString()}</em></button>${deployedChains.map(c => `<button class="chip ${st.chains.has(c) ? 'on' : ''}" data-chain="${c}">${logo(c)}${chains[c].name}${pc[c] || c === 'bitcoin' ? ` <em>${chipCount(c).toLocaleString()}</em>` : ''}${c === 'bitcoin' && pc[c]?.floorSats ? ` <span class="chfl">floor ${ordKit!.D.fmtBtc(pc[c].floorSats)} · ${ordKit!.D.fmtSats(pc[c].floorSats)}${btcUsdR ? ' · ' + ordKit!.D.fmtUsd(pc[c].floorSats, btcUsdR) : ''}</span>` : ''}${chains[c].note ? ' <i class="need">' + esc(chains[c].note) + '</i>' : ''}</button>`).join('')}${btcSoonChip()}</div>`;
}

const mobMq = matchMedia('(max-width:640px)'); const isMob = () => mobMq.matches;
mobMq.addEventListener('change', () => render());
// One predicate for both the chip counts and the grid: an item is on a chain if its primary or any `also` location is there.
const onChain = (loc: Loc | undefined, cs: Set<string>) => !!loc && (cs.has(loc.chain) || !!loc.also?.some(a => cs.has(a.chain)));
const chipCount = (c: string) => items.reduce((n, it) => n + (onChain(owners[it.id], new Set([c])) ? 1 : 0), 0);
function filtered() {
  let arr = items.filter(it => {
    const loc = owners[it.id];
    if (st.chains.size && !onChain(loc, st.chains)) return false;
    if (st.status === 'listed' && !listMap.has(it.id)) return false;
    if (st.status === 'mine') { const me = wallet.address?.toLowerCase(); if (!me || !(loc && (loc.owner.toLowerCase() === me || loc.also?.some(a => a.owner.toLowerCase() === me)))) return false; }
    if (st.q && !(it.name.toLowerCase().includes(st.q) || String(it.id) === st.q || it.attrs.some(a => String(a[1]).toLowerCase().includes(st.q)))) return false;
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
   <div class="grp"><div class="gh">Status</div><label><input type="radio" name="status" value="all" ${st.status === 'all' ? 'checked' : ''}> All</label><label><input type="radio" name="status" value="listed" ${st.status === 'listed' ? 'checked' : ''} ${summary?.listingsAvailable ? '' : 'disabled'}> Listed ${summary?.listingsAvailable ? '' : '<i class="need">needs API key</i>'}</label><label><input type="radio" name="status" value="mine" ${st.status === 'mine' ? 'checked' : ''}> My items ${wallet.address ? `<em>${myCount()}</em>` : '<i class="need">connect wallet</i>'}</label></div>
   <div class="grp"><div class="gh">Chains</div>${deployedChains.map(c => `<label><input type="checkbox" data-chain-cb="${c}" ${st.chains.has(c) ? 'checked' : ''}> ${logo(c)} ${chains[c].name}<em>${summary?.perChain?.[c]?.live ?? '-'}</em></label>`).join('')}</div>
   <div class="gh pad">Traits</div>
   ${Object.entries(T).map(([t, vals]) => `<details class="grp" ${st.traits.get(t)?.size ? 'open' : ''}><summary>${esc(t)}<em>${vals.length}</em></summary>${vals.map(v => `<label><input type="checkbox" data-trait="${esc(t)}" value="${esc(v.value)}" ${st.traits.get(t)?.has(v.value) ? 'checked' : ''}> ${esc(v.value)}<em>${v.count}</em></label>`).join('')}</details>`).join('')}
  </aside>`;
}

const sold = new Set<number>();
const myCount = () => { const me = wallet.address?.toLowerCase(); return me ? Object.values(owners).filter(l => l.owner.toLowerCase() === me || l.also?.some(a => a.owner.toLowerCase() === me)).length : 0; };
// Which chain (if any) the connected wallet holds this id on.
const myChain = (id: number) => { const me = wallet.address?.toLowerCase(); const loc = owners[id]; if (!me || !loc) return null; if (loc.owner.toLowerCase() === me) return loc.chain; return loc.also?.find(a => a.owner.toLowerCase() === me)?.chain || null; };
const sellOn = () => apiReady && (apiFeatures.includes('native') || apiFeatures.includes('sell'));
const sellBtn = (id: number, cls = '') => {
  const ch = myChain(id); if (!ch) return null; const l = listMap.get(id); const me = wallet.address!.toLowerCase();
  if (l && l.seller?.toLowerCase() === me) return sellOn() ? `<button class="buy ghost ${cls}" data-cancel="${id}">Cancel listing</button>` : '';
  return sellOn() ? `<button class="buy ${cls}" data-sell="${id}">List for sale</button>` : '';
};
const buyBtn = (id: number, cls = '') => { const sb = sellBtn(id, cls); if (sb !== null) return sb; const l = listMap.get(id); if (!l || (l.source !== 'multisea' && !chains[l.chain]?.openseaSlug)) return ''; return `<button class="buy ${cls}" data-buy="${id}">Buy</button>`; };
function doBuy(id: number) {
  const l = listMap.get(id); const it = items.find(i => i.id === id); if (!l || !it) return;
  if (l.source === 'multisea') { import('./sell').then(s => s.buyNative(sellItem(id, l.chain), l.orderHash, sid => { listMap.delete(sid); sold.add(sid); owners[sid] = { chain: l.chain, owner: wallet.address! }; render(); }, gid => { listMap.delete(gid); render(); })); return; }
  const dep = COL.deployments.find(d => d.chain === l.chain)!;
  startBuy({ id, name: it.name, img: thumbUrl(it.id), chain: l.chain, contract: dep.address, listing: l },
    sid => { listMap.delete(sid); sold.add(sid); const me = wallet.address!; owners[sid] = { chain: l.chain, owner: me }; render(); },
    gid => { listMap.delete(gid); render(); });
}
const sellItem = (id: number, chain: string) => { const it = items.find(i => i.id === id)!; return { id, name: it.name, img: thumbUrl(id), chain, contract: COL.deployments.find(d => d.chain === chain)!.address, slug: COL.slug }; };
// Buyable listings as cart items (cheapest per item; excludes my own listings).
function cartItems() {
  const me = wallet.address?.toLowerCase(); const out: any[] = [];
  listMap.forEach((l, id) => { const it = items.find(i => i.id === id); const dep = COL.deployments.find(d => d.chain === l.chain); if (!it || !dep || (l.seller && l.seller.toLowerCase() === me)) return; if (l.source !== 'multisea' && !chains[l.chain]?.openseaSlug) return;
    out.push({ key: `${l.chain}:${dep.address.toLowerCase()}:${id}`, chain: l.chain, contract: dep.address, id, name: it.name, img: thumbUrl(id), price: l.price, currency: l.currency, source: l.source || 'opensea', orderHash: l.orderHash, protocolAddress: l.protocolAddress, slug: COL.slug }); });
  return out;
}
function doSell(id: number) { const ch = myChain(id); if (!ch) return; import('./sell').then(s => s.openSell(sellItem(id, ch), () => {})); }
function doCancel(id: number) { const l = listMap.get(id); if (!l) return; import('./sell').then(s => s.cancelListing(sellItem(id, l.chain), l.orderHash, () => { listMap.delete(id); render(); }, l.source === 'multisea' ? 'multisea' : 'opensea')); }
const eq = (l: Listing) => (!/^W?ETH$/.test(l.currency) && l.priceEth != null ? ` <span class="mut eq">≈ ${fmt(l.priceEth)} ETH</span>` : '');
// LIL FOOTS foot wallets: "Wallet: $X" badge for feet whose wallet holds tokens (live, all 5 chains; see /w/<id>).
const FW_ON = COL.slug === 'lil-foots'; const fwv = new Map<number, number | null>(); const fwPending = new Set<number>();
let fwkit: typeof import('./footkit') | null = null;
const fwBadgeFor = (id: number) => (FW_ON && fwkit && fwv.get(id) ? `<span class="fwslot">${fwkit.walletBadge(id, fwv.get(id))}</span>` : '');
async function fwFill() {
  if (!FW_ON) return; fwkit ??= await import('./footkit');
  const ids = [...document.querySelectorAll<HTMLElement>('.grid .card[data-id]')].map(e => +e.dataset.id!).filter(i => !fwv.has(i) && !fwPending.has(i));
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200); part.forEach(x => fwPending.add(x));
    const r = await fwkit.walletUsd(part).catch(() => new Map<number, number | null>()); part.forEach(x => { fwPending.delete(x); fwv.set(x, r.get(x) ?? null); });
    part.forEach(x => { const v = fwv.get(x); if (!v) return; const ci = document.querySelector(`.grid .card[data-id="${x}"] .ci`); if (ci && !ci.querySelector('.fwslot')) ci.insertAdjacentHTML('beforeend', fwBadgeFor(x)); });
  }
}
function card(it: Item, idx = 99) {
  if (isOrd(it.id)) return ordCard(it);
  const loc = owners[it.id]; const l = listMap.get(it.id); const ob = onBtc.get(it.id);
  return `<div class="card" data-id="${it.id}"><div class="ci" style="background:${it.color || '#1a1a1a'}">${thumb(it, idx < 10)}${ob && !loc ? `<span class="badge btcb" title="On Bitcoin: locked in the Abstract vault, inscribed as ${esc(ob.iid)}">${logo('bitcoin')}</span>` : loc ? `<span class="badge">${logo(loc.chain)}</span>` : `<span class="badge none" title="Not located on any chain (unminted or in vault)">?</span>`}${ob ? '<span class="onbtc">On Bitcoin</span>' : ''}<span class="rank" title="Rarity rank (statistical, out of 4404)">Rank ${it.rank}</span>${fwBadgeFor(it.id)}</div>
   <div class="cb"><div class="cn">${esc(it.name)}</div><div class="cp">${l ? `<b>${fmt(l.price)} ${esc(l.currency)}</b>${usd(l)}${srcBadge(l)}` : sold.has(it.id) ? '<span class="ok">Sold to you</span>' : '<span class="mut">Not listed</span>'}</div>${buyBtn(it.id)}</div></div>`;
}

function ordCard(it: Item) {
  const o = ordById.get(it.id)!; const l = listMap.get(it.id); const sats = o.priceSats;
  if (o.tokenId) return `<div class="card ordc bridged" data-ord="${it.id}"><a class="ci" href="${ordHref(it.id)}">${ordKit!.ordFrame(o.iid, thumbUrl(+o.tokenId), esc(it.name))}<span class="badge btcb" title="Bitcoin Ordinal">${logo('bitcoin')}</span><span class="rank">Ordinal</span></a>
   <div class="cb"><div class="cn">${esc(it.name)}</div><div class="own mut small" title="${esc(o.owner)}">Owner <a class="mono" href="https://ordinals.com/address/${esc(o.owner)}" target="_blank" rel="noopener">${esc(short(o.owner))}</a></div><div class="cp">${l && sats ? `<b>${ordKit!.D.fmtBtc(sats)}</b>${usd(l)}${srcBadge(l)}` : '<span class="mut">Not listed</span>'}</div><a class="buy ghost" href="https://ordinals.com/inscription/${esc(o.iid)}" target="_blank" rel="noopener">ordinals.com ↗</a></div></div>`;
  return `<a class="card ordc" data-ord="${it.id}" href="${ordHref(it.id)}"><div class="ci">${ordKit!.ordThumb(o.iid, esc(it.name))}<span class="badge btcb" title="Bitcoin Ordinals${ORD?.demo ? ' (DEMO)' : ''}">${logo('bitcoin')}</span>${ORD?.demo ? '<span class="rank demo">DEMO</span>' : o.num ? `<span class="rank">#${o.num.toLocaleString()}</span>` : ''}</div>
   <div class="cb"><div class="cn">${esc(it.name)}</div><div class="cp">${l && sats ? `<b>${ordKit!.D.fmtBtc(sats)}</b>${usd(l)}${srcBadge(l)}` : '<span class="mut">Not listed</span>'}</div><span class="buy ${l ? '' : 'ghost'}">${l ? 'Buy with BTC' : 'View / List'}</span></div></a>`;
}
function itemsView() {
  const arr = filtered();
  const activeTraits = [...st.traits].flatMap(([t, vs]) => [...vs].map(v => `<button class="pill" data-rm-trait="${esc(t)}" data-v="${esc(v)}">${esc(t)}: ${esc(v)} ✕</button>`)).join('');
  const mob = isMob();
  return `<div class="bar"><button class="fbtn" data-act="toggle-side"><span class="fi" aria-hidden="true">☰</span> <span>Filters</span></button><input class="search" enterkeyhint="search" placeholder="${mob ? 'Search by ID or trait' : 'Search by name or ID'}" value="${esc(st.q)}"><select class="sort" aria-label="Sort">
    ${[['price-asc', 'Price: low to high', 'Price ↑'], ['price-desc', 'Price: high to low', 'Price ↓'], ['rarity', 'Rarity: rarest first', 'Rarest'], ['rarity-desc', 'Rarity: common first', 'Common']].map(([v, n, sh]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${mob ? sh : n}</option>`).join('')}</select><button class="sweepbtn" data-act="sweep" title="Buy the cheapest N listings">🧹 Sweep</button></div>
   <div class="layout">${sidebar()}<section class="main">${ORD?.demo && (!st.chains.size || st.chains.has('bitcoin')) ? `<div class="btcdemo"><b>DEMO DATA</b> The Bitcoin chain here is a signet preview: ${ORD.items.length} mocked Ordinals (real mainnet ${esc(ORD.collection)} artwork) shown to demo the unified view. ${esc(COL.name)} has no real inscriptions. <a href="?demo=0">Hide demo</a></div>` : ''}<div class="count">${arr.length.toLocaleString()} items ${activeTraits ? `<span class="pills">${activeTraits}<button class="pill clr" data-act="clear">Clear all</button></span>` : ''}</div>
   ${cancelAllBar()}
   <div class="grid">${arr.slice(0, st.limit).map((it, k) => card(it, k)).join('')}</div>${arr.length > st.limit ? '<div class="more"><button data-act="more">Load more</button></div>' : ''}</section></div>`;
}

function holdersView() {
  const by = new Map<string, { n: number; chains: Set<string> }>();
  for (const l of Object.values(owners)) for (const x of [l, ...(l.also || [])]) { if (st.chains.size && !st.chains.has(x.chain)) continue; const k = x.owner.toLowerCase(); const h = by.get(k) || { n: 0, chains: new Set() }; h.n++; h.chains.add(x.chain); by.set(k, h); }
  const rows = [...by.entries()].sort((a, b) => b[1].n - a[1].n); const tot = rows.reduce((s, r) => s + r[1].n, 0) || 1;
  return `<div class="act hold"><div class="mut small" style="margin:0 0 8px">${rows.length.toLocaleString()} holders · ${ownersLiveAt ? 'live on-chain ownership' : 'snapshot'} · names via ENS / Basenames</div><div class="acth"><span>#</span><span>Holder</span><span>Owned</span><span>Share</span><span>Chains</span></div>
   ${rows.slice(0, 200).map(([a, h], i) => `<div class="actr"><span>${i + 1}</span><span>${addrHtml(a)}</span><span><b>${h.n}</b></span><span>${((h.n / tot) * 100).toFixed(2)}%</span><span>${[...h.chains].map(c => logo(c)).join('')}</span></div>`).join('') || '<div class="empty">No holders found</div>'}</div>`;
}
function activityView() {
  const rows = activity.filter(a => !st.chains.size || st.chains.has(a.chain)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const byId = new Map(items.map(i => [i.id, i]));
  return `<div class="act"><div class="acth"><span>Event</span><span>Item</span><span>Price</span><span>From</span><span>To</span><span>Time</span></div>
   ${rows.slice(0, 200).map(a => { const it = byId.get(a.id); const ex = chains[a.chain]?.explorer; return `<div class="actr"><span class="ev">${logo(a.chain)}<b class="t-${a.type}">${a.type === 'sale' ? 'Sale' : a.type === 'mint' ? 'Mint' : a.type === 'list' ? 'List' : 'Transfer'}</b></span>
     <span class="ai" data-id="${a.id}">${it ? (isOrd(it.id) ? ordKit!.ordThumb(ordById.get(it.id)!.iid, '').replace('<img', '<img width="40" height="40"') : thumb(it, false, 40)) : ''}<span>${esc(it?.name || '#' + a.id)}${a.ids?.length > 1 ? ` +${a.ids.length - 1}` : ''}</span></span>
     <span>${(a.type === 'sale' || a.type === 'list') && a.price != null ? `${fmt(a.price)} ${esc(a.currency.startsWith('0x') ? short(a.currency) : a.currency)}` : '-'}</span><span>${addrHtml(a.from)}</span><span>${addrHtml(a.to)}</span>
     <span>${ex ? `<a href="${ex}/tx/${a.tx}" target="_blank" rel="noopener">${ago(a.ts)} ↗</a>` : ago(a.ts)}</span></div>`; }).join('') || '<div class="empty">No activity found</div>'}</div>`;
}

function chainsView() {
  const pc = summary?.perChain || {};
  return `<div class="ctab">${COL.deployments.map(d => { const p = pc[d.chain]; const c = chains[d.chain]; return `<div class="cc">${logo(d.chain, 'cl lg')}<div><h3>${c.name} ${(d as any).original ? '<i class="tag">original</i>' : ''} ${c.note ? `<i class="need">${esc(c.note)}</i>` : ''}</h3>
    <a class="mono" href="${c.explorer}/address/${d.address}" target="_blank" rel="noopener">${d.address}</a>
    ${p?.ok ? `<div class="kv"><span>Held (ownerOf)</span><b>${p.minted}</b><span>In vault/escrow</span><b>${p.inEscrow}</b><span>Live on chain</span><b>${p.live}</b><span>Holders</span><b>${p.holders}</b><span>Transfers indexed</span><b>${p.transfers ?? '-'}${p.historyComplete ? '' : ' (partial)'}</b><span>Seaport sales</span><b>${p.sales}</b></div>` : `<div class="mut">${esc(p?.error || 'no data')}</div>`}
    ${c.openseaSlug ? `<a class="os" target="_blank" rel="noopener" href="https://opensea.io/assets/${c.openseaSlug}/${d.address}">View on OpenSea ↗</a>` : ''}</div></div>`; }).join('')}
    ${ordSoon() ? `<div class="cc">${logo('bitcoin', 'cl lg')}<div><h3>Bitcoin (Ordinals) <i class="soon">Coming soon</i></h3><div class="mut">Not live yet. No inscriptions are linked to ${esc(COL.name)}.</div></div></div>` : ''}
    ${ORD ? `<div class="cc">${logo('bitcoin', 'cl lg')}<div><h3>Bitcoin (Ordinals) ${ORD.demo ? '<i class="need">DEMO · signet mock</i>' : ''}</h3><div class="mut">${ORD.collection ? 'Ordinals collection ' + esc(ORD.collection) : bridgedN ? 'Bridged from Abstract (each foot stays locked in the Abstract vault)' : 'Linked inscriptions'} · ${D_net()}</div><div class="kv"><span>Inscriptions</span><b>${ORD.items.length}</b><span>Holders</span><b>${pc.bitcoin?.holders ?? '-'}</b><span>Listed on MultiSea</span><b>${ORD.items.filter(o => o.priceSats != null).length}</b><span>Floor</span><b>${pc.bitcoin?.floorSats ? ordKit!.D.fmtBtc(pc.bitcoin.floorSats) + ' · ' + ordKit!.D.fmtSats(pc.bitcoin.floorSats) : '-'}</b></div><a class="os" href="/btc${ORD.collection ? '/c/' + esc(ORD.collection) : ''}">Open Bitcoin marketplace ↗</a></div></div>` : ''}
    <p class="mut small">Data generated ${summary ? new Date(summary.generatedAt).toLocaleString() : '-'}${ownersLiveAt ? `; ownership and live counts read from chain (ownerOf) at ${new Date(ownersLiveAt).toLocaleTimeString()}` : ''}. Vault/escrow addresses excluded: ${COL.escrow.map(e => `${esc(e.label)} ${short(e.address)}`).join(', ')}.</p></div>`;
}

const D_net = () => (ORD ? ordKit!.D.netLabel(ORD.net) : '');
function mrowHtml(id: number) {
  const it = items.find(i => i.id === id)!; const loc = owners[id];
  return `<div class="mrow" data-mrow="${id}"><span>Owned by <b>${addrHtml(loc?.owner)}</b></span>${loc ? `<span>${logo(loc.chain)} ${chains[loc.chain].name}</span>` : '<span class="mut">Not live on any chain</span>'}<span>Rarity rank ${it.rank} / ${items.length}</span><a href="${gw[0]}${it.image}" target="_blank" rel="noopener">Original ↗</a></div>${loc?.also ? `<div class="mut small">Also held on: ${loc.also.map(a => chains[a.chain].name + ' ' + addrHtml(a.owner)).join(', ')}</div>` : ''}`;
}
function modal(id: number) {
  if (isOrd(id)) { location.href = ordHref(id); return; }
  const it = items.find(i => i.id === id); if (!it) return;
  const loc = owners[id]; const l = listMap.get(id);
  const T = traits.traits as Record<string, { value: string; count: number; pct: number }[]>;
  const osLinks = deployedChains.filter(c => chains[c].openseaSlug).map(c => `<a class="osl ${loc?.chain === c ? 'cur' : ''}" href="${osUrl(c, id)}" target="_blank" rel="noopener">${logo(c)} ${chains[c].name}</a>`).join('');
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="mbox"><button class="x mx">✕</button><div class="mimg" style="background:${it.color}"><img src="${thumbUrl(id)}" width="768" height="768" alt="" class="lo"><img src="${thumbUrl(id, 'm')}" width="768" height="768" alt="${esc(it.name)}" class="hi" onload="this.classList.add('in')" onerror="this.onerror=null;this.src='${gw[0]}${it.image}'"></div><div class="minfo">
    <div class="mcol">${esc(COL.name)}</div><h2>${esc(it.name)}</h2>
    ${mrowHtml(id)}
    ${FW_ON ? `<div class="fwmrow"><a class="obtn sm fwwbtn" href="/w/${id}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></svg> Wallet</a><span class="fwmval" data-fwm="${id}"><span class="fwbadge">Wallet: …</span></span><span class="mut small">Tokens and NFTs inside this foot, on 5 chains</span></div>` : ''}
    <div class="pricebox"><div class="mut">Current price</div><div class="big">${l ? `${logo(l.chain)} ${fmt(l.price)} ${esc(l.currency)}${usd(l)}${srcBadge(l)}` : '-'}</div>${l ? `<div>${eq(l)}</div>` : ''}${!summary?.listingsAvailable ? '<div class="need">Listings need an OpenSea API key</div>' : ''}${buyBtn(id, 'big')}${l && !sellBtn(id, '') ? `<button class="obtn sm addcart" data-cart="${id}">+ Add to cart</button>` : ''}<div class="osls">${osLinks}</div></div>
    <div class="gh">Traits</div><div class="tgrid">${it.attrs.map(([t, v]) => { const x = T[t]?.find(e => e.value === v); return `<div class="trait"><span>${esc(t)}</span><b>${esc(v)}</b><em>${x ? x.pct + '% have this' : ''}</em></div>`; }).join('')}</div>
  </div></div>`;
  m.addEventListener('click', e => { const ac = (e.target as HTMLElement).closest('[data-cart]') as HTMLElement; if (ac) { const ci = cartItems().find(x => x.id === +ac.dataset.cart!); if (ci) import('./gx').then(g => { g.addToCart([ci]); ac.textContent = '✓ In cart'; }); return; } const bb = (e.target as HTMLElement).closest('[data-buy]') as HTMLElement; if (bb) { m.remove(); doBuy(+bb.dataset.buy!); return; } const sb = (e.target as HTMLElement).closest('[data-sell],[data-cancel]') as HTMLElement; if (sb) { m.remove(); sb.dataset.sell ? doSell(+sb.dataset.sell) : doCancel(+sb.dataset.cancel!); return; } if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) m.remove(); });
  document.body.appendChild(m);
  if (FW_ON) import('./footkit').then(async k => { fwkit = k; const r = await k.walletUsd([id]).catch(() => null); const v = r ? r.get(id) ?? null : null; fwv.set(id, v); const el = m.querySelector(`[data-fwm="${id}"]`); if (el) el.innerHTML = k.walletBadge(id, v, true).replace('Wallet: -', 'Wallet: unavailable'); });
}

function render() {
  const y = window.scrollY;
  app.innerHTML = `${navHtml()}
  ${header()}<div class="content">${st.tab === 'items' ? (soonOn ? btcSoonView() : itemsView()) : st.tab === 'activity' ? activityView() : st.tab === 'holders' ? holdersView() : st.tab === 'bridge' ? '<div id="bridgebox"></div>' : chainsView()}</div>`;
  window.scrollTo(0, y);
  applyBridgeFlag(); if (st.tab === 'items') fwFill();
  const on = document.querySelector<HTMLElement>('.chips .chip.on'); if (on) { const r = on.parentElement!; r.scrollLeft = on.offsetLeft - r.offsetLeft - 12; }
  if (st.tab === 'bridge') bridgeEnabled().then(on => { if (!on) { st.tab = 'items'; render(); return; } import('./bridgekit').then(b => b.mountBridge(document.getElementById('bridgebox')!, { slug: COL.slug })); });
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const tab = t.closest('[data-tab]') as HTMLElement; if (tab) { st.tab = tab.dataset.tab!; if (st.tab === 'activity') loadActivity(); render(); return; }
  if (t.closest('[data-btcsoon]')) { soonOn = !soonOn; if (soonOn) st.chains.clear(); render(); return; }
  const chip = t.closest('[data-chain]') as HTMLElement; if (chip) { soonOn = false; const c = chip.dataset.chain!;
    // Chips are single-select (one chain, or All); multi-chain picks stay in the sidebar checkboxes. A union of BNB + Bitcoin read as a leak on mobile.
    const only = st.chains.size === 1 && st.chains.has(c); st.chains.clear(); if (c && !only) st.chains.add(c); render(); return; }
  const bb = t.closest('[data-buy]') as HTMLElement; if (bb) { e.stopPropagation(); doBuy(+bb.dataset.buy!); return; }
  const sb = t.closest('[data-sell],[data-cancel]') as HTMLElement; if (sb) { e.stopPropagation(); sb.dataset.sell ? doSell(+sb.dataset.sell) : doCancel(+sb.dataset.cancel!); return; }
  if (t.closest('.nosell')) { e.stopPropagation(); return; }
  const act = t.closest('[data-act]') as HTMLElement;
  const ca = (e.target as HTMLElement).closest('[data-cancelall]') as HTMLElement | null;
  if (ca) { const k = ca.dataset.cancelall!; import('./sell').then(m => m.cancelAllNative(k, myNative()[k] || 0, () => { const me = wallet.address?.toLowerCase(); [...listMap].forEach(([id, l]) => { if (l.source === 'multisea' && l.chain === k && l.seller?.toLowerCase() === me) listMap.delete(id); }); render(); })); return; }
  if (act?.dataset.act === 'edit') { openEdit({ slug: COL.slug, name: COL.name, description: ovr.description || COL.description, ...ovr }, c => { ovr = c; render(); }); return; }
  if (act?.dataset.act === 'sweep') { import('./cart').then(c => c.openSweep(cartItems(), COL.name)); return; }
  if (act) { const a = act.dataset.act; if (a === 'more') st.limit += 60; if (a === 'toggle-side') st.sidebar = !st.sidebar; if (a === 'close-side') st.sidebar = false; if (a === 'clear') st.traits.clear(); render(); return; }
  const rm = t.closest('[data-rm-trait]') as HTMLElement; if (rm) { st.traits.get(rm.dataset.rmTrait!)?.delete(rm.dataset.v!); render(); return; }
  if (t.closest('.fwbadge')) return;
  if (t.closest('.ordc')) return; // Ordinals cards are links to the inscription detail (BTC wallet Buy/List)
  const c = t.closest('.card,.ai') as HTMLElement; if (c) modal(+c.dataset.id!);
});
app.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.classList.contains('sort')) st.sort = t.value;
  else if (t.name === 'status') st.status = t.value;
  else if (t.dataset.chainCb) { const c = t.dataset.chainCb; t.checked ? st.chains.add(c) : st.chains.delete(c); }
  else if (t.dataset.trait) { const k = t.dataset.trait; if (!st.traits.has(k)) st.traits.set(k, new Set()); t.checked ? st.traits.get(k)!.add(t.value) : st.traits.get(k)!.delete(t.value); }
  else return;
  st.limit = 60; render();
});
let qt: any; app.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (!t.classList.contains('search')) return; clearTimeout(qt); qt = setTimeout(() => { st.q = t.value.trim().toLowerCase(); render(); const s = $('.search') as HTMLInputElement; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250); });
bindNav(() => { if (st.status === 'mine') st.status = 'all'; });
async function refreshEditable() {
  editable = false;
  if (apiReady && wallet.address) { try { editable = !!(await (await fetch(`${API}/collections/${COL.slug}/can-edit?address=${wallet.address}`)).json()).ok; } catch {} }
  render();
}
onWallet(() => { if (!wallet.address && st.status === 'mine') st.status = 'all'; refreshEditable(); });
// Load API data even if /health was blocked (other routes often still work); retry when the API comes back.
const apiLoad = async () => { loadLiveListings().then(render); try { const j = await (await fetch(`${API}/collections/${COL.slug}`)).json(); ovr = j.collection || {}; render(); if (ovr.ordinals) loadOrdinals(); } catch {} refreshEditable(); };
checkApi().then(apiLoad); onApiUp(apiLoad);
render();
loadLiveOwners();
loadOrdinals();
if (params.get('item')) modal(+params.get('item')!);
if (params.get('tab')) { st.tab = params.get('tab')!; if (st.tab === 'activity') loadActivity(); render(); }
