// /deploy-solana, step 2: deploy the MultiSea Solana program from the browser (BPF upgradeable loader), with the wallet
// approving only TWO transactions:
//   approval 1: create the upload ("buffer") account + fund a throwaway upload key with a few thousand lamports
//   uploads   : ~100 small Write transactions signed by the throwaway key in this tab (no wallet prompts), paced
//   (auto)    : the throwaway key hands the buffer to the wallet (SetAuthority)
//   approval 2: create the program account + DeployWithMaxDataLen (upgrade authority = the wallet); the loader closes the
//               buffer and refunds its deposit; the throwaway key returns its leftover lamports
// The throwaway keys (buffer, program, upload) are kept in the browser's storage so an interrupted deploy resumes, or is
// cancelled with the deposit refunded. They control nothing after the deploy. Pure module: also used by the tests.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';

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

async function sendSigned(conn: Connection, tx: Transaction) {
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  const r = await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: (tx as any).lastValidBlockHeight }, 'confirmed');
  if (r.value.err) throw new Error('Solana transaction failed: ' + JSON.stringify(r.value.err)); return sig;
}
async function fresh(conn: Connection, payer: PublicKey, ...ixs: TransactionInstruction[]) { const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'); return new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...ixs); }
/** The wallet signs first (Phantom may add its own safety instructions), then the local keys add their signatures. */
async function walletSend(conn: Connection, w: Wallet, ixs: TransactionInstruction[], local: Keypair[]) {
  const tx = await fresh(conn, w.publicKey, ...ixs); const signed = await w.signTransaction(tx); if (local.length) signed.partialSign(...local); return sendSigned(conn, signed);
}

export type Progress = (p: { stage: string; written?: number; total?: number; sig?: string }) => void;
/** Runs (or resumes) the whole deploy. Returns the program id. */
export async function deployProgram(conn: Connection, so: Uint8Array, w: Wallet, ks: KeyStore, sha: string, on: Progress = () => {}, pace = { parallel: 4, delayMs: 150 }): Promise<string> {
  let st = await deployState(conn, so, ks, sha);
  if (st.phase === 'deployed') return st.programId!;
  let k = loadKeys(ks, sha);
  if (k && k.sha !== sha && st.phase !== 'new') throw new Error('An upload of a different program file is in progress: cancel it first.');
  if (!k || st.phase === 'new') k = k && st.phase === 'new' && k.sha === sha ? k : newKeys(ks, sha);
  const c = await costs(conn, so);
  if (st.phase === 'new') { // approval 1
    on({ stage: 'approve-1' });
    const sig = await walletSend(conn, w, [SystemProgram.createAccount({ fromPubkey: w.publicKey, newAccountPubkey: k.buffer.publicKey, lamports: c.buffer, space: BUF_HDR + so.length, programId: LOADER }),
      L.initBuffer(k.buffer.publicKey, k.upload.publicKey), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: k.upload.publicKey, lamports: UPLOAD_FUND })], [k.buffer]);
    on({ stage: 'buffer-created', sig }); st = await deployState(conn, so, ks, sha);
  }
  // uploads (resume: only the chunks that are not on-chain yet), signed by the throwaway key
  const b0 = await conn.getAccountInfo(k.buffer.publicKey); if (!b0) throw new Error('Upload account missing.');
  const authNow = new PublicKey(b0.data.subarray(5, 37));
  if (authNow.equals(k.upload.publicKey)) {
    for (let round = 0; round < 6; round++) {
      const b = (await conn.getAccountInfo(k.buffer.publicKey))!; const todo = missing(b.data, so); const total = chunks(so).length;
      on({ stage: 'upload', written: total - todo.length, total }); if (!todo.length) break;
      for (let i = 0; i < todo.length; i += pace.parallel) {
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'); // one blockhash per batch (fewer RPC calls)
        await Promise.all(todo.slice(i, i + pace.parallel).map(async n => { const off = n * CHUNK;
          const tx = new Transaction({ feePayer: k!.upload.publicKey, blockhash, lastValidBlockHeight }).add(L.write(k!.buffer.publicKey, k!.upload.publicKey, off, so.subarray(off, Math.min(so.length, off + CHUNK))));
          tx.sign(k!.upload); await sendSigned(conn, tx).catch(() => undefined); }));
        on({ stage: 'upload', written: total - todo.length + Math.min(todo.length, i + pace.parallel), total });
        if (pace.delayMs) await new Promise(r => setTimeout(r, pace.delayMs));
      }
    }
    const b = (await conn.getAccountInfo(k.buffer.publicKey))!; if (missing(b.data, so).length) throw new Error('Upload incomplete (network busy): press the button again to resume.');
    // the upload is verified byte-for-byte; hand the buffer to the wallet so the wallet becomes the upgrade authority
    const tx = await fresh(conn, k.upload.publicKey, L.setBufferAuthority(k.buffer.publicKey, k.upload.publicKey, w.publicKey)); tx.sign(k.upload); await sendSigned(conn, tx);
  } else if (!authNow.equals(w.publicKey)) throw new Error('The upload account belongs to another wallet: connect that wallet or cancel the upload.');
  // approval 2
  on({ stage: 'approve-2' });
  const sig = await walletSend(conn, w, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    SystemProgram.createAccount({ fromPubkey: w.publicKey, newAccountPubkey: k.program.publicKey, lamports: c.program, space: PROG_LEN, programId: LOADER }),
    L.deploy(w.publicKey, programDataOf(k.program.publicKey), k.program.publicKey, k.buffer.publicKey, w.publicKey, so.length)], [k.program]);
  on({ stage: 'deployed', sig });
  await returnLeftover(conn, k.upload, w.publicKey).catch(() => undefined);
  return k.program.publicKey.toBase58();
}
async function returnLeftover(conn: Connection, upload: Keypair, to: PublicKey) {
  const bal = await conn.getBalance(upload.publicKey); if (bal <= 5000) return;
  const tx = await fresh(conn, upload.publicKey, SystemProgram.transfer({ fromPubkey: upload.publicKey, toPubkey: to, lamports: bal - 5000 })); tx.sign(upload); await sendSigned(conn, tx);
}
/** Cancel an unfinished upload: closes the buffer (deposit back to the wallet) and returns the throwaway key's lamports. */
export async function cancelUpload(conn: Connection, w: Wallet, ks: KeyStore, sha: string) {
  const k = loadKeys(ks, sha); if (!k) return;
  const b = await conn.getAccountInfo(k.buffer.publicKey);
  if (b) { const auth = new PublicKey(b.data.subarray(5, 37));
    if (auth.equals(k.upload.publicKey)) { const tx = await fresh(conn, k.upload.publicKey, L.close(k.buffer.publicKey, w.publicKey, k.upload.publicKey)); tx.sign(k.upload); await sendSigned(conn, tx); }
    else if (auth.equals(w.publicKey)) await walletSend(conn, w, [L.close(k.buffer.publicKey, w.publicKey, w.publicKey)], []);
    else throw new Error('The upload account belongs to another wallet.'); }
  await returnLeftover(conn, k.upload, w.publicKey).catch(() => undefined);
  ks.clear();
}
