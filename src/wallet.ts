// Wallet connect (EIP-6963 discovery + window.ethereum fallback) and OpenSea buy flow via the multisea Worker.
import { createWalletClient, createPublicClient, custom, http, fallback, defineChain, parseAbiItem, encodeFunctionData, concat, formatUnits, type Hex, type Chain as VChain } from 'viem';
import CFG from '../config/collections.json';
import APP from '../config/app.json';

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

// ---- API health: Buy stays disabled ("buying coming soon") until the Worker answers ----
export async function checkApi() {
  if (!API) return false;
  try { const ac = new AbortController(); setTimeout(() => ac.abort(), 4000); const r = await fetch(API + '/health', { signal: ac.signal }); apiReady = r.ok; if (r.ok) apiFeatures = (await r.json()).features || []; } catch { apiReady = false; }
  emit(); return apiReady;
}

// ---- EIP-6963 discovery ----
const found = new Map<string, P6963>();
// Silent reconnect across page loads (MultiSea uses full-page navigation): remember the wallet's rdns, use eth_accounts (no prompt).
const LAST = 'multisea-wallet';
async function tryRestore(p: P6963) {
  if (wallet.address || localStorage.getItem(LAST) !== p.info.rdns) return;
  try { const a: string[] = await p.provider.request({ method: 'eth_accounts' }); if (a?.[0]) { wallet.address = a[0]; wallet.provider = p.provider; wallet.name = p.info.name; p.provider.on?.('accountsChanged', (x: string[]) => { wallet.address = x[0] || null; emit(); }); emit(); } } catch {}
}
window.addEventListener('eip6963:announceProvider', (e: any) => { found.set(e.detail.info.uuid, e.detail); tryRestore(e.detail); });
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
      ${list.length ? list.map(p => `<button class="wopt" data-uuid="${esc(p.info.uuid)}">${p.info.icon ? `<img src="${esc(p.info.icon)}" alt="">` : '<span class="wdot"></span>'}${esc(p.info.name)}</button>`).join('') : `<p class="mut">No browser wallet detected${isMobile() ? '. Open this page in your wallet app:' : '. Install MetaMask, Rabby, Coinbase Wallet or OKX.'}</p>`}
      ${isMobile() || !list.length ? deep : ''}`);
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
export function disconnect() { localStorage.removeItem(LAST); wallet.address = null; wallet.provider = null; emit(); }
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
  if (!apiReady) return;
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const os = c.openseaSlug!;
  const m = overlay(`<div class="bhead"><img src="${esc(it.img)}" alt=""><div><div class="mut">${esc(c.name)}</div><h3>${esc(it.name)}</h3></div></div><div class="bbody"><div class="spin"></div> Checking listing on OpenSea…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    // 1) refresh live listing
    const lr = await (await fetch(`${API}/listings/${os}/${it.contract}/${it.id}`)).json();
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
    const enough = bal >= value;
    // 4) confirm screen
    body.innerHTML = `<div class="kv bkv"><span>Price</span><b>${f(price)} ${esc(cur)}</b>
      <span>Includes fees</span><b>${f(fees)} ${esc(cur)}</b><span>Seller receives</span><b>${f(price - fees)} ${esc(cur)}</b>
      <span>Chain</span><b><img class="cl" src="/logos/${it.chain}.svg" alt=""> ${esc(c.name)}</b>
      <span>You pay now</span><b>${f(value)} ${esc(c.native)} + gas</b>
      <span>Your balance</span><b class="${enough ? '' : 'errc'}">${f(bal)} ${esc(c.native)}</b></div>
      ${enough ? '' : '<p class="err">Insufficient funds for this purchase on ' + esc(c.name) + '.</p><button class="bbtn ghost xpay">Pay with ETH from another chain</button>'}
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
    const hash = await wc.sendTransaction({ account: wallet.address as Hex, to: tx.to as Hex, value, data });
    const link = `${c.explorer}/tx/${hash}`;
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Transaction reverted. The listing may have been filled by someone else.');
    onSold(it.id);
    body.innerHTML = `<p class="ok">✓ Purchased! ${esc(it.name)} is yours.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e)); }
}
