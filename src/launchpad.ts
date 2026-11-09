// MultiSea Launchpad: /launchpad (drops: live / upcoming / ended) and /launchpad/<slug> (mint page).
// Worker drops are real: the creator deploys from this page (factory createDrop / createOmniDrop with MultiSea's signed
// approval) and collectors mint with their own wallet (src/lpchain.ts). Demo drops (LIL FOOTS art) stay labeled stubs.
import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, openConnect, apiFeatures, API } from './wallet';
import { navHtml, bindNav, esc, usdRates, type UsdRates } from './shell';
import { gasPrice } from './txgas';
import { LP_LIVE, factoryOn } from './lpchain';
import { getSession, signIn } from './auth';
import { FLAT_FEE_USD } from './xpaycore';
import { AGENT_UI, AGENT_PREVIEW, isAgentDrop, agentCard, attackBox, demoAgents, ORA_FEE_WEI, type AgentView } from './agentdrop';
import { encodeTraits, traitGas, traitsCard, primeCost, loadTraits, saveTraits, fetchTraits, type TraitEnc } from './agenttraits';
import { allDrops as demoAndLocal, findDrop as findLocal, localDrops, dropState, comingSoon, activePhase, nextPhase, countdown, minted, pct, FEE_BPS, GAS_UNITS, isMulti, priceOn, lzUsd, lzEta, mintLegs, legsUsd, HUB, MOVE_FEE_USD, MOVE_GAS_UNITS, OMNI_GAS_UNITS, isBatched, batchEta, batchShareUsd, demoHeld, saveHeld, MAX_PER_TX, type Drop, type Held } from './launchdata';
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
const fromApi = (d: any): Drop => ({ remote: true, addresses: Object.fromEntries((d.deployments || []).map((x: any) => [x.chain, x.address])), raw: d, mode: d.mode === 'multichain' ? 'multichain' : d.mode === 'ordinals' ? 'ordinals' : 'single', ordinals: d.ordinals, slug: d.slug, name: d.name, symbol: d.symbol, creator: d.submitter || '', description: d.description || '', website: d.website, x: d.x, status: d.status,
  // `deployed` comes from the Worker; older Workers lack it, so fall back to the same rule (verified on-chain = status 'live').
  deployed: typeof d.deployed === 'boolean' ? d.deployed : d.status === 'live' && Array.isArray(d.deployments) && d.deployments.length > 0,
  chains: (d.chains || []).map((c: string) => ({ chain: c, supply: d.allocations?.[c] ?? Math.floor(d.maxSupply / d.chains.length), minted: 0 })), maxSupply: d.maxSupply, royaltyBps: d.royaltyBps, reveal: d.reveal,
  phases: (d.phases || []).map((p: any) => ({ ...p, price: Number(BigInt(p.price)) / 1e18, prices: p.prices ? Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, Number(BigInt(v as string)) / 1e18])) : undefined })), img: d.logo ? API + d.logo : '/brand/icon-128.webp', art: d.banner ? [API + d.banner] : [] });
// Agent-drop local preview (VITE_AGENT_DROPS=1 only, flag OFF in config): one labeled demo drop, nothing on-chain.
const AGENT_DEMO: Drop | null = AGENT_PREVIEW ? { slug: 'agents-demo', name: 'Hungry Agents', symbol: 'HGRY', creator: '0x000000000000000000000000000000000000a9e7', demo: true, status: 'live', mode: 'single', nftType: 'erc463n7',
  description: 'Demo ERC-463N7 agent drop. Each NFT is an agent with its own wallet. Unfed agents starve after 30 days; agents with the rare Death skill (5%) can ask ORA to judge a kill on another agent. Preview only: nothing mints on-chain.',
  chains: [{ chain: 'base', supply: 500, minted: 212 }], maxSupply: 500, royaltyBps: 500, reveal: 'instant', img: '/brand/icon-128.webp', art: [],
  phases: [{ name: 'Public', kind: 'public', start: Math.floor(Date.now() / 1000) - 86400, end: 0, price: 0.01, maxPerWallet: 0 }], agent: { starveDays: 30, deathSkill: true, skillPct: 5, traitRows: 500 } } as any : null;
const demoAndLocal2 = () => (AGENT_DEMO ? [AGENT_DEMO, ...demoAndLocal()] : demoAndLocal());
const allDrops = () => [...remote, ...demoAndLocal2().filter(x => !remote.some(r => r.slug === x.slug))];
const findDrop = (s: string) => remote.find(d => d.slug === s) || (AGENT_DEMO && s === AGENT_DEMO.slug ? AGENT_DEMO : null) || findLocal(s);

