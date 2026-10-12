// Sign-In With Ethereum (EIP-4361) against the MultiSea Worker. Session token kept in sessionStorage.
import { createSiweMessage } from 'viem/siwe';
import { wallet, API, openConnect } from './wallet';
const KEY = 'multisea-session';
type Sess = { token: string; address: string; isAdmin: boolean; exp: number };
export function getSession(): Sess | null {
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && s.exp > Date.now() && s.address === wallet.address?.toLowerCase()) return s; } catch {}
  return null;
}
export async function signIn(statement = 'Sign in to MultiSea'): Promise<Sess> {
  if (!wallet.address) { openConnect(); throw new Error('Connect a wallet first'); }
  const cur = getSession(); if (cur) return cur;
  const { nonce } = await (await fetch(API + '/auth/nonce')).json();
  const chainId = parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16) || 1;
  const message = createSiweMessage({ domain: location.host, address: wallet.address as `0x${string}`, statement, uri: location.origin, version: '1', chainId, nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 8 * 3600e3) });
  const signature = await wallet.provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
  const r = await fetch(API + '/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Sign-in failed');
  const s = { token: j.token, address: j.address, isAdmin: j.isAdmin, exp: Date.now() + j.expiresIn * 1000 };
  sessionStorage.setItem(KEY, JSON.stringify(s)); return s;
}
const toHex = (s: string) => '0x' + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
export async function api(path: string, opts: { method?: string; body?: any; raw?: Blob; auth?: boolean } = {}) {
  const h: Record<string, string> = {};
  if (opts.auth) { const s = await signIn(); h.authorization = 'Bearer ' + s.token; }
  if (opts.body) h['content-type'] = 'application/json';
  if (opts.raw) h['content-type'] = opts.raw.type;
  const r = await fetch(API + path, { method: opts.method || (opts.body || opts.raw ? 'POST' : 'GET'), headers: h, body: opts.raw || (opts.body ? JSON.stringify(opts.body) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && opts.auth) sessionStorage.removeItem(KEY);
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
}
// Re-encode any picked image to WebP (max dimension) in the browser before upload (Worker re-validates type/size/dims).
export async function uploadImage(file: File, max: number): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('Images only');
  if (file.size > 15 * 1024 * 1024) throw new Error('Image too large');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.86, blob: Blob | null = null;
  for (; q > 0.4; q -= 0.12) { blob = await new Promise(r => c.toBlob(r, 'image/webp', q)); if (blob && blob.size <= 1.9 * 1024 * 1024) break; }
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('Could not compress under 2MB');
  const j = await api('/media', { raw: blob, auth: true }); return j.url;
}
