// Wallet connect (EIP-6963 discovery + window.ethereum fallback) and OpenSea buy flow via the multisea Worker.
import { createWalletClient, createPublicClient, custom, http, fallback, defineChain, parseAbiItem, encodeFunctionData, concat, formatUnits, type Hex, type Chain as VChain } from 'viem';
import CFG from '../config/collections.json';
import APP from '../config/app.json';
import { embeddedConfigured } from './embedded';

type P6963 = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: any };
type ChainCfg = { rpcs?: string[]; name: string; chainId: number; rpc: string; native: string; openseaSlug: string | null; explorer: string };
const chains = CFG.chains as Record<string, ChainCfg>;
export const API: string = (import.meta.env.VITE_API_BASE as string) || APP.apiBase || '';
export const wallet = { address: null as string | null, provider: null as any, name: '' };
export let apiReady = false;
export let apiFeatures: string[] = [];
const listeners: (() => void)[] = [];
export const onWallet = (f: () => void) => listeners.push(f);
const emit = () => listeners.forEach(f => f());
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
export const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---- API health. Optimistic: features that are live render enabled; a real error only shows if the action itself fails.
// /health is retried with backoff (3 tries over ~15s), then re-checked on window focus / back online.
export let apiReachable: boolean | null = null;
const LIVE_FEATURES = ['buy', 'siwe', 'submit', 'admin', 'edit', 'sell', 'native', 'media'];
apiReady = !!API; apiFeatures = API ? [...LIVE_FEATURES] : [];
const upListeners: (() => void)[] = [];
export const onApiUp = (f: () => void) => { upListeners.push(f); };
let inflight: Promise<boolean> | null = null; let rechecking = false;
async function probe(timeout: number) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try { const r = await fetch(API + '/health', { signal: ac.signal, cache: 'no-store' }); if (!r.ok) return false; const j = await r.json().catch(() => ({})); if (Array.isArray(j.features) && j.features.length) apiFeatures = j.features; return true; }
  catch { return false; } finally { clearTimeout(t); }
}
export function checkApi(): Promise<boolean> {
  if (!API) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = (async () => {
    const was = apiReachable;
    for (const [i, t] of [5000, 5000, 6000].entries()) { if (i) await new Promise(r => setTimeout(r, i * 1500)); if (await probe(t)) { apiReachable = true; break; } apiReachable = false; }
    if (!apiReachable) { console.warn('[MultiSea] API /health unreachable (ad-blocker or network?). Actions stay enabled; will re-check on focus.'); armRecheck(); }
    emit(); if (apiReachable && was === false) upListeners.forEach(f => { try { f(); } catch {} });
    inflight = null; return !!apiReachable;
  })();
  return inflight;
}
function armRecheck() {
  if (rechecking) return; rechecking = true;
  const go = () => { if (apiReachable) return; checkApi(); };
  window.addEventListener('focus', go); window.addEventListener('online', go); document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
}
export const API_DOWN_MSG = "Couldn't reach MultiSea. Check ad-blockers or privacy extensions (allow api.multisea.io) and your connection, then try again.";

