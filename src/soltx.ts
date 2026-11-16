// Reliable Solana sending for the /deploy-solana flows (busy mainnet, mobile wallets, suspended tabs):
//  - a fresh blockhash right before every signature
//  - a priority fee (ComputeBudget unit price from getRecentPrioritizationFees) + a tight compute limit, so transactions land
//  - confirmation by POLLING the signature status (no websocket, no instant "expired" when a wallet hands back a re-built
//    transaction without lastValidBlockHeight), re-sending the same signed bytes every couple of seconds until it lands or
//    its blockhash is no longer valid
//  - transactions signed by local keys (throwaway upload key) are re-signed with a new blockhash and sent again on expiry;
//    wallet transactions report "not confirmed" so the caller re-checks the chain before asking the wallet again.
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (u: Uint8Array) => { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; };
export class TxExpired extends Error { constructor(m = 'The network did not confirm the transaction in time.', public stale = false) { super(m); this.name = 'TxExpired'; } }
/** Extra RPCs that every signed transaction is also broadcast to (errors ignored), in case the main RPC drops or refuses sends. */
const extra: Connection[] = [];
export const addBroadcast = (c: Connection) => { extra.push(c); };
export type Notify = (m: string) => void;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** micro-lamports per compute unit: 75th percentile of recent fees for these accounts, clamped to [floor, cap]. The public
 *  RPCs (publicnode, leorpc) answer getRecentPrioritizationFees with all zeros, so the floor is what is really paid. */
export async function priorityFee(conn: Connection, accounts: PublicKey[] = [], cap = 200_000, floor = 2_000): Promise<number> {
  try { const f = (await conn.getRecentPrioritizationFees({ lockedWritableAccounts: accounts })).map(x => x.prioritizationFee).sort((a, b) => a - b);
    const p = f.length ? f[Math.floor(f.length * 0.75)] : 0; return Math.min(cap, Math.max(floor, Math.ceil(p))); } catch { return floor; }
}
export const budget = (units: number, microLamports: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
export const feeOf = (units: number, microLamports: number, sigs = 1) => 5000 * sigs + Math.ceil(units * microLamports / 1e6);

/** Is this blockhash really expired? With our own lastValidBlockHeight (wallet kept our blockhash): current block height >
 *  lastValidBlockHeight. Wallet swapped in its own blockhash: ask isBlockhashValid ('processed', the most permissive) on
 *  the main RPC and every broadcast RPC, 3 rounds 1.5 s apart, and call it expired only if every answer is "not valid":
 *  a load-balanced public RPC can answer from a node a few slots behind (or one that never saw a 'processed' blockhash a
 *  wallet picked) and say "not valid" for a perfectly fresh blockhash. Unknown (RPC errors) = not expired: sending an
 *  expired transaction is harmless, the network just drops it. */
export async function blockhashExpired(conn: Connection, bh: string, lastValidBlockHeight?: number): Promise<boolean> {
  if (lastValidBlockHeight) { const h = await conn.getBlockHeight('confirmed').catch(() => 0); return h > lastValidBlockHeight; }
  for (let round = 0; round < 3; round++) {
    if (round) await sleep(1500);
    const answers = await Promise.all([conn, ...extra].map(c => c.isBlockhashValid(bh, { commitment: 'processed' }).then(r => r.value, () => null)));
    if (answers.some(a => a !== false)) return false;
  }
  return true;
}
const CB = 'ComputeBudget111111111111111111111111111111';
/** Local checks on the SIGNED transaction (what the wallet handed back): things the network drops without a trace. */
export function inspectSigned(tx: Transaction, raw: Uint8Array) {
  const problems: string[] = [];
  if (raw.length > 1232) problems.push(`it is ${raw.length} bytes, over Solana's 1,232-byte limit`);
  const cb = tx.instructions.filter(i => i.programId.toBase58() === CB); const kinds = cb.map(i => i.data[0]);
  if (kinds.some((k, j) => kinds.indexOf(k) !== j)) problems.push('the wallet added a second compute-budget instruction (the network rejects duplicates)');
  const dv = (i?: TransactionInstruction) => (i ? new DataView(Uint8Array.from(i.data).buffer) : null);
  const lim = dv(cb.find(i => i.data[0] === 2)), pr = dv(cb.find(i => i.data[0] === 3));
  const units = lim ? lim.getUint32(1, true) : null, price = pr ? Number(pr.getBigUint64(1, true)) : null;
  return { problems, size: raw.length, units, price, ixs: tx.instructions.length, desc: `${raw.length} bytes, ${tx.instructions.length} instructions, CU limit ${units ?? 'none'}, ${price ?? 0} µlamports/CU` };
}
/** Exact preflight of the signed bytes (signatures verified) at 'processed' on every RPC. blockhash = "Blockhash not found"
 *  everywhere (an RPC that has not seen the wallet's fresh blockhash yet); err+logs = a real rejection to show. */
async function preflight(conn: Connection, raw: Uint8Array): Promise<{ ok: boolean; units?: number; blockhash?: boolean; err?: string; logs?: string[] }> {
  let sawBh = false, rpcErr = '';
  for (const c of [conn, ...extra]) {
    try {
      const r = await c.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: 'processed' });
      if (!r.value.err) return { ok: true, units: r.value.unitsConsumed };
      const e = JSON.stringify(r.value.err); if (/BlockhashNotFound/i.test(e)) { sawBh = true; continue; }
      return { ok: false, err: e, logs: r.value.logs || [] };
    } catch (x: any) { const m = String(x?.message || x); if (/Blockhash not found/i.test(m)) sawBh = true; else rpcErr = m.slice(0, 160); }
  }
  return { ok: false, blockhash: sawBh, err: sawBh ? 'Blockhash not found' : rpcErr || 'no RPC answered' };
}
const logTail = (l?: string[]) => (l || []).filter(x => /rror|failed|exceed|insufficient/i.test(x)).slice(-3).join(' | ');
/** Sends signed bytes, re-sending until confirmed. Returns the signature, or throws TxExpired once its blockhash is dead.
 *  Before the first send the exact signed transaction is checked locally (size, duplicate compute-budget instructions) and
 *  preflighted on every RPC; a real rejection is thrown with the RPC's error and logs instead of a silent re-send loop. */
