// /deploy-solana, "Existing collections on Solana": give a live V1 multichain collection its Solana side the same way the
// EVM chains have it: register the collection (Core collection, enforced royalties) and create EVERY id as a locked copy
// owned by the Store PDA (the Solana escrow). Bridging in then releases the copy from escrow; leaving locks it again.
// Admin only (the Store admin pays). Re-planned from the chain each time, so a partial run only signs what is missing.
// Pure module (no DOM): the page and the local tests both use it.
import { Connection, PublicKey } from '@solana/web3.js';
import * as O from './solanaomni';
import { sendBatched, type BatchItem, type BatchSigner, type Notify } from './soltx';

/** Copies per transaction: 8 (measured ~22k CU per copy on the local validator; 8 = ~180k CU, ~610 bytes, lots of room for
 *  whatever a mobile wallet adds). */
export const COPIES_PER_TX = 8;
/** Copy transactions per approval: 100 pieces = 13 transactions = ONE approval (after the register approval). */
export const EXISTING_BATCH = 16;
/** The public RPCs report zero recent priority fees, so pay a fixed decent price: ~0.000012 SOL per copy transaction. */
export const EXISTING_PRICE = 50_000;
export type ExistingCfg = { pid: PublicKey; admin: PublicKey; cid: string; params: O.ExistingParams };
export type ExistingState = { registered: boolean; total: number; created: number; items: BatchItem[] };

export async function existingPlan(conn: Connection, c: ExistingCfg): Promise<ExistingState> {
  const registered = !!(await conn.getAccountInfo(O.dropPda(c.cid, c.pid)));
  const N = c.params.maxSupply; const have: boolean[] = [false];
  for (let i = 1; i <= N; i += 100) {
    const ks = Array.from({ length: Math.min(100, N - i + 1) }, (_, k) => O.assetPda(c.cid, i + k, c.pid));
    (await conn.getMultipleAccountsInfo(ks)).forEach(a => have.push(!!a));
  }
  const items: BatchItem[] = [];
  if (!registered) items.push({ label: `Register ${c.params.name} on Solana (royalties ${c.params.royaltyBps / 100}% to ${c.params.payout.toBase58()})`,
    ixs: [O.registerExistingIx({ admin: c.admin, cid: c.cid, params: c.params }, c.pid)], cu: 80_000 }); // measured 34–39k
  for (let st = 1; st <= N; st += COPIES_PER_TX) {
    const q = Math.min(COPIES_PER_TX, N - st + 1);
    if (have.slice(st, st + q).every(Boolean)) continue;
    items.push({ label: `Copies #${st}–#${st + q - 1}`, ixs: [O.existingCopiesIx(c.admin, c.cid, st, q, c.pid)], cu: 40_000 + q * 30_000 }); // measured ~22k per copy
  }
  return { registered, total: N, created: have.filter(Boolean).length, items };
}
/** Approvals for a plan: register alone first (so the copy transactions are checked against a registered collection, by the
 *  wallet's own simulation and by our preflight), then the copies. */
export const approvalsFor = (p: { registered: boolean; items: BatchItem[] }) => { const copies = p.items.length - (p.registered ? 0 : 1); return (p.registered ? 0 : 1) + Math.ceil(Math.max(0, copies) / EXISTING_BATCH); };
const OPTS = { batch: EXISTING_BATCH, again: 'Add to Solana', priceCap: 200_000, priceFloor: EXISTING_PRICE };
export async function runExisting(conn: Connection, w: BatchSigner, c: ExistingCfg, on: Notify = () => {}) {
  let p = await existingPlan(conn, c); const sigs: string[] = [];
  if (!p.registered) { on('Approval 1 of 2: register the collection'); sigs.push(...await sendBatched(conn, w, p.items.slice(0, 1), on, OPTS)); p = await existingPlan(conn, c); if (!p.registered) throw new Error('The register transaction confirmed but the collection is not visible yet. Tap "Add to Solana" again in a few seconds.'); }
  if (p.items.length) sigs.push(...await sendBatched(conn, w, p.items, on, OPTS));
  return sigs;
}
