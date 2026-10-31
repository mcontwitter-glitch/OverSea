// Bitcoin data layer: network switch, mempool.space (fees, prices, UTXOs, broadcast), Ordinals indexer, listing store.
// All public, keyless APIs. Anything that would need a key (a signet ord server, a paid indexer) goes through the Worker.
import BTC from '../../config/btc.json';
import { API, apiFeatures } from '../wallet';
export type Net = 'signet' | 'testnet' | 'mainnet';
export const CFG = BTC as any;
const NK = 'multisea-btc-net';
export const mainnetOn = () => CFG.mainnetTrading === true;
export function getNet(): Net { const n = localStorage.getItem(NK) as Net; return n && CFG.networks.includes(n) ? n : CFG.defaultNetwork; }
export function setNet(n: Net) { localStorage.setItem(NK, n); }
export const canTrade = (n: Net = getNet()) => n !== 'mainnet' || mainnetOn();
export const feeAddress = (n: Net = getNet()): string => CFG.feeAddress[n] || '';
export const feeBps = (): number => CFG.marketplaceFeeBps;
export const mempool = (n: Net = getNet()) => CFG.mempool[n];
export const explorer = (n: Net = getNet()) => CFG.explorer[n];
export const ordExplorer = (n: Net = getNet()) => CFG.ordExplorer[n] || '';
export const txUrl = (txid: string, n: Net = getNet()) => `${explorer(n)}/tx/${txid}`;
export const addrUrl = (a: string, n: Net = getNet()) => `${explorer(n)}/address/${a}`;
export const insUrl = (id: string, n: Net = 'mainnet') => (ordExplorer(n) ? `${ordExplorer(n)}/inscription/${id}` : '');
export const contentUrl = (id: string) => CFG.indexer.content + id;
export const previewUrl = (id: string) => (CFG.indexer as any).preview + id;
export const netLabel = (n: Net) => ({ mainnet: 'Mainnet', signet: 'Signet', testnet: 'Testnet3' }[n]);
const J = async (u: string, o?: RequestInit) => { const r = await fetch(u, o); if (!r.ok) throw new Error(`${r.status} ${u.split('?')[0]}`); return r.json(); };
const memo = new Map<string, Promise<any>>();
const once = (k: string, f: () => Promise<any>) => { if (!memo.has(k)) memo.set(k, f().catch(e => { memo.delete(k); throw e; })); return memo.get(k)!; };

