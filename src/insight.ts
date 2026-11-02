// thirdweb Insight (indexer) reads, authed with the public client ID only (no secret key). Plain fetch: no SDK bundle.
// Coverage of MultiSea chains (checked 2026-11-02): Ethereum, Base, Abstract, ApeChain, BNB yes; Robinhood (4663) NOT
// supported ("Chains [4663] not supported"), so callers keep their RPC / snapshot path there.
import CFG from '../config/collections.json';
const CID = (import.meta.env.VITE_THIRDWEB_CLIENT_ID as string) || '';
const chains = CFG.chains as Record<string, { chainId: number; explorer?: string }>;
export const INSIGHT_CHAINS = ['ethereum', 'base', 'abstract', 'apechain', 'bnb'].filter(k => chains[k]);
export const insightOn = (chain: string) => !!CID && INSIGHT_CHAINS.includes(chain);
const BASE = 'https://insight.thirdweb.com';
async function get(path: string, q: Record<string, string | number>, timeout = 20_000): Promise<any> {
  if (!CID) throw new Error('Insight needs VITE_THIRDWEB_CLIENT_ID');
  const u = new URL(BASE + path); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try { const r = await fetch(u, { headers: { 'x-client-id': CID }, signal: ac.signal }); if (!r.ok) throw new Error(`Insight ${r.status}`); const j = await r.json(); return j?.data?.data ?? j?.data ?? []; }
  finally { clearTimeout(t); }
}
export type Xfer = { type: 'mint' | 'transfer' | 'sale' | 'burn'; chain: string; id: number; contract: string; from: string; to: string; tx: string; ts: number; block: number };
const ZERO = '0x0000000000000000000000000000000000000000';
const toX = (chain: string) => (r: any): Xfer => ({ chain, id: +r.token_id, contract: r.contract_address, from: r.from_address, to: r.to_address, tx: r.transaction_hash, block: +r.block_number,
  ts: Math.floor(Date.parse(r.block_timestamp) / 1000), type: r.transfer_type === 'sale' ? 'sale' : r.from_address === ZERO ? 'mint' : r.to_address === ZERO ? 'burn' : 'transfer' });
const cacheGet = (k: string, ttl: number) => { try { const c = JSON.parse(sessionStorage.getItem(k) || 'null'); return c && Date.now() - c.at < ttl ? c.v : null; } catch { return null; } };
const cacheSet = (k: string, v: any) => { try { sessionStorage.setItem(k, JSON.stringify({ at: Date.now(), v })); } catch {} };

/** Latest transfers (mints, transfers, sales) of one collection deployment, newest first. */
export async function collectionTransfers(chain: string, contract: string, limit = 200): Promise<Xfer[]> {
  const k = `ms-ins-x:${chain}:${contract}:${limit}`; const c = cacheGet(k, 60_000); if (c) return c;
  const v = (await get(`/v1/nfts/transfers/${contract}`, { chain_id: chains[chain].chainId, limit, metadata: 'false', sort_order: 'desc' }, 45_000)).map(toX(chain));
  cacheSet(k, v); return v;
}
/** Current owner of every token of a deployment (paged, 1000 per page). Best for satellite deployments with few tokens. */
export async function collectionOwners(chain: string, contract: string, maxPages = 5): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let page = 0; page < maxPages; page++) {
    const d = await get(`/v1/nfts/${contract}`, { chain_id: chains[chain].chainId, include_owners: 'true', limit: 1000, page }, 30_000);
    for (const n of d) if (n.owner_addresses?.[0]) out.set(+n.token_id, n.owner_addresses[0]);
    if (d.length < 1000) break;
  }
  return out;
}
/** One wallet's NFT transfers on one chain (last `days` days), newest first. */
export async function walletTransfers(chain: string, owner: string, days = 365, limit = 200): Promise<Xfer[]> {
  const k = `ms-ins-w:${chain}:${owner.toLowerCase()}`; const c = cacheGet(k, 60_000); if (c) return c;
  const v = (await get('/v1/nfts/transfers', { chain_id: chains[chain].chainId, owner_address: owner, block_timestamp_from: Math.floor(Date.now() / 1000 - days * 86400), sort_order: 'desc', limit, metadata: 'false' }, 45_000)).map(toX(chain));
  cacheSet(k, v); return v;
}
