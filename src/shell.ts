import { applyBridgeFlag } from './bridgeflag';
import AV from './assetv.json';
// Shared MultiSea chrome: top bar, wallet button, helpers.
import { wallet, openConnect, disconnect, walletLabel, API, apiReady } from './wallet';
export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const media = (u?: string | null) => (!u ? '' : u.startsWith('/media/') ? API + u : u);
export function navHtml(active = '') {
  return `<nav class="top"><a class="brand" href="/"><img src="${AV['brand/icon-64.webp']}" srcset="${AV['brand/icon-64.webp']} 1x, ${AV['brand/icon-128.webp']} 2x" width="34" height="34" alt="MultiSea"><span>Multi<b>Sea</b></span></a>
  <div class="navl"><a href="/" class="${active === 'home' ? 'on' : ''}">Collections</a><a href="/bridge" data-bridge-flag hidden class="${active === 'bridge' ? 'on' : ''}">Bridge</a><a href="/list-collection" class="${active === 'list' ? 'on' : ''}">List your collection</a><a href="/submit" class="navsub ${active === 'submit' ? 'on' : ''}">Submit</a></div>
  <div class="navr"><button class="wbtn ${wallet.address ? 'on' : ''}" data-act="wallet">${wallet.address ? '<span class="wdot on"></span>' : ''}${walletLabel()}</button></div></nav>`;
}
let bound = false;
export function bindNav(onDisconnect?: () => void) {
  applyBridgeFlag();
  if (bound) return; bound = true;
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
