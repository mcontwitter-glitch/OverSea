// MultiSea Launchpad (PREVIEW): /launchpad (drops: live / upcoming / ended) and /launchpad/<slug> (mint page).
// Mint is a clearly labeled DEMO stub: no launchpad factory is deployed yet, so nothing is sent on-chain.
import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, openConnect, apiFeatures, API } from './wallet';
import { navHtml, bindNav, esc, usdRates, type UsdRates } from './shell';
import { gasPrice } from './txgas';
import { FLAT_FEE_USD } from './xpaycore';
import { allDrops as demoAndLocal, findDrop as findLocal, localDrops, dropState, comingSoon, activePhase, nextPhase, countdown, minted, pct, FEE_BPS, GAS_UNITS, isMulti, priceOn, lzUsd, lzEta, mintLegs, legsUsd, HUB, MOVE_FEE_USD, MOVE_GAS_UNITS, OMNI_GAS_UNITS, isBatched, batchEta, batchShareUsd, demoHeld, saveHeld, type Drop, type Held } from './launchdata';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; native: string; chainId: number }>;
const path = location.pathname.replace(/\/+$/, '');
const slug = path.split('/')[2] || '';
const fmt = (n: number, d = 6) => (+n.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const usdTxt = (v: number | null) => (v == null || !isFinite(v) ? '' : v > 0 && v < 0.01 ? '< $0.01' : '≈ $' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rateOf = (r: UsdRates, k: string) => (chains[k]?.native === 'APE' ? r.APE : chains[k]?.native === 'BNB' ? r.BNB : r.ETH);
const chainLogos = (d: Drop) => d.chains.map(c => `<img class="cl" src="/logos/${c.chain}.svg" title="${esc(chains[c.chain]?.name)}" alt="">`).join('');
const demoTag = (d: Drop) => (d.demo ? '<span class="ldtag demo">Demo</span>' : d.local ? '<span class="ldtag demo">Local preview</span>' : '');
const mcTag = (d: Drop) => (isMulti(d) ? '<span class="ldtag mc" title="One shared supply across chains; NFTs can move between chains">Multichain</span>' : '');
const CH_COL: Record<string, string> = { base: '#3b82f6', ethereum: '#a3a3ff', apechain: '#1d4ed8', bnb: '#f0b90b', robinhood: '#c3f53c' };
let rates: UsdRates = { ETH: null, APE: null, BNB: null };
// Worker drops (once the launchpad Worker routes are deployed). Prices arrive in wei; per-chain minted counts would come
// from each drop contract's totalMinted() (not wired in this preview: shows 0 until contracts exist).
let remote: Drop[] = [];
const fromApi = (d: any): Drop => ({ mode: d.mode === 'multichain' ? 'multichain' : 'single', slug: d.slug, name: d.name, symbol: d.symbol, creator: d.submitter || '', description: d.description || '', website: d.website, x: d.x, status: d.status,
  // `deployed` comes from the Worker; older Workers lack it, so fall back to the same rule (verified on-chain = status 'live').
  deployed: typeof d.deployed === 'boolean' ? d.deployed : d.status === 'live' && Array.isArray(d.deployments) && d.deployments.length > 0,
  chains: (d.chains || []).map((c: string) => ({ chain: c, supply: d.allocations?.[c] ?? Math.floor(d.maxSupply / d.chains.length), minted: 0 })), maxSupply: d.maxSupply, royaltyBps: d.royaltyBps, reveal: d.reveal,
  phases: (d.phases || []).map((p: any) => ({ ...p, price: Number(BigInt(p.price)) / 1e18, prices: p.prices ? Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, Number(BigInt(v as string)) / 1e18])) : undefined })), img: d.logo ? API + d.logo : '/brand/icon-128.webp', art: d.banner ? [API + d.banner] : [] });
const allDrops = () => [...remote, ...demoAndLocal().filter(x => !remote.some(r => r.slug === x.slug))];
const findDrop = (s: string) => remote.find(d => d.slug === s) || findLocal(s);