export async function sendUntilConfirmed(conn: Connection, tx: Transaction, o: { lastValidBlockHeight?: number; onWait?: Notify; maxMs?: number; note?: string } = {}): Promise<string> {
  const raw = tx.serialize(); const sig = b58(tx.signature!); const bh = tx.recentBlockhash!; const t0 = Date.now();
  const status = async (hist = false) => (await conn.getSignatureStatuses([sig], { searchTransactionHistory: hist }).catch(() => ({ value: [null] }))).value[0];
  const dead = () => blockhashExpired(conn, bh, o.lastValidBlockHeight);
  const ins = inspectSigned(tx, raw);
  if (ins.problems.length) throw new Error(`Not sent: ${ins.problems.join('; ')} [${ins.desc}${o.note ? '; ' + o.note : ''}].`);
  let pre = await preflight(conn, raw);
  for (let k = 0; k < 3 && !pre.ok && pre.blockhash; k++) { await sleep(1500); pre = await preflight(conn, raw); }
  if (!pre.ok && pre.logs) throw new Error(`The network rejected it in preflight, nothing was sent: ${pre.err}${logTail(pre.logs) ? ' · ' + logTail(pre.logs) : ''} [${ins.desc}].`);
  if (!pre.ok && pre.blockhash && await dead()) throw new TxExpired('The signed transaction was already too old when it was sent (its blockhash expired).', true);
  const preNote = () => (pre.ok ? `preflight OK, ${pre.units} CU` : `preflight: ${pre.err}`);
  let lastErr = ''; let first = true;
  for (let i = 0; ; i++) {
    if (i % 2 === 0) {
      for (const x of extra) x.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      try { await conn.sendRawTransaction(raw, { skipPreflight: !first || !pre.ok, preflightCommitment: 'processed', maxRetries: 0 }); lastErr = ''; }
      catch (e: any) { const m = String(e?.message || e); lastErr = m.slice(0, 240);
        if (first && !/already been processed|AlreadyProcessed|Blockhash not found/i.test(m)) throw new Error(`The RPC refused it: ${m.slice(0, 300)}${logTail(e?.logs) ? ' · ' + logTail(e.logs) : ''} [${ins.desc}].`); }
      first = false; }
    await sleep(1500);
    const s = await status();
    if (s?.err) throw new Error('Solana transaction failed: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    if (i > 0 && i % 8 === 0 && !pre.ok) { // blind re-sends: look again for a real rejection instead of timing out silently
      const p2 = await preflight(conn, raw); if (p2.ok || p2.logs) pre = p2;
      if (!p2.ok && p2.logs) throw new Error(`The network rejects it: ${p2.err}${logTail(p2.logs) ? ' · ' + logTail(p2.logs) : ''} [${ins.desc}].`); }
    if (i > 0 && i % 4 === 0) {
      if (await dead() || Date.now() - t0 > (o.maxMs ?? 180_000)) {
        await sleep(1500); const f = await status(true); // last look: it may have landed just before the blockhash died
        if (f?.err) throw new Error('Solana transaction failed: ' + JSON.stringify(f.err));
        if (f) return sig;
        throw new TxExpired(`The network did not confirm the transaction in time (${preNote()}; last send answer: ${lastErr || 'accepted'}; ${ins.desc}${o.note ? '; ' + o.note : ''}).`);
      }
      if (i >= 8) o.onWait?.('The network is busy: still sending…');
    }
  }
}
/** Signed by local keys only (fee payer = first signer): re-signed with a fresh blockhash after every expiry. */
export async function sendLocal(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], o: { onRetry?: Notify; attempts?: number } = {}): Promise<string> {
  for (let a = 0; ; a++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs); tx.sign(...signers);
    try { return await sendUntilConfirmed(conn, tx, { lastValidBlockHeight, onWait: o.onRetry }); }
    catch (e) { if (!(e instanceof TxExpired) || a + 1 >= (o.attempts ?? 6)) throw e; o.onRetry?.('Network busy: retrying with a fresh transaction…'); }
  }
}
export type WalletSigner = { publicKey: PublicKey; signTransaction(tx: Transaction): Promise<Transaction> };
/** The wallet signs first (fresh blockhash fetched right before), then local keys. TxExpired = not confirmed: re-check the chain. */
export async function sendWallet(conn: Connection, w: WalletSigner, ixs: TransactionInstruction[], locals: Keypair[] = [], o: { onWait?: Notify } = {}): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: w.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const signed = await w.signTransaction(tx); if (locals.length) signed.partialSign(...locals);
  // a wallet may hand back a re-built transaction (own blockhash, no lastValidBlockHeight): then the blockhash check decides
  return sendUntilConfirmed(conn, signed, { lastValidBlockHeight: signed.recentBlockhash === blockhash ? lastValidBlockHeight : undefined, onWait: o.onWait });
}

