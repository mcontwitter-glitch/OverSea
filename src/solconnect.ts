// Solana wallet connection, ADD-ONLY next to the EVM wallet (src/wallet.ts is untouched by it): Phantom and Solflare
// (injected providers), every other Solana wallet in the browser through the Wallet Standard (Backpack, OKX, Glow, …),
// and, when configured, Google/X sign-in with an embedded Solana wallet (src/solprivy.ts, VITE_PRIVY_APP_ID).
// No @solana/web3.js here: it is loaded on every page (nav + connect window). Transactions are signed through the same
// provider object by src/solwallet.ts.
import { walletBrowseLink, detectSolflare, isSolMobile } from './soldetect';
export type SolProv = {
  publicKey?: { toBase58(): string } | null;
  connect(o?: { onlyIfTrusted?: boolean }): Promise<unknown>;
  disconnect?(): Promise<void>;
  signTransaction(tx: any): Promise<any>;
  signAllTransactions?(txs: any[]): Promise<any[]>;
  signMessage?(m: Uint8Array, enc?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
};
export type SolOpt = { id: string; name: string; icon: string; installed: boolean; url: string; deep?: string };
const W = window as any;
const LAST = 'msea-sol-wallet';
export const PRIVY_ON = !!(import.meta as any).env?.VITE_PRIVY_APP_ID;
export const sol = { id: '', name: '', address: '', prov: null as SolProv | null };
const subs: (() => void)[] = [];
export const onSol = (f: () => void) => { subs.push(f); };
const emit = () => subs.forEach(f => { try { f(); } catch {} });
export const shortSol = (a: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const isMobile = () => isSolMobile(navigator.userAgent, navigator.maxTouchPoints || 0);

// ---- Wallet Standard discovery (https://github.com/wallet-standard/wallet-standard): wallets register with the app
const std = new Map<string, any>();
const register = (...ws: any[]) => { for (const w of ws) if (w?.name && (w.chains || []).some((c: string) => c.startsWith('solana:')) && w.features?.['standard:connect']) std.set(w.name, w); return () => {}; };
try {
  window.addEventListener('wallet-standard:register-wallet', (e: any) => { try { e.detail?.({ register }); } catch {} });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
} catch { /* very old browsers */ }

/** Wallet Standard wallet -> the provider shape the rest of the site uses. */
function fromStd(w: any): SolProv {
  let acct: any = null; const b58 = (u: Uint8Array) => B58.enc(u);
  const p: SolProv = {
    publicKey: null,
    async connect() { const r = await w.features['standard:connect'].connect(); acct = (r?.accounts || w.accounts || [])[0];
      if (!acct) throw new Error(`${w.name} did not share an address.`); const a = typeof acct.address === 'string' ? acct.address : b58(acct.publicKey); p.publicKey = { toBase58: () => a }; },
    async disconnect() { await w.features['standard:disconnect']?.disconnect?.().catch(() => {}); },
    async signTransaction(tx: any) { const f = w.features['solana:signTransaction']; if (!f) throw new Error(`${w.name} cannot sign transactions here.`);
      const [o] = await f.signTransaction({ account: acct, chain: 'solana:mainnet', transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) });
      return tx.constructor.from(o.signedTransaction); },
    async signAllTransactions(txs: any[]) { const f = w.features['solana:signTransaction']; if (!f) throw new Error(`${w.name} cannot sign transactions here.`);
      const outs = await f.signTransaction(...txs.map(tx => ({ account: acct, chain: 'solana:mainnet', transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) })));
      return outs.map((o: any, i: number) => txs[i].constructor.from(o.signedTransaction)); },
    async signMessage(m: Uint8Array) { const f = w.features['solana:signMessage']; if (!f) throw new Error(`${w.name} cannot sign messages.`);
      const [o] = await f.signMessage({ account: acct, message: m }); return { signature: o.signature }; },
  };
  return p;
}
const B58 = { A: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  enc(u: Uint8Array) { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = this.A[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; } };

const injected: Record<string, { name: string; get: () => SolProv | undefined; url: string; deep: () => string; icon: string }> = {
  phantom: { name: 'Phantom', get: () => W.phantom?.solana, url: 'https://phantom.app/', deep: () => walletBrowseLink('phantom', location.href, location.origin),
    icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#ab9ff2"/><text x="14" y="19.5" font-family="Arial" font-weight="900" font-size="15" fill="#fff" text-anchor="middle">P</text></svg>') },
  solflare: { name: 'Solflare', get: () => detectSolflare(W), url: 'https://solflare.com/', deep: () => walletBrowseLink('solflare', location.href, location.origin),
    icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fc7227"/><stop offset="1" stop-color="#fec80b"/></linearGradient></defs><rect width="28" height="28" rx="7" fill="url(#g)"/><text x="14" y="19.5" font-family="Arial" font-weight="900" font-size="15" fill="#111" text-anchor="middle">S</text></svg>') },
};
/** Phantom + Solflare always (installed or "open app"), then any other Wallet Standard Solana wallet in this browser. */
export function solWalletOptions(): SolOpt[] {
  const out: SolOpt[] = Object.entries(injected).map(([id, x]) => {
    const s = std.get(x.name); const installed = !!x.get() || !!s;
    return { id, name: x.name, icon: s?.icon || x.icon, installed, url: x.url, deep: isMobile() && !installed ? x.deep() : undefined };
  });
  for (const [name, w] of std) if (!Object.values(injected).some(x => x.name === name)) out.push({ id: 'std:' + name, name, icon: w.icon || '', installed: true, url: '' });
  return out;
}
function provOf(id: string): SolProv | undefined {
  if (id.startsWith('std:')) { const w = std.get(id.slice(4)); return w ? fromStd(w) : undefined; }
  const x = injected[id]; if (!x) return undefined;
  return x.get() || (std.get(x.name) ? fromStd(std.get(x.name)) : undefined);
}
export async function connectSolWallet(id: string, silent = false): Promise<string> {
  if (id === 'privy') { const P = await import('./solprivy'); const r = await P.privySolana(); return setSol('privy', r.name, r.address, r.prov); }
  if (silent && id === 'solflare') throw new Error('no silent connect'); // Solflare would open a popup
  if (silent && id.startsWith('std:') && !(std.get(id.slice(4))?.accounts || []).length) throw new Error('not authorized yet');
  const p = provOf(id); const name = id.startsWith('std:') ? id.slice(4) : injected[id]?.name || id;
  if (!p) { if (silent) throw new Error('not installed'); const o = solWalletOptions().find(x => x.id === id); location.href = o?.deep || o?.url || 'https://phantom.app/'; throw new Error(`${name} is not installed in this browser.`); }
  await p.connect(silent ? { onlyIfTrusted: true } : undefined);
  const a = p.publicKey?.toBase58(); if (!a) throw new Error(`${name} did not share an address.`);
  return setSol(id, name, a, p);
}
export function setSol(id: string, name: string, address: string, prov: SolProv) {
  Object.assign(sol, { id, name, address, prov }); localStorage.setItem(LAST, id); emit(); return address;
}
export async function disconnectSolWallet() {
  const id = sol.id; await sol.prov?.disconnect?.().catch(() => {}); if (id === 'privy') await import('./solprivy').then(P => P.privyLogout()).catch(() => {});
  Object.assign(sol, { id: '', name: '', address: '', prov: null }); localStorage.removeItem(LAST); emit();
}
/** Sign a UTF-8 text message with the connected Solana wallet; returns the 64-byte ed25519 signature. */
export async function signSolMessage(text: string): Promise<Uint8Array> {
  if (!sol.prov?.signMessage) throw new Error(`${sol.name || 'This wallet'} cannot sign messages.`);
  const r: any = await sol.prov.signMessage(new TextEncoder().encode(text), 'utf8');
  const s = r instanceof Uint8Array ? r : r?.signature; if (!(s instanceof Uint8Array) && !Array.isArray(s)) throw new Error('The wallet returned no signature.');
  return Uint8Array.from(s as ArrayLike<number>);
}
/** Reconnect the last wallet without a prompt (Phantom/Solflare "trusted" apps; Privy session). */
export function restoreSol() {
  const id = localStorage.getItem(LAST); if (!id || sol.address) return;
  const go = () => connectSolWallet(id, true).catch(() => { if (id !== 'privy' && !provOf(id)) return; });
  if (id === 'privy') { if (PRIVY_ON) go(); return; }
  setTimeout(go, 300); // injected providers / Wallet Standard registrations arrive shortly after load
}
