// MultiSea Launchpad: drop model + DEMO data (preview). No launchpad contract is deployed on any chain yet, so every drop
// here is either demo data (clearly labeled) or a local preview submission saved in this browser.
import LP from '../config/launchpad.json';
import APP from '../config/app.json';
export type Phase = { name: string; kind: 'allowlist' | 'public'; start: number; end: number; price: number; prices?: Record<string, number>; maxPerWallet: number; allowlist?: string[]; allowCount?: number }; // prices: per-chain native price (multichain)
// supply: single-chain = that chain's edition size; multichain = that chain's current unminted-ID pool size (initial pool ± rebalances).
export type ChainAlloc = { chain: string; supply: number; minted: number; price?: number }; // price in the chain's native token (overrides public phase price)
export type Drop = {
  mode?: 'single' | 'multichain'; // multichain = one shared supply, escrow + LayerZero (MultiSeaOmniDrop)
  slug: string; name: string; symbol: string; creator: string; description: string; chains: ChainAlloc[];
  maxSupply: number; royaltyBps: number; reveal: 'instant' | 'delayed'; phases: Phase[]; img: string; art: string[];
  demo?: boolean; local?: boolean; status?: 'pending' | 'approved' | 'rejected' | 'live'; website?: string; x?: string; submittedAt?: string; storage?: string; baseURI?: string; preRevealURI?: string; payout?: string; creatorReserve?: number;
};
export const FEE_BPS: number = LP.platformFeeBps; // 0.5% of primary sales, paid from creator proceeds by withdraw()
export const LP_CHAINS: string[] = LP.chains;
export const GAS_UNITS = (qty: number) => BigInt(LP.mintGasUnits.first + LP.mintGasUnits.perExtra * Math.max(0, qty - 1));
const H = 3600_000, D = 24 * H;
const img = (id: number) => `/img/lil-foots/m/${id}.webp`;
// Anchor demo times to "now" so countdowns always show a sensible state.
const t = Date.now(); const s = (ms: number) => Math.floor((t + ms) / 1000);
export const DEMO_ALLOWLIST = [...APP.adminAddresses, '0x000000000000000000000000000000000000f007'].map(a => a.toLowerCase());
export const DEMO: Drop[] = [
  { slug: 'lil-foots', name: 'LIL FOOTS', symbol: 'FOOT', creator: APP.adminAddresses[0], demo: true, status: 'live', mode: 'multichain',
    description: '4,404 tiny feet walking every chain, as ONE multichain collection: one shared supply across Base, Ethereum, ApeChain, BNB and Robinhood. Demo drop for the MultiSea Launchpad preview: the real LIL FOOTS collection already exists, nothing here mints on-chain.',
    chains: [{ chain: 'base', supply: 1604, minted: 1320, price: 0.003 }, { chain: 'ethereum', supply: 400, minted: 212, price: 0.003 }, { chain: 'apechain', supply: 800, minted: 590, price: 50 }, { chain: 'bnb', supply: 800, minted: 541, price: 0.01 }, { chain: 'robinhood', supply: 800, minted: 455, price: 0.003 }],
    maxSupply: 4404, royaltyBps: 500, reveal: 'instant', img: img(2396), art: [2396, 1858, 3958, 4356, 4088, 1, 777, 4404].map(img),
    phases: [
      { name: 'Foot holders', kind: 'allowlist', start: s(-3 * D), end: s(-1 * D), price: 0, maxPerWallet: 1, allowlist: DEMO_ALLOWLIST, allowCount: 491 },
      { name: 'Allowlist', kind: 'allowlist', start: s(-1 * D), end: s(-2 * H), price: 0.002, prices: { apechain: 35, bnb: 0.007 }, maxPerWallet: 3, allowlist: DEMO_ALLOWLIST, allowCount: 1250 },
      { name: 'Public', kind: 'public', start: s(-2 * H), end: s(1 * D + 14 * H + 23 * 60_000), price: 0.003, maxPerWallet: 10 },
    ] },
  { slug: 'lil-foots-robinhood', name: 'LIL FOOTS: Robinhood Steps', symbol: 'STEP', creator: APP.adminAddresses[0], demo: true, status: 'approved',
    description: 'Demo upcoming drop on Robinhood Chain (chain id 4663).', chains: [{ chain: 'robinhood', supply: 1000, minted: 0 }],
    maxSupply: 1000, royaltyBps: 500, reveal: 'delayed', img: img(3958), art: [3958, 12, 345, 2222].map(img),
    phases: [{ name: 'Allowlist', kind: 'allowlist', start: s(2 * D + 5 * H), end: s(3 * D), price: 0.0015, maxPerWallet: 2, allowlist: DEMO_ALLOWLIST, allowCount: 600 }, { name: 'Public', kind: 'public', start: s(3 * D), end: 0, price: 0.0025, maxPerWallet: 5 }] },
  { slug: 'lil-foots-eth-genesis', name: 'LIL FOOTS: Ethereum Genesis', symbol: 'GFOOT', creator: APP.adminAddresses[0], demo: true, status: 'live',
    description: 'Demo ended drop on Ethereum (sold out).', chains: [{ chain: 'ethereum', supply: 404, minted: 404 }],
    maxSupply: 404, royaltyBps: 500, reveal: 'instant', img: img(1858), art: [1858, 99, 404, 1000].map(img),
    phases: [{ name: 'Public', kind: 'public', start: s(-20 * D), end: s(-18 * D), price: 0.01, maxPerWallet: 5 }] },
];
// ---- local preview submissions (browser only; the real flow POSTs /launchpad/submit to the Worker) ----
const KEY = 'multisea-lp-preview';
export const localDrops = (): Drop[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
export const saveLocal = (l: Drop[]) => localStorage.setItem(KEY, JSON.stringify(l));
export const isLocalHost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
export const allDrops = () => [...DEMO, ...localDrops().filter(d => d.status === 'approved' || d.status === 'live')];
export const findDrop = (slug: string) => allDrops().find(d => d.slug === slug) || localDrops().find(d => d.slug === slug);
// ---- state helpers ----
export const nowS = () => Math.floor(Date.now() / 1000);
export const minted = (d: Drop) => d.chains.reduce((a, c) => a + c.minted, 0);
export function activePhase(d: Drop): number { const n = nowS(); return d.phases.findIndex(p => n >= p.start && (!p.end || n < p.end)); }
export function nextPhase(d: Drop): number { const n = nowS(); return d.phases.findIndex(p => p.start > n); }
export function dropState(d: Drop): 'live' | 'upcoming' | 'ended' {
  if (minted(d) >= d.maxSupply) return 'ended';
  if (activePhase(d) >= 0) return 'live';
  return nextPhase(d) >= 0 ? 'upcoming' : 'ended';
}
export function countdown(toS: number) {
  let x = Math.max(0, toS - nowS()); const d = Math.floor(x / 86400); x %= 86400; const h = Math.floor(x / 3600); x %= 3600; const m = Math.floor(x / 60); const sec = x % 60;
  return { d, h, m, s: sec, text: d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s` };
}
export const pct = (a: number, b: number) => (b ? Math.min(100, (a / b) * 100) : 0);
// ---- multichain (escrow) helpers ----
export const isMulti = (d: Drop) => d.mode === 'multichain';
/** Price of phase p on chain k in k's native token. */
export function priceOn(d: Drop, p: Phase, k: string) { const c = d.chains.find(x => x.chain === k); if (p.prices?.[k] != null) return p.prices[k]; return p.kind === 'public' && c?.price != null ? c.price : p.price; }
// LayerZero V2 fee ESTIMATES in USD per message (fork quotes, 2 DVNs, Oct 17 2026: foot-wallets FORK_DRYRUN.md). Real fees come from escrow.quoteMove().
export function lzUsd(src: string, dst: string) {
  if (dst === 'ethereum') return 1.8; if (src === 'ethereum') return 0.51;
  if ((src === 'apechain' && dst === 'bnb') || (src === 'bnb' && dst === 'apechain')) return 1.47;
  return 0.27;
}
export const lzEta = (src: string, dst: string) => (src === 'ethereum' || dst === 'ethereum' ? '≈ 3-5 min' : '≈ 1-3 min');
export const MOVE_FEE_USD: number = LP.moveFeeUsd;
export const MOVE_GAS_UNITS = BigInt(LP.moveGasUnits);
export const OMNI_GAS_UNITS = (qty: number) => BigInt(LP.omniMintGasUnits.first + LP.omniMintGasUnits.perExtra * Math.max(0, qty - 1));
// Demo "your NFTs" in a multichain drop (in-memory; a move just flips the Active chain after a short fake delay).
export type Held = { id: number; active: string; moving?: string };
const HKEY = 'multisea-lp-held';
export const demoHeld = (): Held[] => { try { const h = JSON.parse(sessionStorage.getItem(HKEY) || 'null'); if (Array.isArray(h)) return h; } catch {} return [{ id: 2396, active: 'base' }, { id: 1858, active: 'apechain' }, { id: 3958, active: 'robinhood' }]; };
export const saveHeld = (h: Held[]) => sessionStorage.setItem(HKEY, JSON.stringify(h));