export type BatchItem = { label: string; ixs: TransactionInstruction[]; cu: number };
export type BatchSigner = { publicKey: PublicKey; signAllTransactions(txs: Transaction[]): Promise<Transaction[]> };
/** Many wallet transactions with few approvals (used by program setup and existing-collection copies):
 *  - a dry run of the first one (its inputs exist already) so a real program error shows before anything is signed
 *  - batches of `batch` per approval, each with a fresh blockhash fetched right before it (a slow approval on a phone
 *    rarely outlives the ~150 blocks a blockhash is valid); after signing, the signed blockhash is checked against the chain
 *    (block height vs lastValidBlockHeight, or isBlockhashValid on every RPC) and nothing is sent only if it is really dead
 *  - strictly in order: each one is re-broadcast (also to the extra RPCs) until confirmed before the next is sent
 *  - errors name the transaction, the approval time and the RPC's answer; the caller re-plans from the chain on retry */
export async function sendBatched(conn: Connection, w: BatchSigner, items: BatchItem[], on: Notify, o: { batch: number; again: string; priceCap?: number; priceFloor?: number }): Promise<string[]> {
  if (!items.length) return [];
  const price = await priorityFee(conn, [w.publicKey], Math.max(o.priceCap ?? 20_000, o.priceFloor ?? 0), o.priceFloor ?? 2_000);
  { const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const sim = await conn.simulateTransaction(new Transaction({ feePayer: w.publicKey, recentBlockhash: blockhash }).add(...budget(items[0].cu, price), ...items[0].ixs)).catch(() => null);
    if (sim?.value.err) throw new Error(`${items[0].label}: the network rejected it in a dry run: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).filter(l => /rror|failed/i.test(l)).slice(-2).join(' ')}`); }
  const nb = Math.ceil(items.length / o.batch); const sigs: string[] = [];
  for (let b = 0; b < nb; b++) {
    const part = items.slice(b * o.batch, (b + 1) * o.batch);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'); // fresh, right before the approval
    const txs = part.map(it => new Transaction({ feePayer: w.publicKey, blockhash, lastValidBlockHeight }).add(...budget(it.cu, price), ...it.ixs));
    on(`Approve ${txs.length} transaction${txs.length > 1 ? 's' : ''} in your wallet${txs.length > 1 ? ' ("Approve all")' : ''}${nb > 1 ? ` · approval ${b + 1} of ${nb}` : ''}`);
    const t0 = Date.now(); const signed = await w.signAllTransactions(txs); const secs = Math.round((Date.now() - t0) / 1000);
    const changed = signed[0].recentBlockhash !== blockhash;
    // Real check, not a timer: the signed blockhash against the chain (block height vs lastValidBlockHeight when the wallet
    // kept ours; every RPC's isBlockhashValid when it swapped in its own). Refuse only if it is actually expired.
    const dead = await Promise.all([...new Set(signed.map(t => t.recentBlockhash!))].map(h => blockhashExpired(conn, h, h === blockhash ? lastValidBlockHeight : undefined)));
    if (dead.some(Boolean))
      throw new Error(`The signed transaction${signed.length > 1 ? 's' : ''} expired before ${signed.length > 1 ? 'they' : 'it'} could be sent (the blockhash is past its last valid block on Solana; approval took ${secs} s; wallet ${changed ? 'changed' : 'kept'} the blockhash), so nothing was sent. Tap "${o.again}" again.`);
    for (const [i, tx] of signed.entries()) {
      const n = b * o.batch + i + 1, label = part[i].label;
      on(`Sending ${n} of ${items.length}: ${label}`);
      try { sigs.push(await sendUntilConfirmed(conn, tx, { lastValidBlockHeight: tx.recentBlockhash === blockhash ? lastValidBlockHeight : undefined, onWait: m => on(`${n} of ${items.length}: ${m}`), note: `approval took ${secs} s, wallet ${changed ? 'changed' : 'kept'} the blockhash, we set CU ${part[i].cu} at ${price} µlamports/CU` })); }
      catch (e) { const m = String((e as any)?.message || e);
        if (e instanceof TxExpired) throw new Error(`Transaction ${n} of ${items.length} (${label}) was not confirmed: ${m} Tap "${o.again}" again: only the missing ones are signed.`);
        throw new Error(`Transaction ${n} of ${items.length} (${label}): ${m}`); }
      on(`✓ ${label}`);
    }
  }
  return sigs;
}
