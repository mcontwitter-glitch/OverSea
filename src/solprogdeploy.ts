// /deploy-solana, step 2: deploy the MultiSea Solana program from the browser (BPF upgradeable loader), with the wallet
// approving only TWO transactions:
//   approval 1: create the upload ("buffer") account + fund a throwaway upload key with a few thousand lamports
//   uploads   : ~100 small Write transactions signed by the throwaway key in this tab (no wallet prompts), paced
//   (auto)    : the throwaway key hands the buffer to the wallet (SetAuthority)
//   approval 2: create the program account + DeployWithMaxDataLen (upgrade authority = the wallet); the loader closes the
//               buffer and refunds its deposit; the throwaway key returns its leftover lamports
// The throwaway keys (buffer, program, upload) are kept in the browser's storage so an interrupted deploy resumes, or is
// cancelled with the deposit refunded. They control nothing after the deploy. Pure module: also used by the tests.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { sendLocal, sendWallet, priorityFee, budget, feeOf, TxExpired } from './soltx';

export const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const BUF_HDR = 37, PD_HDR = 45, PROG_LEN = 36;
export const CHUNK = 950; // bytes per Write transaction (fits the 1232-byte packet with one signer)
export const UPLOAD_FUND = 2_000_000; // lamports for the throwaway key: ~110 Write fees + 2 cleanup transactions
export type Wallet = { publicKey: PublicKey; signTransaction(tx: Transaction): Promise<Transaction> };
export type KeyStore = { get(): string | null; set(v: string): void; clear(): void };
type Keys = { program: Keypair; buffer: Keypair; upload: Keypair; sha: string };

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const ix = (keys: [PublicKey, boolean, boolean][], data: Uint8Array) => new TransactionInstruction({ programId: LOADER, keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data: Buffer.from(data) });
export const L = {
  initBuffer: (buf: PublicKey, auth: PublicKey) => ix([[buf, false, true], [auth, false, false]], u32(0)),
  write: (buf: PublicKey, auth: PublicKey, off: number, bytes: Uint8Array) => ix([[buf, false, true], [auth, true, false]], cat(u32(1), u32(off), u64(bytes.length), bytes)),
  deploy: (payer: PublicKey, pd: PublicKey, prog: PublicKey, buf: PublicKey, auth: PublicKey, maxLen: number) =>
    ix([[payer, true, true], [pd, false, true], [prog, false, true], [buf, false, true], [SYSVAR_RENT_PUBKEY, false, false], [SYSVAR_CLOCK_PUBKEY, false, false], [SystemProgram.programId, false, false], [auth, true, false]], cat(u32(2), u64(maxLen))),
  setBufferAuthority: (buf: PublicKey, cur: PublicKey, next: PublicKey) => ix([[buf, false, true], [cur, true, false], [next, false, false]], u32(4)),
  close: (acc: PublicKey, to: PublicKey, auth: PublicKey) => ix([[acc, false, true], [to, false, true], [auth, true, false]], u32(5)),
};
export const programDataOf = (prog: PublicKey) => PublicKey.findProgramAddressSync([prog.toBuffer()], LOADER)[0];

const kpOut = (k: Keypair) => Array.from(k.secretKey);
const kpIn = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
export function loadKeys(ks: KeyStore, sha: string): Keys | null {
  try { const j = JSON.parse(ks.get() || 'null'); if (!j) return null; return { program: kpIn(j.program), buffer: kpIn(j.buffer), upload: kpIn(j.upload), sha: j.sha || sha }; } catch { return null; }
}
function newKeys(ks: KeyStore, sha: string): Keys { const k = { program: Keypair.generate(), buffer: Keypair.generate(), upload: Keypair.generate(), sha }; ks.set(JSON.stringify({ program: kpOut(k.program), buffer: kpOut(k.buffer), upload: kpOut(k.upload), sha })); return k; }

