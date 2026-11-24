// Founder box: "Set up revenue share". Deploy one RevShareVault per chain from the collection owner's own wallet (one tx, founder pays gas;
// simulated before the wallet is prompted), register it with the Worker (SIWE, collection owner/editor), show balance / paid / pending and
// pause toggles. The vault has no owner withdraw: holders are paid by the contract and nobody else can take the funds.
import { createWalletClient, custom, parseEther, type Address, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, readClient, ensureChain, vchain, friendly, API } from './wallet';
import { api } from './auth';
import { FACTORIES, FACTORY_ABI, VAULT_ABI, hasFactories, readVault, fe, errText, type VaultStats } from './rsvault';
import type { FounderCol } from './founder';

const chains = CFG.chains as Record<string, { name: string; chainId: number; native: string; explorer: string }>;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const logo = (k: string) => `<img class="cl" src="/logos/${k}.svg" alt="">`;
const ZERO = '0x0000000000000000000000000000000000000000';
type Row = { k: string; collection: Address; factory?: Address; vault?: Address; stats?: VaultStats | null; registered: boolean; busy: string; err: string; tx: string; famt?: string; fb?: string; ferr?: string; ftx?: string };
type St = { col: FounderCol; slug: string; rows: Row[]; fee: string; roy: string; supply: string; firstId: string; terms: boolean; msg: string; loaded: boolean; cap: number; cfg: any; busy: boolean };
let S: St | null = null; let host: HTMLElement | null = null; let fundHost: HTMLElement | null = null;

export async function initRevshareFounder(col: FounderCol) {
  S = null; if (!col.slug) return;
  const deps = (col.deployments || []).filter(d => d?.address && chains[d.chain]);
  const rows: Row[] = deps.map(d => ({ k: d.chain, collection: d.address as Address, factory: FACTORIES[d.chain] as Address | undefined, registered: false, busy: '', err: '', tx: '' }));
  const st: St = { col, slug: col.slug, rows, fee: '25', roy: '5', supply: String(col.supply || ''), firstId: '1', terms: false, msg: '', loaded: false, cap: 50, cfg: null, busy: false };
  S = st; paint();
  try {
    const info = await fetch(`${API}/revshare/${st.slug}`).then(r => r.json()).catch(() => null);
    st.cfg = info?.config || null; st.cap = (info?.capBps || 5000) / 100;
    if (st.cfg?.enabled) { st.fee = String((st.cfg.feeShareBps || 0) / 100); st.supply = String(st.cfg.supply || st.supply); if (st.cfg.firstId != null) st.firstId = String(st.cfg.firstId); }
    const rb = Number((await fetch(`${API}/native/config/${st.slug}`).then(r => r.json()).catch(() => null))?.royalty?.bps || 0); if (rb) st.roy = String(rb / 100);
    await Promise.all(rows.map(async r => {
      if (!r.factory) return;
      try {
        const v = await readClient(r.k).readContract({ address: r.factory, abi: FACTORY_ABI, functionName: 'vaultOf', args: [r.collection] } as any) as string;
        if (v && v.toLowerCase() !== ZERO) { r.vault = v as Address; r.stats = await readVault(r.k, v); r.registered = st.cfg?.vaults?.[r.k]?.toLowerCase() === v.toLowerCase(); }
      } catch (e: any) { r.err = errText(e, r.k); }
    }));
    if (!st.supply) { const any = rows.find(r => r.stats); if (any?.stats) st.supply = String(any.stats.supply); }
    // first token id: 0 if ownerOf(0) exists on the first chain, else 1 (only when no vault exists yet to copy it from)
    const anyV = rows.find(r => r.stats); if (anyV?.stats) st.firstId = String(anyV.stats.firstId);
    else { const r0 = rows[0]; if (r0) { const ok = await readClient(r0.k).readContract({ address: r0.collection, abi: [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] }], functionName: 'ownerOf', args: [0n] } as any).then(() => true).catch(() => false); st.firstId = ok ? '0' : '1'; } }
  } catch (e: any) { st.msg = `<span class="err">${esc(errText(e))}</span>`; }
  st.loaded = true; paint();
}
export function mountRevshareFounder(el: HTMLElement | null, fundEl: HTMLElement | null = null) { host = el; fundHost = fundEl; paint(); }

