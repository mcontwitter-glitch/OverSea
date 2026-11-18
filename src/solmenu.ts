// Solana parts of the shared wallet UI. ADD-ONLY: the EVM connect window, EVM wallet menu and thirdweb Google/X EVM sign-in
// (src/wallet.ts, src/embedded.ts) render exactly as before; these functions append a Solana section / block / nav button.
import { sol, onSol, shortSol, solWalletOptions, connectSolWallet, disconnectSolWallet, restoreSol, setSol, PRIVY_ON } from './solconnect';
import { wallet, overlay, esc, API } from './wallet';
import { profileWallets } from './walletlinks';

const SOL_RPC: string = (import.meta as any).env?.VITE_SOLANA_RPC || 'https://solana-rpc.publicnode.com';
const SOL_ICON = '/logos/solana.svg';
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Solana section at the bottom of the connect window. */
export function solConnectSection() {
  const opts = solWalletOptions();
  const row = (o: ReturnType<typeof solWalletOptions>[number]) => {
    const tag = sol.id === o.id && sol.address ? '<span class="r">Connected</span>' : o.installed ? '<span class="r">Detected</span>' : `<span class="r m">${isMobile() ? 'Open app' : 'Install'}</span>`;
    return `<button class="wopt sol" data-solw="${esc(o.id)}">${o.icon ? `<img src="${esc(o.icon)}" alt="">` : '<span class="wdot"></span>'}${esc(o.name)}${tag}</button>`;
  };
  return `<div class="solsec"><div class="gh solgh"><img src="${SOL_ICON}" alt="">Solana wallets <em>new</em></div>
    ${sol.address ? `<p class="mut small">Connected: <b>${esc(sol.name)}</b> <span class="mono">${esc(shortSol(sol.address))}</span></p>` : ''}
    ${PRIVY_ON ? `<div class="socials solsoc"><button class="wopt soc sol" data-solsoc="twitter"><span class="sico">𝕏</span>Solana with X</button><button class="wopt soc sol" data-solsoc="google"><span class="sico g">G</span>Solana with Google</button></div><p class="mut small">Free Solana wallet tied to your X or Google login (Privy). Your EVM wallet stays the same.</p>` : ''}
    ${opts.map(row).join('')}
    <p class="mut small solnote">Any Solana wallet in this browser shows up here automatically. Phantom and Solflare also connect to EVM chains: pick them once per side.</p></div>`;
}
export function bindSolConnectSection(m: HTMLElement) {
  const fail = (msg: string) => { m.querySelector('.solsec .err')?.remove(); m.querySelector('.solgh')!.insertAdjacentHTML('afterend', `<p class="err">${esc(msg)}</p>`); };
  m.querySelectorAll<HTMLElement>('[data-solw]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.solw!; const o = solWalletOptions().find(x => x.id === id);
    if (o && !o.installed) { location.href = o.deep || o.url; return; }
    const was = b.innerHTML; b.innerHTML = `<span class="spin"></span> Connecting ${esc(o?.name || '')}…`;
    try { await connectSolWallet(id); m.remove(); }
    catch (e: any) { b.innerHTML = was; fail(e?.code === 4001 || /reject/i.test(e?.message || '') ? 'Connection rejected in wallet.' : e?.message || String(e)); }
  }));
  m.querySelectorAll<HTMLElement>('[data-solsoc]').forEach(b => b.addEventListener('click', async () => {
    const p = b.dataset.solsoc as 'google' | 'twitter'; b.innerHTML = `<span class="spin"></span> Opening ${p === 'google' ? 'Google' : 'X'}…`;
    try { const P = await import('./solprivy'); const r = await P.privySolana(p); setSol('privy', r.name, r.address, r.prov); m.remove(); }
    catch (e: any) { b.innerHTML = p === 'google' ? '<span class="sico g">G</span>Solana with Google' : '<span class="sico">𝕏</span>Solana with X'; fail(e?.message || String(e)); }
  }));
}

async function solBalance(a: string) {
  const r = await fetch(SOL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [a, { commitment: 'confirmed' }] }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return (j.result?.value ?? 0) / 1e9;
}
/** Linked Solana address of a profile: string, null (none), or undefined (couldn't tell: busy API / offline; retried twice). */
export async function linkedSol(evm: string): Promise<string | null | undefined> {
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try { const r = await fetch(`${API}/profile/${evm.toLowerCase()}/solana`, { cache: 'no-store' }); if (r.ok) return (await r.json()).sol || null; if (r.status < 429) return null; } catch { /* retry */ }
  }
  return undefined;
}
const solBlock = () => `<div class="acct solacct"><div class="h"><img src="${SOL_ICON}" alt="">Solana · ${esc(sol.name)}<span class="b" data-solm="link"></span></div>
  <div class="a mono">${esc(sol.address)}</div><div class="bal"><span data-solm="bal" class="mut small"><span class="spin"></span> SOL balance…</span></div></div>`;