export type DeployState = { phase: 'new' | 'buffer' | 'ready' | 'deployed'; programId?: string; bufferAuthority?: string; written: number; total: number; authority?: string; needLamports: number; programRent: number };
const chunks = (so: Uint8Array) => Array.from({ length: Math.ceil(so.length / CHUNK) }, (_, i) => i);
export async function costs(conn: Connection, so: Uint8Array) {
  const [buf, pd, prog] = await Promise.all([conn.getMinimumBalanceForRentExemption(BUF_HDR + so.length), conn.getMinimumBalanceForRentExemption(PD_HDR + so.length), conn.getMinimumBalanceForRentExemption(PROG_LEN)]);
  return { buffer: buf, programData: pd, program: prog, need: buf + pd + prog + UPLOAD_FUND + 20_000, locked: pd + prog };
}
/** What is done already (reads the chain). */
export async function deployState(conn: Connection, so: Uint8Array, ks: KeyStore, sha: string, knownProgram?: string): Promise<DeployState> {
  const c = await costs(conn, so); const base = { written: 0, total: chunks(so).length, needLamports: c.need, programRent: c.locked };
  const k = loadKeys(ks, sha); const pid = knownProgram || k?.program.publicKey.toBase58();
  if (pid) { const p = await conn.getAccountInfo(new PublicKey(pid));
    if (p?.executable && p.owner.equals(LOADER)) { const pd = await conn.getAccountInfo(programDataOf(new PublicKey(pid)));
      const auth = pd && pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : undefined; return { ...base, phase: 'deployed', programId: pid, authority: auth, written: base.total }; } }
  if (!k) return { ...base, phase: 'new' };
  const b = await conn.getAccountInfo(k.buffer.publicKey);
  if (!b) return { ...base, phase: 'new', programId: pid };
  const auth = b.data[4] === 1 ? new PublicKey(b.data.subarray(5, 37)).toBase58() : undefined;
  const written = missing(b.data, so).length; const done = base.total - written;
  return { ...base, phase: written === 0 ? 'ready' : 'buffer', programId: pid, bufferAuthority: auth, written: done };
}
const missing = (data: Uint8Array, so: Uint8Array) => chunks(so).filter(i => { const a = i * CHUNK, e = Math.min(so.length, a + CHUNK);
  for (let j = a; j < e; j++) if (data[BUF_HDR + j] !== so[j]) return true; return false; });