// ---- EIP-6963 discovery ----
const found = new Map<string, P6963>();
// Silent reconnect across page loads (MultiSea uses full-page navigation): remember the wallet's rdns, use eth_accounts (no prompt).
const LAST = 'multisea-wallet';
async function tryRestore(p: P6963) {
  if (wallet.address || localStorage.getItem(LAST) !== p.info.rdns) return;
  try { const a: string[] = await p.provider.request({ method: 'eth_accounts' }); if (a?.[0]) { wallet.address = a[0]; wallet.provider = p.provider; wallet.name = p.info.name; p.provider.on?.('accountsChanged', (x: string[]) => { wallet.address = x[0] || null; emit(); }); emit(); } } catch {}
}
window.addEventListener('eip6963:announceProvider', (e: any) => { found.set(e.detail.info.uuid, e.detail); tryRestore(e.detail); });
// Embedded (social) wallet: restore silently if that's what the user signed in with last time.
export function setWallet(address: string, provider: any, name: string, rdns: string) {
  wallet.address = address; wallet.provider = provider; wallet.name = name; localStorage.setItem(LAST, rdns);
  provider.on?.('accountsChanged', (a: string[]) => { wallet.address = a[0] || null; emit(); }); emit();
}
if (embeddedConfigured && localStorage.getItem(LAST) === 'embedded') import('./embedded').then(m => m.restoreSocial()).then(r => { if (r && !wallet.address) setWallet(r.address, r.provider, r.name, 'embedded'); }).catch(() => {});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function providers(): P6963[] {
  const list = [...found.values()];
  const eth = (window as any).ethereum;
  if (!list.length && eth) list.push({ info: { uuid: 'injected', name: eth.isMetaMask ? 'MetaMask' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet', icon: '', rdns: 'injected' }, provider: eth });
  return list;
}
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function overlay(html: string) {
  document.querySelector('.wov')?.remove();
  const m = document.createElement('div'); m.className = 'modal wov';
  m.innerHTML = `<div class="wbox"><button class="x mx">✕</button>${html}</div>`;
  m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) m.remove(); });
  document.body.appendChild(m); return m;
}

export function openConnect() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => {
    const list = providers();
    const here = location.href.replace(/^https?:\/\//, '');
    const deep = `<div class="gh">Open in a wallet app</div>
      <a class="wopt" href="https://metamask.app.link/dapp/${here}"><img src="/logos/metamask.svg" alt="">MetaMask app</a>
      <a class="wopt" href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}"><img src="/logos/coinbase.svg" alt="">Coinbase Wallet app</a>`;
    const m = overlay(`<h3>Connect wallet</h3>
      <div class="gh">New to crypto? Sign in</div>
      <div class="socials"><button class="wopt soc" data-social="x"><span class="sico">𝕏</span>Sign in with X</button><button class="wopt soc" data-social="google"><span class="sico g">G</span>Sign in with Google</button></div>
      ${embeddedConfigured ? '<p class="mut small">Creates a free embedded wallet for you. No seed phrase, works on every MultiSea chain.</p>' : '<p class="setup small"><b>Setup needed (admin):</b> add a thirdweb Client ID as <code>VITE_THIRDWEB_CLIENT_ID</code> to enable social sign-in.</p>'}
      <div class="gh">Or connect a wallet</div>
      ${list.length ? list.map(p => `<button class="wopt" data-uuid="${esc(p.info.uuid)}">${p.info.icon ? `<img src="${esc(p.info.icon)}" alt="">` : '<span class="wdot"></span>'}${esc(p.info.name)}</button>`).join('') : `<p class="mut">No browser wallet detected${isMobile() ? '. Open this page in your wallet app:' : '. Install MetaMask, Rabby, Coinbase Wallet or OKX.'}</p>`}
      ${isMobile() || !list.length ? deep : ''}`);
    m.querySelectorAll('[data-social]').forEach(b => b.addEventListener('click', async () => {
      const s = (b as HTMLElement).dataset.social as 'x' | 'google'; m.querySelector('.err')?.remove();
      if (!embeddedConfigured) { (m.querySelector('.socials') as HTMLElement).insertAdjacentHTML('afterend', `<p class="err">Social sign-in isn't enabled yet. Admin: create a thirdweb project, enable X + Google auth and set VITE_THIRDWEB_CLIENT_ID.</p>`); return; }
      (b as HTMLElement).innerHTML = '<span class="spin"></span> Opening ' + (s === 'x' ? 'X' : 'Google') + '…';
      try { const r = await (await import('./embedded')).connectSocial(s); m.remove(); setWallet(r.address, r.provider, r.name, 'embedded'); }
      catch (e: any) { (m.querySelector('.socials') as HTMLElement).insertAdjacentHTML('afterend', `<p class="err">${esc(e?.message || e)}</p>`); (b as HTMLElement).textContent = s === 'x' ? 'Sign in with X' : 'Sign in with Google'; }
    }));
    m.querySelectorAll('[data-uuid]').forEach(b => b.addEventListener('click', async () => {
      const p = list.find(x => x.info.uuid === (b as HTMLElement).dataset.uuid)!;
      try {
        const accts: string[] = await p.provider.request({ method: 'eth_requestAccounts' });
        wallet.address = accts[0]; wallet.provider = p.provider; wallet.name = p.info.name; localStorage.setItem(LAST, p.info.rdns);
        p.provider.on?.('accountsChanged', (a: string[]) => { wallet.address = a[0] || null; emit(); });
        m.remove(); emit();
      } catch (e: any) { (m.querySelector('h3') as HTMLElement).insertAdjacentHTML('afterend', `<p class="err">${esc(e?.code === 4001 ? 'Connection rejected in wallet.' : e?.message || e)}</p>`); }
    }));
  }, 150);
}
export function disconnect() { if (localStorage.getItem(LAST) === 'embedded') import('./embedded').then(m => m.logoutSocial()); localStorage.removeItem(LAST); wallet.address = null; wallet.provider = null; emit(); }
export const walletLabel = () => (wallet.address ? short(wallet.address) : 'Connect wallet');

