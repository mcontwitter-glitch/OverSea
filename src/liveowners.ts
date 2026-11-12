// Live ownership from chain (ownerOf via Multicall3), layered over the static owners snapshot.
// The snapshot (public/data/<slug>/owners.json) is built at deploy time and never refreshes, so a later
// mint, bridge, or escrow flush kept showing stale per-chain Held / In vault/escrow numbers.
// Every chain is swept once on page load (refresh re-reads). Multicall3 is one eth_call per chunk;
// if a chunk fails (RPC size or 429, as on Robinhood), it is retried in groups of 20.
import { parseAbi, type Hex } from 'viem';
import { bulkClient } from './wallet';
import { MC3 } from './footkit';

export type Loc = { chain: string; owner: string; also?: { chain: string; owner: string }[] };
type Dep = { chain: string; address: string; original?: boolean };
type Col = { slug: string; idStart: number; idEnd: number; deployments: Dep[]; escrow?: { chain: string; address: string }[] };
export type LiveStats = Record<string, { held: number; inEscrow: number; live: number; holders: number }>;
const ABI = parseAbi(['function ownerOf(uint256) view returns (address)']);
const CHUNK = 200;
const FALLBACK = 20;

async function ownersOn(chain: string, token: string, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>(); const pc = bulkClient(chain);
  const call = (part: number[]) => pc.multicall({
    multicallAddress: MC3, allowFailure: true, batchSize: 0,
    contracts: part.map(id => ({ address: token as Hex, abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] })),
  }) as Promise<{ status: string; result?: unknown }[]>;
  const apply = (part: number[], r: { status: string; result?: unknown }[]) => {
    if (r.length !== part.length) throw new Error('owner read incomplete');
    r.forEach((x, i) => { if (x.status === 'success' && x.result) out.set(part[i], x.result as string); });
  };
  const read = async (part: number[]) => {
    try { apply(part, await call(part)); }
    catch (e) {
      if (part.length <= FALLBACK) throw e;
      for (let i = 0; i < part.length; i += FALLBACK) {
        const sub = part.slice(i, i + FALLBACK);
        apply(sub, await call(sub));
      }
    }
  };
  const parts: number[][] = []; for (let i = 0; i < ids.length; i += CHUNK) parts.push(ids.slice(i, i + CHUNK));
  await Promise.all(parts.map(read));
  return out;
}

/** Returns live owners for every id (null if no chain could be read: the caller keeps the snapshot). */
export async function liveOwners(col: Col, snap: Record<string, Loc>): Promise<{ owners: Record<string, Loc>; stats: LiveStats; failed: string[]; at: number } | null> {
  const ids = Array.from({ length: col.idEnd - col.idStart + 1 }, (_, i) => col.idStart + i);
  const esc = new Set((col.escrow || []).map(e => `${e.chain}:${e.address.toLowerCase()}`));
  const isEsc = (chain: string, a: string) => esc.has(`${chain}:${a.toLowerCase()}`);
  const origin = (col.deployments.find(d => d.original) || col.deployments.find(d => (col.escrow || []).some(e => e.chain === d.chain)) || col.deployments[0])?.chain;
  const failed: string[] = []; const read: Record<string, Map<number, string>> = {};
  const src: Record<string, string> = {};
  await Promise.all(col.deployments.map(async d => {
    try { read[d.chain] = await ownersOn(d.chain, d.address, ids); src[d.chain] = 'rpc'; }
    catch {
      try {
        const { insightOn, collectionOwners } = await import('./insight');
        if (!insightOn(d.chain)) throw new Error('n/a');
        const m = await collectionOwners(d.chain, d.address, 5);
        if (!m.size) throw new Error('empty');
        read[d.chain] = m; src[d.chain] = 'insight';
      } catch { failed.push(d.chain); }
    }
  }));
  ((window as any).__msPerf ??= {}).ownerSources = src;
  if (!Object.keys(read).length) return null;
  const owners: Record<string, Loc> = {};
  for (const id of ids) {
    const s = snap[id]; const locs: { chain: string; owner: string }[] = [];
    for (const d of col.deployments) {
      const m = read[d.chain];
      if (m) { const o = m.get(id); if (o && !isEsc(d.chain, o)) locs.push({ chain: d.chain, owner: o }); }
      else for (const l of s ? [s, ...(s.also || [])] : []) if (l.chain === d.chain) locs.push(l);
    }
    if (!locs.length) continue;
    locs.sort((a, b) => (a.chain === origin ? 1 : 0) - (b.chain === origin ? 1 : 0));
    owners[id] = { ...locs[0], ...(locs.length > 1 ? { also: locs.slice(1) } : {}) };
  }
  const stats: LiveStats = {};
  for (const d of col.deployments) {
    const m = read[d.chain]; if (!m) continue;
    const own = [...m.values()]; const live = own.filter(o => !isEsc(d.chain, o));
    stats[d.chain] = { held: own.length, inEscrow: own.length - live.length, live: live.length, holders: new Set(live.map(o => o.toLowerCase())).size };
  }
  return { owners, stats, failed, at: Date.now() };
}