// ---- formatting ----
export const fmtBtc = (sats: number) => { const b = sats / 1e8; return (b >= 1 ? b.toFixed(4) : b >= 0.01 ? b.toFixed(5) : b.toFixed(6)).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'; };
export const fmtSats = (sats: number) => Math.round(sats).toLocaleString() + ' sats';
export const fmtUsd = (sats: number, usd: number | null) => (usd ? '$' + ((sats / 1e8) * usd).toLocaleString(undefined, { maximumFractionDigits: sats * usd / 1e8 >= 100 ? 0 : 2 }) : '');
export const price3 = (sats: number, usd: number | null) => `<b>${fmtBtc(sats)}</b><small class="usd">${fmtSats(sats)}${usd ? ' · ' + fmtUsd(sats, usd) : ''}</small>`;
export const short = (a: string) => (a ? a.slice(0, 6) + '…' + a.slice(-5) : '');

// ---- mempool.space ----
export type Fees = { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number };
export const fees = (n: Net = getNet()): Promise<Fees> => once('fees:' + n, () => J(mempool(n) + '/v1/fees/recommended'));
export const btcUsd = (): Promise<number | null> => once('usd', () => J(CFG.mempool.mainnet + '/v1/prices').then(j => j.USD || null).catch(() => null));
export type Utxo = { txid: string; vout: number; value: number; status?: { confirmed: boolean } };
export const utxos = (addr: string, n: Net = getNet()): Promise<Utxo[]> => J(`${mempool(n)}/address/${addr}/utxo`);
export const addrBalance = async (addr: string, n: Net = getNet()) => { const j = await J(`${mempool(n)}/address/${addr}`); const c = j.chain_stats, m = j.mempool_stats; return c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum; };
export const outspend = (txid: string, vout: number, n: Net = getNet()): Promise<{ spent: boolean; txid?: string }> => J(`${mempool(n)}/tx/${txid}/outspend/${vout}`);
export async function broadcast(hex: string, n: Net = getNet()) { const r = await fetch(mempool(n) + '/tx', { method: 'POST', body: hex }); const t = await r.text(); if (!r.ok) throw new Error('broadcast rejected: ' + t); return t.trim(); }

// ---- Ordinals indexer (mainnet: Ordinals Wallet public API; signet/testnet: Worker /btc/ord/<net>/ proxy to an ord server) ----
const OW = CFG.indexer.mainnet;
export type Coll = { slug: string; name: string; icon: string; description: string; supply: number; floor: number | null; listed: number; volume: number | null; sales: number | null; owners: number | null };
export type Ins = { id: string; num: number; name: string; contentType: string; sat: number | null; address: string; value: number; satpoint: string; height: number | null; collection: { slug: string; name: string } | null; attributes: { trait_type: string; value: string; percent?: string }[]; rank: number | null; timestamp?: number };
export const collection = (slug: string): Promise<Coll> => once('c:' + slug, async () => {
  const [c, s] = await Promise.all([J(`${OW}/collection/${slug}`), J(`${OW}/collection/${slug}/stats`).catch(() => ({}))]);
  return { slug, name: c.name, icon: c.icon || (c.icon_inscription ? contentUrl(c.icon_inscription) : ''), description: c.description || '', supply: s.total_supply ?? c.total_supply ?? 0, floor: s.floor_price ?? null, listed: s.listed ?? 0, volume: s.volume_total ?? null, sales: s.sales ?? null, owners: s.owners ?? null };
});
export const featured = () => Promise.all(CFG.featuredCollections.map((s: string) => collection(s).catch(() => null))).then(l => l.filter(Boolean) as Coll[]);
// The public list endpoint has no paging (whole collection, ~6 MB for 10k). In production the Worker pages + caches it
// (GET /btc/ord/mainnet/collection/<slug>/inscriptions?offset&limit); the static preview falls back to one direct fetch.
export const collItems = (slug: string): Promise<any[]> => once('ci:' + slug, async () => {
  if (apiFeatures.includes('btc')) try { return (await J(`${API}/btc/ord/mainnet/collection/${slug}/inscriptions?offset=0&limit=200`)).items; } catch {}
  return J(`${OW}/collection/${slug}/inscriptions`);
});
export async function inscription(id: string): Promise<Ins> {
  const [o, r] = await Promise.all([J(`${OW}/inscription/${id}`).catch(() => null), J(`https://ordinals.com/r/inscription/${id}`).catch(() => null)]);
  if (!o && !r) throw new Error('inscription not found');
  const meta = o?.meta || {}; // ordinals.com (ord itself) is authoritative for location; Ordinals Wallet adds collection + traits
  return { id, num: r?.number ?? o?.num, name: meta.name || `Inscription #${(r?.number ?? o?.num)?.toLocaleString()}`, contentType: r?.content_type || o?.content_type, sat: r?.sat ?? o?.sat ?? null,
    address: r?.address || o?.address, value: r?.value ?? o?.value, satpoint: r?.satpoint || o?.satpoint, height: r?.height ?? o?.genesis_height ?? null, timestamp: r?.timestamp,
    collection: o?.collection ? { slug: o.collection.slug, name: o.collection.name } : null, attributes: meta.attributes || [], rank: meta.rank ?? null };
}
export type Held = { id: string; num: number; name: string; contentType: string; outpoint: string; offset: number; value: number; collection: string | null };
export async function holdings(addr: string, n: Net = getNet()): Promise<{ balance: number | null; items: Held[] }> {
  if (n !== 'mainnet') { if (!apiFeatures.includes('btc')) return { balance: null, items: [] }; return J(`${API}/btc/ord/${n}/wallet/${addr}`); }
  const j = await J(`${OW}/wallet/${addr}`);
  return { balance: j.balance ?? null, items: (j.inscriptions || []).map((x: any) => ({ id: x.id, num: x.num, name: x.meta?.name || `#${x.num}`, contentType: x.content_type, outpoint: x.outpoint?.outpoint, offset: x.outpoint?.sat_offset ?? 0, value: x.outpoint?.sats ?? 0, collection: x.collection?.name || null })) };
}

// ---- MultiSea listing store: Worker KV (/btc/<net>/listings). Static preview without the Worker: this browser only. ----
export type Listing = { inscriptionId: string; net: Net; psbt: string; priceSats: number; seller: string; payout: string; txid: string; vout: number; value: number; createdAt: number; name?: string; collection?: string };
const LK = (n: Net) => 'multisea-btc-listings:' + n;
export const workerStore = () => apiFeatures.includes('btc');
const local = (n: Net): Listing[] => { try { return JSON.parse(localStorage.getItem(LK(n)) || '[]'); } catch { return []; } };
const saveLocal = (n: Net, l: Listing[]) => localStorage.setItem(LK(n), JSON.stringify(l));
export async function listings(n: Net = getNet(), f: { collection?: string; inscription?: string } = {}): Promise<Listing[]> {
  if (workerStore()) return (await J(`${API}/btc/${n}/listings?${new URLSearchParams(f as any)}`)).listings;
  return local(n).filter(l => (!f.collection || l.collection === f.collection) && (!f.inscription || l.inscriptionId === f.inscription));
}
// Worker session from BIP-322 sign-in (/btc/auth/verify). Creating a listing needs no session: the seller's signature
// in the PSBT proves control of the inscription UTXO and the Worker validates it. Removing one needs the seller's session.
const TK = 'multisea-btc-token';
export const setToken = (t?: string) => { t ? localStorage.setItem(TK, t) : localStorage.removeItem(TK); };
const token = () => localStorage.getItem(TK) || undefined;
export async function putListing(l: Listing) {
  if (workerStore()) return J(`${API}/btc/${l.net}/listings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inscriptionId: l.inscriptionId, psbt: l.psbt, name: l.name, collection: l.collection }) });
  saveLocal(l.net, [...local(l.net).filter(x => x.inscriptionId !== l.inscriptionId), l]); return { ok: true, local: true };
}
export async function removeListing(n: Net, id: string, _unused?: unknown, reason = 'cancel') {
  if (workerStore()) return J(`${API}/btc/${n}/listings/${id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token(), reason }) });
  saveLocal(n, local(n).filter(x => x.inscriptionId !== id)); return { ok: true, local: true };
}
// Stale = the listed UTXO was spent (sold elsewhere, transferred, or cancelled on-chain), or the inscription moved.
export async function staleCheck(l: Listing, ins?: Ins | null): Promise<string | null> {
  try { const o = await outspend(l.txid, l.vout, l.net); if (o.spent) return 'The listed UTXO was spent' + (o.txid ? ` (tx ${o.txid.slice(0, 10)}…)` : '') + ': this listing can no longer be filled.'; } catch {}
  if (ins?.satpoint && !ins.satpoint.startsWith(`${l.txid}:${l.vout}:`)) return 'The inscription moved since it was listed.';
  return null;
}
