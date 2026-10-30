/**
 * Fee policy (spec B7/B13). Pure functions; the service wires them to the backend.
 *  - The buyer pays BTC network costs in USDC as `order.inscriptionFee` (quoted by `quoteUsdc6`, capped on-chain).
 *  - That amount, converted at the BTC/USD price, is the hard sats budget for the order: commit + reveal fees,
 *    postage and any RBF/CPFP bumps must all fit; MAX_FEE_RATE caps the rate regardless of budget.
 */
export type BumpInput = {
  commitConfirmed: boolean; revealConfirmed: boolean;
  revealSignalsRbf: boolean; commitSignalsRbf: boolean;
  paidRate: number;          // current effective rate of the pair
  marketRate: number;        // backend fee estimate now
  maxFeeRate: number;        // MAX_FEE_RATE cap
  budgetRate: number;        // highest rate the order's budget allows (also what commit:0 was funded for)
  hasRevealChange: boolean; hasCommitChange: boolean;
  minIncrement?: number;     // sat/vB above paidRate required to bother (BIP-125 rule 4 needs > relay fee)
};
export type BumpDecision =
  | { action: "none"; reason: string }
  | { action: "rbf-pair" | "rbf-reveal" | "cpfp"; rate: number; via?: "reveal:1" | "commit:1" }
  | { action: "over-budget"; reason: string };

export function decideBump(i: BumpInput): BumpDecision {
  if (i.revealConfirmed) return { action: "none", reason: "reveal confirmed" };
  const inc = i.minIncrement ?? 1;
  const cap = Math.min(i.maxFeeRate, i.budgetRate);
  if (i.marketRate < i.paidRate + inc) return { action: "none", reason: "paid rate still competitive" };
  if (cap < i.paidRate + inc) return { action: "over-budget", reason: `market ${i.marketRate} > cap ${cap} (budget/MAX_FEE_RATE)` };
  const rate = Math.min(i.marketRate, cap);
  if (!i.commitConfirmed && i.commitSignalsRbf && i.revealSignalsRbf) return { action: "rbf-pair", rate };
  if (i.commitConfirmed && i.revealSignalsRbf) return { action: "rbf-reveal", rate };
  if (i.hasRevealChange) return { action: "cpfp", rate, via: "reveal:1" };
  if (!i.commitConfirmed && i.hasCommitChange) return { action: "cpfp", rate, via: "commit:1" };
  return { action: "none", reason: "no RBF signal and no service-owned output to CPFP" };
}

/** sats budget from USDC (6dp) at BTC/USD price in cents: sats = usdc6 * 1e8 / (cents * 1e4) */
export const budgetSats = (inscriptionFeeUsdc6: bigint, btcUsdCents: bigint) =>
  btcUsdCents > 0n ? (inscriptionFeeUsdc6 * 10_000n) / btcUsdCents : 0n;

/** USDC (6dp) needed to cover `sats`, rounded up. */
export const satsToUsdc6 = (sats: bigint, btcUsdCents: bigint) => (sats * btcUsdCents + 9_999n) / 10_000n;

/** Quote: (commit+reveal vsize) at `quoteRate` + postage, with `headroomPct` extra for later bumps. */
export function quoteUsdc6(p: { commitVsize: number; revealVsize: number; postage: bigint; quoteRate: number;
  btcUsdCents: bigint; headroomPct?: number }) {
  const rate = p.quoteRate * (1 + (p.headroomPct ?? 50) / 100);
  const sats = BigInt(Math.ceil((p.commitVsize + p.revealVsize) * rate)) + p.postage;
  return { sats, usdc6: satsToUsdc6(sats, p.btcUsdCents), rate };
}

/** Highest sat/vB the budget allows for the pair (after postage), capped by MAX_FEE_RATE. */
export function budgetRate(p: { budgetSats: bigint; postage: bigint; commitVsize: number; revealVsize: number; maxFeeRate: number }) {
  const spend = p.budgetSats - p.postage;
  if (spend <= 0n) return 0;
  return Math.min(p.maxFeeRate, Number(spend) / (p.commitVsize + p.revealVsize));
}

/** BIP-125 signal: any input nSequence < 0xfffffffe. */
export const signalsRbf = (sequences: number[]) => sequences.some((s) => s < 0xfffffffe);
