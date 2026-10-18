// Pre-flight for every purchase transaction: simulate the exact call on MultiSea's own RPCs and hand the wallet an
// explicit gas limit. Without one, wallets run their own estimate; when that fails or is skewed they fall back to the
// block gas limit (60M gas on Ethereum, far more on Abstract/Robinhood) and show a bogus "you need ~0.25 ETH"
// insufficient-funds warning even though the buyer can easily afford price + real gas.
import { formatUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { readClient, wallet } from './wallet';

const chains = CFG.chains as Record<string, { name: string; native: string }>;
// Typical gas units for one Seaport purchase. Abstract (zkSync VM) meters gas very differently: a fulfill costs ~2.2M.
const UNITS: Record<string, bigint> = { abstract: 3_000_000n };
export const gasUnits = (k: string, n = 1) => (UNITS[k] ?? 350_000n) * BigInt(Math.max(1, n));
export const gasPrice = (k: string) => readClient(k).getGasPrice().catch(() => 0n) as Promise<bigint>;
const fmt = (w: bigint) => (+formatUnits(w, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const FUNDS = /insufficient funds|exceeds (the )?balance|balance: \d+/i;
const NET = /RPC Request failed|HTTP request failed|Failed to fetch|fetch failed|NetworkError|Load failed|timed? ?out|TimeoutError|rate limit|429|50[234]/i;

export type Pre = { gas?: bigint; gp: bigint; costWei: bigint; enough: boolean; short: bigint; bal: bigint; reverted?: string };

/** Simulate `tx` from the connected wallet on chain `k`. Never throws: callers decide what to show. */
export async function preflight(k: string, tx: { to: Hex | string; data?: Hex | string; value?: bigint }, balance?: bigint): Promise<Pre> {
  const pub = readClient(k); const me = wallet.address as Hex; const value = tx.value ?? 0n;
  const [gp, bal] = await Promise.all([gasPrice(k), balance != null ? Promise.resolve(balance) : pub.getBalance({ address: me }).catch(() => 0n) as Promise<bigint>]);
  let gas: bigint | undefined; let reverted: string | undefined; let units = gasUnits(k); let noFunds = false; let netErr = false;
  try { const est: bigint = await pub.estimateGas({ account: me, to: tx.to as Hex, data: (tx.data || '0x') as Hex, value }); gas = (est * 125n) / 100n + 10_000n; units = gas; }
  catch (e: any) {
    const m = [e?.shortMessage, e?.details, e?.message, e?.cause?.message].filter(Boolean).join(' ');
    noFunds = FUNDS.test(m); netErr = !noFunds && NET.test(m);
    if (!noFunds && !NET.test(m)) reverted = (e?.shortMessage || e?.details || 'execution reverted').split('\n')[0].slice(0, 160);
  }
  const costWei = units * gp; const need = value + costWei; const enough = netErr ? bal >= value : !noFunds && bal >= need; // RPC hiccup: don't block, let the wallet estimate
  return { gas, gp, costWei, enough, short: enough ? 0n : need > bal ? need - bal : 1n, bal, reverted };
}

/** Throw a clear, MultiSea-side message instead of letting the wallet show a misleading one. Returns the gas limit to send. */
export function assertSendable(k: string, p: Pre, value: bigint): bigint | undefined {
  const c = chains[k];
  if (p.reverted) throw Object.assign(new Error(`This purchase would fail on ${c.name} right now (the listing may have sold, been cancelled, or the NFT moved). Nothing was sent.`), { kind: 'stale' });
  if (!p.enough) throw Object.assign(new Error(`Not enough ${c.native} on ${c.name}: you need about ${fmt(value + p.costWei)} ${c.native} (price ${fmt(value)} + gas ~${fmt(p.costWei)}) and have ${fmt(p.bal)}.`), { kind: 'stale' });
  return p.gas;
}

/** Pre-flight + assert, retrying briefly while a just-bridged balance becomes visible to the RPCs. */
export async function gasFor(k: string, tx: { to: Hex | string; data?: Hex | string; value?: bigint }, waitForFunds = false): Promise<bigint | undefined> {
  let p = await preflight(k, tx);
  for (let i = 0; waitForFunds && !p.enough && !p.reverted && i < 8; i++) { await new Promise(r => setTimeout(r, 3000)); p = await preflight(k, tx); }
  return assertSendable(k, p, tx.value ?? 0n);
}
export const fmtEth = fmt;