function paint() {
  if (fundHost) fundHost.innerHTML = fundHtml();
  if (!host) return;
  if (!S) { host.innerHTML = ''; return; }
  const st = S;
  if (!hasFactories()) {
    host.innerHTML = `<h4>Set up revenue share</h4><p class="mut small"><b>Coming soon.</b> Revenue-share vaults are not live on any chain yet. When they are, you'll be able to share a % of MultiSea's fee and your creator royalty with every holder, paid by an on-chain vault you deploy from your own wallet.</p>`;
    return;
  }
  const me = (wallet.address || '').toLowerCase();
  const usable = st.rows.filter(r => r.factory);
  const supplyOk = /^\d{1,7}$/.test(st.supply) && +st.supply > 0;
  const rowsHtml = usable.map(r => {
    const c = chains[r.k]; const s = r.stats; const mine = !!s && s.owner === me;
    const stats = s ? `<div class="mut small">Vault <a class="mono" href="${esc(c.explorer)}/address/${esc(r.vault)}" target="_blank" rel="noopener">${esc(String(r.vault).slice(0, 8))}…${esc(String(r.vault).slice(-6))}</a> · balance ${fe(s.balance, 6)} ${esc(c.native)} · deposited ${fe(s.deposited, 6)} · paid to holders ${fe(s.claimed, 6)} · owed ${fe(s.owed, 6)}${s.claimsPaused ? ' · <b class="err">claims paused</b>' : ''}${s.depositsPaused ? ' · deposits paused' : ''}</div>
      ${r.registered ? '' : '<div class="small warn">Deployed but not registered with MultiSea yet.</div>'}` : '<div class="mut small">No vault on this chain yet. Chains without a vault keep paying the royalty to your normal recipient.</div>';
    const btn = !r.vault ? `<button class="bbtn sm" data-rsv="deploy" data-chain="${esc(r.k)}" ${st.busy || !wallet.address ? 'disabled' : ''}>Deploy vault on ${esc(c.name)}</button>`
      : !r.registered ? `<button class="bbtn sm" data-rsv="register" data-chain="${esc(r.k)}" ${st.busy ? 'disabled' : ''}>Register with MultiSea</button>` : '';
    const pause = mine ? `<button class="pill sm" data-rsv="pc" data-chain="${esc(r.k)}" ${st.busy ? 'disabled' : ''}>${s!.claimsPaused ? 'Resume claims' : 'Pause claims'}</button> <button class="pill sm" data-rsv="pd" data-chain="${esc(r.k)}" ${st.busy ? 'disabled' : ''}>${s!.depositsPaused ? 'Resume deposits' : 'Pause deposits'}</button>` : '';
    return `<div class="fndr">${logo(r.k)}<div class="fndm"><b>${esc(c.name)}</b>${stats}${r.busy ? `<div class="mut small"><span class="spin"></span> ${esc(r.busy)}</div>` : ''}${r.err ? `<div class="err small">${esc(r.err)}</div>` : ''}${r.tx ? `<div class="small ok">✓ <a href="${esc(c.explorer)}/tx/${esc(r.tx)}" target="_blank" rel="noopener">Tx ↗</a></div>` : ''}<div class="fndbtns">${btn} ${pause}</div></div></div>`;
  }).join('');
  host.innerHTML = `<h4>Set up revenue share</h4>
    <p class="mut small">Share revenue with every holder, on-chain. You deploy one vault per chain from your own wallet (you pay the gas; each step is simulated before your wallet is asked). The vault splits every deposit <b>equally across all ${esc(st.supply || 'N')} tokens</b>; the reward follows the token. You can pause claims or deposits, but there is no function to withdraw holders' money, for anyone, including you and MultiSea.</p>
    <div class="two"><label>% of MultiSea's fee to holders <span class="mut small">(0–${st.cap})</span><input data-rsvi="fee" inputmode="decimal" value="${esc(st.fee)}"></label>
      <label>Creator royalty % on MultiSea listings <span class="mut small">(0–10, 100% goes to the vault)</span><input data-rsvi="roy" inputmode="decimal" value="${esc(st.roy)}"></label></div>
    <div class="two"><label>Tokens sharing the pool (supply)<input data-rsvi="supply" inputmode="numeric" value="${esc(st.supply)}" ${usable.some(r => r.vault) ? 'disabled' : ''}></label>
      <label>First token ID<input data-rsvi="firstId" inputmode="numeric" value="${esc(st.firstId)}" ${usable.some(r => r.vault) ? 'disabled' : ''}></label></div>
    <label class="chk"><input type="checkbox" data-rsvi="terms" ${st.terms ? 'checked' : ''}> I understand revenue-sharing NFTs may be treated as securities in some places and I've taken advice where needed. The royalty share is funded by listings paying the vault; the fee share is added by MultiSea.</label>
    <p class="mut small">Existing listings keep their old royalty recipient (they are not changed). New listings, offers and bundles on a vault chain pay the royalty to the vault. A token that sits on another chain earns on that chain's vault only when it is there, so deposits for tokens elsewhere wait in the vault for them.</p>
    ${!st.loaded ? '<div class="spin"></div>' : rowsHtml || '<p class="mut small">This collection has no deployments on a chain with a revenue-share factory yet.</p>'}
    ${st.msg ? `<p class="small fndmsg">${st.msg}</p>` : ''}`;
}

