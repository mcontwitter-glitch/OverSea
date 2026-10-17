// Shared helpers for the growth features (cart, referrals, revenue share, bundles, quests).
import { createWalletClient, custom, formatUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { API, wallet, readClient, ensureChain, vchain } from './wallet';
import { relayQuote, quoteWithFlatFee, summarize, RELAY } from './xpaycore';
export const chains = CFG.chains as Record<string, { name: string; chainId: number; rpc: string; native: string; openseaSlug: string | null; explorer: string }>;
export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const short = (a?: string | null) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
export const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="/logos/${k}.svg" alt="${esc(chains[k]?.name || k)}" title="${esc(chains[k]?.name || k)}">`;
export const fmtWei = (w: bigint | string, d = 18, max = 6) => (+formatUnits(BigInt(w || 0), d)).toLocaleString(undefined, { maximumFractionDigits: max });
export const usdTxt = (v: number | null | undefined) => (v == null || !isFinite(v) ? '' : '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function getJ(path: string) { const r = await fetch(API + path); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }
export const closed = (m: HTMLElement) => new Promise<never>((_, rej) => m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) rej(Object.assign(new Error('closed'), { kind: 'closed' })); }));
// Known MultiSea collections (static) for item thumbnails.
export function thumbFor(chain: string, token: string, id: string | number) {
  const c = CFG.collections.find(c => c.deployments.some(d => d.chain === chain && d.address.toLowerCase() === token.toLowerCase()));
  return c ? `/img/${c.slug}/s/${id}.webp` : '';
}
export const nameFor = (chain: string, token: string, id: string | number) => { const c = CFG.collections.find(c => c.deployments.some(d => d.chain === chain && d.address.toLowerCase() === token.toLowerCase())); return `${c ? c.name : short(token)} #${id}`; };

// Buyer-reported fill: the Worker reads the receipt and credits referrals, revenue share and buy quests.
export { reportFill } from './wallet';

// ---- cart (localStorage) ----
export type CartItem = { key: string; chain: string; contract: string; id: number; name: string; img: string; price: number; currency: string; source: 'multisea' | 'opensea'; orderHash: string; protocolAddress: string; slug?: string };
const CK = 'multisea-cart';
const cartL: (() => void)[] = [];
export const onCart = (f: () => void) => cartL.push(f);
export function cart(): CartItem[] { try { return JSON.parse(localStorage.getItem(CK) || '[]'); } catch { return []; } }
function saveCart(c: CartItem[]) { localStorage.setItem(CK, JSON.stringify(c.slice(0, 100))); cartL.forEach(f => f()); document.querySelectorAll('[data-cartn]').forEach(e => { e.textContent = String(c.length); (e as HTMLElement).hidden = !c.length; }); }
export function addToCart(items: CartItem[]) { const c = cart(); const have = new Set(c.map(x => x.key)); items.forEach(i => { if (!have.has(i.key)) c.push(i); }); saveCart(c); }
export function removeFromCart(key: string) { saveCart(cart().filter(x => x.key !== key)); }
export function clearCart(keys?: string[]) { saveCart(keys ? cart().filter(x => !keys.includes(x.key)) : []); }

// ---- referrals: first-touch capture from /r/<code> ----
const RK = 'multisea-ref';
export function captureRef(code: string) { if (!/^[0-9a-f]{8}$/i.test(code)) return; if (!localStorage.getItem(RK)) localStorage.setItem(RK, JSON.stringify({ code: code.toLowerCase(), at: Date.now() })); }
export function pendingRef(): { code: string; at: number } | null { try { return JSON.parse(localStorage.getItem(RK) || 'null'); } catch { return null; } }
export function markRefDone(addr: string) { localStorage.setItem(RK + ':done:' + addr.toLowerCase(), '1'); }
export const refDone = (addr: string) => !!localStorage.getItem(RK + ':done:' + addr.toLowerCase());

// ---- Relay: move native funds to the user's own wallet on another chain (sweeps, bundles, bridge quest) ----
export async function topUpQuote(fromKey: string, toKey: string, needWei: bigint) {
  const me = wallet.address!; const q = await quoteWithFlatFee({ user: me, originChainId: chains[fromKey].chainId, destinationChainId: chains[toKey].chainId, amount: needWei });
  return { ...q, s: summarize(q.quote) };
}
export async function exactInQuote(fromKey: string, toKey: string, amountWei: bigint) {
  const me = wallet.address!;
  const r = await fetch(`${RELAY()}/quote/v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: me, recipient: me, refundTo: me, originChainId: chains[fromKey].chainId, destinationChainId: chains[toKey].chainId, originCurrency: '0x0000000000000000000000000000000000000000', destinationCurrency: '0x0000000000000000000000000000000000000000', amount: amountWei.toString(), tradeType: 'EXACT_INPUT' }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.message || `Relay quote failed (${r.status})`), { kind: 'stale' }); return { quote: j, s: summarize(j) };
}
void relayQuote;
export async function runRelay(quote: any, fromKey: string, status: (h: string) => void): Promise<string> {
  const me = wallet.address as Hex; const src = chains[fromKey];
  await ensureChain(fromKey); const wc = createWalletClient({ chain: vchain(fromKey), transport: custom(wallet.provider) }); const pub = readClient(fromKey);
  let requestId = quote.requestId as string;
  for (const step of quote.steps) for (const item of step.items) {
    if (step.kind !== 'transaction') throw new Error('Unsupported Relay step: ' + step.kind);
    const d = item.data; if (Number(d.chainId) !== src.chainId) throw new Error('Unexpected chain in Relay step');
    status(`${esc(step.action || 'Confirm in your wallet')}…`);
    const h = await wc.sendTransaction({ account: me, to: d.to, data: d.data, value: BigInt(d.value || 0), ...(d.gas ? { gas: BigInt(d.gas) } : {}) });
    status(`Waiting for ${esc(src.name)}… <a href="${src.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`);
    await pub.waitForTransactionReceipt({ hash: h, timeout: 240_000 }); requestId = step.requestId || requestId;
  }
  const t0 = Date.now(); let st = '';
  while (Date.now() - t0 < 15 * 60_000) {
    status(`Relay is moving funds… <a href="https://relay.link/transaction/${requestId}" target="_blank" rel="noopener">Track ↗</a>`);
    await sleep(3000); const j = await (await fetch(`${RELAY()}/intents/status/v3?requestId=${requestId}`)).json().catch(() => ({})); st = j.status || st;
    if (['success', 'refund', 'refunded', 'failure'].includes(st)) break;
  }
  if (st !== 'success') throw Object.assign(new Error(st.startsWith('refund') ? 'Relay refunded your funds.' : 'Relay did not complete. Check the status on relay.link.'), { kind: 'stale' });
  // bridge quest credit (verified server-side from Relay + the origin tx)
  fetch(`${API}/quests/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }) }).catch(() => {});
  return requestId;
}
// Native balances on every chain (for picking a Relay source).
export async function balances(): Promise<Record<string, bigint | null>> {
  const me = wallet.address as Hex; const out: Record<string, bigint | null> = {};
  await Promise.all(Object.keys(chains).map(async k => { out[k] = await readClient(k).getBalance({ address: me }).catch(() => null); })); return out;
}

// Page frame: nav + section; nav re-renders on wallet change.
import { navHtml, bindNav } from './shell';
import { onWallet } from './wallet';
export function frame(active: string, title: string, cls = 'page') {
  document.title = title + ' · MultiSea';
  const app = document.getElementById('app')!;
  app.innerHTML = `${navHtml(active)}<section class="${cls}" id="pg"></section>`;
  bindNav(); onWallet(() => { const n = app.querySelector('nav.top'); if (n) n.outerHTML = navHtml(active); });
  return app.querySelector('#pg') as HTMLElement;
}
export const connectCta = (what: string) => `<div class="fcard cta"><p>${esc(what)}</p><button class="bbtn sm" data-act="connect">Connect wallet</button></div>`;
