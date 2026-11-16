// Local-validator test of the /deploy-solana browser flows, with a test keypair standing in for Phantom (signer adapter):
//  - program deploy through src/solprogdeploy.ts: exactly 2 wallet approvals, interrupted upload resumes, cancel refunds
//  - program setup through src/solsetup.ts: one "Approve all", idempotent (partial setup only signs what is missing)
// Needs: solana-test-validator on :8899 with the LayerZero endpoint + simple message lib + Metaplex Core (scripts/test/solprog-local.sh).
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { EndpointProgram, SimpleMessageLibProgram } from '@layerzerolabs/lz-solana-sdk-v2';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as D from '../../src/solprogdeploy.ts';
import * as S from '../../src/solsetup.ts';
import * as O from '../../src/solanaomni.ts';

const L: any = JSON.parse(readFileSync(new URL('../../config/launchpad.json', import.meta.url), 'utf8'));
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const so = new Uint8Array(readFileSync(new URL('../../public/sol/multisea_omni.so', import.meta.url)));
const sha = createHash('sha256').update(so).digest('hex');
const SIMPLE = new PublicKey('6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy');
const SOL_EID = L.solana.eid as number;
let fails = 0; const check = (n: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  (' + d + ')' : ''}`); };
// "Phantom": a test keypair behind the wallet interface, counting approvals. mode 'rebuild' hands back a deserialised copy (no
// lastValidBlockHeight, like a mobile wallet); 'newhash' also swaps in its own fresh blockhash before signing.
function phantom(kp: Keypair, mode: 'same' | 'rebuild' | 'newhash' = 'same') { const w = { publicKey: kp.publicKey, approvals: 0, mode,
  async signTransaction(tx: Transaction) { w.approvals++;
    if (w.mode === 'newhash') tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.partialSign(kp); return w.mode === 'same' ? tx : Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); },
  async signAllTransactions(txs: Transaction[]) { w.approvals++; txs.forEach(t => t.partialSign(kp)); return txs; } }; return w; }