// ---------------- list ----------------
let tab: 'live' | 'upcoming' | 'ended' = 'live';
const SOON = '<span class="ldst soon">Coming soon</span>';
const fmtStart = (s: number) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function stateChip(d: Drop) {
  if (comingSoon(d)) return SOON;
  const st = dropState(d); const a = activePhase(d), n = nextPhase(d);
  if (st === 'live') { const p = d.phases[a]; return `<span class="ldst live"><i></i>Live${p.end ? ` · ends in <b data-cd="${p.end}">${countdown(p.end).text}</b>` : ''}</span>`; }
  if (st === 'upcoming') return `<span class="ldst up">Starts in <b data-cd="${d.phases[n].start}">${countdown(d.phases[n].start).text}</b></span>`;
  return `<span class="ldst end">${minted(d) >= d.maxSupply ? 'Sold out' : 'Ended'}</span>`;
}
function dropCard(d: Drop) {
  const st = dropState(d); const ph = d.phases[activePhase(d)] || d.phases[nextPhase(d)] || d.phases[d.phases.length - 1];
  const c0 = d.chains[0]; const price = priceOn(d, ph, c0.chain);
  return `<a class="ldcard" href="/launchpad/${esc(d.slug)}"><div class="ldimg"><img src="${esc(d.img)}" alt="" loading="lazy" width="384" height="384"><span class="ldtags2">${demoTag(d)}${mcTag(d)}</span></div>
   <div class="ldbody"><div class="ldname">${esc(d.name)}</div><div class="ldchains">${chainLogos(d)}</div>${stateChip(d)}
   <div class="ldprog"><div class="ldbar"><i style="width:${pct(minted(d), d.maxSupply)}%"></i></div><span>${minted(d).toLocaleString()} / ${d.maxSupply.toLocaleString()} minted${isMulti(d) ? ` · shared by ${d.chains.length} chains` : ''}</span></div>
   <div class="ldmeta"><span>${st === 'ended' && !comingSoon(d) ? 'Price' : esc(ph.name)}</span><b>${price ? `${fmt(price)} ${esc(chains[c0.chain]?.native)}` : 'No mint price'}</b></div></div></a>`;
}
function listPage() {
  document.title = 'Launchpad · MultiSea';
  const drops = allDrops(); const by = (s: string) => drops.filter(d => (comingSoon(d) ? 'upcoming' : dropState(d)) === s);
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
  const a = activePhase(d); const soon = comingSoon(d);
  return d.phases.map((p, i) => {
    const n = Math.floor(Date.now() / 1000); const st = soon ? 'soon' : i === a ? 'live' : p.start > n ? 'up' : 'end';
    const when = soon ? `Planned start ${esc(fmtStart(p.start))} · opens once the contract is deployed` : st === 'live' ? (p.end ? `Ends in <b data-cd="${p.end}">${countdown(p.end).text}</b>` : 'Open until sold out') : st === 'up' ? `Starts in <b data-cd="${p.start}">${countdown(p.start).text}</b>` : 'Ended';
    const c = d.chains.find(x => x.chain === chainSel) || d.chains[0]; const price = priceOn(d, p, c.chain);
    return `<div class="ldph ${st}"><div class="ldphh"><b>${esc(p.name)}</b><span class="ldst ${st === 'up' ? 'up' : st}">${st === 'soon' ? 'Coming soon' : st === 'live' ? '<i></i>Live' : st === 'up' ? 'Upcoming' : 'Ended'}</span></div>
     <div class="ldphm"><span>${p.kind === 'allowlist' ? `🔒 Allowlist${p.allowCount ? ` · ${p.allowCount.toLocaleString()} wallets` : ''}` : '🌐 Public'}</span><span>${price ? `${fmt(price)} ${esc(chains[c.chain]?.native)}` : 'No mint price'}</span><span>${p.maxPerWallet ? `Max ${p.maxPerWallet} / wallet` : 'No wallet limit'}</span></div>
     <div class="ldphw mut small">${when}</div></div>`;
  }).join('');
}
function breakdown(d: Drop) {
  const c = d.chains.find(x => x.chain === chainSel) || d.chains[0]; const ai = activePhase(d); const p = d.phases[ai];
  if (!p) return '';
  const nat = chains[c.chain].native; const unit = priceOn(d, p, c.chain); const price = unit * qty;
  const r = rateOf(rates, c.chain); const g = gp[c.chain];
  const gasNat = g ? Number(((isMulti(d) ? OMNI_GAS_UNITS(qty, c.chain === HUB, isBatched(d)) : GAS_UNITS(qty)) * 125n / 100n + 10_000n) * g) / 1e18 : null;
  const feeNat = (price * FEE_BPS) / 10_000; const relayUsd = pay === 'relay' ? FLAT_FEE_USD : 0;
  // Multichain: the LayerZero messages that create the escrow copies are a pass-through cost, shown on their OWN line
  // (not inside "MultiSea fee"). It pays LayerZero; in BATCHED mode the unused part of the batch-pool buffer is swept to
  // the MultiSea fee wallet at the end of the drop (decision M3b), which the line says. Estimate from the Oct 17 fork
  // quotes; production uses quoteMint().
  const legs = isMulti(d) ? mintLegs(d, c.chain, qty) : []; const lzUsdTot = legsUsd(legs); const lzNat = r ? lzUsdTot / r : 0;
  const total = price + (gasNat ?? 0) + (r ? relayUsd / r : 0) + lzNat;
  return `<div class="kv bkv ldkv"><span>Mint price</span><b>${qty} × ${fmt(unit)} = ${fmt(price)} ${esc(nat)} <i class="usd">${usdTxt(r ? price * r : null)}</i></b>
    <span>MultiSea fee</span><b>${fmt(feeNat + (r ? relayUsd / r : 0))} ${esc(nat)} <i class="usd">${pay === 'relay' ? `0.5% included + $${FLAT_FEE_USD.toFixed(2)} Relay route` : '0.5% included in price'}</i></b>
    <span>Network gas (est.)</span><b>${gasNat == null ? '<span class="spin"></span>' : `${fmt(gasNat, 7)} ${esc(nat)} <i class="usd">${usdTxt(r ? gasNat * r : null)}</i>`}</b>
    ${isBatched(d) ? batchedLine(d, c.chain, legs, lzNat, nat) : isMulti(d) ? `<span>Escrow copies on ${legs.filter(l => l.kind === 'copy').length + (c.chain === HUB ? 0 : 1)} chains (LayerZero, est.)</span><b>${r ? fmt(lzNat, 5) + ' ' + esc(nat) : ''} <i class="usd">≈ $${lzUsdTot.toFixed(2)} · ${legs.length} message${legs.length > 1 ? 's' : ''}, passed through to LayerZero${qty > 1 ? ` · one message per chain carries all ${qty}` : ''}</i></b>` : ''}
    <span>Total</span><b class="xtot">${fmt(total)} ${esc(nat)} <i class="usd">${usdTxt(r ? total * r : null)}</i></b></div>`;
}
// BATCHED (default): the escrow copies ride in the next batch, so the minter pays a per-NFT share of one batch message per
// chain (+ REQUEST/CONFIRM when not minting on Base). Own line, not inside "MultiSea fee". The share includes a 20% buffer;
// what the batches don't use goes to MultiSea when the drop closes (≈ $0.01 per NFT at full batches).
function batchedLine(d: Drop, k: string, legs: ReturnType<typeof mintLegs>, lzNat: number, nat: string) {
  const tot = legsUsd(legs); const share = legs.find(l => l.kind === 'share')!.usd; const conf = tot - share;
  const n = d.chains.length - 1; const per = tot / qty;
  const how = k === HUB ? `your share of one batch message per chain` : `batch share $${share.toFixed(2)} + confirm via Base $${conf.toFixed(2)}`;
  return `<span>Escrow copies on ${n} chains (batched, LayerZero est.)</span><b>${lzNat ? fmt(lzNat, 5) + ' ' + esc(nat) : ''} <i class="usd">≈ $${per.toFixed(2)} per NFT · ${how} · pays LayerZero</i><i class="usd ldbuf">Unused batch buffer goes to MultiSea</i></b>`;
}
// Gentle nudge where quantity really lowers the per-NFT cost (the REQUEST/CONFIRM pair is per tx, not per NFT).
function qtyHint(d: Drop, k: string) {
  if (!isBatched(d)) return '';
  const per = (q: number) => legsUsd(mintLegs(d, k, q)) / q;
  if (k === HUB) return `<div class="ldhint">💡 Base is the cheapest chain to mint on: ≈ $${per(1).toFixed(2)} cross-chain per NFT, any quantity.</div>`;
  const base = legsUsd(mintLegs(d, HUB, 1));
  if (qty >= 3) return `<div class="ldhint">💡 Saving: ≈ $${per(qty).toFixed(2)}/NFT cross-chain at ${qty} vs $${per(1).toFixed(2)} at 1. Base is cheapest at ≈ $${base.toFixed(2)}.</div>`;
  return `<div class="ldhint">💡 Buy 3+ to save: cross-chain cost ≈ $${per(3).toFixed(2)}/NFT at 3 vs $${per(1).toFixed(2)} at 1 (one confirm covers the whole mint). Base is cheapest at ≈ $${base.toFixed(2)}.</div>`;
}
function mintBox(d: Drop) {
  if (comingSoon(d)) return `<div class="fcard ldmintbox"><div class="gh">Mint</div><span class="ldst soon">Coming soon</span>
   <p class="mut small">This drop is approved. Minting opens once its contract is deployed and verified on-chain.</p>
   <button class="bbtn" disabled>Minting opens soon</button></div>`;
  const st = dropState(d); const ai = activePhase(d); const p = d.phases[ai]; const c = d.chains.find(x => x.chain === chainSel) || d.chains[0];
  const left = isMulti(d) ? Math.max(0, d.maxSupply - minted(d)) : Math.max(0, c.supply - c.minted); const max = Math.max(1, Math.min(p?.maxPerWallet || 20, left, 20));
  if (qty > max) qty = max;
  const al = p?.kind === 'allowlist'; const eligible = !al || (!!wallet.address && !!p.allowlist?.includes(wallet.address.toLowerCase()));
  const btn = st !== 'live' ? `<button class="bbtn" disabled>${st === 'upcoming' ? 'Not started' : 'Minting ended'}</button>`
    : !eligible ? `<button class="bbtn" disabled>${wallet.address ? 'Not on this allowlist' : 'Connect to check allowlist'}</button>`
    : left <= 0 ? `<button class="bbtn" disabled>Sold out</button>`
    : isMulti(d) && pend && !pend.done ? `<button class="bbtn" disabled><span class="spin"></span> Minting… confirming across chains</button>`
    : `<button class="bbtn ldmint" data-act="mint">Mint ${qty} on ${esc(chains[c.chain].name)} · demo (no transaction)</button>`;
  return `<div class="fcard ldmintbox">
   ${d.chains.length > 1 ? `<div class="gh">${isMulti(d) ? 'Mint on <span class="mut small">you pay on this chain · your NFT is Active here</span>' : 'Mint on'}</div><div class="ldchsel">${d.chains.map(x => `<button class="ldch ${x.chain === c.chain ? 'on' : ''}" data-ch="${x.chain}"><img class="cl" src="/logos/${x.chain}.svg" alt=""><span><b>${esc(chains[x.chain].name)}</b><em>${isMulti(d) ? (x.chain === HUB ? (isBatched(d) ? 'Instant · cheapest' : 'Instant · supply hub') : 'Confirms via Base') : `${(x.supply - x.minted).toLocaleString()} left`}</em></span></button>`).join('')}</div>` : ''}
   ${isMulti(d) ? mcExplainer(d, c.chain) : ''}
   ${st === 'live' ? `<div class="ldqty"><span class="gh">Quantity</span><div class="qpick"><button data-q="-1" ${qty <= 1 ? 'disabled' : ''} aria-label="Less">−</button><input data-qin type="number" min="1" max="${max}" value="${qty}" aria-label="Quantity"><button data-q="1" ${qty >= max ? 'disabled' : ''} aria-label="More">+</button></div><button class="pill" data-q="max">Max ${max}</button></div>
   <div class="ldpay"><label class="${pay === 'direct' ? 'on' : ''}"><input type="radio" name="pay" value="direct" ${pay === 'direct' ? 'checked' : ''}><span><b>${esc(chains[c.chain].native)} on ${esc(chains[c.chain].name)}</b><em>Direct mint</em></span></label><label class="${pay === 'relay' ? 'on' : ''}"><input type="radio" name="pay" value="relay" ${pay === 'relay' ? 'checked' : ''}><span><b>Any token, any chain</b><em>Routed by Relay</em></span></label></div>
   ${qtyHint(d, c.chain)}${breakdown(d)}` : ''}
   ${btn}
   ${isMulti(d) && pend ? pendBox(d) : demoMsg ? `<div class="okbox small">${demoMsg}</div>` : ''}
   <p class="mut small">Demo / testnet stub: this preview never sends a transaction. In production the button simulates the mint, sets an explicit gas limit (+25%), then asks your wallet to sign.</p></div>`;
}
function alBox(d: Drop) {
  const al = d.phases.filter(p => p.kind === 'allowlist'); if (!al.length) return '';
  return `<div class="fcard"><div class="gh">Allowlist check</div><div class="ldal"><input data-al placeholder="0x… wallet address" value="${esc(alAddr || wallet.address || '')}"><button class="obtn sm" data-act="alcheck">Check</button></div>${alRes ? `<p class="small">${alRes}</p>` : '<p class="mut small">Checks every allowlist phase. In production the Worker returns your Merkle proof from /launchpad/proof.</p>'}</div>`;
}
// Shared-supply bar: one bar for the whole collection, segmented by the chain each token was minted on.
function sharedBar(d: Drop) {
  const m = minted(d);
  return `<div class="ldprog big"><div class="ldprogh"><b>${pct(m, d.maxSupply).toFixed(1)}% of the shared supply minted</b><span>${m.toLocaleString()} / ${d.maxSupply.toLocaleString()}</span></div>
   <div class="ldbar ldseg">${d.chains.map(c => `<i style="width:${pct(c.minted, d.maxSupply)}%;background:${CH_COL[c.chain] || '#888'}" title="${esc(chains[c.chain]?.name)}: ${c.minted.toLocaleString()}"></i>`).join('')}</div>
   <div class="ldlegend">${d.chains.map(c => `<span><i style="background:${CH_COL[c.chain] || '#888'}"></i>${esc(chains[c.chain]?.name)} <b>${c.minted.toLocaleString()}</b></span>`).join('')}<span class="mut">${(d.maxSupply - m).toLocaleString()} left, mintable on any chain</span></div>
   <p class="mut small">One supply of ${d.maxSupply.toLocaleString()} for the whole collection, shown by the chain each NFT was minted on. Every minted NFT also exists in escrow on the other ${d.chains.length - 1} chains${isBatched(d) ? ` (copies are created in batches: every ${batchEta(d).k} IDs or ${batchEta(d).t} min)` : ''}. The next ID always comes from the Base supply hub, so no ID is minted twice and the total can't be exceeded.</p></div>`;
}
function mcExplainer(d: Drop, k: string) {
  const others = d.chains.map(c => c.chain).filter(x => x !== k).map(x => esc(chains[x]?.name)); const nm = esc(chains[k].name);
  if (isBatched(d)) { const b = batchEta(d, qty);
    return `<div class="ldexpl"><b>🔁 One NFT, ${d.chains.length} chains.</b> Your NFT is <b>Active on ${nm}</b> as soon as the mint confirms. The same ID is also <b>minted into MultiSea's escrow on ${others.join(', ')}</b> (locked, never burned) in the <b>next batch</b>: one LayerZero message per chain every ${b.k} IDs or ${b.t} min, whichever comes first. That's why the cross-chain cost is a small share instead of ≈ $2.40+ per mint.
     ${k === HUB ? '<span class="mut">Base is the supply hub: your ID is assigned in your mint transaction (instant).</span>' : `<span class="mut">Minting on ${nm}: you pay on ${nm} (held by the contract), the Base supply hub assigns your ID and checks the shared supply, then it is Active on ${nm} (≈ ${lzEta(k, HUB).replace('≈ ', '')} each way). If it sold out meanwhile, you're refunded automatically.</span>`}
     <span class="mut">You can move it to another chain any time, even before its batch lands.</span></div>`; }
  return `<div class="ldexpl"><b>🔁 One NFT, ${d.chains.length} chains.</b> Your NFT is <b>Active on ${nm}</b>, the chain you mint on. The same ID is also <b>minted into MultiSea's escrow on ${others.join(', ')}</b> (locked, never burned), so you can move it later via LayerZero.
   ${k === HUB ? '<span class="mut">Base is the supply hub: your ID is assigned in your mint transaction (instant), and the escrow copies arrive on the other chains within minutes.</span>' : `<span class="mut">Minting on ${nm} takes two steps: you pay on ${nm} (held by the contract), the Base supply hub assigns your ID and checks the shared supply, then it becomes Active here (≈ ${lzEta(k, HUB).replace('≈ ', '')} each way). If it sold out meanwhile, you're refunded automatically.</span>`}</div>`;
}
// Demo pending-mint tracker (no transaction): shows the real sequence honestly.
type Pend = { origin: string; qty: number; start: number; t0: number; done?: boolean; batch?: number };
let pend: Pend | null = null;
function pendSteps(d: Drop, p: Pend) {
  const el = (Date.now() - p.t0) / 1000; const hub = p.origin === HUB; const o = esc(chains[p.origin].name);
  const ids = p.qty > 1 ? `#${p.start}–#${p.start + p.qty - 1}` : `#${p.start}`;
  const st = (ok: boolean) => (ok ? '<i class="ok">✓</i>' : '<span class="spin"></span>');
  const steps: string[] = [];
  if (!hub) {
    steps.push(`${st(true)} Paid on ${o} · held by the drop contract`);
    steps.push(`${st(el > 1.5)} Base hub ${el > 1.5 ? `assigned ${ids} · shared supply checked` : 'assigning your ID · checking shared supply'}`);
    steps.push(`${st(el > 3)} ${el > 3 ? `Active on ${o}` : `Confirming on ${o}`}`);
  } else steps.push(`${st(true)} ${ids} assigned by the Base hub · Active on Base`);
  const copyChains = d.chains.map(c => c.chain).filter(k => k !== p.origin);
  if (isBatched(d)) {
    const act = hub ? 0 : 3; const flushAt = act + 6; // demo: the batch goes out a few seconds later
    const b = batchEta(d, 0); // queue already includes this mint (added on click)
    const flushed = el > flushAt; const q = el > act;
    const copies = copyChains.map(k => `<span class="ldcopy ${flushed ? 'ok' : ''}"><img class="cl" src="/logos/${k}.svg" alt="">${esc(chains[k].name)} ${flushed ? '✓' : (k === HUB && !hub ? '✓' : '⏳')}</span>`);
    const qline = !q ? 'Escrow copies' : flushed ? `Escrow copies created on ${copyChains.length} chains · batch #${p.batch ?? b.batch}` : b.full ? `Escrow copies queued · your mint completes batch #${b.batch}: sending now` : `Escrow copies queued · next batch in ~${b.mintsLeft} mints / ${b.minLeft} min`;
    return { steps, copies, allDone: q, ids, flushed, qline };
  }
  const copies = copyChains.map((k, i) => { const at = (hub ? 1 : 3) + (k === 'ethereum' ? 2.5 : 0.6 + i * 0.4) + (k === HUB && !hub ? -1.6 : 0); return `<span class="ldcopy ${el > at ? 'ok' : ''}"><img class="cl" src="/logos/${k}.svg" alt="">${esc(chains[k].name)} ${el > at ? '✓' : '…'}</span>`; });
  const allDone = el > (hub ? 1 : 3) + 2.6;
  return { steps, copies, allDone, ids, flushed: allDone, qline: 'Escrow copies' };
}
function pendBox(d: Drop) {
  const p = pend!; const x = pendSteps(d, p); const o = esc(chains[p.origin].name);
  return `<div class="ldpend ${x.allDone ? 'done' : ''}"><b>${x.allDone ? `✓ Minted ${x.ids} · Active on ${o}` : '<span class="spin"></span> Minting… confirming across chains'}</b>
   <ul>${x.steps.map(t => `<li>${t}</li>`).join('')}<li>${x.flushed ? '<i class="ok">✓</i>' : x.allDone && isBatched(d) ? '<i class="q">⏳</i>' : '<span class="spin"></span>'} <span>${x.qline}</span> <span class="ldcopies">${x.copies.join('')}</span></li></ul>
   ${isBatched(d) && x.allDone && !x.flushed ? `<span class="mut small">Your NFT is already Active on ${o}: you can trade it or move it now. The escrow copies only matter once it moves.</span>` : ''}
   <span class="mut small">Demo only: no transaction was sent. Timings are simulated (real LayerZero delivery ≈ 1-5 min per hop${isBatched(d) ? `; a batch goes out every ${batchEta(d).k} IDs or ${batchEta(d).t} min` : ''}).</span></div>`;
}
let held: Held[] = demoHeld(); let moveId = 0; let moveDst = ''; let moveMsg = '';
function heldBox(d: Drop) {
  return `<div class="fcard ldheld"><div class="gh">Your NFTs <span class="mut small">demo</span></div>${held.map(h => `<div class="ldhrow"><img src="/img/lil-foots/m/${h.id}.webp" alt="" width="48" height="48"><div><b>${esc(d.symbol)} #${h.id}</b>${h.minting ? `<span class="ldactive moving">Minting… confirming across chains</span>` : h.queued ? `<span class="ldactive"><img class="cl" src="/logos/${h.active}.svg" alt="">Active on ${esc(chains[h.active]?.name)}</span><em class="ldq mut small">escrow copies queued for the next batch</em>` : h.moving ? `<span class="ldactive moving">Moving → ${esc(chains[h.moving]?.name)}…</span>` : `<span class="ldactive"><img class="cl" src="/logos/${h.active}.svg" alt="">Active on ${esc(chains[h.active]?.name)}</span>`}</div><button class="obtn sm" data-move="${h.id}" ${h.moving || h.minting ? 'disabled' : ''}>Move to chain</button></div>`).join('')}
   <p class="mut small">An NFT is Active on one chain at a time. On every other chain the same ID is held by the escrow contract: it was minted there into escrow ${isBatched(d) ? 'in the batch after your mint (moving before that is fine: the destination creates it on arrival)' : 'when you minted'}.</p></div>`;
}
function moveModal(d: Drop) {
  const h = held.find(x => x.id === moveId); if (!h) return '';
  const dsts = d.chains.map(c => c.chain).filter(k => k !== h.active); if (!dsts.includes(moveDst)) moveDst = dsts[0];
  const src = h.active; const r = rateOf(rates, src); const g = gp[src]; const nat = chains[src].native;
  const lz = lzUsd(src, moveDst); const gasNat = g ? Number(MOVE_GAS_UNITS * g) / 1e18 : null; const gasUsd = gasNat != null && r ? gasNat * r : null;
  const tot = lz + MOVE_FEE_USD + (gasUsd ?? 0);
  return `<div class="ldmodal" role="dialog" aria-modal="true" aria-label="Move to chain"><div class="ldmodalin fcard">
   <div class="ldmh"><b>Move ${esc(d.symbol)} #${h.id}</b><button class="x" data-act="mclose" aria-label="Close">✕</button></div>
   <div class="ldmflow"><span><img class="cl" src="/logos/${src}.svg" alt=""> ${esc(chains[src].name)}<em>Active now → locked in escrow</em></span><b>→</b><span><img class="cl" src="/logos/${moveDst}.svg" alt=""> ${esc(chains[moveDst].name)}<em>released from escrow → Active</em></span></div>
   <div class="gh">Destination</div><div class="ldchsel">${dsts.map(k => `<button class="ldch ${k === moveDst ? 'on' : ''}" data-dst="${k}"><img class="cl" src="/logos/${k}.svg" alt=""><span><b>${esc(chains[k].name)}</b><em>${lzEta(src, k)}</em></span></button>`).join('')}</div>
   <div class="kv bkv ldkv"><span>LayerZero fee (est.)</span><b>≈ $${lz.toFixed(2)} <i class="usd">paid in ${esc(nat)} on ${esc(chains[src].name)}; exact quote from escrow.quoteMove()</i></b>
    <span>MultiSea move fee</span><b>$${MOVE_FEE_USD.toFixed(2)} <i class="usd">flat, in ${esc(nat)}</i></b>
    <span>Source gas (est.)</span><b>${gasNat == null ? '<span class="spin"></span>' : `${fmt(gasNat, 7)} ${esc(nat)} <i class="usd">${usdTxt(gasUsd)}</i>`}</b>
    <span>Arrives</span><b>${lzEta(src, moveDst)}</b>
    <span>Total</span><b class="xtot">≈ $${tot.toFixed(2)}</b></div>
   <p class="mut small">The token is never burned: it is locked in the escrow on ${esc(chains[src].name)} and the escrow on ${esc(chains[moveDst].name)} releases the same ID to you. If the message is delayed it can be retried; the token can't be Active on two chains.</p>
   <button class="bbtn" data-act="domove">Move to ${esc(chains[moveDst].name)} · demo (no transaction)</button>
   ${moveMsg ? `<div class="okbox small">${moveMsg}</div>` : ''}</div></div>`;
}
function dropPage(d: Drop) {
  document.title = `${d.name} · Launchpad · MultiSea`;
  // Multichain: pre-select Base (the hub: instant and the cheapest chain to mint on).
  if (!chainSel || !d.chains.some(c => c.chain === chainSel)) chainSel = isMulti(d) && d.chains.some(c => c.chain === HUB) ? HUB : d.chains[0].chain;
  const soon = comingSoon(d); const st = dropState(d); const ai = activePhase(d), ni = nextPhase(d);
  const target = soon ? 0 : st === 'live' ? d.phases[ai].end : st === 'upcoming' ? d.phases[ni].start : 0;
  const cd = target ? countdown(target) : null;
  app.innerHTML = `${navHtml('launchpad')}<section class="ldrop">
   <div class="ldban"><div class="ldbanart">${d.art.slice(0, 8).map(u => `<img src="${esc(u)}" alt="" width="200" height="200">`).join('')}</div><div class="ldbanfade"></div>
    <div class="ldbanin"><img class="ldlogo" src="${esc(d.img)}" alt="" width="96" height="96"><div><div class="ldtags">${demoTag(d)}${mcTag(d)}${soon ? SOON : `<span class="ldst ${st === 'upcoming' ? 'up' : st}">${st === 'live' ? '<i></i>Live' : st === 'upcoming' ? 'Upcoming' : 'Ended'}</span>`}</div><h1>${esc(d.name)}</h1><div class="ldchains">${chainLogos(d)} ${d.creator ? `<span class="mut small">by <span class="mono">${esc(d.creator.slice(0, 6) + '…' + d.creator.slice(-4))}</span></span>` : ''}</div></div></div></div>
   <div class="ldwrap"><div class="ldmain ldtop">
    <p class="desc">${esc(d.description)}</p>
    ${cd ? `<div class="ldcd" data-target="${target}"><span class="mut">${st === 'live' ? esc(d.phases[ai].name) + ' ends in' : esc(d.phases[ni].name) + ' starts in'}</span><div class="ldcdg"><div><b data-u="d">${cd.d}</b><em>days</em></div><div><b data-u="h">${cd.h}</b><em>hrs</em></div><div><b data-u="m">${cd.m}</b><em>min</em></div><div><b data-u="s">${cd.s}</b><em>sec</em></div></div></div>` : ''}
    ${isMulti(d) ? sharedBar(d) : `<div class="ldprog big"><div class="ldprogh"><b>${pct(minted(d), d.maxSupply).toFixed(1)}% minted</b><span>${minted(d).toLocaleString()} / ${d.maxSupply.toLocaleString()}</span></div><div class="ldbar"><i style="width:${pct(minted(d), d.maxSupply)}%"></i></div>
     ${d.chains.length > 1 ? `<div class="ldperch">${d.chains.map(c => `<span><img class="cl" src="/logos/${c.chain}.svg" alt=""> ${c.minted.toLocaleString()} / ${c.supply.toLocaleString()}</span>`).join('')}</div>` : ''}</div>`}
   </div><div class="ldmain ldphwrap"><div class="gh pad">Phases</div><div class="ldphs">${phaseRows(d)}</div></div>
   <aside class="ldside">${mintBox(d)}${soon ? '' : alBox(d)}
    <div class="fcard small"><div class="kv"><span>Supply</span><b>${d.maxSupply.toLocaleString()}</b><span>Royalty (ERC-2981)</span><b>${d.royaltyBps / 100}%</b><span>Reveal</span><b>${d.reveal === 'instant' ? 'Instant' : 'Delayed'}</b><span>Standard</span><b>${isMulti(d) ? 'ERC-721 + LayerZero V2 escrow' : 'ERC-721A'}</b>${isMulti(d) ? `<span>Supply model</span><b>Shared · IDs assigned by the Base hub</b><span>Each mint creates</span><b>1 Active + ${d.chains.length - 1} escrow copies${isBatched(d) ? ` <i class="usd">batched every ${batchEta(d).k} IDs / ${batchEta(d).t} min</i>` : ''}</b><span>Move between chains</span><b>LZ fee + $${MOVE_FEE_USD.toFixed(2)}</b>` : ''}<span>After mint</span><b>Trades on MultiSea</b></div></div>
   ${isMulti(d) && !soon ? heldBox(d) : ''}
   </aside></div></section>${moveId ? moveModal(d) : ''}`;
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
  const t = e.target as HTMLElement; const el = t.closest('[data-tab],[data-ch],[data-q],[data-act],[data-move],[data-dst]') as HTMLElement | null; if (!el) { if (t.classList.contains('ldmodal')) { moveId = 0; moveMsg = ''; render(); } return; }
  if (el.dataset.tab) { tab = el.dataset.tab as any; render(); return; }
  const d = findDrop(slug); if (!d) return;
  if (el.dataset.move) { moveId = +el.dataset.move; moveDst = ''; moveMsg = ''; const h = held.find(x => x.id === moveId); if (h && gp[h.active] === undefined) loadGas({ ...d, chains: [{ chain: h.active, supply: 0, minted: 0 }] }).then(render); render(); return; }
  if (el.dataset.dst) { moveDst = el.dataset.dst; moveMsg = ''; render(); return; }
  if (el.dataset.act === 'mclose') { moveId = 0; moveMsg = ''; render(); return; }
  if (el.dataset.act === 'domove') {
    const h = held.find(x => x.id === moveId); if (!h) return; const dst = moveDst;
    h.moving = dst; saveHeld(held); moveId = 0; moveMsg = ''; render();
    setTimeout(() => { h.active = dst; delete h.moving; saveHeld(held); render(); }, 2500);
    return;
  }
  if (el.dataset.ch) { chainSel = el.dataset.ch; qty = 1; demoMsg = ''; if (pend?.done) pend = null; render(); }
  if (el.dataset.q) { qty = el.dataset.q === 'max' ? 999 : Math.max(1, qty + +el.dataset.q); demoMsg = ''; render(); }
  if (el.dataset.act === 'alcheck') {
    alAddr = (app.querySelector('[data-al]') as HTMLInputElement).value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(alAddr)) alRes = '<span class="err">Enter a 0x address.</span>';
    else alRes = d.phases.filter(p => p.kind === 'allowlist').map(p => `${p.allowlist?.includes(alAddr) ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'} ${esc(p.name)}`).join(' &nbsp; ') + ' <span class="mut">(demo list)</span>';
    render();
  }
  if (el.dataset.act === 'mint' && comingSoon(d)) return; // no mint before the contract is deployed
  if (el.dataset.act === 'mint' && isMulti(d)) {
    const c = d.chains.find(x => x.chain === chainSel)!; const start = minted(d) + 1; const q = qty;
    pend = { origin: c.chain, qty: q, start, t0: Date.now(), batch: d.queue?.batch }; c.minted += q; // demo counter only
    if (isBatched(d) && d.queue) d.queue.ids += q; // this mint's copies join the current batch (demo state)
    const h: Held = { id: Math.min(start, d.maxSupply), active: c.chain, minting: 1 };
    held.unshift(h); saveHeld(held.filter(x => !x.minting));
    const iv = setInterval(() => { if (!pend) return clearInterval(iv); const x = pendSteps(d, pend);
      if (x.allDone && !pend.done) { pend.done = true; delete h.minting; if (!x.flushed) h.queued = true; saveHeld(held); }
      if (x.flushed) { delete h.queued; if (isBatched(d) && d.queue && d.queue.ids >= 0) { const b = d.queue; b.batch += 1; b.ids = 0; b.ageMin = 0; } saveHeld(held); clearInterval(iv); }
      render(); }, 400);
    render(); return;
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