// ---- chains ----
const byOs: Record<string, string> = {}; Object.entries(chains).forEach(([k, c]) => { if (c.openseaSlug) byOs[c.openseaSlug] = k; });
export function vchain(k: string): VChain {
  const c = chains[k];
  return defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } }, blockExplorers: { default: { name: 'Explorer', url: c.explorer } } });
}
// Browser chain reads: MultiSea Worker RPC proxy (server-side fallback across public RPCs) first, then the public RPCs
// directly, then the connected wallet's own provider when it is on that chain. Retries on each.
const readCache: Record<string, any> = {};
export function readClient(k: string) {
  if (readCache[k]) return readCache[k];
  const c = chains[k]; const direct: string[] = c.rpcs?.length ? c.rpcs : [c.rpc];
  const viaWallet = custom({ async request(a: any) {
    if (!wallet.provider) throw new Error('no wallet');
    if (parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16) !== c.chainId) throw new Error('wallet on another chain');
    try { return await wallet.provider.request(a); } catch (e: any) { if (e?.code === 3 || /revert/i.test(e?.message || '')) throw e; throw new Error('RPC Request failed (wallet provider): ' + (e?.message || e)); }
  } }, { retryCount: 0 });
  return (readCache[k] = createPublicClient({ chain: vchain(k), transport: fallback([http(`${API}/rpc/${k}`, { timeout: 15_000, retryCount: 2, retryDelay: 400 }), ...direct.slice(0, 3).map(u => http(u, { timeout: 10_000, retryCount: 1 })), viaWallet]) }));
}
// Bulk reads (big multicalls, e.g. ownerOf sweeps): public RPCs only. They exceed the Worker proxy's 64 KB body cap and
// would count toward the visitor's per-IP Worker rate limit, which listings / buy checks share.
const bulkCache: Record<string, any> = {};
export function bulkClient(k: string) {
  if (bulkCache[k]) return bulkCache[k];
  const c = chains[k]; const direct: string[] = c.rpcs?.length ? c.rpcs : [c.rpc];
  return (bulkCache[k] = createPublicClient({ chain: vchain(k), transport: fallback(direct.slice(0, 3).map(u => http(u, { timeout: 15_000, retryCount: 1 }))) }));
}
export async function ensureChain(k: string) {
  const c = chains[k]; const hex = '0x' + c.chainId.toString(16);
  const cur = parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16);
  if (cur === c.chainId) return;
  try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e: any) {
    if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '')) {
      await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }] });
    } else throw e;
  }
  const now = parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16);
  if (now !== c.chainId) throw Object.assign(new Error(`Please switch your wallet to ${c.name}.`), { kind: 'wrong-chain' });
}

