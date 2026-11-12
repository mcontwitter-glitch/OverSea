// Launchpad drop stats read from chain: primary mint volume and unique holders across chains.
// OpenSea stats only count secondary sales and sum owners per chain (one wallet on two chains counts twice).
import CFG from '../config/collections.json';
import { formatEther, parseAbi, type Hex } from 'viem';
import { readClient } from './wallet';

type Dep = { chain: string; address: string };
const chains = CFG.chains as Record<string, { native: string }>;
const ABI = parseAbi([
  'struct P { uint64 start; uint64 end; uint128 price; uint32 maxPerWallet; uint32 maxSupply; bytes32 merkleRoot; }',
  'function phases() view returns (P[])',
  'function mintedHere() view returns (uint32)',
  'function priceOf(uint256) view returns (uint256)',
  'function phaseMinted(uint256) view returns (uint256)',
]);
export type Vol = Record<string, number>;
const fmt = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : (+n.toFixed(4)).toString());
export const volText = (v: Vol) => { const e = Object.entries(v).filter(([, x]) => x > 0); return e.length ? e.map(([k, x]) => `${fmt(x)} ${k}`).join(' + ') : '0 ETH'; };
export const addVol = (a: Vol, b: Vol) => { const o = { ...a }; for (const [k, x] of Object.entries(b)) o[k] = (o[k] || 0) + x; return o; };

/** Primary mint volume per native currency. Omni drop: mintedHere x price on each chain (single phase only).
 *  Single-chain drop: sum of phaseMinted x phase price. Returns null if nothing could be read. */
export async function primaryVolume(deps: Dep[]): Promise<Vol | null> {
  const out: Vol = {}; let ok = false;
  await Promise.all(deps.map(async d => {
    const pc = readClient(d.chain), address = d.address as Hex, cur = chains[d.chain]?.native || 'ETH';
    try {
      const ph = await pc.readContract({ address, abi: ABI, functionName: 'phases' }) as readonly { price: bigint }[];
      let wei = 0n, here: number | null = null;
      try { here = Number(await pc.readContract({ address, abi: ABI, functionName: 'mintedHere' })); } catch {}
      if (here != null) { if (ph.length !== 1) return; wei = BigInt(here) * (await pc.readContract({ address, abi: ABI, functionName: 'priceOf', args: [0n] })); }
      else for (let i = 0; i < ph.length; i++) wei += (await pc.readContract({ address, abi: ABI, functionName: 'phaseMinted', args: [BigInt(i)] })) * ph[i].price;
      out[cur] = (out[cur] || 0) + Number(formatEther(wei)); ok = true;
    } catch {}
  }));
  return ok ? out : null;
}

/** Unique holder wallets across every chain (vault/escrow excluded), from a live ownerOf sweep. Null if any chain fails. */
export async function uniqueHolders(col: { slug: string; idStart: number; idEnd: number; deployments: Dep[]; escrow?: Dep[] }): Promise<number | null> {
  try {
    const { liveOwners } = await import('./liveowners');
    const r = await liveOwners(col, {});
    return r && !r.failed.length ? holdersOf(r.owners) : null;
  } catch { return null; }
}
export const holdersOf = (owners: Record<string, { owner: string; also?: { owner: string }[] }>) => {
  const s = new Set<string>(); for (const l of Object.values(owners)) for (const x of [l, ...(l.also || [])]) s.add(x.owner.toLowerCase()); return s.size;
};
