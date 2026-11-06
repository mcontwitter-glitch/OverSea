// ENS + Basenames (and ENS avatars) for addresses shown anywhere in the UI, via thirdweb's ENS utilities
// (thirdweb/extensions/ens: resolveName on Ethereum, resolveL2Name on Base with the Basename resolver, resolveAvatar).
// Usage: render addresses as <span data-addr="0x…">0x12…abcd</span>; this module swaps in the name (and avatar) once
// resolved. Results (including "no name") are cached in localStorage; thirdweb is lazy-loaded only when needed.
const CID = (import.meta.env.VITE_THIRDWEB_CLIENT_ID as string) || '';
import { API } from './wallet';
type Rec = { n: string | null; a: string | null; t: number; custom?: boolean };
type Prof = { address: string; name: string; avatar: string; nft?: any };
const PKEY = 'ms-profiles-v1', PTTL = 5 * 60e3;
let profiles: Record<string, Prof & { t: number }> = {}; try { profiles = JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch {}
const ppending = new Map<string, Promise<Prof | null>>();
export const profileName = (a?: string | null) => a && profiles[a.toLowerCase()]?.t > Date.now() - PTTL ? profiles[a.toLowerCase()].name : '';
export const profileAvatar = (a?: string | null) => a && profiles[a.toLowerCase()]?.t > Date.now() - PTTL ? profiles[a.toLowerCase()].avatar : '';
function storeProfile(p: Prof) { if (p?.address) { profiles[p.address.toLowerCase()] = { ...p, t: Date.now() }; try { localStorage.setItem(PKEY, JSON.stringify(profiles)); } catch {} } }
export function loadProfile(address: string): Promise<Prof | null> {
  const a = address.toLowerCase(), hit = profiles[a]; if (hit?.t > Date.now() - PTTL) return Promise.resolve(hit);
  if (ppending.has(a)) return ppending.get(a)!;
  const p = fetch(API + '/profiles?addresses=' + a).then(r => r.ok ? r.json() : null).then(j => { if (!j?.profiles?.[a]) return null; storeProfile(j.profiles[a]); paint(a); return j.profiles[a]; }).catch(() => null).finally(() => ppending.delete(a));
  ppending.set(a, p); return p;
}
export function invalidateProfiles(address: string) { const a = address.toLowerCase(); delete profiles[a]; try { localStorage.setItem(PKEY, JSON.stringify(profiles)); } catch {} loadProfile(a); }
const KEY = 'ms-names-v1', TTL_HIT = 7 * 86400e3, TTL_MISS = 86400e3, MAX_CACHE = 2000;
let cache: Record<string, Rec> = {}; try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const persist = () => { try { const e = Object.entries(cache); if (e.length > MAX_CACHE) cache = Object.fromEntries(e.sort((a, b) => b[1].t - a[1].t).slice(0, MAX_CACHE)); localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} };
const fresh = (r?: Rec) => !!r && Date.now() - r.t < (r.n ? TTL_HIT : TTL_MISS);
export const shortAddr = (a?: string | null) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
export const cachedName = (a?: string | null) => (a && (profileName(a) || (fresh(cache[a.toLowerCase()]) ? cache[a.toLowerCase()].n : null))); 
/** HTML for an address that upgrades itself to a name. */
export const addrHtml = (a?: string | null, cls = 'mono') => (!a ? '-' : `<span class="${cls}" data-addr="${a}" title="${a}">${cachedName(a) || shortAddr(a)}</span>`);

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
let tw: Promise<any> | null = null;
const lib = () => (tw ??= Promise.all([import('thirdweb'), import('thirdweb/extensions/ens'), import('thirdweb/chains')]).then(([t, ens, ch]) => ({ client: t.createThirdwebClient({ clientId: CID }), ens, base: ch.base })));
const inflight = new Map<string, Promise<Rec>>(); const queue: string[] = []; let active = 0; const CONC = 4;
async function resolveOne(a: string): Promise<Rec> {
  const { client, ens, base } = await lib();
  const tmo = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), 8000))]).catch(() => null);
  let n: string | null = await tmo(ens.resolveName({ client, address: a as any }));
  if (!n) n = await tmo(ens.resolveL2Name({ client, address: a as any, resolverAddress: ens.BASENAME_RESOLVER_ADDRESS, resolverChain: base }));
  let av: string | null = null; if (n && n.endsWith('.eth') && !n.endsWith('.base.eth')) av = await tmo(ens.resolveAvatar({ client, name: n }));
  return { n: n || null, a: av || null, t: Date.now() };
}
function pump() {
  while (active < CONC && queue.length) {
    const a = queue.shift()!; active++;
    const p = resolveOne(a).catch(() => ({ n: null, a: null, t: Date.now() })).then(r => { cache[a] = r; persist(); paint(a); return r; }).finally(() => { active--; inflight.delete(a); pump(); });
    inflight.set(a, p);
  }
}
/** Resolve (cached) one address; resolves to the name or null. */
export function nameOf(addr: string): Promise<string | null> {
  const a = addr.toLowerCase(); if (fresh(cache[a])) return Promise.resolve(cache[a].n);
  if (!CID) return Promise.resolve(null);
  if (!inflight.has(a) && !queue.includes(a)) { queue.push(a); pump(); }
  return new Promise(res => { const t = setInterval(() => { if (fresh(cache[a])) { clearInterval(t); res(cache[a].n); } }, 250); setTimeout(() => { clearInterval(t); res(null); }, 30_000); });
}
function paintEl(el: HTMLElement, r: Rec) {
  const pa = el.dataset.addr && profileAvatar(el.dataset.addr); if (pa && !el.querySelector('img')) el.innerHTML = `<img class="ensav" src="${esc(pa.startsWith('/media/') ? API + pa : pa)}" alt="" width="16" height="16">` + esc(r.n || cachedName(el.dataset.addr) || shortAddr(el.dataset.addr));
  if (!r.n || el.dataset.named === r.n) return; el.dataset.named = r.n;
  el.innerHTML = `${r.a && /^https:\/\//.test(r.a) ? `<img class="ensav" src="${esc(r.a)}" alt="" width="16" height="16" loading="lazy" onerror="this.remove()">` : ''}${esc(r.n)}`;
}
function paint(a: string) { const r = cache[a] || { n: profileName(a), a: profileAvatar(a), t: Date.now() }; if (!r?.n && !r?.a) return; document.querySelectorAll<HTMLElement>('[data-addr]').forEach(el => { if (el.dataset.addr!.toLowerCase() === a) paintEl(el, r); }); }
/** Upgrade every [data-addr] currently in the DOM (visible ones first, capped per pass). */
export function hydrateNames(root: ParentNode = document) {
  const want = new Set<string>();
  root.querySelectorAll<HTMLElement>('[data-addr]').forEach(el => { const a = el.dataset.addr!.toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return; loadProfile(a);
    if (fresh(cache[a])) paintEl(el, cache[a]); else if (want.size < 60) want.add(a); });
  want.forEach(a => { if (!inflight.has(a) && !queue.includes(a)) queue.push(a); }); pump();
}
let started = false;
/** Auto-hydrate on DOM changes (debounced). Called once by the shell. */
export function autoNames() {
  if (started || !CID) return; started = true; let t: any = 0;
  const run = () => { clearTimeout(t); t = setTimeout(() => hydrateNames(), 150); };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true }); run();
}
