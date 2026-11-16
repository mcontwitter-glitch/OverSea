// /deploy-solana, "Existing collections on Solana": give a live V1 multichain collection its Solana side the same way the
// EVM chains have it: register the collection (Core collection, enforced royalties) and create EVERY id as a locked copy
// owned by the Store PDA (the Solana escrow). Bridging in then releases the copy from escrow; leaving locks it again.
// Admin only (the Store admin pays). Re-planned from the chain each time, so a partial run only signs what is missing.
// Pure module (no DOM): the page and the local tests both use it.
import { Connection, PublicKey } from '@solana/web3.js';
import * as O from './solanaomni';
import { sendBatched, type BatchItem, type BatchSigner, type Notify } from './soltx';

/** Copies per transaction: 20 is the program max, 16 leaves room for what a mobile wallet adds (1,232-byte limit). */
export const COPIES_PER_TX = 16;
/** Transactions per approval: register + 7 copy transactions = a 100-piece collection in ONE approval. */
export const EXISTING_BATCH = 8;
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
    ixs: [O.registerExistingIx({ admin: c.admin, cid: c.cid, params: c.params }, c.pid)], cu: 100_000 });
  for (let st = 1; st <= N; st += COPIES_PER_TX) {
    const q = Math.min(COPIES_PER_TX, N - st + 1);
    if (have.slice(st, st + q).every(Boolean)) continue;
    items.push({ label: `Copies #${st}–#${st + q - 1}`, ixs: [O.existingCopiesIx(c.admin, c.cid, st, q, c.pid)], cu: 60_000 + q * 32_000 });
  }
  return { registered, total: N, created: have.filter(Boolean).length, items };
}
export const approvalsFor = (n: number) => Math.ceil(n / EXISTING_BATCH);
export async function runExisting(conn: Connection, w: BatchSigner, c: ExistingCfg, on: Notify = () => {}) {
  const p = await existingPlan(conn, c);
  return sendBatched(conn, w, p.items, on, { batch: EXISTING_BATCH, again: 'Add to Solana', priceCap: 20_000 });
}
