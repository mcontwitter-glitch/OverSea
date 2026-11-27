// /deploy-bridge-v3 — the bridge admin wallet deploys + configures MultiSeaFactoryV3 on each chain from his own browser wallet.
// No server key. Per chain, 7 transactions in order; each is re-simulated on-chain right before the wallet is asked, and a step that
// is already done on-chain is skipped (so you can stop and resume). Nothing here changes bridge.json: switching the site to V3 is a separate step.
import { createWalletClient, custom, formatEther, formatGwei, type Address, type Hex } from 'viem';
import { wallet, openConnect, onWallet, ensureChain, ensureAccount, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';
import CFG from '../config/collections.json';
import { A, ADMIN, stepsFor, readLive, doneSteps, verifyChain, type Live, type State } from './bridgev3steps';

const chains = CFG.chains as Record<string, { name: string; native: string; explorer: string }>;
const KEYS = Object.keys(A.chains) as string[];
const GAS_UNITS = 7_300_000n; // all 7 steps, measured on forks of every chain (7.21M) + headroom
const logo = (k: string) => `<img class="cl" src="/logos/${k}.svg" alt="">`;
const app = document.getElementById('app')!;
document.title = 'Deploy bridge V3 · MultiSea';
const isAdmin = () => !!wallet.address && wallet.address.toLowerCase() === ADMIN.toLowerCase();
const LS = 'multisea.bridgev3';
type Row = { st: State; live?: Live; done: Record<number, boolean>; verified?: string[]; bal?: bigint; gp?: bigint; busy?: string; err?: string; loading: boolean; ok?: string };
const rows: Record<string, Row> = {}; let saved: Record<string, State> = {}; let log = '';
try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch {}
for (const k of KEYS) rows[k] = { st: saved[k] || {}, done: {}, loading: true };
const persist = () => { const o: Record<string, State> = {}; for (const k of KEYS) o[k] = rows[k].st; localStorage.setItem(LS, JSON.stringify(o)); };
const short = (a?: string) => (a ? a.slice(0, 8) + '…' + a.slice(-6) : '—');
const fmt = (w: bigint) => { const [a, b = ''] = formatEther(w).split('.'); return a + (b ? '.' + b.slice(0, 6).replace(/0+$/, '') : ''); };

async function refresh(k: string) {
  const r = rows[k]; const pub = readClient(k);
  try {
    r.live = r.live || await readLive(k, A.chains[k].oldFactory, pub);
    r.done = await doneSteps(k, r.live, r.st, pub);
    r.gp = await pub.getGasPrice().catch(() => r.gp);
    r.bal = await pub.getBalance({ address: ADMIN }).catch(() => r.bal);
    r.verified = r.done[7] && r.done[4] && r.done[5] ? await verifyChain(k, r.live, r.st, pub) : undefined;
    r.err = '';
  } catch (e: any) { r.err = 'Could not read the chain: ' + (friendly(e, k) || e?.message); }
  r.loading = false; draw();
}
const needOf = (r: Row) => (r.gp ? (GAS_UNITS * r.gp * 13n) / 10n : 0n);
const stepsLeft = (r: Row) => [1, 2, 3, 4, 5, 6, 7].filter(i => !r.done[i]).length;

function draw() {
  const allOk = KEYS.every(k => rows[k].verified && rows[k].verified!.length === 0);
  app.innerHTML = `${navHtml('launchpad')}<main class="page ld"><h1>Deploy bridge V3</h1>
    <p class="mut">Deploys <b>MultiSeaFactoryV3</b>, its <b>EscrowDeployer</b> and <b>MirrorDeployer</b> on each chain and configures them (7 transactions per chain, from the admin wallet <span class="mono">${esc(short(ADMIN))}</span>). Each transaction is simulated on-chain first; if it would fail your wallet is not asked. Steps already done are skipped, so you can stop and continue later. This page does <b>not</b> switch the site to V3.</p>
    ${!wallet.address ? `<div class="fcard cta"><button class="bbtn" data-act="connect">Connect wallet</button></div>`
      : !isAdmin() ? `<p class="err">Connected ${esc(short(wallet.address))}. Connect the admin wallet ${esc(ADMIN)} to continue (read-only until then).</p>` : `<p class="ok small">Admin wallet connected.</p>`}
    <div class="ldchgrid">${KEYS.map(k => {
      const r = rows[k]; const c = chains[k] || { name: k, native: 'ETH', explorer: '' }; const need = needOf(r); const short_ = r.bal != null && need > r.bal;
      const left = stepsLeft(r); const names = r.live ? stepsFor(k, r.live, r.st) : [];
      return `<div class="fcard ldchrow ${left === 0 && r.verified?.length === 0 ? 'on' : ''}">${logo(k)}<b>${esc(c.name)}</b>
        <div class="mut small">Gas wallet balance ${r.bal != null ? esc(fmt(r.bal)) : '…'} ${esc(c.native)} · needs ≈ ${r.gp ? esc(fmt(need)) : '…'} (gas ${r.gp ? esc(formatGwei(r.gp)) : '…'} gwei, 30% margin)</div>
        ${short_ ? `<p class="err small">Short by ${esc(fmt(need - r.bal!))} ${esc(c.native)}: send that to ${esc(short(ADMIN))} on ${esc(c.name)} first.</p>` : ''}
        <ol class="small" style="margin:.4rem 0 .4rem 1.1rem">${names.map(s => `<li>${r.done[s.id] ? '✓' : '·'} ${esc(s.label)}${s.key && r.st[s.key] ? ` <a class="mono" href="${esc(c.explorer)}/address/${esc(r.st[s.key]!)}" target="_blank" rel="noopener">${esc(short(r.st[s.key]))}</a>` : ''}</li>`).join('')}</ol>
        ${r.verified ? (r.verified.length ? `<p class="err small">Verification found problems: ${esc(r.verified.join('; '))}</p>` : `<p class="ok small">✓ Verified on-chain (owner, endpoint, route, deployers, gas costs).</p>`) : ''}
        ${r.err ? `<p class="err small">${esc(r.err)}</p>` : ''}${r.busy ? `<p class="mut small"><span class="spin"></span> ${esc(r.busy)}</p>` : ''}${r.ok ? `<p class="ok small">${esc(r.ok)}</p>` : ''}
        ${isAdmin() && left > 0 && !r.busy && !r.loading ? `<button class="pill sm" data-run="${k}">${left === 7 ? 'Start' : 'Continue'} on ${esc(c.name)} (${left} left)</button>` : ''}</div>`;
    }).join('')}</div>
    ${allOk ? `<div class="fcard"><b>All 5 chains verified.</b><p class="mut small">Next (done by MultiSea, not this page): record these in <span class="mono">contracts/deployments/mainnet.json</span>, regenerate <span class="mono">bridge.json</span> so new listings use V3, publish. Existing collections keep their current escrows.</p></div>` : ''}
    <p class="mut small">Progress is kept in this browser. Addresses so far (copy this if you switch device, then paste it into "Restore" there):</p>
    <textarea id="bv3json" class="fcard small mono" style="width:100%;min-height:8rem" readonly>${esc(JSON.stringify(Object.fromEntries(KEYS.map(k => [k, rows[k].st])), null, 1))}</textarea>
    <p><button class="pill sm" data-act="restore">Restore from pasted JSON</button> <span class="mut small">(paste into the box above first)</span></p>
    ${log ? `<pre class="fcard small" style="white-space:pre-wrap">${esc(log)}</pre>` : ''}</main>`;
  const ta = document.getElementById('bv3json') as HTMLTextAreaElement | null; if (ta && wallet.address) ta.readOnly = false;
  bindNav();
}

let running = false;
async function run(k: string) {
  if (running) return; running = true; const r = rows[k]; r.err = ''; r.ok = '';
  try {
    if (!isAdmin()) throw new Error('Connect the admin wallet first.');
    for (let guard = 0; guard < 12; guard++) {
      r.busy = 'Reading the chain…'; draw(); await refresh(k); r.busy = 'Reading the chain…';
      const pub = readClient(k); const live = r.live!;
      const next = [1, 2, 3, 4, 5, 6, 7].find(i => !r.done[i]);
      if (!next) break;
      const step = stepsFor(k, live, r.st).find(s => s.id === next)!;
      if (next >= 2 && !r.st.factory) throw new Error('The factory address is missing. Paste your saved JSON into Restore.');
      r.busy = 'Switching to ' + (chains[k]?.name || k) + '…'; draw(); await ensureChain(k);
      const acc = await ensureAccount(); if (acc.toLowerCase() !== ADMIN.toLowerCase()) throw new Error('Your wallet switched to another account. Select the admin account.');
      r.busy = `Step ${next}/7: simulating “${step.label}” on-chain…`; draw();
      let gas: bigint;
      try { gas = await pub.estimateGas({ account: acc, to: step.to, data: step.data }); }
      catch (e: any) { throw new Error(`Step ${next} (${step.label}) would fail, so nothing was sent: ${String(friendly(e, k) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 220)}`); }
      const gp = await pub.getGasPrice(); const bal = await pub.getBalance({ address: acc }); const cost = (gas * 125n / 100n) * gp;
      if (bal < cost) throw new Error(`Not enough ${chains[k].native} on ${chains[k].name} for this step: need ≈ ${fmt(cost)}, have ${fmt(bal)}.`);
      r.busy = `Step ${next}/7: confirm “${step.label}” in your wallet (≈ ${fmt(cost)} ${chains[k].native} gas)…`; draw();
      const w = createWalletClient({ account: acc, chain: vchain(k), transport: custom(wallet.provider || (window as any).ethereum) });
      const hash = await w.sendTransaction({ account: acc, chain: vchain(k), to: step.to, data: step.data, gas: gas * 125n / 100n } as any);
      log += `${k} step ${next} ${step.label}: ${hash}\n`; r.busy = `Step ${next}/7: waiting for confirmation…`; draw();
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success') throw new Error(`Step ${next} reverted on-chain (${hash}).`);
      if (step.kind === 'deploy') { r.st[step.key!] = rc.contractAddress as Address; log += `${k} ${step.key}: ${rc.contractAddress}\n`; persist(); }
    }
    r.busy = ''; await refresh(k);
    r.ok = r.verified && r.verified.length === 0 ? `${chains[k].name} is fully deployed and verified.` : '';
  } catch (e: any) { r.err = friendly(e, k) || e?.message || String(e); }
  r.busy = ''; running = false; draw();
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-act="connect"]')) openConnect();
  const b = t.closest<HTMLElement>('[data-run]'); if (b) run(b.dataset.run!);
  if (t.closest('[data-act="restore"]')) {
    try { const o = JSON.parse((document.getElementById('bv3json') as HTMLTextAreaElement).value);
      for (const k of KEYS) if (o[k]) rows[k].st = { factory: o[k].factory, escrowDeployer: o[k].escrowDeployer, mirrorDeployer: o[k].mirrorDeployer };
      persist(); KEYS.forEach(refresh); draw(); } catch { alert('That is not valid JSON.'); }
  }
});
onWallet(draw);
draw();
KEYS.forEach(k => refresh(k));