const phantomSame = (w: ReturnType<typeof phantom>, mode: 'same' | 'rebuild' | 'newhash') => { w.mode = mode; return w; };
// A connection that misbehaves like busy mainnet / a suspended phone tab: drops the first N upload txs (they never land, so
// they expire), reports a short lastValidBlockHeight (fast expiry), can hide signature statuses, or "dies" after N upload sends.
function flaky(o: { dropWrites?: number; shortLvbh?: boolean; hideStatus?: () => boolean; dieAfterWrites?: number }) {
  const stats = { dropped: 0, writes: 0 }; const droppedSigs = new Set<string>(); let dead = false;
  const c = new Proxy(conn, { get(t: any, k) { const v = t[k]; if (typeof v !== 'function') return v;
    if (dead) return async () => { throw new Error('tab closed'); };
    if (k === 'sendRawTransaction') return async (raw: Uint8Array, opts: any) => { const id = Buffer.from(raw.subarray(1, 65)).toString('base64'); const isW = raw.length > 900;
      if (isW && o.dieAfterWrites !== undefined && ++stats.writes > o.dieAfterWrites) { dead = true; throw new Error('tab closed'); }
      if (isW && (droppedSigs.has(id) || stats.dropped < (o.dropWrites || 0))) { if (!droppedSigs.has(id)) { droppedSigs.add(id); stats.dropped++; } return 'dropped'; }
      return v.call(t, raw, opts); };
    if (k === 'getLatestBlockhash' && o.shortLvbh) return async (cm: any) => { const r = await v.call(t, cm); return { ...r, lastValidBlockHeight: (await t.getBlockHeight(cm)) + 2 }; };
    if (k === 'getSignatureStatuses' && o.hideStatus) return async (sg: string[], cm: any) => (o.hideStatus!() ? { context: { slot: 0 }, value: sg.map(() => null) } : v.call(t, sg, cm));
    return v.bind(t); } }) as Connection;
  return { conn: c, stats };
}
const mem = () => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } }; };
const sol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  const admin = Keypair.generate(), other = Keypair.generate(), lz = Keypair.generate();
  for (const k of [admin, other, lz]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL));
  const c = await D.costs(conn, so); console.log(`program ${so.length} B sha256 ${sha.slice(0, 12)}…  need ${sol(c.need)} SOL, locked ${sol(c.locked)} SOL`);

  // ---- 1. cancel + refund an interrupted upload (the "tab" dies after ~12 upload sends)
  { const w = phantom(other); const ks = mem(); const b0 = await conn.getBalance(other.publicKey);
    await D.deployProgram(flaky({ dieAfterWrites: 12 }).conn, so, w, ks, sha, () => {}, { parallel: 4, delayMs: 0 }).catch(e => e);
    const st = await D.deployState(conn, so, ks, sha);
    check('interrupted upload is detected on-chain', st.phase === 'buffer' && st.written > 0 && st.written < st.total, `${st.written}/${st.total} chunks`);
    await D.cancelUpload(conn, w, ks, sha);
    const k = ks.get(); const b1 = await conn.getBalance(other.publicKey);
    check('cancel closes the upload account and refunds the deposit', k === null && b0 - b1 < 0.001 * LAMPORTS_PER_SOL, `cost ${sol(b0 - b1)} SOL in fees`); }

  // ---- 2. MC's case + forced expiry + mid-upload "tab reload", with a wallet that hands back a RE-BUILT transaction (like Phantom)
  const w = phantom(admin, 'rebuild'); const ks = mem(); const b0 = await conn.getBalance(admin.publicKey); let low = Infinity;
  const track = async () => { low = Math.min(low, await conn.getBalance(admin.publicKey)); };
  const notes: string[] = []; let a1 = true;
  const f1 = flaky({ hideStatus: () => a1, shortLvbh: true, dropWrites: 8, dieAfterWrites: 70 });
  const r1 = await D.deployProgram(f1.conn, so, w, ks, sha, p => { if (p.stage === 'upload') a1 = false; if (p.stage === 'retry') notes.push(p.note!); }, { parallel: 4, delayMs: 0 }).catch(e => e);
  await track();
  const mid = await D.deployState(conn, so, ks, sha);
  check('approval 1 landed but its confirmation was lost: the deploy carried on (no second upload account, no error)', w.approvals === 1 && mid.phase === 'buffer' && mid.written > 0, `approvals ${w.approvals}`);
  check('upload txs that never landed expired and were re-signed + re-sent automatically', f1.stats.dropped === 8 && notes.some(n => /retrying with a fresh transaction/.test(n)), `${f1.stats.dropped} dropped, ${notes.length} retry notes`);
  check('tab "reload" mid-upload: state on-chain', mid.phase === 'buffer' && mid.written < mid.total && /tab closed/.test(String(r1?.message || r1)), `${mid.written}/${mid.total}`);
  const t0 = Date.now(); const f2 = flaky({ shortLvbh: true, dropWrites: 5 });
  const pid = await D.deployProgram(f2.conn, so, phantomSame(w, 'newhash'), ks, sha, () => {}, { parallel: 4, delayMs: 50 });
  await track();
  check('resume (wallet uses its own blockhash) finished with exactly 2 wallet approvals in total', w.approvals === 2, `${w.approvals} approvals, resume took ${((Date.now() - t0) / 1000).toFixed(1)} s, ${f2.stats.dropped} more dropped + re-sent`);
  const prog = await conn.getAccountInfo(new PublicKey(pid)); const pd = await conn.getAccountInfo(D.programDataOf(new PublicKey(pid)));
  check('program is executable and owned by the upgradeable loader', !!prog?.executable && prog.owner.equals(D.LOADER));
  check('program bytes on-chain = the published .so', !!pd && Buffer.from(pd.data.subarray(D.PD_HDR, D.PD_HDR + so.length)).equals(Buffer.from(so)));
  check('upgrade authority = the wallet', !!pd && pd.data[12] === 1 && new PublicKey(pd.data.subarray(13, 45)).equals(admin.publicKey));
  const st = await D.deployState(conn, so, ks, sha);
  check('state detection: deployed', st.phase === 'deployed' && st.programId === pid && st.authority === admin.publicKey.toBase58());
  const st2 = await D.deployState(conn, so, mem(), sha, pid);
  check('state detection from a known program id (other browser)', st2.phase === 'deployed');
  const kk = D.loadKeys(ks, sha)!; check('throwaway upload key emptied', (await conn.getBalance(kk.upload.publicKey)) === 0);
  check('upload account closed', !(await conn.getAccountInfo(kk.buffer.publicKey)));
  const b1 = await conn.getBalance(admin.publicKey);
  check('cost matches the estimate', Math.abs((b0 - b1) - c.locked) < 0.002 * LAMPORTS_PER_SOL && b0 - low <= c.need, `spent ${sol(b0 - b1)} SOL (est. locked ${sol(c.locked)}), peak ${sol(b0 - low)} SOL (est. need ${sol(c.need)})`);
  // compute units actually used (to size the compute limits / priority fee)
  const cuOf = async (who: PublicKey) => { const sg = await conn.getSignaturesForAddress(who, { limit: 200 }); const t = await Promise.all(sg.map(x => conn.getTransaction(x.signature, { maxSupportedTransactionVersion: 0 })));
    return t.map(x => x?.meta?.computeUnitsConsumed || 0); };
  console.log('   CU wallet txs', JSON.stringify(await cuOf(admin.publicKey)), 'max upload-key tx', Math.max(...await cuOf(kk.upload.publicKey)));
  const again = await D.deployProgram(conn, so, w, ks, sha);
  check('pressing Deploy again is a no-op', again === pid && w.approvals === 2);

  // ---- 3. setup: local LayerZero endpoint with the simple message lib (the mainnet ULN DVN config cannot run locally)
  const ep = new EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID); const simple = new SimpleMessageLibProgram.SimpleMessageLib(SIMPLE);
  const tx = (...ix: any[]) => sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ix), [lz], { commitment: 'confirmed' });
  await tx(ep.initEndpoint(SOL_EID, lz.publicKey, lz.publicKey), ep.registerLibrary(lz.publicKey, SIMPLE), simple.initSimpleMessageLib(O.LZ_ENDPOINT_ID, lz.publicKey, lz.publicKey, SOL_EID, 5000));
  const keys = Object.keys(L.solana.v2.escrows);
  for (const k of keys) { const eid = L.mainnet.chains[k].eid; await tx(await ep.setDefaultSendLibrary(conn, lz.publicKey, SIMPLE, eid), await ep.setDefaultReceiveLibrary(conn, lz.publicKey, SIMPLE, eid)); }
  const links: S.Link[] = keys.map(k => ({ k, name: k, eid: L.mainnet.chains[k].eid, escrow: L.solana.v2.escrows[k], mover: L.solana.v2.movers[k], v1: L.mainnet.chains[k].omniEscrow, confirmations: L.mainnet.chains[k].confirmations }));
  const cfg = (ls: S.Link[]): S.SetupCfg => ({ pid: new PublicKey(pid), admin: admin.publicKey, localEid: SOL_EID, approver: L.mainnet.approver, feeRecipient: new PublicKey(L.solana.feeRecipient), feeBps: L.solana.feeBps, moveFee: BigInt(L.solana.moveFeeLamports), links: ls, msgLib: SIMPLE, dvnConfig: false });
  const ws = phantom(admin);
  let items = await S.setupPlan(conn, cfg(links.slice(0, 2)));
  check('fresh program: setup lists store + links + movers', items.length === 1 + 2 * 2 && items.every(i => !i.done), `${items.length} transactions`);
  await S.runSetup(conn, ws, items);
  items = await S.setupPlan(conn, cfg(links));
  const left = items.filter(i => !i.done);
  check('partial setup is detected (only the 3 missing chains remain)', left.length === 3 * 2, `${left.length} of ${items.length} missing`);
  const sigs = await S.runSetup(conn, ws, items, m => console.log('   ', m));
  check('the rest signed with one "Approve all"', ws.approvals === 2 && sigs.length === left.length, `${ws.approvals} approvals for 2 runs, ${sigs.length} transactions`);
  items = await S.setupPlan(conn, cfg(links));
  check('everything done after setup (idempotent re-check)', items.every(i => i.done) && (await S.runSetup(conn, ws, items)).length === 0);
  const store = O.decodeStore((await conn.getAccountInfo(O.storePda(new PublicKey(pid))))!.data);
  check('store settings', store.feeRecipient.equals(new PublicKey(L.solana.feeRecipient)) && store.feeBps === 50 && store.localEid === SOL_EID);
  let peersOk = true; for (const l of links) { const p = O.decodePeer((await conn.getAccountInfo(O.peerPda(l.eid, new PublicKey(pid))))!.data);
    peersOk &&= Buffer.from(p.address).equals(Buffer.from(O.evmTo32(l.escrow))) && Buffer.from(p.mover).equals(Buffer.from(O.evmTo32(l.mover!))) && Buffer.from(p.v1Escrow).equals(Buffer.from(O.evmTo32(l.v1!))); }
  check('peers: V2 escrow + mover + V1 escrow for all 5 chains', peersOk);
  const fake = { ...links[0], escrow: '0x000000000000000000000000000000000000dEaD' };
  items = await S.setupPlan(conn, cfg([fake, ...links.slice(1)]));
  const fix = items.filter(i => !i.done); const fixIx = fix.length === 1 ? await fix[0].ixs!() : [];
  check('a wrong peer is detected and re-pointed (set_peer + its nonce only)', fix.length === 1 && fix[0].id === 'link-' + fake.k && fixIx.length === 2, `${fixIx.length} instructions`);
  await S.runSetup(conn, ws, items); items = await S.setupPlan(conn, cfg([fake, ...links.slice(1)]));
  check('re-pointed peer is done', items.every(i => i.done));
  await S.runSetup(conn, ws, await S.setupPlan(conn, cfg(links))); // back to the real V2 escrow (the switch test reads this state)
  check('restored', (await S.setupPlan(conn, cfg(links))).every(i => i.done));
  console.log(JSON.stringify({ programId: pid, testOnly: true }));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