// "Fund revenue share vault": the collection owner sends native tokens into each chain's vault (vault.deposit, own wallet, simulated first).
// Anyone can deposit; nobody can withdraw. Not to be confused with the ERC-6551 token-bound wallet airdrop (founder.ts).
function fundHtml(): string {
  const st = S; if (!st || !hasFactories()) return '';
  const rows = st.rows.filter(r => r.factory);
  const body = !st.loaded ? '<div class="spin"></div>' : rows.map(r => {
    const c = chains[r.k]; const s = r.stats;
    if (!r.vault || !s) return `<div class="fndr">${logo(r.k)}<div class="fndm"><b>${esc(c.name)}</b><div class="mut small">No vault on this chain yet. Create it under “Set up revenue share” above, then fund it here.</div></div></div>`;
    const dis = !!r.fb || !wallet.address || s.depositsPaused;
    return `<div class="fndr">${logo(r.k)}<div class="fndm"><b>${esc(c.name)}</b>
      <div class="mut small">Vault <a class="mono" href="${esc(c.explorer)}/address/${esc(r.vault)}" target="_blank" rel="noopener">${esc(String(r.vault))}</a></div>
      <div class="mut small">In the vault now: <b>${fe(s.balance, 6)} ${esc(c.native)}</b> · claimable by holders: ${fe(s.owed, 6)} · already paid out: ${fe(s.claimed, 6)} · total ever funded: ${fe(s.deposited, 6)}</div>
      ${s.depositsPaused ? '<div class="small warn">Deposits are paused on this vault.</div>' : ''}
      <div class="crow rsvfrow"><input data-rsvf-amt="${esc(r.k)}" inputmode="decimal" placeholder="0.0" value="${esc(r.famt || '')}" style="width:150px;flex:none"><span class="mut">${esc(c.native)}</span>
        <button class="bbtn sm rsvfbtn" data-rsvf="fund" data-chain="${esc(r.k)}" aria-label="Fund vault on ${esc(c.name)}" ${dis ? 'disabled' : ''}>${r.fb ? 'WORKING…' : 'FUND VAULT'}</button></div>
      ${r.fb ? `<div class="mut small"><span class="spin"></span> ${esc(r.fb)}</div>` : ''}${r.ferr ? `<div class="err small">${esc(r.ferr)}</div>` : ''}${r.ftx ? `<div class="small ok">✓ Funded. <a href="${esc(c.explorer)}/tx/${esc(r.ftx)}" target="_blank" rel="noopener">Tx ↗</a></div>` : ''}</div></div>`;
  }).join('') || '<p class="mut small">This collection has no deployments on a chain with a revenue-share factory yet.</p>';
  return `<h4>Fund revenue share vault</h4>
    <p class="mut small">Send ${esc('native tokens')} from your wallet into this collection's <b>revenue share vault</b> on each chain. Whatever is in a vault is split equally across all ${esc(st.supply || 'N')} tokens (the reward follows the token) and holders claim it on the collection page. Anyone can add funds; nobody, including you and MultiSea, can take them out. <b>This is not the token-bound wallet airdrop below.</b></p>${body}`;
}
async function fund(k: string) {
  const st = S; const r = st?.rows.find(x => x.k === k); if (!st || !r || !r.vault || r.fb) return; r.ferr = ''; r.ftx = '';
  try {
    if (!wallet.address || !wallet.provider) throw new Error('Connect your wallet first.');
    let v: bigint; try { v = parseEther(r.famt || '0'); } catch { throw new Error('Enter a valid amount.'); }
    if (v <= 0n) throw new Error('Enter an amount greater than 0.');
    const me = wallet.address as Address;
    r.fb = 'Switching chain…'; paint(); await ensureChain(k);
    const pc = readClient(k); const req = { address: r.vault, abi: VAULT_ABI, functionName: 'deposit', value: v, account: me } as any;
    r.fb = 'Checking the deposit…'; paint();
    await pc.simulateContract(req).catch((e: any) => { throw new Error(`The deposit would fail (${String(friendly(e, k) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 160)}). Nothing was sent.`); });
    r.fb = 'Confirm in your wallet…'; paint();
    const hash = await wc(k).writeContract({ ...req, chain: vchain(k), gas: await bufferedGas(k, req, 100_000n) });
    r.fb = 'Waiting for confirmation…'; paint();
    const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('The deposit reverted.');
    r.ftx = hash; r.famt = ''; r.stats = await readVault(k, r.vault);
  } catch (e: any) { r.ferr = errText(e, k); }
  r.fb = ''; paint();
}

