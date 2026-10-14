import { applyBridgeFlag } from './bridgeflag';
import AV from './assetv.json';
// Shared MultiSea chrome: top bar, wallet button, helpers.
import { wallet, openConnect, disconnect, walletLabel, API, apiReady } from './wallet';
export const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const media = (u?: string | null) => (!u ? '' : u.startsWith('/media/') ? API + u : u);
export function navHtml(active = '') {
  return `<nav class="top"><a class="brand" href="/"><img src="${AV['brand/icon-64.webp']}" srcset="${AV['brand/icon-64.webp']} 1x, ${AV['brand/icon-128.webp']} 2x" width="34" height="34" alt="MultiSea"><span>Multi<b>Sea</b></span></a>
  <div class="navl"><a href="/" class="${active === 'home' ? 'on' : ''}">Collections</a><a href="/bridge" data-bridge-flag hidden class="${active === 'bridge' ? 'on' : ''}">Bridge</a><a href="/submit" class="${active === 'submit' ? 'on' : ''}">Submit</a></div>
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
export const soon = (what = 'This') => `<div class="soon">🚧 ${esc(what)} is coming online soon. The MultiSea API isn't live yet.</div>`;
export { apiReady };

let _eu: Promise<number | null> | null = null;
export function ethUsdRate(): Promise<number | null> { return _eu ??= fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then(r => r.json()).then(j => j?.ethereum?.usd || null).catch(() => null); }
export function mcapUsd(floorEth: number | null | undefined, supply: number, usd: number | null | undefined) { return floorEth && supply && usd ? '$' + Math.round(floorEth * supply * usd).toLocaleString() : '-'; }
export const mcapStatHtml = (v: string) => `<div class="stat tip mcap"><b>${v}</b><span>Market cap ⓘ</span><div class="tipbox"><div class="tipnote">Floor price × total supply</div></div></div>`;