function fillSol(m: HTMLElement) {
  const a = sol.address; const bal = m.querySelector('[data-solm=bal]') as HTMLElement | null; const lk = m.querySelector('[data-solm=link]') as HTMLElement | null;
  solBalance(a).then(v => { if (bal && sol.address === a) bal.innerHTML = `<b>${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}</b> SOL`; bal?.classList.remove('mut', 'small'); })
    .catch(() => { if (bal) bal.textContent = 'Couldn’t read SOL balance'; });
  if (lk && wallet.address) Promise.all([profileWallets(a), profileWallets(wallet.address)]).then(([x, y]) => { lk.innerHTML = x && y && x.profile === y.profile && x.wallets.some(w => w.addr === a) ? '✓ linked to profile' : `<a href="/u/${esc(wallet.address!.toLowerCase())}#add-solana">Link to profile</a>`; });
}
/** Appended to the EVM wallet menu (EVM part unchanged): Solana account + "Disconnect Solana", or a connect link. */
export function solMenuBlock(m: HTMLElement) {
  const host = m.querySelector('[data-wm=bal]'); if (!host) return;
  if (sol.address) {
    host.insertAdjacentHTML('afterend', solBlock());
    m.querySelector('[data-wm=out]')!.insertAdjacentHTML('afterend', '<button class="bbtn ghost" data-solm="out">Disconnect Solana</button>');
    m.querySelector('[data-solm=out]')!.addEventListener('click', () => { m.remove(); disconnectSolWallet(); });
    fillSol(m);
  } else {
    host.insertAdjacentHTML('afterend', `<button class="wopt sol solmini" data-solm="add"><img src="${SOL_ICON}" alt="">Connect a Solana wallet</button>`);
    m.querySelector('[data-solm=add]')!.addEventListener('click', () => { m.remove(); openSolConnect(); });
  }
}
/** Solana-only window (no EVM wallet connected, or "Connect a Solana wallet" from the menu). */
export function openSolConnect() { const m = overlay(`<h3>Connect a Solana wallet</h3>${solConnectSection()}`); bindSolConnectSection(m); }
export function openSolMenu() {
  if (!sol.address) return openSolConnect();
  const m = overlay(`<h3>Your wallets</h3>${solBlock()}
    <div style="display:grid;gap:10px;margin-top:14px"><button class="bbtn" data-solm="evm">Connect EVM wallet</button><button class="bbtn ghost" data-solm="out">Disconnect Solana</button></div>`);
  m.querySelector('[data-solm=out]')!.addEventListener('click', () => { m.remove(); disconnectSolWallet(); });
  m.querySelector('[data-solm=evm]')!.addEventListener('click', () => { m.remove(); import('./wallet').then(w => w.openConnect()); });
  fillSol(m);
}
/** Nav: a separate Solana button left of the (unchanged) EVM wallet button, only while a Solana wallet is connected. */
export const solNavHtml = () => `<button class="wbtn on wsol" data-act="solwallet" ${sol.address ? '' : 'hidden'}><img src="${SOL_ICON}" width="14" height="14" alt="">${esc(shortSol(sol.address))}</button>`;
const syncNav = () => document.querySelectorAll<HTMLElement>('[data-act="solwallet"]').forEach(b => { b.outerHTML = solNavHtml(); });

let inited = false;
export function initSol() {
  if (inited) return; inited = true;
  onSol(syncNav);
  document.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-act="solwallet"]'); if (!b) return; e.preventDefault(); e.stopPropagation(); openSolMenu(); }, true);
  if (PRIVY_ON && /[?&]privy_oauth_code=/.test(location.search)) {
    import('./solprivy').then(P => P.completePrivyRedirect()).then(r => { if (r) setSol('privy', r.name, r.address, r.prov); })
      .catch(e => overlay(`<h3>Solana sign-in failed</h3><p class="err">${esc(e?.message || String(e))}</p><button class="bbtn mx">Close</button>`));
  } else restoreSol();
}
