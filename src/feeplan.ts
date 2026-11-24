// Direct/launchpad listing fee plan. The factory's listingFee(eids) = baseGasCost + sum(chainGasCost[eid]) (all in the NATIVE chain's token) and is only
// as fresh as the last setGasCosts. Each remote chain's entry must pay, from the creator's fee alone: the LayerZero native-drop gas that the worker's refuel step
// sends to the operator on that chain, the LayerZero fee for sending it, and (inside the drop) the mirror+escrow deploy and wire gas on that chain.
// Same constants as worker/src/bridgeauto.js (setupGas = deployMirror + wire units), with safety markups so a gas-price spike between "fee set" and "job run" is covered.
export type Units = { list: number; deployMirror: number; wire: number };
export type Markups = { dropMarkup: number; lzMarkup: number; baseMarkup: number };
// dropMarkup 2: the gas dropped to a chain is sized at 2x its price at fee time (worker sizes at 1.3x live price when the job runs), lzMarkup 1.3 on the LayerZero quote.
export const DEFAULT_MARKUPS: Markups = { dropMarkup: 2, lzMarkup: 1.3, baseMarkup: 1.5 };
const mulf = (x: bigint, f: number) => (x * BigInt(Math.round(f * 1000))) / 1000n;
export type PlanIn = {
  native: string; keys: string[]; eid: Record<string, number>; gasPrice: Record<string, bigint>; units: Units; markups?: Markups;
  quote: (dstEids: number[], amounts: bigint[]) => Promise<bigint>; // refuel.quote on the native chain (token of the native chain)
};
export type Plan = { base: bigint; remote: Record<string, { eid: number; drop: bigint; lz: bigint; cost: bigint }>; total: bigint; eids: number[]; costs: bigint[] };
export async function planNative(i: PlanIn): Promise<Plan> {
  const m = i.markups || DEFAULT_MARKUPS; const setup = BigInt(i.units.deployMirror + i.units.wire);
  const base = mulf(BigInt(i.units.list + i.units.wire) * i.gasPrice[i.native], m.baseMarkup);
  const remote: Plan['remote'] = {}; let total = base;
  for (const k of i.keys) { if (k === i.native) continue;
    const drop = mulf(setup * i.gasPrice[k], m.dropMarkup); const q = await i.quote([i.eid[k]], [drop]); const cost = mulf(q, m.lzMarkup);
    remote[k] = { eid: i.eid[k], drop, lz: q, cost }; total += cost; }
  return { base, remote, total, eids: [0, ...Object.values(remote).map(r => r.eid)], costs: [base, ...Object.values(remote).map(r => r.cost)] };
}