export type Progress = (p: { stage: string; written?: number; total?: number; sig?: string; note?: string }) => void;
// compute limits measured on a local validator (x1.5 margin); unit prices from recent mainnet fees (src/soltx.ts)
export const CU = { approve1: 15_000, write: 4_500, setAuth: 4_500, deploy: 120_000, transfer: 1_000, close: 4_500 }; // measured on a local validator: write/close/setAuth ≤ 2,970, transfer 450; ×1.5
const WRITE_FEE_CAP = 50_000, WALLET_FEE_CAP = 100_000;
const notConfirmed = (what: string) => new Error(`${what} was not confirmed by the network (busy). Nothing is lost: tap Deploy again to continue.`);
/** Runs (or resumes) the whole deploy. Returns the program id. Safe to call again at any point: it re-reads the chain. */
export async function deployProgram(conn: Connection, so: Uint8Array, w: Wallet, ks: KeyStore, sha: string, on: Progress = () => {}, pace = { parallel: 4, delayMs: 100 }): Promise<string> {
  let st = await deployState(conn, so, ks, sha);
  if (st.phase === 'deployed') return st.programId!;
  let k = loadKeys(ks, sha);
  if (k && k.sha !== sha && st.phase !== 'new') throw new Error('An upload of a different program file is in progress: cancel it first.');
  if (!k || st.phase === 'new') k = k && st.phase === 'new' && k.sha === sha ? k : newKeys(ks, sha);
  const kk = k; const c = await costs(conn, so);
  const retry = (note: string) => on({ stage: 'retry', note });
  if (st.phase === 'new') { // approval 1 (only when no upload account exists yet: never funds a second one)
    on({ stage: 'approve-1' });
    const price = await priorityFee(conn, [w.publicKey], WALLET_FEE_CAP);
    try {
      const sig = await sendWallet(conn, w, [...budget(CU.approve1, price), SystemProgram.createAccount({ fromPubkey: w.publicKey, newAccountPubkey: kk.buffer.publicKey, lamports: c.buffer, space: BUF_HDR + so.length, programId: LOADER }),
        L.initBuffer(kk.buffer.publicKey, kk.upload.publicKey), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: kk.upload.publicKey, lamports: UPLOAD_FUND })], [kk.buffer], { onWait: retry });
      on({ stage: 'buffer-created', sig });
    } catch (e) { if (!(e instanceof TxExpired)) throw e; if (!(await conn.getAccountInfo(kk.buffer.publicKey))) throw notConfirmed('Approval 1'); }
    st = await deployState(conn, so, ks, sha);
  }
  const b0 = await conn.getAccountInfo(kk.buffer.publicKey); if (!b0) throw new Error('Upload account missing: cancel the upload and start again.');
  const authNow = new PublicKey(b0.data.subarray(5, 37)); const total = chunks(so).length;
  if (authNow.equals(kk.upload.publicKey)) {
    // uploads: only the parts not yet on-chain (byte-compared), signed by the throwaway key, retried until all are written
    for (let round = 0; round < 40; round++) {
      const b = (await conn.getAccountInfo(kk.buffer.publicKey))!; const todo = missing(b.data, so);
      let written = total - todo.length; on({ stage: 'upload', written, total }); if (!todo.length) break;
      if (round) retry(`Network busy: re-sending ${todo.length} part${todo.length > 1 ? 's' : ''}…`);
      const price = await priorityFee(conn, [kk.buffer.publicKey], WRITE_FEE_CAP);
      const bal = await conn.getBalance(kk.upload.publicKey); const need = todo.length * feeOf(CU.write, price) + 2 * feeOf(CU.transfer, price) + feeOf(CU.setAuth, price);
      if (bal < need) { on({ stage: 'top-up' }); // fees used up by retries: one extra small approval
        try { await sendWallet(conn, w, [...budget(CU.transfer, await priorityFee(conn, [w.publicKey], WALLET_FEE_CAP)), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: kk.upload.publicKey, lamports: need - bal + 500_000 })], [], { onWait: retry }); }
        catch (e) { if (!(e instanceof TxExpired)) throw e; continue; } }
      for (let i = 0; i < todo.length; i += pace.parallel) {
        await Promise.all(todo.slice(i, i + pace.parallel).map(async n => { const off = n * CHUNK;
          try { await sendLocal(conn, [kk.upload], [...budget(CU.write, price), L.write(kk.buffer.publicKey, kk.upload.publicKey, off, so.subarray(off, Math.min(so.length, off + CHUNK)))], { attempts: 2, onRetry: retry });
            written++; on({ stage: 'upload', written, total }); } catch { /* re-checked against the chain next round */ } }));
        if (pace.delayMs) await new Promise(r => setTimeout(r, pace.delayMs));
      }
    }
    const b = (await conn.getAccountInfo(kk.buffer.publicKey))!; if (missing(b.data, so).length) throw new Error('The network is very busy: part of the upload is still missing. Tap Deploy again to continue (nothing is lost).');
    // verified byte-for-byte: hand the upload to the wallet so the wallet becomes the upgrade authority
    await sendLocal(conn, [kk.upload], [...budget(CU.setAuth, await priorityFee(conn, [kk.buffer.publicKey], WRITE_FEE_CAP)), L.setBufferAuthority(kk.buffer.publicKey, kk.upload.publicKey, w.publicKey)], { onRetry: retry });
  } else if (!authNow.equals(w.publicKey)) throw new Error('The upload account belongs to another wallet: connect that wallet or cancel the upload.');
  // approval 2
  on({ stage: 'approve-2' });
  const price = await priorityFee(conn, [w.publicKey, kk.buffer.publicKey], WALLET_FEE_CAP);
  try {
    const sig = await sendWallet(conn, w, [...budget(CU.deploy, price),
      SystemProgram.createAccount({ fromPubkey: w.publicKey, newAccountPubkey: kk.program.publicKey, lamports: c.program, space: PROG_LEN, programId: LOADER }),
      L.deploy(w.publicKey, programDataOf(kk.program.publicKey), kk.program.publicKey, kk.buffer.publicKey, w.publicKey, so.length)], [kk.program], { onWait: retry });
    on({ stage: 'deployed', sig });
  } catch (e) { if (!(e instanceof TxExpired)) throw e; if ((await deployState(conn, so, ks, sha)).phase !== 'deployed') throw notConfirmed('Approval 2'); }
  await returnLeftover(conn, kk.upload, w.publicKey).catch(() => undefined);
  return kk.program.publicKey.toBase58();
}
async function returnLeftover(conn: Connection, upload: Keypair, to: PublicKey) {
  const price = await priorityFee(conn, [], WRITE_FEE_CAP); const bal = await conn.getBalance(upload.publicKey); const fee = feeOf(CU.transfer, price); if (bal <= fee) return;
  await sendLocal(conn, [upload], [...budget(CU.transfer, price), SystemProgram.transfer({ fromPubkey: upload.publicKey, toPubkey: to, lamports: bal - fee })], { attempts: 3 });
}
/** Cancel an unfinished upload: closes the buffer (deposit back to the wallet) and returns the throwaway key's lamports. */
export async function cancelUpload(conn: Connection, w: Wallet, ks: KeyStore, sha: string) {
  const k = loadKeys(ks, sha); if (!k) return;
  const b = await conn.getAccountInfo(k.buffer.publicKey);
  if (b) { const auth = new PublicKey(b.data.subarray(5, 37)); const price = await priorityFee(conn, [k.buffer.publicKey], WRITE_FEE_CAP);
    if (auth.equals(k.upload.publicKey)) await sendLocal(conn, [k.upload], [...budget(CU.close, price), L.close(k.buffer.publicKey, w.publicKey, k.upload.publicKey)]);
    else if (auth.equals(w.publicKey)) { try { await sendWallet(conn, w, [...budget(CU.close, price), L.close(k.buffer.publicKey, w.publicKey, w.publicKey)]); }
      catch (e) { if (!(e instanceof TxExpired) || (await conn.getAccountInfo(k.buffer.publicKey))) throw e; } }
    else throw new Error('The upload account belongs to another wallet.'); }
  await returnLeftover(conn, k.upload, w.publicKey).catch(() => undefined);
  if (!(await conn.getAccountInfo(k.buffer.publicKey))) ks.clear();
}