const wc = (k: string) => createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
async function bufferedGas(k: string, req: any, floor: bigint) { const est = await readClient(k).estimateContractGas(req).catch(() => floor); const p = est * 14n / 10n; return p > floor ? p : floor; }

async function register(r: Row) {
  const st = S!; const feeBps = Math.round(+st.fee * 100), roy = Math.round(+st.roy * 100);
  r.busy = 'Registering with MultiSea (sign in with your wallet)…'; paint();
  await api(`/revshare/${st.slug}/vaults`, { auth: true, body: { chain: r.k, vault: r.vault, feeShareBps: feeBps, royaltyBps: roy, acceptedTerms: true } });
  r.registered = true; r.busy = ''; r.err = '';
  const info = await fetch(`${API}/revshare/${st.slug}`).then(x => x.json()).catch(() => null); st.cfg = info?.config || st.cfg;
}
function validate(): string | null {
  const st = S!; const fee = +st.fee, roy = +st.roy;
  if (!wallet.address || !wallet.provider) return 'Connect your wallet first.';
  if (!(fee >= 0 && fee <= st.cap)) return `Fee share must be 0–${st.cap}%.`;
  if (!(roy >= 0 && roy <= 10)) return 'Creator royalty must be 0–10%.';
  if (!st.terms) return 'Please accept the revenue-share terms first.';
  if (!(/^\d{1,7}$/.test(st.supply) && +st.supply > 0)) return 'Enter the collection supply.';
  if (!/^\d{1,9}$/.test(st.firstId)) return 'Enter the first token ID (0 or 1).';
  return null;
}
async function act(a: string, k: string) {
  const st = S; if (!st || st.busy) return; const r = st.rows.find(x => x.k === k); if (!r) return;
  st.msg = ''; r.err = ''; r.tx = '';
  try {
    if (a === 'deploy' || a === 'register') { const bad = validate(); if (bad) { st.msg = `<span class="err">${esc(bad)}</span>`; paint(); return; } }
    st.busy = true;
    const me = wallet.address as Address;
    if (a === 'deploy') {
      r.busy = 'Switching chain…'; paint(); await ensureChain(k);
      const pc = readClient(k); const req = { address: r.factory!, abi: FACTORY_ABI, functionName: 'createVault', args: [r.collection, BigInt(st.supply), BigInt(st.firstId)], account: me } as any;
      r.busy = 'Simulating on-chain…'; paint();
      try { await pc.simulateContract(req); } catch (e: any) { throw new Error(`Deploying the vault would fail on ${chains[k].name}: ${String(friendly(e, k) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 200)} (only the collection's owner() wallet can create its vault). No transaction was sent.`); }
      r.busy = 'Confirm the vault deployment in your wallet…'; paint();
      const hash = await wc(k).writeContract({ ...req, chain: vchain(k), gas: await bufferedGas(k, req, 400_000n) });
      r.tx = hash; r.busy = 'Waiting for confirmation…'; paint();
      const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('Vault deployment reverted.');
      r.vault = await pc.readContract({ address: r.factory!, abi: FACTORY_ABI, functionName: 'vaultOf', args: [r.collection] } as any) as Address;
      r.stats = await readVault(k, r.vault); r.busy = ''; paint();
      await register(r);
    } else if (a === 'register') { await register(r); }
    else if (a === 'pc' || a === 'pd') {
      if (!r.vault || !r.stats) return; r.busy = 'Switching chain…'; paint(); await ensureChain(k);
      const fn = a === 'pc' ? 'setClaimsPaused' : 'setDepositsPaused'; const next = a === 'pc' ? !r.stats.claimsPaused : !r.stats.depositsPaused;
      const pc = readClient(k); const req = { address: r.vault, abi: VAULT_ABI, functionName: fn, args: [next], account: me } as any;
      await pc.simulateContract(req).catch((e: any) => { throw new Error(`That change would fail (${String(friendly(e, k) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 160)}). Nothing was sent.`); });
      r.busy = 'Confirm in your wallet…'; paint();
      const hash = await wc(k).writeContract({ ...req, chain: vchain(k), gas: await bufferedGas(k, req, 80_000n) });
      await pc.waitForTransactionReceipt({ hash }); r.tx = hash;
    }
    if (r.vault) r.stats = await readVault(k, r.vault);
    r.busy = '';
  } catch (e: any) { r.err = errText(e, k); r.busy = ''; }
  st.busy = false; paint();
}

export function bindRevshareFounder(root: HTMLElement) {
  root.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rsvf="fund"]'); if (b) { e.preventDefault(); fund(b.dataset.chain!); } });
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; const k = t.dataset.rsvfAmt; if (!k || !S) return; const r = S.rows.find(x => x.k === k); if (r) r.famt = t.value.trim(); });
  root.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rsv]'); if (b) { e.preventDefault(); act(b.dataset.rsv!, b.dataset.chain!); } });
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; const k = t.dataset.rsvi; if (!S || !k) return; if (k === 'terms') return; (S as any)[k] = t.value.trim(); });
  root.addEventListener('change', e => { const t = e.target as HTMLInputElement; if (S && t.dataset.rsvi === 'terms') S.terms = t.checked; });
}