// ---- buy ----
export type BuyItem = { id: number; name: string; img: string; chain: string; contract: string; listing: { orderHash: string; protocolAddress: string; osChain?: string } };
const toArr = (v: any): any => (Array.isArray(v) ? v.map(toArr) : v && typeof v === 'object' ? Object.values(v).map(toArr) : v);
const RPC_FAIL = /RPC Request failed|HTTP request failed|Failed to fetch|fetch failed|NetworkError|Load failed|timed? ?out|TimeoutError|all RPCs failed|rate limit|429|50[234]|Network request failed/i;
function chainOfErr(e: any, m: string): string | undefined {
  const all = [m, e?.message, e?.details, e?.cause?.message, e?.url].filter(Boolean).join(' ');
  const viaProxy = all.match(/\/rpc\/([a-z]+)/)?.[1]; if (viaProxy && chains[viaProxy]) return chains[viaProxy].name;
  for (const k of Object.keys(chains)) for (const u of (chains[k].rpcs || [chains[k].rpc])) { try { if (all.includes(new URL(u).host)) return chains[k].name; } catch {} }
}
export function friendly(e: any, chainKey?: string): string {
  try { console.error('[MultiSea]', e); } catch {}
  if (e instanceof TypeError && /Failed to fetch|NetworkError|Load failed|fetch/i.test(e.message)) return API_DOWN_MSG;
  if (e?.name === 'AbortError') return API_DOWN_MSG;
  const m = String(e?.shortMessage || e?.details || e?.message || e);
  const full = m + ' ' + String(e?.message || '') + ' ' + String(e?.details || '');
  if (!(e?.code === 4001) && !/user rejected|denied/i.test(full) && (RPC_FAIL.test(full) || e?.name === 'HttpRequestError' || e?.name === 'TimeoutError' || /ContractFunctionExecutionError/.test(String(e?.name)) && RPC_FAIL.test(String(e?.cause?.message || e?.cause?.shortMessage || '')))) {
    const n = (chainKey && chains[chainKey]?.name) || chainOfErr(e, full); return `Couldn't reach the ${n || 'blockchain'} network. Please try again in a moment.`;
  }
  if (e?.code === 4001 || /user rejected|denied|rejected the request/i.test(m)) return 'You rejected the request in your wallet.';
  if (/insufficient funds|exceeds balance/i.test(m)) return 'Insufficient funds for price + gas on this chain.';
  if (e?.kind === 'wrong-chain' || /chain mismatch|does not match the target chain/i.test(m)) return 'Wrong network. Switch your wallet to the listing’s chain and try again.';
  if (e?.kind === 'stale') return m;
  return m.split('\n')[0].replace(/\s*(Request body|URL|Raw Call Arguments|Contract Call|Docs|Version):.*$/s, '').slice(0, 200);
}

