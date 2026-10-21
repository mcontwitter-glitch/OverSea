// MultiSea Launchpad (PREVIEW): /launchpad (drops: live / upcoming / ended) and /launchpad/<slug> (mint page).
// Mint is a clearly labeled DEMO stub: no launchpad factory is deployed yet, so nothing is sent on-chain.
import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, openConnect, apiFeatures, API } from './wallet';
import { navHtml, bindNav, esc, usdRates, type UsdRates } from './shell';
import { gasPrice } from './txgas';
import { FLAT_FEE_USD } from './xpaycore';
import { allDrops as demoAndLocal, findDrop as findLocal, localDrops, dropState, activePhase, nextPhase, countdown, minted, pct, FEE_BPS, GAS_UNITS, type Drop } from './launchdata';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; native: string; chainId: number }>;
const path = location.pathname.replace(/\/+$/, '');
const slug = path.split('/')[2] || '';
const fmt = (n: number, d = 6) => (+n.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const usdTxt = (v: number | null) => (v == null || !isFinite(v) ? '' : v > 0 && v < 0.01 ? '< $0.01' : '≈ $' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rateOf = (r: UsdRates, k: string) => (chains[k]?.native === 'APE' ? r.APE : chains[k]?.native === 'BNB' ? r.BNB : r.ETH);
const chainLogos = (d: Drop) => d.chains.map(c => `<img class="cl" src="/logos/${c.chain}.svg" title="${esc(chains[c.chain]?.name)}" alt="">`).join('');
const demoTag = (d: Drop) => (d.demo ? '<span class="ldtag demo">Demo</span>' : d.local ? '<span class="ldtag demo">Local preview</span>' : '');
let rates: UsdRates = { ETH: null, APE: null, BNB: null };
// Worker drops (once the launchpad Worker routes are deployed). Prices arrive in wei; per-chain minted counts would come
// from each drop contract's totalMinted() (not wired in this preview: shows 0 until contracts exist).
let remote: Drop[] = [];
const fromApi = (d: any): Drop => ({ slug: d.slug, name: d.name, symbol: d.symbol, creator: d.submitter || '', description: d.description || '', website: d.website, x: d.x, status: d.status,
  chains: (d.chains || []).map((c: string) => ({ chain: c, supply: d.allocations?.[c] ?? Math.floor(d.maxSupply / d.chains.length), minted: 0 })), maxSupply: d.maxSupply, royaltyBps: d.royaltyBps, reveal: d.reveal,
  phases: (d.phases || []).map((p: any) => ({ ...p, price: Number(BigInt(p.price)) / 1e18 })), img: d.logo ? API + d.logo : '/brand/icon-128.webp', art: d.banner ? [API + d.banner] : [] });
const allDrops = () => [...remote, ...demoAndLocal().filter(x => !remote.some(r => r.slug === x.slug))];
const findDrop = (s: string) => remote.find(d => d.slug === s) || findLocal(s);

// ---------------- list ----------------
let tab: 'live' | 'upcoming' | 'ended' = 'live';
function stateChip(d: Drop) {
  const st = dropState(d); const a = activePhase(d), n = nextPhase(d);
  if (st === 'live') { const p = d.phases[a]; return `<span class="ldst live"><i></i>Live${p.end ? ` · ends in <b data-cd="${p.end}">${countdown(p.end).text}</b>` : ''}</span>`; }
  if (st === 'upcoming') return `<span class="ldst up">Starts in <b data-cd="${d.phases[n].start}">${countdown(d.phases[n].start).text}</b></span>`;
  return `<span class="ldst end">${minted(d) >= d.maxSupply ? 'Sold out' : 'Ended'}</span>`;
}
function dropCard(d: Drop) {
  const st = dropState(d); const ph = d.phases[activePhase(d)] || d.phases[nextPhase(d)] || d.phases[d.phases.length - 1];
  const c0 = d.chains[0]; const price = c0.price ?? ph.price;
  return `<a class="ldcard" href="/launchpad/${esc(d.slug)}"><div class="ldimg"><img src="${esc(d.img)}" alt="" loading="lazy" width="384" height="384">${demoTag(d)}</div>
   <div class="ldbody"><div class="ldname">${esc(d.name)}</div><div class="ldchains">${chainLogos(d)}</div>${stateChip(d)}
   <div class="ldprog"><div class="ldbar"><i style="width:${pct(minted(d), d.maxSupply)}%"></i></div><span>${minted(d).toLocaleString()} / ${d.maxSupply.toLocaleString()} minted</span></div>
   <div class="ldmeta"><span>${st === 'ended' ? 'Price' : esc(ph.name)}</span><b>${price ? `${fmt(price)} ${esc(chains[c0.chain]?.native)}` : 'Free'}</b></div></div></a>`;
}
function listPage() {
  document.title = 'Launchpad · MultiSea';
  const drops = allDrops(); const by = (s: string) => drops.filter(d => dropState(d) === s);
  const mine = localDrops().filter(d => d.status === 'pending' || d.status === 'rejected');
  const l = by(tab);
  app.innerHTML = `${navHtml('launchpad')}<section class="page wide ldpage">
   <div class="ldhero"><div><h1>🚀 Launchpad</h1><p class="mut">Mint new collections on Base, Ethereum, ApeChain, BNB and Robinhood. Pay with any token from any chain. Every drop is reviewed by MultiSea before it goes live, then trades on MultiSea from the first mint.</p></div>
    <a class="bbtn sm" href="/launchpad/create">+ Create a drop</a></div>
   <div class="ldnote">Preview: launchpad contracts are not deployed yet. Drops below are <b>demo data</b> (LIL FOOTS art) and minting is a stub.</div>
   <div class="ldtabs" role="tablist">${(['live', 'upcoming', 'ended'] as const).map(k => `<button role="tab" class="ldtab ${tab === k ? 'on' : ''}" data-tab="${k}">${k[0].toUpperCase() + k.slice(1)} <span>${by(k).length}</span></button>`).join('')}</div>
   <div class="ldgrid">${l.length ? l.map(dropCard).join('') : `<p class="mut">No ${tab} drops right now.</p>`}</div>
   ${mine.length ? `<div class="gh pad">Your submissions (this browser)</div><div class="ldmine">${mine.map(d => `<div class="qcard"><b>${esc(d.name)}</b> <span class="ldtag ${d.status}">${esc(d.status)}</span><div class="mut small">${d.chains.map(c => esc(chains[c.chain]?.name)).join(', ')} · ${d.maxSupply.toLocaleString()} supply · submitted ${esc(d.submittedAt?.slice(0, 10))}</div></div>`).join('')}</div>` : ''}
  </section>`;
}

// ---------------- drop / mint page ----------------
let chainSel = ''; let qty = 1; let pay: 'direct' | 'relay' = 'direct'; let gp: Record<string, bigint | null> = {}; let alAddr = ''; let alRes = ''; let demoMsg = '';
function phaseRows(d: Drop) {
  const a = activePhase(d);
  return d.phases.map((p, i) => {
    const n = Math.floor(Date.now() / 1000); const st = i === a ? 'live' : p.start > n ? 'up' : 'end';
    const when = st === 'live' ? (p.end ? `Ends in <b data-cd="${p.end}">${countdown(p.end).text}</b>` : 'Open until sold out') : st === 'up' ? `Starts in <b data-cd="${p.start}">${countdown(p.start).text}</b>` : 'Ended';
    const c = d.chains.find(x => x.chain === chainSel) || d.chains[0]; const price = c.price != null && p.kind === 'public' ? c.price : p.price;
    return `<div class="ldph ${st}"><div class="ldphh"><b>${esc(p.name)}</b><span class="ldst ${st === 'up' ? 'up' : st}">${st === 'live' ? '<i></i>Live' : st === 'up' ? 'Upcoming' : 'Ended'}</span></div>
     <div class="ldphm"><span>${p.kind === 'allowlist' ? `🔒 Allowlist${p.allowCount ? ` · ${p.allowCount.toLocaleString()} wallets` : ''}` : '🌐 Public'}</span><span>${price ? `${fmt(price)} ${esc(chains[c.chain]?.native)}` : 'Free'}</span><span>${p.maxPerWallet ? `Max ${p.maxPerWallet} / wallet` : 'No wallet limit'}</span></div>
     <div class="ldphw mut small">${when}</div></div>`;
  }).join('');
}
function breakdown(d: Drop) {
  const c = d.chains.find(x => x.chain === chainSel) || d.chains[0]; const ai = activePhase(d); const p = d.phases[ai];
  if (!p) return '';
  const nat = chains[c.chain].native; const unit = p.kind === 'public' && c.price != null ? c.price : p.price; const price = unit * qty;
  const r = rateOf(rates, c.chain); const g = gp[c.chain];
  const gasNat = g ? Number((GAS_UNITS(qty) * 125n / 100n + 10_000n) * g) / 1e18 : null;
  const feeNat = (price * FEE_BPS) / 10_000; const relayUsd = pay === 'relay' ? FLAT_FEE_USD : 0;
  const total = price + (gasNat ?? 0) + (r ? relayUsd / r : 0);
  return `<div class="kv bkv ldkv"><span>Mint price</span><b>${qty} × ${fmt(unit)} = ${fmt(price)} ${esc(nat)} <i class="usd">${usdTxt(r ? price * r : null)}</i></b>
    <span>MultiSea fee</span><b>${fmt(feeNat + (r ? relayUsd / r : 0))} ${esc(nat)} <i class="usd">${pay === 'relay' ? `0.5% included + $${FLAT_FEE_USD.toFixed(2)} Relay route` : '0.5% included in price'}</i></b>
    <span>Network gas (est.)</span><b>${gasNat == null ? '<span class="spin"></span>' : `${fmt(gasNat, 7)} ${esc(nat)} <i class="usd">${usdTxt(r ? gasNat * r : null)}</i>`}</b>
    <span>Total</span><b class="xtot">${fmt(total)} ${esc(nat)} <i class="usd">${usdTxt(r ? total * r : null)}</i></b></div>`;
}
function mintBox(d: Drop) {
  const st = dropState(d); const ai = activePhase(d); const p = d.phases[ai]; const c = d.chains.find(x => x.chain === chainSel) || d.chains[0];
  const left = c.supply - c.minted; const max = Math.max(1, Math.min(p?.maxPerWallet || 20, left, 20));
  if (qty > max) qty = max;
  const al = p?.kind === 'allowlist'; const eligible = !al || (!!wallet.address && !!p.allowlist?.includes(wallet.address.toLowerCase()));
  const btn = st !== 'live' ? `<button class="bbtn" disabled>${st === 'upcoming' ? 'Not started' : 'Minting ended'}</button>`
    : !eligible ? `<button class="bbtn" disabled>${wallet.address ? 'Not on this allowlist' : 'Connect to check allowlist'}</button>`
    : `<button class="bbtn ldmint" data-act="mint">Mint ${qty} · demo (no transaction)</button>`;
  return `<div class="fcard ldmintbox">
   ${d.chains.length > 1 ? `<div class="gh">Mint on</div><div class="ldchsel">${d.chains.map(x => `<button class="ldch ${x.chain === c.chain ? 'on' : ''}" data-ch="${x.chain}"><img class="cl" src="/logos/${x.chain}.svg" alt=""><span><b>${esc(chains[x.chain].name)}</b><em>${(x.supply - x.minted).toLocaleString()} left</em></span></button>`).join('')}</div>` : ''}
   ${st === 'live' ? `<div class="ldqty"><span class="gh">Quantity</span><div class="qpick"><button data-q="-1" ${qty <= 1 ? 'disabled' : ''} aria-label="Less">−</button><input data-qin type="number" min="1" max="${max}" value="${qty}" aria-label="Quantity"><button data-q="1" ${qty >= max ? 'disabled' : ''} aria-label="More">+</button></div><button class="pill" data-q="max">Max ${max}</button></div>
   <div class="ldpay"><label class="${pay === 'direct' ? 'on' : ''}"><input type="radio" name="pay" value="direct" ${pay === 'direct' ? 'checked' : ''}><span><b>${esc(chains[c.chain].native)} on ${esc(chains[c.chain].name)}</b><em>Direct mint</em></span></label><label class="${pay === 'relay' ? 'on' : ''}"><input type="radio" name="pay" value="relay" ${pay === 'relay' ? 'checked' : ''}><span><b>Any token, any chain</b><em>Routed by Relay</em></span></label></div>
   ${breakdown(d)}` : ''}
   ${btn}
   ${demoMsg ? `<div class="okbox small">${demoMsg}</div>` : ''}
   <p class="mut small">Demo / testnet stub: this preview never sends a transaction. In production the button simulates the mint, sets an explicit gas limit (+25%), then asks your wallet to sign.</p></div>`;
}
function alBox(d: Drop) {
  const al = d.phases.filter(p => p.kind === 'allowlist'); if (!al.length) return '';
  return `<div class="fcard"><div class="gh">Allowlist check</div><div class="ldal"><input data-al placeholder="0x… wallet address" value="${esc(alAddr || wallet.address || '')}"><button class="obtn sm" data-act="alcheck">Check</button></div>${alRes ? `<p class="small">${alRes}</p>` : '<p class="mut small">Checks every allowlist phase. In production the Worker returns your Merkle proof from /launchpad/proof.</p>'}</div>`;
}
function dropPage(d: Drop) {
  document.title = `${d.name} · Launchpad · MultiSea`;
  if (!chainSel || !d.chains.some(c => c.chain === chainSel)) chainSel = d.chains[0].chain;
  const st = dropState(d); const ai = activePhase(d), ni = nextPhase(d);
  const target = st === 'live' ? d.phases[ai].end : st === 'upcoming' ? d.phases[ni].start : 0;
  const cd = target ? countdown(target) : null;
  app.innerHTML = `${navHtml('launchpad')}<section class="ldrop">
   <div class="ldban"><div class="ldbanart">${d.art.slice(0, 8).map(u => `<img src="${esc(u)}" alt="" width="200" height="200">`).join('')}</div><div class="ldbanfade"></div>
    <div class="ldbanin"><img class="ldlogo" src="${esc(d.img)}" alt="" width="96" height="96"><div><div class="ldtags">${demoTag(d)}<span class="ldst ${st === 'upcoming' ? 'up' : st}">${st === 'live' ? '<i></i>Live' : st === 'upcoming' ? 'Upcoming' : 'Ended'}</span></div><h1>${esc(d.name)}</h1><div class="ldchains">${chainLogos(d)} ${d.creator ? `<span class="mut small">by <span class="mono">${esc(d.creator.slice(0, 6) + '…' + d.creator.slice(-4))}</span></span>` : ''}</div></div></div></div>
   <div class="ldwrap"><div class="ldmain ldtop">
    <p class="desc">${esc(d.description)}</p>
    ${cd ? `<div class="ldcd" data-target="${target}"><span class="mut">${st === 'live' ? esc(d.phases[ai].name) + ' ends in' : esc(d.phases[ni].name) + ' starts in'}</span><div class="ldcdg"><div><b data-u="d">${cd.d}</b><em>days</em></div><div><b data-u="h">${cd.h}</b><em>hrs</em></div><div><b data-u="m">${cd.m}</b><em>min</em></div><div><b data-u="s">${cd.s}</b><em>sec</em></div></div></div>` : ''}
    <div class="ldprog big"><div class="ldprogh"><b>${pct(minted(d), d.maxSupply).toFixed(1)}% minted</b><span>${minted(d).toLocaleString()} / ${d.maxSupply.toLocaleString()}</span></div><div class="ldbar"><i style="width:${pct(minted(d), d.maxSupply)}%"></i></div>
     ${d.chains.length > 1 ? `<div class="ldperch">${d.chains.map(c => `<span><img class="cl" src="/logos/${c.chain}.svg" alt=""> ${c.minted.toLocaleString()} / ${c.supply.toLocaleString()}</span>`).join('')}</div>` : ''}</div>
   </div><div class="ldmain ldphwrap"><div class="gh pad">Phases</div><div class="ldphs">${phaseRows(d)}</div></div>
   <aside class="ldside">${mintBox(d)}${alBox(d)}
    <div class="fcard small"><div class="kv"><span>Supply</span><b>${d.maxSupply.toLocaleString()}</b><span>Royalty (ERC-2981)</span><b>${d.royaltyBps / 100}%</b><span>Reveal</span><b>${d.reveal === 'instant' ? 'Instant' : 'Delayed'}</b><span>Standard</span><b>ERC-721A</b><span>After mint</span><b>Trades on MultiSea</b></div></div>
   </aside></div></section>`;
}
function tick() {
  document.querySelectorAll<HTMLElement>('[data-cd]').forEach(e => { e.textContent = countdown(+e.dataset.cd!).text; });
  const c = document.querySelector<HTMLElement>('.ldcd'); if (c) { const x = countdown(+c.dataset.target!); (['d', 'h', 'm', 's'] as const).forEach(u => { const b = c.querySelector(`[data-u="${u}"]`); if (b) b.textContent = String(x[u]); }); }
}
// Live gas price from MultiSea's read RPCs; fallback is a rough per-chain estimate when the RPC is slow (labelled est.).
const FALLBACK_GP: Record<string, bigint> = { ethereum: 2_000_000_000n, bnb: 100_000_000n, apechain: 25_000_000_000n, base: 10_000_000n, robinhood: 10_000_000n };
async function loadGas(d: Drop) {
  await Promise.all(d.chains.map(async c => { if (gp[c.chain] !== undefined) return; gp[c.chain] = null;
    const g = await Promise.race([gasPrice(c.chain), new Promise<bigint>(r => setTimeout(() => r(0n), 6000))]); gp[c.chain] = g || FALLBACK_GP[c.chain] || 10_000_000n; }));
}
function render() {
  if (!slug) return listPage();
  if (slug === 'create') return;
  const d = findDrop(slug);
  if (!d) { app.innerHTML = `${navHtml('launchpad')}<section class="page"><h2>Drop not found</h2><p><a href="/launchpad">Back to Launchpad</a></p></section>`; return; }
  dropPage(d);
}
app.addEventListener('click', e => {
  const t = e.target as HTMLElement; const el = t.closest('[data-tab],[data-ch],[data-q],[data-act]') as HTMLElement | null; if (!el) return;
  if (el.dataset.tab) { tab = el.dataset.tab as any; render(); return; }
  const d = findDrop(slug); if (!d) return;
  if (el.dataset.ch) { chainSel = el.dataset.ch; qty = 1; demoMsg = ''; render(); }
  if (el.dataset.q) { qty = el.dataset.q === 'max' ? 999 : Math.max(1, qty + +el.dataset.q); demoMsg = ''; render(); }
  if (el.dataset.act === 'alcheck') {
    alAddr = (app.querySelector('[data-al]') as HTMLInputElement).value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(alAddr)) alRes = '<span class="err">Enter a 0x address.</span>';
    else alRes = d.phases.filter(p => p.kind === 'allowlist').map(p => `${p.allowlist?.includes(alAddr) ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'} ${esc(p.name)}`).join(' &nbsp; ') + ' <span class="mut">(demo list)</span>';
    render();
  }
  if (el.dataset.act === 'mint') {
    const c = d.chains.find(x => x.chain === chainSel)!;
    demoMsg = `✓ Demo only: would mint <b>${qty}</b> × ${esc(d.name)} on ${esc(chains[c.chain].name)}${pay === 'relay' ? ' paying with any token via Relay' : ''}. No transaction was created or sent.${wallet.address ? '' : ' (Connect a wallet to test the allowlist path.)'}`;
    render();
  }
});
app.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'pay') { pay = t.value as any; render(); }
  if (t.dataset.qin != null) { qty = Math.max(1, Math.floor(+t.value || 1)); render(); }
});
if (path === '/launchpad/create') import('./launchcreate');
else {
  bindNav(); render(); setInterval(tick, 1000); onWallet(render); checkApi().then(async () => { if (!apiFeatures.includes('launchpad')) return; try { const j = await fetch(API + '/launchpad/drops').then(r => r.json()); remote = (j.drops || []).map(fromApi); render(); } catch {} });
  usdRates().then(r => { rates = r; render(); });
  const d = slug ? findDrop(slug) : null; if (d) loadGas(d).then(render);
}
export { openConnect };
