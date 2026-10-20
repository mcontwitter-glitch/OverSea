// Live ownership from chain (ownerOf multicalls), layered over the static owners snapshot.
// The snapshot (public/data/<slug>/owners.json) is built at deploy time and never refreshes, so feet bridged after it
// (e.g. Abstract -> BNB, where OpenSea has no coverage) kept showing on their old chain/owner.
// Satellite deployments hold few tokens, so a full ownerOf sweep there is ~4 eth_calls per chain. The origin chain
// (biggest supply) is only re-read for the ids whose location changed. Escrow/vault holders are excluded.
import { parseAbi, type Hex } from 'viem';
import { bulkClient } from './wallet';
import { MC3 } from './footkit';

export type Loc = { chain: string; owner: string; also?: { chain: string; owner: string }[] };
type Dep = { chain: string; address: string; original?: boolean };
type Col = { slug: string; idStart: number; idEnd: number; deployments: Dep[]; escrow?: { chain: string; address: string }[] };
export type LiveStats = Record<string, { held: number; inEscrow: number; live: number; holders: number }>;
const ABI = parseAbi(['function ownerOf(uint256) view returns (address)']);
const TTL = 120_000;

async function ownersOn(chain: string, token: string, ids: number[], batch: number): Promise<Map<number, string>> {
  const out = new Map<number, string>(); const pc = bulkClient(chain);
  const parts: number[][] = []; for (let i = 0; i < ids.length; i += batch) parts.push(ids.slice(i, i + batch));
  await Promise.all(parts.map(async part => {
    const r: any[] = await pc.multicall({ multicallAddress: MC3, allowFailure: true, batchSize: 0, contracts: part.map(id => ({ address: token as Hex, abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] })) });
    r.forEach((x, i) => { if (x.status === 'success' && x.result) out.set(part[i], x.result as string); });
  }));
  return out;
}

/** Returns live owners for every id (null for chains that could not be read: the caller keeps the snapshot there). */
export async function liveOwners(col: Col, snap: Record<string, Loc>): Promise<{ owners: Record<string, Loc>; stats: LiveStats; failed: string[]; at: number } | null> {
  const key = `ms-live-owners:${col.slug}`;
  try { const c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && Date.now() - c.at < TTL) return c; } catch {}
  const ids = Array.from({ length: col.idEnd - col.idStart + 1 }, (_, i) => col.idStart + i);
  const esc = new Set((col.escrow || []).map(e => `${e.chain}:${e.address.toLowerCase()}`));
  const isEsc = (chain: string, a: string) => esc.has(`${chain}:${a.toLowerCase()}`);
  const origin = (col.deployments.find(d => d.original) || col.deployments.find(d => (col.escrow || []).some(e => e.chain === d.chain)) || col.deployments[0]).chain;
  const sats = col.deployments.filter(d => d.chain !== origin);
  const failed: string[] = []; const read: Record<string, Map<number, string>> = {};
  await Promise.all(sats.map(async d => { try { read[d.chain] = await ownersOn(d.chain, d.address, ids, 1100); } catch { failed.push(d.chain); } }));
  if (failed.length === sats.length) return null;
  // Origin chain: re-read only ids whose satellite picture differs from the snapshot (bridged out, or came back).
  const recheck = ids.filter(id => { const s = snap[id]; const onSat = sats.some(d => read[d.chain]?.has(id));
    return onSat ? s?.chain !== sats.find(d => read[d.chain]?.has(id))!.chain || !!s?.also : (s && s.chain !== origin && !failed.includes(s.chain)); });
  const od = col.deployments.find(d => d.chain === origin)!;
  try { if (recheck.length) read[origin] = await ownersOn(origin, od.address, recheck, 150); } catch { failed.push(origin); }
  const owners: Record<string, Loc> = {};
  for (const id of ids) {
    const s = snap[id]; const locs: { chain: string; owner: string }[] = [];
    for (const d of col.deployments) {
      const m = read[d.chain];
      if (m && (d.chain !== origin || recheck.includes(id))) { const o = m.get(id); if (o && !isEsc(d.chain, o)) locs.push({ chain: d.chain, owner: o }); }
      else for (const l of s ? [s, ...(s.also || [])] : []) if (l.chain === d.chain) locs.push(l); // unread chain: keep the snapshot
    }
    if (!locs.length) continue;
    // Primary = a satellite where it is live (the origin copy sits in the vault while bridged), else the origin.
    locs.sort((a, b) => (a.chain === origin ? 1 : 0) - (b.chain === origin ? 1 : 0));
    owners[id] = { ...locs[0], ...(locs.length > 1 ? { also: locs.slice(1) } : {}) };
  }
  const stats: LiveStats = {};
  for (const d of sats) { const m = read[d.chain]; if (!m) continue; const own = [...m.values()]; const live = own.filter(o => !isEsc(d.chain, o));
    stats[d.chain] = { held: own.length, inEscrow: own.length - live.length, live: live.length, holders: new Set(live.map(o => o.toLowerCase())).size }; }
  const val = { owners, stats, failed, at: Date.now() };
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch {}
  return val;
}