export async function startBuy(it: BuyItem, onSold: (id: number) => void, onGone: (id: number) => void) {
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const os = c.openseaSlug!;
  const m = overlay(`<div class="bhead"><img src="${esc(it.img)}" alt=""><div><div class="mut">${esc(c.name)}</div><h3>${esc(it.name)}</h3></div></div><div class="bbody"><div class="spin"></div> Checking listing on OpenSea…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    // 1) refresh live listing
    const lres = await fetch(`${API}/listings/${os}/${it.contract}/${it.id}`);
    if (!lres.ok) throw Object.assign(new Error(lres.status === 429 ? 'MultiSea is busy right now (rate limited). Wait a few seconds and try again.' : `Could not check the listing (MultiSea API ${lres.status}). Try again.`), { kind: 'api' });
    const lr = await lres.json();
    const L = lr.listing;
    if (!L) { onGone(it.id); throw Object.assign(new Error('This listing is no longer valid (sold, cancelled or expired).'), { kind: 'stale' }); }
    // 2) chain
    body.innerHTML = `<div class="spin"></div> Switching wallet to ${esc(c.name)}…`;
    await ensureChain(it.chain);
    // 3) fulfillment data
    body.innerHTML = `<div class="spin"></div> Preparing order…`;
    const fr = await fetch(`${API}/fulfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: L.orderHash, chain: os, protocolAddress: L.protocolAddress, fulfiller: wallet.address }) });
    const fj = await fr.json();
    if (!fr.ok) { if (fr.status === 409) onGone(it.id); throw Object.assign(new Error(fr.status === 409 ? 'This listing is no longer valid on OpenSea.' : `OpenSea: ${fj.message || fj.error || 'could not prepare order'}`), { kind: 'stale' }); }
    const tx = fj.transaction;
    const abi = parseAbiItem('function ' + tx.function) as any;
    let data = encodeFunctionData({ abi: [abi], functionName: abi.name, args: Object.values(tx.input_data).map(toArr) });
    if (tx.calldata_suffix) data = concat([data, tx.calldata_suffix as Hex]);
    const value = BigInt(tx.value || 0);
    const pub = readClient(it.chain);
    const bal = await pub.getBalance({ address: wallet.address as Hex });
    const dec = L.price?.decimals ?? 18, cur = L.price?.currency || c.native;
    const price = BigInt(L.price?.value || value);
    const fees = (L.fees || []).reduce((s: bigint, f: any) => s + BigInt(f.amount), 0n);
    const f = (x: bigint) => (+formatUnits(x, dec)).toLocaleString(undefined, { maximumFractionDigits: 6 });
    const fn = (x: bigint) => (+formatUnits(x, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
    // Simulate the exact purchase on this chain (price + real gas) before the wallet ever sees it.
    const { preflight, assertSendable } = await import('./txgas');
    const pre = await preflight(it.chain, { to: tx.to, data, value }, bal);
    if (pre.reverted) { assertSendable(it.chain, pre, value); }
    const enough = pre.enough;
    // 4) confirm screen
    body.innerHTML = `<div class="kv bkv"><span>Price</span><b>${f(price)} ${esc(cur)}</b>
      <span>Includes fees</span><b>${f(fees)} ${esc(cur)}</b><span>Seller receives</span><b>${f(price - fees)} ${esc(cur)}</b>
      <span>Chain</span><b><img class="cl" src="/logos/${it.chain}.svg" alt=""> ${esc(c.name)}</b>
      <span>You pay now</span><b>${fn(value)} ${esc(c.native)} + gas</b>
      <span>Network gas (est.)</span><b>~${fn(pre.costWei)} ${esc(c.native)}</b>
      <span>Your balance</span><b class="${enough ? '' : 'errc'}">${fn(bal)} ${esc(c.native)}</b></div>
      ${enough ? '' : `<p class="err">Not enough ${esc(c.native)} on ${esc(c.name)}: you need about ${fn(value + pre.costWei)} ${esc(c.native)} (price + gas), short ${fn(pre.short)}.</p><button class="bbtn ghost xpay">Pay with ${esc(c.native)} from another chain</button>`}
      <p class="mut small">Fulfilled through OpenSea's Seaport 1.6 contract. You'll confirm in ${esc(wallet.name || 'your wallet')}.</p>
      <button class="bbtn go" ${enough ? '' : 'disabled'}>Confirm purchase</button>`;
    await new Promise<void>((res, rej) => {
      body.querySelector('.go')!.addEventListener('click', () => res());
      body.querySelector('.xpay')?.addEventListener('click', () => { m.remove(); import('./xpay').then(x => x.openXPay({ it, price, currency: cur, tx, orders: fj.orders, onSold, restart: () => startBuy(it, onSold, onGone) })); rej(Object.assign(new Error('closed'), { kind: 'closed' })); });
      m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) rej(Object.assign(new Error('closed'), { kind: 'closed' })); });
    });
    // 5) send
    body.innerHTML = `<div class="spin"></div> Confirm in your wallet…`;
    await ensureChain(it.chain);
    const wc = createWalletClient({ chain: vchain(it.chain), transport: custom(wallet.provider) });
    const gas = assertSendable(it.chain, await preflight(it.chain, { to: tx.to, data, value }), value);
    const hash = await wc.sendTransaction({ account: wallet.address as Hex, to: tx.to as Hex, value, data, ...(gas ? { gas } : {}) });
    const link = `${c.explorer}/tx/${hash}`;
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Transaction reverted. The listing may have been filled by someone else.');
    onSold(it.id); reportFill(it.chain, hash);
    body.innerHTML = `<p class="ok">✓ Purchased! ${esc(it.name)} is yours.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e)); }
}

// Buyer-reported fill so the Worker can credit referrals, revenue share and quests (verified from the receipt).
export function reportFill(chain: string, txHash: string) { fetch(`${API}/native/filled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain, txHash }) }).catch(() => {}); }
