// Reliable Solana sending for the /deploy-solana flows (busy mainnet, mobile wallets, suspended tabs):
//  - a fresh blockhash right before every signature
//  - a priority fee (ComputeBudget unit price from getRecentPrioritizationFees) + a tight compute limit, so transactions land
//  - confirmation by POLLING the signature status (no websocket, no instant "expired" when a wallet hands back a re-built
//    transaction without lastValidBlockHeight), re-sending the same signed bytes every couple of seconds until it lands or
//    its blockhash is no longer valid
//  - transactions signed by local keys (throwaway upload key) are re-signed with a new blockhash and sent again on expiry;
//    wallet transactions report "not confirmed" so the caller re-checks the chain before asking the wallet again.
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (u: Uint8Array) => { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; };
export class TxExpired extends Error { constructor(m = 'The network did not confirm the transaction in time.') { super(m); this.name = 'TxExpired'; } }
export type Notify = (m: string) => void;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** micro-lamports per compute unit: 75th percentile of recent fees for these accounts, clamped. */
export async function priorityFee(conn: Connection, accounts: PublicKey[] = [], cap = 200_000): Promise<number> {
  try { const f = (await conn.getRecentPrioritizationFees({ lockedWritableAccounts: accounts })).map(x => x.prioritizationFee).sort((a, b) => a - b);
    const p = f.length ? f[Math.floor(f.length * 0.75)] : 0; return Math.min(cap, Math.max(2_000, Math.ceil(p))); } catch { return 2_000; }
}
export const budget = (units: number, microLamports: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
export const feeOf = (units: number, microLamports: number, sigs = 1) => 5000 * sigs + Math.ceil(units * microLamports / 1e6);

/** Sends signed bytes, re-sending until confirmed. Returns the signature, or throws TxExpired once its blockhash is dead. */
export async function sendUntilConfirmed(conn: Connection, tx: Transaction, o: { lastValidBlockHeight?: number; onWait?: Notify; maxMs?: number } = {}): Promise<string> {
  const raw = tx.serialize(); const sig = b58(tx.signature!); const bh = tx.recentBlockhash!; const t0 = Date.now();
  const status = async (hist = false) => (await conn.getSignatureStatuses([sig], { searchTransactionHistory: hist }).catch(() => ({ value: [null] }))).value[0];
  let first = true;
  for (let i = 0; ; i++) {
    if (i % 2 === 0) { try { await conn.sendRawTransaction(raw, { skipPreflight: !first, maxRetries: 0 }); }
      catch (e: any) { const m = String(e?.message || e); if (first && !/already been processed|AlreadyProcessed|Blockhash not found/i.test(m)) throw e; } first = false; }
    await sleep(1500);
    const s = await status();
    if (s?.err) throw new Error('Solana transaction failed: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    if (i > 0 && i % 4 === 0) {
      const dead = o.lastValidBlockHeight && tx.recentBlockhash === bh ? (await conn.getBlockHeight('confirmed').catch(() => 0)) > o.lastValidBlockHeight
        : !(await conn.isBlockhashValid(bh, { commitment: 'confirmed' }).then(r => r.value).catch(() => true));
      if (dead || Date.now() - t0 > (o.maxMs ?? 150_000)) {
        await sleep(1500); const f = await status(true); // last look: it may have landed just before the blockhash died
        if (f?.err) throw new Error('Solana transaction failed: ' + JSON.stringify(f.err));
        if (f) return sig;
        throw new TxExpired();
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
