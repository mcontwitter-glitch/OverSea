import { applyBridgeFlag } from './bridgeflag';
import AV from './assetv.json';
// Shared MultiSea chrome: top bar, wallet button, helpers.
import { wallet, openConnect, disconnect, walletLabel, API, apiReady, onWallet } from './wallet';
export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const media = (u?: string | null) => (!u ? '' : u.startsWith('/media/') ? API + u : u);
const cartCount = () => { try { return JSON.parse(localStorage.getItem('multisea-cart') || '[]').length; } catch { return 0; } };
export function navHtml(active = '') {
  return `<nav class="top"><a class="brand" href="/"><img src="${AV['brand/icon-64.webp']}" srcset="${AV['brand/icon-64.webp']} 1x, ${AV['brand/icon-128.webp']} 2x" width="34" height="34" alt="MultiSea"><span>Multi<b>Sea</b></span></a>
  <div class="navl"><a href="/" class="${active === 'home' ? 'on' : ''}">Collections</a><a href="/bridge" data-bridge-flag hidden class="${active === 'bridge' ? 'on' : ''}">Bridge</a><a href="/list-collection" class="navlc ${active === 'list' ? 'on' : ''}">List your collection</a><a href="/submit" class="navsub ${active === 'submit' ? 'on' : ''}">Submit</a>
  <details class="navmore ${['quests', 'bundles', 'referrals', 'revshare', 'cart'].includes(active) ? 'on' : ''}"><summary>More</summary><div class="navmenu">
   <a href="/list-collection" class="navm"><b>List your collection</b><span>For creators</span></a>
   <a href="/quests" class="${active === 'quests' ? 'on' : ''}"><b>Quests</b><span>Chain badges + rare free mint</span></a>
   <a href="/bundles" class="${active === 'bundles' ? 'on' : ''}"><b>Bundles</b><span>Sell many NFTs as one</span></a>
   <a href="/cart" class="${active === 'cart' ? 'on' : ''}"><b>Cart</b><span>Multi-chain checkout</span></a>
   <a href="/referrals" class="${active === 'referrals' ? 'on' : ''}"><b>Referrals</b><span>Earn from friends' buys</span></a>
   <a href="/revenue-share" class="${active === 'revshare' ? 'on' : ''}"><b>Revenue share</b><span>Holder rewards</span></a>
   ${wallet.address ? `<a href="/u/${wallet.address.toLowerCase()}"><b>My profile</b><span>Badges &amp; stats</span></a>` : ''}</div></details></div>
  <div class="navr"><a class="cartbtn" href="/cart" title="Cart" aria-label="Cart"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg><span data-cartn ${cartCount() ? '' : 'hidden'}>${cartCount()}</span></a><button class="wbtn ${wallet.address ? 'on' : ''}" data-act="wallet">${wallet.address ? '<span class="wdot on"></span>' : ''}${walletLabel()}</button></div></nav>`;
}
let bound = false;
// First-touch referral: after /r/<code>, ask the connected wallet to link (one free SIWE signature). Permanent server-side.
async function refPrompt() {
  const raw = localStorage.getItem('multisea-ref'); if (!raw || !wallet.address) return;
  if (localStorage.getItem('multisea-ref:done:' + wallet.address.toLowerCase()) || document.querySelector('.reftoast')) return;
  let code = ''; try { code = JSON.parse(raw).code; } catch { return; }
  const t = document.createElement('div'); t.className = 'reftoast';
  t.innerHTML = `<span>You were invited to MultiSea <span class="mono">/r/${esc(code)}</span>. Link your wallet to your inviter (free signature).</span><button class="bbtn sm" data-ref="go">Link</button><button class="x sm" data-ref="no">✕</button>`;
  document.body.appendChild(t);
  t.addEventListener('click', async e => {
    const a = (e.target as HTMLElement).dataset.ref; const addr = wallet.address!.toLowerCase();
    if (a === 'no') { t.remove(); return; }
    if (a === 'go') { try { const { api } = await import('./auth'); const r = await api('/ref/bind', { auth: true, body: { code } }); localStorage.setItem('multisea-ref:done:' + addr, '1'); t.innerHTML = `<span class="ok">✓ ${r.bound ? 'Linked to your inviter.' : esc(r.note || 'Already linked.')}</span>`; setTimeout(() => t.remove(), 3000); }
      catch (err: any) { if (/yourself|already|unknown/i.test(err.message)) localStorage.setItem('multisea-ref:done:' + addr, '1'); t.innerHTML = `<span class="err">${esc(err.message)}</span>`; setTimeout(() => t.remove(), 4000); } }
  });
}
export function bindNav(onDisconnect?: () => void) {
  applyBridgeFlag();
  if (bound) return; bound = true;
  onWallet(() => { refPrompt(); }); setTimeout(refPrompt, 800);
  document.addEventListener('click', e => { const d = document.querySelector('details.navmore[open]'); if (d && !d.contains(e.target as Node)) d.removeAttribute('open'); });
  document.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('[data-act="wallet"]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (wallet.address) { if (confirm('Disconnect ' + wallet.address + '?')) { disconnect(); onDisconnect?.(); } } else openConnect();
  }, true);
}
export const soon = (what = 'This') => `<div class="soon">${esc(what)} couldn't reach the MultiSea API. Check ad-blockers or privacy extensions (allow api.multisea.io) and your connection. <a href="" onclick="location.reload();return false">Retry</a></div>`;
export { apiReady };

// Live USD rates (CoinGecko), shared by market cap and listing prices; cached 10 min in sessionStorage.
export type UsdRates = { ETH: number | null; APE: number | null; BNB: number | null };
let _ur: Promise<UsdRates> | null = null;
export function usdRates(): Promise<UsdRates> {
  return _ur ??= (async () => {
    try { const c = JSON.parse(sessionStorage.getItem('multisea-usd') || 'null'); if (c && Date.now() - c.t < 600_000) return c.r; } catch {}
    const r: UsdRates = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,apecoin,binancecoin&vs_currencies=usd').then(r => r.json())
      .then(j => ({ ETH: j?.ethereum?.usd || null, APE: j?.apecoin?.usd || null, BNB: j?.binancecoin?.usd || null })).catch(() => ({ ETH: null, APE: null, BNB: null }));
    if (r.ETH) try { sessionStorage.setItem('multisea-usd', JSON.stringify({ t: Date.now(), r })); } catch {}
    return r;
  })();
}
export function ethUsdRate(): Promise<number | null> { return usdRates().then(r => r.ETH); }
export function mcapUsd(floorEth: number | null | undefined, supply: number, usd: number | null | undefined) { return floorEth && supply && usd ? '$' + Math.round(floorEth * supply * usd).toLocaleString() : '-'; }
export const mcapStatHtml = (v: string) => `<div class="stat tip mcap"><b>${v}</b><span>Market cap ⓘ</span><div class="tipbox"><div class="tipnote">Floor price × total supply</div></div></div>`;
