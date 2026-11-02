// /me: the connected wallet's NFT activity across chains (thirdweb Insight): buys, sales, transfers, mints.
// Robinhood isn't covered by Insight, so it is listed as a gap rather than silently missing.
import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect } from './wallet';
import { frame, esc, logo, chains, nameFor } from './gx';
import { addrHtml } from './names';
import { INSIGHT_CHAINS, walletTransfers, type Xfer } from './insight';
const el = frame('me', 'My activity', 'page wact');
const q = new URLSearchParams(location.search); const previewAs = /^0x[0-9a-fA-F]{40}$/.test(q.get('as') || '') ? q.get('as')! : '';
const who = () => previewAs || wallet.address || '';
const uncovered = Object.keys(CFG.chains).filter(k => !INSIGHT_CHAINS.includes(k));
let rows: (Xfer & { kind: string })[] = []; let state: Record<string, 'loading' | 'ok' | 'err'> = {}; let filter = 'all'; let loadedFor = '';
const ZERO = '0x0000000000000000000000000000000000000000';
function kindOf(x: Xfer, me: string) {
  const to = x.to.toLowerCase() === me, from = x.from.toLowerCase() === me;
  if (x.from === ZERO && to) return 'mint'; if (x.type === 'sale') return to ? 'buy' : 'sale'; return to ? 'in' : from ? 'out' : 'transfer';
}
const LBL: Record<string, string> = { mint: 'Mint', buy: 'Buy', sale: 'Sale', in: 'Received', out: 'Sent', transfer: 'Transfer' };
async function load() {
  const a = who(); if (!a || loadedFor === a) { draw(); return; } loadedFor = a; rows = []; state = {}; const me = a.toLowerCase(); const t = performance.now();
  INSIGHT_CHAINS.forEach(c => (state[c] = 'loading')); draw();
  await Promise.all(INSIGHT_CHAINS.map(c => walletTransfers(c, a).then(xs => { rows.push(...xs.map(x => ({ ...x, kind: kindOf(x, me) }))); state[c] = 'ok'; })
    .catch(() => { state[c] = 'err'; }).finally(() => { rows.sort((x, y) => y.ts - x.ts); draw(); })));
  ((window as any).__msPerf ??= {}).walletActivityMs = performance.now() - t; document.documentElement.dataset.meLoaded = '1';
}
const ago = (ts: number) => { const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
function draw() {
  const a = who();
  if (!a) { el.innerHTML = `<h1>My activity</h1><div class="fcard cta"><p>Connect a wallet to see your buys, sales, transfers and mints across chains.</p><button class="bbtn sm" data-act="connect">Connect wallet</button></div>`; return; }
  const counts: Record<string, number> = {}; rows.forEach(r => (counts[r.chain] = (counts[r.chain] || 0) + 1));
  const vis = rows.filter(r => filter === 'all' || r.chain === filter);
  el.innerHTML = `<h1>My activity</h1><p class="mut">${addrHtml(a)}${previewAs ? ' <span class="mut small">(preview)</span>' : ''} · NFT mints, buys, sales and transfers over the last 12 months · <a href="/u/${a}">Profile</a></p>
  <div class="pills"><button data-f="all" class="${filter === 'all' ? 'on' : ''}">All chains (${rows.length})</button>${INSIGHT_CHAINS.map(c => `<button data-f="${c}" class="${filter === c ? 'on' : ''}">${logo(c)} ${esc(chains[c].name)} ${state[c] === 'loading' ? '…' : state[c] === 'err' ? '⚠' : `(${counts[c] || 0})`}</button>`).join('')}</div>
  ${uncovered.length ? `<p class="mut small">Not indexed: ${uncovered.map(c => esc(chains[c].name)).join(', ')} (thirdweb Insight doesn't cover ${uncovered.length > 1 ? 'these chains' : 'this chain'} yet).</p>` : ''}
  <div class="r h"><span>Event</span><span>Chain</span><span>Item</span><span>From → To</span><span>When</span><span>Tx</span></div>
  ${vis.slice(0, 300).map(r => { const ex = chains[r.chain].explorer; return `<div class="r" data-row="${r.kind}"><span><span class="tag ${r.kind}">${LBL[r.kind]}</span></span><span>${logo(r.chain)} ${esc(chains[r.chain].name)}</span><span>${esc(nameFor(r.chain, r.contract, r.id))}</span><span>${r.from === ZERO ? '<i class="mut">mint</i>' : addrHtml(r.from)} → ${addrHtml(r.to)}</span><span title="${new Date(r.ts * 1000).toLocaleString()}">${ago(r.ts)}</span><span><a href="${ex}/tx/${r.tx}" target="_blank" rel="noopener">View ↗</a></span></div>`; }).join('')
    || (Object.values(state).includes('loading') ? '<p><span class="spin"></span> Loading from every chain…</p>' : '<p class="mut">No NFT activity found.</p>')}`;
}
el.addEventListener('click', e => { const t = e.target as HTMLElement; const f = t.closest<HTMLElement>('[data-f]'); if (f) { filter = f.dataset.f!; draw(); } if (t.closest('[data-act="connect"]')) openConnect(); });
onWallet(() => { if (!previewAs) load(); });
load();
