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
// "Phantom": a test keypair behind the wallet interface, counting approvals
function phantom(kp: Keypair) { const w = { publicKey: kp.publicKey, approvals: 0,
  async signTransaction(tx: Transaction) { w.approvals++; tx.partialSign(kp); return tx; },
  async signAllTransactions(txs: Transaction[]) { w.approvals++; txs.forEach(t => t.partialSign(kp)); return txs; } }; return w; }
const mem = () => { let v: string | null = null; return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } }; };
const sol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  const admin = Keypair.generate(), other = Keypair.generate(), lz = Keypair.generate();
  for (const k of [admin, other, lz]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL));
  const c = await D.costs(conn, so); console.log(`program ${so.length} B sha256 ${sha.slice(0, 12)}…  need ${sol(c.need)} SOL, locked ${sol(c.locked)} SOL`);

  // ---- 1. cancel + refund an interrupted upload
  { const w = phantom(other); const ks = mem(); const b0 = await conn.getBalance(other.publicKey);
    await D.deployProgram(conn, so, w, ks, sha, p => { if (p.stage === 'upload' && (p.written ?? 0) > 10) throw new Error('tab closed'); }, { parallel: 4, delayMs: 0 }).catch(e => e);
    const st = await D.deployState(conn, so, ks, sha);
    check('interrupted upload is detected on-chain', st.phase === 'buffer' && st.written > 0 && st.written < st.total, `${st.written}/${st.total} chunks`);
    await D.cancelUpload(conn, w, ks, sha);
    const k = ks.get(); const b1 = await conn.getBalance(other.publicKey);
    check('cancel closes the upload account and refunds the deposit', k === null && b0 - b1 < 0.001 * LAMPORTS_PER_SOL, `cost ${sol(b0 - b1)} SOL in fees`); }

  // ---- 2. deploy with an interruption mid-upload, then resume; exactly 2 approvals in total
  const w = phantom(admin); const ks = mem(); const b0 = await conn.getBalance(admin.publicKey); let low = Infinity;
  const track = async () => { low = Math.min(low, await conn.getBalance(admin.publicKey)); };
  await D.deployProgram(conn, so, w, ks, sha, p => { if (p.stage === 'upload' && (p.written ?? 0) > 40) throw new Error('tab closed'); }, { parallel: 4, delayMs: 0 }).catch(() => undefined);
  await track();
  const mid = await D.deployState(conn, so, ks, sha);
  check('state after interruption: buffer partly written', mid.phase === 'buffer', `${mid.written}/${mid.total}`);
  const t0 = Date.now();
  const pid = await D.deployProgram(conn, so, w, ks, sha, () => {}, { parallel: 4, delayMs: 50 });
  await track();
  check('resume finished the deploy with exactly 2 wallet approvals', w.approvals === 2, `${w.approvals} approvals, resume took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