// ---------------- list ----------------
let tab: 'live' | 'upcoming' | 'ended' = (['upcoming', 'ended'] as const).find(t => t === new URLSearchParams(location.search).get('tab')) || 'live';
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
   ${LP_LIVE ? (drops.some(d => d.demo) ? '<div class="ldnote">Drops tagged <b>Demo</b> (LIL FOOTS art) are examples: minting them is a stub. Every other drop is a real on-chain contract.</div>' : '') : '<div class="ldnote">Preview: launchpad contracts are not deployed yet. Drops below are <b>demo data</b> (LIL FOOTS art) and minting is a stub.</div>'}
   <div class="ldtabs" role="tablist">${(['live', 'upcoming', 'ended'] as const).map(k => `<button role="tab" class="ldtab ${tab === k ? 'on' : ''}" data-tab="${k}">${k[0].toUpperCase() + k.slice(1)} <span>${by(k).length}</span></button>`).join('')}</div>
   <div class="ldgrid">${l.length ? l.map(dropCard).join('') : `<p class="mut">${tab === 'live' ? 'No collections minting right now.' : `No ${tab} drops right now.`}</p>`}</div>
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
  const R = d as any; const isCreator = !!getSession() && mine.has(d.slug);
  const undeployed = R.remote && LP_LIVE ? d.chains.filter(c => !R.addresses?.[c.chain]) : [];
  const dep = isCreator && undeployed.length ? deployBox(d, undeployed.map(c => c.chain)) : '';
  if (comingSoon(d)) return dep || `${R.remote && LP_LIVE && !getSession() ? '<div class="fcard small" style="margin-bottom:10px">Creator? <button class="pill" data-act="lsignin">Sign in to deploy</button></div>' : ''}` + `<div class="fcard ldmintbox"><div class="gh">Mint</div><span class="ldst soon">Coming soon</span>
   <p class="mut small">This drop is approved. Minting opens once its contract is deployed and verified on-chain.</p>
   <button class="bbtn" disabled>Minting opens soon</button></div>`;
  const st = dropState(d); const ai = activePhase(d); const p = d.phases[ai]; const c = d.chains.find(x => x.chain === chainSel) || d.chains[0];
  const left = isMulti(d) ? Math.max(0, d.maxSupply - minted(d)) : Math.max(0, c.supply - c.minted); const max = Math.max(1, Math.min(p?.maxPerWallet || MAX_PER_TX, left, MAX_PER_TX));
  if (qty > max) qty = max;
  const al = p?.kind === 'allowlist'; const eligible = !al || (!!wallet.address && (R.remote ? true : !!p.allowlist?.includes(wallet.address.toLowerCase())));
  const real = R.remote && LP_LIVE && !!R.addresses?.[c.chain];
  const btn = st !== 'live' ? `<button class="bbtn" disabled>${st === 'upcoming' ? 'Not started' : 'Minting ended'}</button>`
    : !eligible ? `<button class="bbtn" disabled>${wallet.address ? 'Not on this allowlist' : 'Connect to check allowlist'}</button>`
    : left <= 0 ? `<button class="bbtn" disabled>Sold out</button>`
    : isMulti(d) && pend && !pend.done ? `<button class="bbtn" disabled><span class="spin"></span> Minting… confirming across chains</button>`
    : R.remote && LP_LIVE && !real ? `<button class="bbtn" disabled>Not deployed on ${esc(chains[c.chain].name)} yet</button>`
    : real ? (wallet.address ? `<button class="bbtn ldmint" data-act="mint" ${realBusy ? 'disabled' : ''}>${realBusy ? '<span class="spin"></span> Minting…' : `Mint ${qty} on ${esc(chains[c.chain].name)}`}</button>` : '<button class="bbtn ldmint" data-act="connect">Connect wallet to mint</button>')
    : `<button class="bbtn ldmint" data-act="mint">Mint ${qty} on ${esc(chains[c.chain].name)} · demo (no transaction)</button>`;
  return `<div class="fcard ldmintbox">
   ${d.chains.length > 1 ? `<div class="gh">${isMulti(d) ? 'Mint on <span class="mut small">you pay on this chain · your NFT is Active here</span>' : 'Mint on'}</div><div class="ldchsel">${d.chains.map(x => `<button class="ldch ${x.chain === c.chain ? 'on' : ''}" data-ch="${x.chain}"><img class="cl" src="/logos/${x.chain}.svg" alt=""><span><b>${esc(chains[x.chain].name)}</b><em>${isMulti(d) ? (x.chain === HUB ? (isBatched(d) ? 'Instant · cheapest' : 'Instant · supply hub') : 'Confirms via Base') : `${(x.supply - x.minted).toLocaleString()} left`}</em></span></button>`).join('')}</div>` : ''}
   ${isMulti(d) ? mcExplainer(d, c.chain) : ''}
   ${st === 'live' ? `<div class="ldqty"><span class="gh">Quantity</span><div class="qpick"><button data-q="-1" ${qty <= 1 ? 'disabled' : ''} aria-label="Less">−</button><input data-qin type="number" min="1" max="${max}" value="${qty}" aria-label="Quantity"><button data-q="1" ${qty >= max ? 'disabled' : ''} aria-label="More">+</button></div><button class="pill" data-q="max">Max ${max}</button></div>
   <div class="ldpay"><label class="${pay === 'direct' ? 'on' : ''}"><input type="radio" name="pay" value="direct" ${pay === 'direct' ? 'checked' : ''}><span><b>${esc(chains[c.chain].native)} on ${esc(chains[c.chain].name)}</b><em>Direct mint</em></span></label><label class="${pay === 'relay' ? 'on' : ''}"><input type="radio" name="pay" value="relay" ${pay === 'relay' ? 'checked' : ''}><span><b>Any token, any chain</b><em>Routed by Relay</em></span></label></div>
   ${qtyHint(d, c.chain)}${breakdown(d)}` : ''}
   ${btn}
   ${real ? (realMsg ? `<div class="okbox small">${realMsg}</div>` : '') : isMulti(d) && pend ? pendBox(d) : demoMsg ? `<div class="okbox small">${demoMsg}</div>` : ''}
   ${real ? '<p class="mut small">Real transaction: the price is quoted on-chain, gas is estimated (+25%), then your wallet asks you to sign. MultiSea fee 0.5% is included in the price.</p>' : '<p class="mut small">Demo / testnet stub: this preview never sends a transaction. In production the button simulates the mint, sets an explicit gas limit (+25%), then asks your wallet to sign.</p>'}</div>${dep}`;
}
let mine = new Set<string>(); async function loadMine() { mine = new Set(); if (!LP_LIVE || !getSession() || !apiFeatures.includes('launchpad')) return; try { const j = await import('./auth').then(a => a.api('/launchpad/mine', { auth: true })); mine = new Set(j.drops.map((x: any) => x.slug)); } catch {} }
// Reveal (delayed-reveal drops): creator + on-chain owner only, contract not revealed yet. ?mockreveal on localhost = UI preview.
type RevSt = { revealed: boolean; frozen: boolean; owner: string } | null;
const revCache: Record<string, RevSt | 'loading' | 'err'> = {}; let revURI = ''; let revStored = ''; let revStep: '' | 'confirm' = ''; let revCustom = false; let revBusy = false; let revMsg = '';
const MOCK_REV = /localhost|127\.0\.0\.1/.test(location.hostname) && new URLSearchParams(location.search).has('mockreveal');
function revealBox(d: Drop) {
  const R = d as any; if (d.reveal !== 'delayed') return '';
  const k = R.addresses?.[chainSel] ? chainSel : d.chains.map(c => c.chain).find(c => R.addresses?.[c]) || (MOCK_REV ? d.chains[0]?.chain : undefined); const addr = k && R.addresses?.[k];
  if (!MOCK_REV && !(R.remote && LP_LIVE && addr && getSession() && mine.has(d.slug))) return '';
  const key = MOCK_REV ? 'mock' : `${k}:${addr}`; let s = MOCK_REV ? { revealed: false, frozen: false, owner: (wallet.address || '0xmock').toLowerCase() } : revCache[key];
  if (!MOCK_REV && s === undefined) { revCache[key] = 'loading'; import('./lpchain').then(m => m.revealState(k!, addr)).then(v => { revCache[key] = v; }).catch(() => { revCache[key] = 'err'; }).finally(render); return ''; }
  if (!s || s === 'loading' || s === 'err' || s.frozen) return '';
  if (s.revealed) return `<div class="fcard small ldrevbox"><div class="gh">Reveal</div><span class="ok">✓ Revealed on ${esc(chains[k || 'base'].name)}</span>${revMsg ? `<p class="small">${revMsg}</p>` : ''}</div>`;
  if (!MOCK_REV && s.owner !== (wallet.address || '').toLowerCase()) return `<div class="fcard small ldrevbox"><div class="gh">Reveal</div><p class="mut">Connect the contract owner wallet (<span class="mono">${esc(s.owner.slice(0, 8))}…</span>) to reveal.</p></div>`;
  if (!revStored && !MOCK_REV) import('./lpchain').then(m => m.storedRevealURI(d.slug)).then(u => { revStored = u || 'none'; if (!revURI) revURI = u; render(); }).catch(() => { revStored = 'none'; render(); });
  if (MOCK_REV && !revStored) { revStored = 'ipfs://QmavdjX1pSf11jePFqCHZ45NzY6fpL96XupsVAi6wEpoBe/'; revURI ||= revStored; }
  const others = isMulti(d) ? d.chains.map(c => c.chain).filter(c => c !== k && R.addresses?.[c]) : [];
  const ok = /^(ipfs|ar):\/\/\S+\/$|^https:\/\/\S+\/$/.test(revURI);
  return `<div class="fcard ldrevbox"><div class="gh">Reveal collection</div><p class="mut small">Holders see the placeholder until you reveal. Token N then resolves to <span class="mono">baseURI + N.json</span>. You sign the transaction on ${esc(chains[k || 'base'].name)} and pay the gas.</p>
   <div class="small">Base URI: ${revURI ? `<code class="mono">${esc(revURI)}</code>` : `<span class="mut">${revStored ? 'none stored' : 'loading…'}</span>`}${revURI && revURI !== revStored && revStored && revStored !== 'none' ? ' <span class="ldtag xp">custom</span>' : ''}</div>
   ${revCustom ? `<label class="small ldrevin">Different base URI<input data-revuri value="${esc(revURI)}" placeholder="ipfs://CID/"></label>` : `<button type="button" class="pill sm" data-act="revcustom">Use a different base URI</button>`}
   ${revURI && !ok ? '<p class="err small">Base URI must end with "/" (ipfs://CID/).</p>' : ''}
   ${revStep === 'confirm' ? `<div class="ldnote small">Reveal sets the final metadata for every token on ${esc(chains[k || 'base'].name)}. You can't undo it once metadata is frozen.</div><div class="two"><button class="obtn" data-act="revcancel">Cancel</button><button class="bbtn" data-act="revgo" ${revBusy ? 'disabled' : ''}>${revBusy ? '<span class="spin"></span> Revealing…' : 'Confirm & sign'}</button></div>`
     : `<button class="bbtn" data-act="revask" ${ok ? '' : 'disabled'}>Reveal collection</button>`}
   ${others.length ? `<p class="mut small">Multichain: each chain has its own contract. Switch the chain above and reveal on ${others.map(c => esc(chains[c].name)).join(', ')} too.</p>` : ''}
   ${revMsg ? `<p class="small">${revMsg}</p>` : ''}</div>`;
}
let realBusy = false; let realMsg = ''; let depMsg = ''; let depBusy = '';
const EXPL: Record<string, string> = Object.fromEntries(Object.entries(CFG.chains as any).map(([k, c]: any) => [k, c.explorer]));
const txLink = (k: string, h: string) => `<a href="${EXPL[k]}/tx/${h}" target="_blank" rel="noopener" class="mono">${h.slice(0, 10)}…</a>`;
function deployBox(d: Drop, todo: string[]) {
  const ok = todo.filter(k => factoryOn(k));
  return `<div class="fcard ldmintbox" style="margin-top:14px"><div class="gh">Deploy your drop <span class="mut small">you are the creator</span></div>
   <p class="mut small">MultiSea approved this drop. Deploying creates your contract through the MultiSea factory with MultiSea's signed approval; you pay the gas and own the contract.${isMulti(d) ? ' Deploy on every chain (Base, the supply hub, first).' : ''}</p>
   ${!getSession() ? '<button class="bbtn sm" data-act="lsignin">Sign in to deploy</button>' : ok.map(k => `<button class="bbtn sm" data-deploy="${k}" ${depBusy ? 'disabled' : ''} style="margin:4px 4px 0 0">${depBusy === k ? '<span class="spin"></span> Deploying…' : `Deploy on ${esc(chains[k].name)}`}</button>`).join('')}
   ${depMsg ? `<p class="small" style="margin-top:8px">${depMsg}</p>` : ''}</div>`;
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
// Bitcoin Ordinals drops: order lifecycle paid -> inscribing -> delivered (or refunded in USDC after the delivery window).
// Orders come from the Worker (/launchpad/:slug/orders?buyer=) once deployed; preview shows this browser's demo orders (labeled).
type OrdOrder = { id: string; qty: number; usdc: number; btcAddr: string; paidAt: number; status: 'paid' | 'inscribing' | 'delivered' | 'refunded'; inscriptions?: string[]; refundTx?: string };
function ordOrders(d: Drop): OrdOrder[] {
  try { const l = JSON.parse(localStorage.getItem('multisea-ord-orders:' + d.slug) || 'null'); if (l) return l; } catch {}
  const now = Date.now(), p = +(d.ordinals?.priceUsdc || 0);
  return [{ id: 'ord-0003', qty: 2, usdc: p * 2, btcAddr: 'bc1p…demo', paidAt: now - 9 * 60e3, status: 'paid' }, { id: 'ord-0002', qty: 1, usdc: p, btcAddr: 'bc1p…demo', paidAt: now - 2.2 * 3600e3, status: 'inscribing' }, { id: 'ord-0001', qty: 3, usdc: p * 3, btcAddr: 'bc1p…demo', paidAt: now - 26 * 3600e3, status: 'delivered', inscriptions: ['i0', 'i1', 'i2'] }];
}
function ordBox(d: Drop) {
  const o = d.ordinals || { priceUsdc: 0, orderLimit: 50, deliveryHours: 6, feeBps: 50 }; const H = o.deliveryHours || 6;
  const stepI = (s: OrdOrder['status']) => ({ paid: 0, inscribing: 1, delivered: 2, refunded: 2 }[s]);
  const rows = ordOrders(d).map(r => { const i = stepI(r.status), due = r.paidAt + H * 3600e3; const steps = ['Paid (USDC)', 'Inscribing', r.status === 'refunded' ? 'Refunded' : 'Delivered'];
    return `<div class="ordrow"><div class="ordh"><b>${esc(r.id)}</b><span class="mut small">${r.qty} × · ${r.usdc.toFixed(2)} USDC</span><span class="ordst ${r.status}">${r.status}</span></div><ol class="ordsteps">${steps.map((s, j) => `<li class="${j < i || (j === i && (r.status === 'paid' || r.status === 'delivered')) ? 'ok' : j === i ? (r.status === 'refunded' ? 'bad' : 'on') : ''}">${s}</li>`).join('')}</ol><div class="mut small">${r.status === 'delivered' ? `Delivered to <span class="mono">${esc(r.btcAddr)}</span>` : r.status === 'refunded' ? 'Refunded in USDC on Base' : `Delivery by ${new Date(due).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} or automatic USDC refund`}</div></div>`; }).join('');
  return `<div class="fcard ldordbox"><div class="gh"><img class="cl" src="/logos/bitcoin.svg" alt=""> Bitcoin Ordinals drop</div><div class="kv small"><span>Price</span><b>${esc(String(o.priceUsdc))} USDC on Base</b><span>Inscription fee</span><b>Paid by buyer (mempool rate at checkout)</b><span>Delivery</span><b>To your taproot address within ${H}h, else refund</b><span>Order limit</span><b>${o.orderLimit} per wallet</b><span>MultiSea fee</span><b>${(o.feeBps || 50) / 100}%</b></div>
   <div class="gh" style="margin-top:12px">Your orders <span class="ldtag xp">Preview data</span></div>${rows}</div>`;
}
// ---- ERC-463N7 agent drops: your agents (wallet, last fed, Feed, Starve), Death-skill attack with strike/grace, burned tombstones, creator lock ----
let agents: AgentView[] | null = null; let growthData: Record<number, any> = {}; let growthAddress: string | null | undefined; let growthTypes: any[] = []; let growthSlug = ''; let atkFrom = 0; let agMsg = ''; let agBusy = ''; let demoLocked = false;
// Onchain CSV traits (AgentDropKit): table from this browser (create form), the pinned traitsURI, or a re-uploaded CSV.
let trEnc: TraitEnc | null = null; let trSlug = ''; let trState: { expected: number; rows: number; done: boolean; dict: boolean } | null | undefined; let trMsg = ''; let demoTraits = '';
const demoEnc = (n: number) => encodeTraits(Array.from({ length: n }, (_, i) => ({ tokenID: String(i + 1), attrs: [['Background', ['Mint', 'Peach', 'Night', 'Sand', 'Lilac'][i % 5]], ['Fur', ['Gold', 'Ash', 'Cream', 'Ink'][(i * 7) % 4]], ['Eyes', ['Laser', 'Sleepy', 'Wide', 'Wink', 'Hypno', 'X'][(i * 3) % 6]], ['Mouth', ['Grin', 'Fang', 'Pipe'][(i * 5) % 3]], ['Hat', i % 4 ? ['Cap', 'Crown', 'Halo', 'Beanie'][(i * 11) % 4] : ''], ['Status', ['Common', 'Rare'][i % 9 ? 0 : 1]]].map(([trait_type, value]) => ({ trait_type, value })) }))) as TraitEnc;
function traitsBox(d: Drop) {
  const R = d as any; const A: any = R.agent || R.raw?.agent || {}; const demo = !!R.demo; const k = d.chains[0].chain; const eng = R.addresses?.[k];
  if (trSlug !== d.slug) { trSlug = d.slug; trState = undefined; trMsg = ''; trEnc = demo ? demoEnc(A.traitRows) : loadTraits(d.slug);
    if (!trEnc && A.traitsURI) fetchTraits(A.traitsURI).then(e => { if (e && trSlug === d.slug) { trEnc = e; saveTraits(d.slug, e); render(); } }); }
  if (!demo && eng && trState === undefined) { trState = null; import('./agentdrop').then(m => m.agentTraitsState(k, eng)).then(t => { trState = t; render(); }); }
  if (demo ? demoTraits : trState?.done) return `<div class="small ok" style="margin-bottom:8px">✓ ${demo ? demoTraits : trState!.rows ? `CSV traits stored onchain (${trState!.rows.toLocaleString()} rows)` : 'CSV traits skipped'} · mint can open</div>`;
  if (!demo && !eng) return `<div class="fcard small agatk" style="margin-bottom:8px"><div class="gh">Creator: CSV traits onchain</div><p class="mut small">After you deploy, upload your ${(+A.traitRows).toLocaleString()} CSV trait rows here (mint stays closed until then).</p></div>`;
  if (trEnc) primeCost(trEnc, [k], render);
  const n = trEnc ? traitGas(trEnc).txs : 0; const busy = agBusy === 'traits' || agBusy === 'skiptraits';
  const done = trState?.rows ? ` · ${trState.rows.toLocaleString()} of ${trState.expected.toLocaleString()} rows already uploaded` : '';
  return `<div class="fcard small agatk lptrstep" style="margin-bottom:8px"><div class="gh">Creator: put the CSV traits onchain <span class="ldtag drop">before mint</span></div>
   <p class="mut small">Mint stays closed onchain until the ${(+A.traitRows).toLocaleString()} signed trait rows are uploaded (or you skip them). Uploading is final and locks at the first mint${done}.</p>
   ${trEnc ? traitsCard(trEnc, [k], 'Your traits table') : `<p class="small ldwarn">The traits table isn't in this browser${A.traitsURI ? ' (loading the pinned copy…)' : ''}. Re-upload the same metadata CSV:</p><label class="small">Metadata CSV<input type="file" accept=".csv,text/csv" data-trcsv></label>`}
   ${trMsg ? `<p class="small">${trMsg}</p>` : ''}
   <div class="agbtns"><button class="bbtn sm" data-agtr="up" ${!trEnc || busy ? 'disabled' : ''}>${agBusy === 'traits' ? '<span class="spin"></span> Uploading…' : `Upload traits on-chain (${n} tx)`}</button><button class="obtn sm" data-agtr="skip" ${busy ? 'disabled' : ''}>Skip CSV traits</button></div></div>`;
}
async function loadGrowth(d: Drop) {
 const k = d.chains[0].chain; const engine = (d as any).addresses?.[k]; if (!engine) { growthAddress = null; return; }
 const mod = await import('./agentgrowth'); const { kitOf } = await import('./agentdrop'); const kit = await kitOf(k, engine);
 if (!kit) { growthAddress = null; return; }
 try { growthAddress = await (await import('./wallet')).readClient(k).readContract({ address: kit, abi: (await import('viem')).parseAbi(['function growth() view returns (address)']), functionName: 'growth' }); } catch { growthAddress = null; return; }
 if (!growthAddress || /^0x0+$/.test(growthAddress)) return;
 try { growthTypes = await mod.growthTypes(k, engine, growthAddress as any, kit); } catch { growthAddress = null; return; }
 for (const a of (agents || []).filter(a => !a.dead)) try {
  const g = await mod.loadGrowthToken(k, engine, growthAddress as any, a.id, kit); growthData[a.id] = g;
  const el = document.querySelector(`[data-growth="${a.id}"]`); if (el) { el.innerHTML = mod.growthHtml(g); const p = el.querySelector('[data-preview]');
   if (p) mod.loadComposite(k, engine, (await mod.tokenId(k, engine, a.id))).then(uri => { p.innerHTML = `<details><summary>Layered NFT image</summary><img src="${uri}" alt="Layered agent #${a.id}"></details>`; }).catch(() => {});
  }
 } catch {}
 const creator = document.querySelector('[data-gcreator]'); if (creator) creator.innerHTML = mod.creatorGrowthHtml(growthTypes);
}

function agentBox(d: Drop) {
  const now = Math.floor(Date.now() / 1000); const A: any = (d as any).agent || (d as any).raw?.agent || {}; const k = d.chains[0].chain; const native = chains[k]?.native || 'ETH';
  if (agents === null && (d as any).demo) agents = demoAgents(now);
  const feeEth = ORA_FEE_WEI[k] ? Number(BigInt(ORA_FEE_WEI[k])) / 1e18 : undefined;
  const o = { symbol: d.symbol, periodS: (A.starveDays || 30) * 86400, now, feeEth, native, busy: agBusy };
  if (growthSlug !== d.slug) { growthSlug = d.slug; growthData = {}; growthAddress = undefined; }
  if (growthAddress === undefined) { growthAddress = 'loading' as any; setTimeout(() => loadGrowth(d), 0); }
  return `<div class="fcard ldagents"><div class="gh">Your agents ${(d as any).demo ? '<span class="mut small">demo</span>' : ''}</div>
   ${A.traitRows && ((d as any).demo || (!!getSession() && mine.has(d.slug))) ? traitsBox(d) : ''}${A.deathSkill && ((d as any).demo || (!!getSession() && mine.has(d.slug))) ? lockBox(d) : ''}
   <p class="mut small">Starvation is always on for every agent: unfed for ${A.starveDays || 30} days, anyone can starve it (NFT burned, wallet to its heir or the treasury). It survives transfers and holders can't turn it off. Feed an agent (any amount into its wallet) to reset the clock. ${A.deathSkill ? `Agents with the ☠ Death skill (${A.skillPct || 5}% of supply) can ask ORA to judge a kill on another agent.` : ''}</p>
   ${agents?.length ? agents.map(a => agentCard(a, o)).join('') : `<p class="mut small">${wallet.address ? 'No agents loaded yet.' : 'Connect a wallet to see your agents.'}</p>`}
   ${(d as any).demo ? '' : `<div class="agbtns"><input data-agid type="number" min="1" placeholder="Agent #"><button class="obtn sm" data-agload>Load agent</button></div>`}
   ${mine.has(d.slug) ? '<div data-gcreator><span class="mut small">Loading creator growth…</span></div>' : ''}${atkFrom ? attackBox(atkFrom, { symbol: d.symbol, feeEth, native, limits: A.limits }) : ''}${agMsg ? `<p class="small">${agMsg}</p>` : ''}</div>`;
}
function lockBox(d: Drop) {
  const demo = !!(d as any).demo;
  if (demo && demoLocked) return `<div class="small ok" style="margin-bottom:8px">✓ Death-skill table locked · mint is open (demo)</div>`;
  return `<div class="fcard small agatk" style="margin-bottom:8px"><div class="gh">Creator: lock the Death skill table</div>
   <p class="mut small">Mint stays closed on-chain until you lock. Enter the token ids that get the ☠ Death skill (from your rarity table; ids are assigned in mint order), then lock. Locking is final.</p>
   <label>Death-skill ids<input data-aglockids placeholder="e.g. 7, 19, 33"></label><div class="agbtns"><button class="bbtn sm" data-aglock>Assign &amp; lock</button></div></div>`;
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
   <aside class="ldside">${d.mode === 'ordinals' ? ordBox(d) : ''}${revealBox(d)}${mintBox(d)}${AGENT_UI && isAgentDrop(d) ? agentBox(d) : ''}${soon ? '' : alBox(d)}
    <div class="fcard small"><div class="kv"><span>Supply</span><b>${d.maxSupply.toLocaleString()}</b><span>Royalty (ERC-2981)</span><b>${d.royaltyBps / 100}%</b><span>Reveal</span><b>${d.reveal === 'instant' ? 'Instant' : 'Delayed'}</b><span>Standard</span><b>${isAgentDrop(d) ? 'ERC-463N7 agents (experimental, unaudited)' : isMulti(d) ? 'ERC-721 + LayerZero V2 escrow' : 'ERC-721A'}</b>${isMulti(d) ? `<span>Supply model</span><b>Shared · IDs assigned by the Base hub</b><span>Each mint creates</span><b>1 Active + ${d.chains.length - 1} escrow copies${isBatched(d) ? ` <i class="usd">batched every ${batchEta(d).k} IDs / ${batchEta(d).t} min</i>` : ''}</b><span>Move between chains</span><b>LZ fee + $${MOVE_FEE_USD.toFixed(2)}</b>` : ''}<span>After mint</span><b>Trades on MultiSea</b></div></div>
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
  const t = e.target as HTMLElement;
  const ag = t.closest('[data-agfeed],[data-agatk],[data-agdo],[data-agcancel],[data-agload],[data-agtrib],[data-agtr],[data-agclaim],[data-agadd]') as HTMLElement | null;
  if (ag) { const d = findDrop(slug); if (d) (ag.hasAttribute('data-agclaim') || ag.hasAttribute('data-agadd') ? onGrowth(d, ag) : onAgent(d, ag)); return; }
  const el = t.closest('[data-tab],[data-ch],[data-q],[data-act],[data-move],[data-dst]') as HTMLElement | null; if (!el) { if (t.classList.contains('ldmodal')) { moveId = 0; moveMsg = ''; render(); } return; }
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
  if (el.dataset.act === 'connect') { openConnect(); return; }
  if (el.dataset.act?.startsWith('rev')) { const d = findDrop(slug); if (!d) return; const a = el.dataset.act;
    if (a === 'revcustom') { revCustom = true; render(); return; }
    if (a === 'revask') { revStep = 'confirm'; revMsg = ''; render(); return; }
    if (a === 'revcancel') { revStep = ''; render(); return; }
    if (a === 'revgo') { const R = d as any; const k = R.addresses?.[chainSel] ? chainSel : d.chains.map(c => c.chain).find(c => R.addresses?.[c]);
      if (MOCK_REV || !k) { revMsg = '<span class="mut">Preview only: no transaction sent.</span>'; revStep = ''; render(); return; }
      revBusy = true; render();
      import('./lpchain').then(m => m.revealOn(k, R.addresses[k], revURI, h => { revMsg = `Transaction sent: ${txLink(k, h)}`; render(); }))
        .then(() => { revCache[`${k}:${R.addresses[k]}`] = undefined as any; delete revCache[`${k}:${R.addresses[k]}`]; revMsg = '✓ Revealed. Marketplaces may take a few minutes to refresh metadata.'; revStep = ''; })
        .catch(e => { revMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { revBusy = false; render(); }); return; } }
  if (el.dataset.act === 'lsignin') { (wallet.address ? signIn('Sign in to MultiSea to deploy your drop') : Promise.resolve(openConnect()).then(() => { throw new Error('Connect your wallet, then sign in.'); })).then(loadMine).then(render).catch(e => { depMsg = `<span class="err">${esc(e?.message || e)}</span>`; render(); }); return; }
  if (el.dataset.deploy) { const k = el.dataset.deploy; depBusy = k; depMsg = ''; render();
    (isAgentDrop(d) ? import('./agentdrop').then(m => m.deployAgentOn(d.slug, k, h => { depMsg = `Transaction sent: ${txLink(k, h)}`; render(); })) : import('./lpchain').then(m => m.deployOn(d.slug, k, h => { depMsg = `Transaction sent: ${txLink(k, h)}`; render(); })))
      .then(async a => { depMsg = `✓ Deployed on ${esc(chains[k].name)}: <span class="mono">${esc(a)}</span>`; (d as any).addresses = { ...(d as any).addresses, [k]: a }; d.deployed = true; await refreshRemote(); })
      .catch(e => { depMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { depBusy = ''; render(); }); return; }
  if (el.dataset.act === 'mint' && comingSoon(d)) return; // no mint before the contract is deployed
  if (el.dataset.act === 'mint' && (d as any).remote && LP_LIVE && (d as any).addresses?.[chainSel]) {
    if (!wallet.address) { openConnect(); return; } const k = chainSel; const ai = activePhase(d); const ph: any = (d as any).raw.phases[ai]; const n = qty;
    const unit = BigInt(ph.prices?.[k] ?? ph.price); realBusy = true; realMsg = ''; render();
    (async () => { let proof: `0x${string}`[] = [];
      if (ph.kind === 'allowlist') { const r = await fetch(`${API}/launchpad/proof/${d.slug}/${ai}/${wallet.address!.toLowerCase()}`).then(r => r.json()); if (!r.eligible) throw new Error('This wallet is not on the ' + ph.name + ' allowlist.'); proof = r.proof; }
      if (isAgentDrop(d)) { const am = await import('./agentdrop');
        const why = await am.agentMintGate(k, (d as any).addresses[k]); if (why) throw new Error(why);
        return am.agentMint(k, (d as any).addresses[k], n, h => { realMsg = `<span class="spin"></span> Sent ${txLink(k, h)}…`; render(); }, ai, proof, unit); }
      const m = await import('./lpchain');
      return m.mint(isMulti(d), k, (d as any).addresses[k], ai, n, proof, unit, h => { realMsg = `<span class="spin"></span> Sent ${txLink(k, h)}…`; render(); }); })()
      .then(r => { realMsg = `✓ Minted ${n} on ${esc(chains[k].name)}: ${txLink(k, r.hash)}${isMulti(d) && k !== 'base' ? ' · the Base hub confirms your IDs in a few minutes' : ''}`; })
      .catch(e => { realMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { realBusy = false; render(); });
    return;
  }
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
async function onGrowth(d: Drop, el: HTMLElement) {
 const k = d.chains[0].chain; const engine = (d as any).addresses[k]; const mod = await import('./agentgrowth');
 try { agBusy = 'growth';
  if (el.hasAttribute('data-agclaim')) {
   const id = +(el.closest('[data-growth]') as HTMLElement).dataset.growth!; const token = await mod.tokenId(k, engine, id);
   for (const v of growthData[id].claimable) await mod.claimGrowthValue(k, engine, growthAddress! as any, token, v.k, v.v.id, h => { agMsg = `Claim submitted ${txLink(k, h)}`; render(); });
   agMsg = '✓ Traits claimed';
  }

  else { const f = (document.querySelector('[data-gart]') as HTMLInputElement).files?.[0]; if (!f) throw new Error('Select the trait artwork.'); const typeId = +(document.querySelector('[data-gtype]') as HTMLSelectElement).value; const typeName = (document.querySelector('[data-gtypename]') as HTMLInputElement).value; const name = (document.querySelector('[data-gname]') as HTMLInputElement).value; if (!name || typeId < 0 && !typeName) throw new Error('Name the type and value.'); const breeding = (document.querySelector('[data-grule]') as HTMLSelectElement).value === 'breeding'; const req = (document.querySelector('[data-greq]') as HTMLInputElement).value.split(':'); await mod.createGrowthValue(k, engine, growthAddress! as any, typeId < 0 ? growthTypes.length : typeId, typeName, name, f, { kind: breeding ? 'breeding' : 'level', level: +(document.querySelector('[data-glevel]') as HTMLInputElement).value, chanceBps: Math.round(+(document.querySelector('[data-gchance]') as HTMLInputElement).value * 100), parent: +(document.querySelector('[data-gparent]') as HTMLInputElement).value, reqType: req[0] ? +req[0] : 255, reqValue: +req[1] || 0 }, h => { agMsg = `Trait submitted ${txLink(k, h)}`; render(); }); agMsg = '✓ New trait added'; }
  await loadGrowth(d);
 } catch (err: any) { agMsg = `<span class="err">${esc(err?.message || err)}</span>`; render(); }
 finally { agBusy = ''; }
}
function onAgent(d: Drop, el: HTMLElement) {
  const demo = !!(d as any).demo; const k = d.chains[0].chain; const eng = (d as any).addresses?.[k];
  const m2 = (id: number) => import('./agentdrop').then(m => m.loadAgent(k, eng, id)).then(a => { agents = (agents || []).map(x => (x.id === id ? a : x)); });
  if (el.dataset.agload != null) { const id = +((app.querySelector('[data-agid]') as HTMLInputElement)?.value || 0); if (!(id > 0) || !eng) return;
    import('./agentdrop').then(m => m.loadAgent(k, eng, id)).then(a => { agents = [a, ...(agents || []).filter(x => x.id !== id)]; agMsg = ''; }).catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(render); return; }
  if (el.dataset.agcancel != null) { atkFrom = 0; agMsg = ''; render(); return; }
  if (el.dataset.agtr) { const skip = el.dataset.agtr === 'skip';
    if (skip && !confirm('Skip CSV traits? Agents will show only their onchain traits. This is final.')) return;
    if (demo) { demoTraits = skip ? 'CSV traits skipped (demo)' : `CSV traits stored onchain (${trEnc?.rows ?? 0} rows, ${trEnc ? traitGas(trEnc).txs : 0} tx, demo: nothing sent)`; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = skip ? 'skiptraits' : 'traits'; trMsg = ''; render();
    import('./agentdrop').then(m => skip ? m.agentSkipTraits(k, eng, h => { trMsg = `Sent ${txLink(k, h)}…`; render(); })
      : m.agentUploadTraits(k, eng, trEnc!, (h, i, n) => { trMsg = `<span class="spin"></span> Tx ${i}/${n}: ${txLink(k, h)}`; render(); }))
      .then(() => import('./agentdrop')).then(m => m.agentTraitsState(k, eng)).then(t => { trState = t; trMsg = ''; })
      .catch(e => { trMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); return; }
  if (el.dataset.aglock != null) { const raw = ((app.querySelector('[data-aglockids]') as HTMLInputElement)?.value || '').split(/[\s,]+/).filter(Boolean);
    if (raw.some(x => !/^\d+$/.test(x))) { agMsg = '<span class="err">Ids must be whole numbers.</span>'; render(); return; }
    if (demo) { demoLocked = true; agMsg = `✓ Demo only: ${raw.length} ids would get the Death skill, then lock() opens mint. No transaction was sent.`; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = 'lock';
    import('./agentdrop').then(m => m.agentLockSkills(k, eng, raw.map(x => BigInt(x)), h => { agMsg = `Sent ${txLink(k, h)}…`; render(); })).then(() => { agMsg = '✓ Locked. Mint is open.'; })
      .catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); return; }
  if (el.dataset.agstarve) { const id = +el.dataset.agstarve;
    if (demo) { const a = agents?.find(x => x.id === id); if (a) { a.dead = true; a.custodian = '0x2fee00000000000000000000000000000000a9e7'; a.heirIsTreasury = true; } agMsg = `✓ Demo only: #${id} starved: NFT burned, wallet to its heir or the treasury. No transaction was sent.`; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = 'starve';
    import('./agentdrop').then(m => m.agentStarve(k, eng, id, h => { agMsg = `Sent ${txLink(k, h)}…`; render(); })).then(() => m2(id)).then(() => { agMsg = `✓ #${id} starved`; })
      .catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); return; }
  if (el.dataset.agtrib) { const q = +el.dataset.agtrib;
    const raw = ((el.closest('.agtrib')?.querySelector('[data-agtribids]') as HTMLInputElement)?.value || '');
    const ids = [...new Set(raw.split(/[\s,]+/).filter(Boolean).map(Number))].filter(n => Number.isInteger(n) && n > 0 && n !== q);
    if (!ids.length || ids.length > 100) { agMsg = '<span class="err">List 1-100 other agents\' token ids.</span>'; render(); return; }
    if (demo) { agMsg = `✓ Demo only: Queen #${q} would collect tribute from ${ids.map(i => '#' + i).join(', ')} (agents already paid this period, Queens and empty wallets are skipped). No transaction was sent.`; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = 'tribute';
    import('./agentdrop').then(m => m.agentTribute(k, eng, q, ids, h => { agMsg = `Sent ${txLink(k, h)}…`; render(); })).then(() => m2(q)).then(() => { agMsg = `✓ Queen #${q} collected tribute`; })
      .catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); return; }
  if (el.dataset.agatk) { atkFrom = +el.dataset.agatk; agMsg = ''; render(); return; }
  if (el.dataset.agfeed) { const id = +el.dataset.agfeed;
    if (demo) { const a = agents?.find(x => x.id === id); if (a) { a.lastFed = Math.floor(Date.now() / 1000); a.strikeAt = 0; a.graceEnd = 0; } agMsg = `✓ Demo only: fed #${id} (clock reset, strike cleared). No transaction was sent.`; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = 'feed';
    import('./agentdrop').then(m => m.agentFeed(k, eng, id, 10n ** 14n, h => { agMsg = `Sent ${txLink(k, h)}…`; render(); })).then(() => m2(id)).then(() => { agMsg = `✓ Fed #${id}`; })
      .catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); return; }
  if (el.dataset.agdo) { const from = +el.dataset.agdo; const tgt = +((app.querySelector('[data-agtgt]') as HTMLInputElement)?.value || 0);
    if (!(tgt > 0) || tgt === from) { agMsg = '<span class="err">Enter another agent\'s token id.</span>'; render(); return; }
    if (demo) { agMsg = `✓ Demo only: #${from} asked ORA to judge #${tgt}. A K verdict would put a strike on #${tgt} (its holder then has the grace period to feed it). No transaction was sent.`; atkFrom = 0; render(); return; }
    if (!wallet.address) { openConnect(); return; } agBusy = 'attack';
    import('./agentdrop').then(m => m.agentAttack(k, eng, from, tgt, h => { agMsg = `Sent ${txLink(k, h)}… ORA answers in a few minutes.`; render(); })).then(() => { atkFrom = 0; })
      .catch(e => { agMsg = `<span class="err">${esc(e?.shortMessage || e?.message || e)}</span>`; }).finally(() => { agBusy = ''; render(); }); }
}
app.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.dataset.revuri != null) { revURI = t.value.trim(); } });
app.addEventListener('focusout', e => { if ((e.target as HTMLElement).dataset?.revuri != null) render(); });
app.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'pay') { pay = t.value as any; render(); }
  if (t.dataset.qin != null) { qty = Math.max(1, Math.floor(+t.value || 1)); render(); }
  if (t.dataset.trcsv != null && t.files?.[0]) { const d = findDrop(slug); t.files[0].text().then(async txt => { const lm = await import('./lpmedia'); lm.loadCsv(t.files![0].name, txt);
    const e = lm.media.csvErr || encodeTraits(lm.media.rows); lm.media.rows = [];
    if (typeof e === 'string' || !e) { trMsg = `<span class="err">${esc(e || 'No trait columns in that CSV.')}</span>`; } else { trEnc = e; if (d) saveTraits(d.slug, e); trMsg = ''; } render(); }); }
});
async function refreshRemote() { if (!apiFeatures.includes('launchpad')) return; try { const j = await fetch(API + '/launchpad/drops').then(r => r.json()); remote = (j.drops || []).map(fromApi); render(); } catch {} }
if (path === '/launchpad/create') import('./launchcreate');
else {
  bindNav(); render(); setInterval(tick, 1000); onWallet(render); checkApi().then(refreshRemote).then(loadMine).then(render); onWallet(() => loadMine().then(render));
  usdRates().then(r => { rates = r; render(); });
  const d = slug ? findDrop(slug) : null; if (d) loadGas(d).then(render);
}
export { openConnect };
