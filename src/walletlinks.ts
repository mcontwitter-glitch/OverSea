// Multi-wallet profiles (worker/src/walletlink.js): a profile = its primary EVM wallet + up to 10 linked wallets (EVM or Solana).
import { API } from './wallet';
export type LinkedWallet = { addr: string; kind: 'evm' | 'sol'; linkedAt: number };
export type ProfileWallets = { profile: string; wallets: LinkedWallet[] };
export const MAX_LINKED = 10;
const cache = new Map<string, { t: number; v: Promise<ProfileWallets | null> }>();
const key = (a: string) => (a.startsWith('0x') ? a.toLowerCase() : a);
/** Profile + linked wallets of any address (a linked wallet resolves to its profile). null = API unavailable. */
export function profileWallets(addr: string, fresh = false): Promise<ProfileWallets | null> {
  const k = key(addr), hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.t < 60_000) return hit.v;
  const v = fetch(`${API}/profile/wallets/${k}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  cache.set(k, { t: Date.now(), v }); v.then(x => { if (!x) cache.delete(k); });
  return v;
}
export function forgetWallets() { cache.clear(); }
/** address -> profile primary for the linked ones (and primaries that have links). Batched by 100. */
export async function resolveProfiles(addrs: string[]): Promise<Record<string, string>> {
  const list = [...new Set(addrs.map(key))], out: Record<string, string> = {};
  const parts: string[][] = []; for (let i = 0; i < list.length; i += 100) parts.push(list.slice(i, i + 100));
  // Chunks run in parallel (was one after another, ~0.7s each).
  await Promise.all(parts.map(async part => {
    try { const r = await fetch(`${API}/profile/resolve?addresses=${part.join(',')}`); if (r.ok) Object.assign(out, (await r.json()).map || {}); } catch { /* unmerged rows */ }
  }));
  return out;
}
async function call(method: 'GET' | 'POST', path: string, body?: any) {
  const r = await fetch(API + path, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error || `API ${r.status}`); return j;
}
/** Step 1: the profile wallet authorizes adding a wallet (one-time code, 10 minutes). */
export async function authorizeLink(profile: string, signProfile: (m: string) => Promise<string>) {
  const n = await call('GET', `/profile/link/nonce?profile=${profile.toLowerCase()}`);
  await call('POST', '/profile/link/authorize', { nonce: n.nonce, profileSignature: await signProfile(n.confirm) });
  return n.nonce as string;
}
/** Step 2: the new wallet signs a message naming the profile and the code. */
export async function finishLink(nonce: string, walletAddr: string, signWallet: (m: string) => Promise<string>): Promise<ProfileWallets> {
  const { message } = await call('GET', `/profile/link/message?nonce=${nonce}&wallet=${key(walletAddr)}`);
  const r = await call('POST', '/profile/link', { nonce, wallet: key(walletAddr), walletSignature: await signWallet(message) }); forgetWallets(); return r;
}
/** Unlink, signed by the profile wallet or by the linked wallet itself (`by`). */
export async function unlinkWallet(profile: string, walletAddr: string, by: string, sign: (m: string) => Promise<string>): Promise<ProfileWallets> {
  const n = await call('GET', `/profile/unlink/nonce?profile=${profile.toLowerCase()}&wallet=${key(walletAddr)}&by=${key(by)}`);
  const r = await call('POST', '/profile/unlink', { nonce: n.nonce, signature: await sign(n.message) }); forgetWallets(); return r;
}
