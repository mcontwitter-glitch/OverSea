// Manual delivery of LayerZero messages into the Solana program that are verified + committed but not executed.
// LayerZero's Solana executor now asks the receiver for lz_receive_types_info (LzReceiveTypesV2) first and gives up
// ("receiver program is not using LzReceiveTypesV2") instead of falling back to our V1 lz_receive_types. lz_receive is
// permissionless (the endpoint only checks the committed payload hash), so any connected Solana wallet can deliver:
//   1. find the Store's inbound messages on LayerZero Scan that are not delivered,
//   2. confirm on-chain: the endpoint's PayloadHash account holds keccak256(guid ‖ message) (committed, not cleared),
//   3. ask the program for the exact accounts (V1 lz_receive_types, simulated with the wallet as payer),
//   4. preflight the lz_receive, have the wallet sign it and send it with the re-sending path in soltx.
import './btc/polyfill';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { keccak256, concat, type Hex } from 'viem';
import { solConn, solWallet } from './solwallet';
import { sendWallet, priorityFee, budget } from './soltx';
import { SOLANA_ID } from './solflag';
import * as O from './solanaomni';
import LP from '../config/launchpad.json';

const SOL_EID: number = Number((LP as any).solana?.eid || 30168);
const SCAN = 'https://scan.layerzero-api.com/v1';
const I_LZ_RECEIVE_TYPES = 0x601f80f89ff611ddn, I_LZ_RECEIVE = 0x50bd76216d78b308n;
export const scanLink = (srcTx: string) => `https://layerzeroscan.com/tx/${srcTx}`;

export type Inbound = { guid: Hex; srcEid: number; sender: Hex /* bytes32 */; nonce: number; payload: Hex; srcTx: string; srcChain: string; scan: string; created: number };
export type Pending = Inbound & { state: 'deliverable' | 'delivered' | 'unverified' };

const pid = () => new PublicKey(SOLANA_ID);
const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map(b => parseInt(b, 16)));
const pad32 = (a: string) => ('0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')) as Hex;
const le32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const le64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const be32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); return b; };
const be64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), false); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

function toInbound(m: any): Inbound | null {
  const p = m?.pathway, tx = m?.source?.tx;
  if (!p || !tx?.payload || +p.dstEid !== SOL_EID || !m.guid) return null;
  return { guid: m.guid, srcEid: +p.srcEid, sender: pad32(p.sender?.address || ''), nonce: +p.nonce, payload: tx.payload, srcTx: tx.txHash, srcChain: p.sender?.chain || String(p.srcEid),
    scan: scanLink(tx.txHash), created: +(tx.blockTimestamp || 0) * 1000 };
}
/** The Store's inbound messages that LayerZero Scan does not show as delivered (source sent). Newest first. */
export async function scanUndelivered(): Promise<Inbound[]> {
  if (!SOLANA_ID) return [];
  const store = O.storePda(pid()).toBase58(); const out: Inbound[] = []; let next = '';
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`${SCAN}/messages/oapp/${SOL_EID}/${store}?limit=100${next ? '&nextToken=' + encodeURIComponent(next) : ''}`).catch(() => null);
    if (!r?.ok) break; const j: any = await r.json().catch(() => null); if (!j?.data) break;
    for (const m of j.data) { if (m?.pathway?.receiver?.address !== store || m?.source?.status !== 'SUCCEEDED') continue;
      if (m?.destination?.status === 'SUCCEEDED' || m?.status?.name === 'DELIVERED') continue;
      const x = toInbound(m); if (x) out.push(x); }
    if (!j.nextToken || j.data.length < 100) break; next = j.nextToken;
  }
  return out;
}
/** One message by its source transaction hash (LayerZero Scan). */
export async function scanByTx(srcTx: string): Promise<Inbound | null> {
  const r = await fetch(`${SCAN}/messages/tx/${srcTx}`).catch(() => null); if (!r?.ok) return null;
  const j: any = await r.json().catch(() => null); return toInbound(j?.data?.[0]);
}
export function payloadHashPda(m: Inbound) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('PayloadHash'), O.storePda(pid()).toBytes(), be32(m.srcEid), hexBytes(m.sender), be64(m.nonce)], O.LZ_ENDPOINT_ID)[0];
}
/** On-chain truth: the endpoint holds keccak256(guid ‖ message) until lz_receive clears it. */
export async function onChainState(ms: Inbound[]): Promise<Pending[]> {
  if (!ms.length) return [];
  const infos = await solConn.getMultipleAccountsInfo(ms.map(payloadHashPda), 'confirmed');
  return ms.map((m, i) => { const a = infos[i]; const want = keccak256(concat([m.guid, m.payload]));
    const h = a && a.data.length >= 40 ? ('0x' + Array.from(a.data.subarray(8, 40), b => b.toString(16).padStart(2, '0')).join('')) as Hex : null;
    const state: Pending['state'] = h && h.toLowerCase() === want.toLowerCase() ? 'deliverable' : !a || /^0x0+$/.test(h || '0x0') ? (a ? 'unverified' : 'delivered') : 'unverified';
    return { ...m, state }; });
}
/** Verified-but-undelivered messages into the Store, confirmed on-chain. */
export async function stuckInbound(): Promise<Pending[]> {
  try { return (await onChainState(await scanUndelivered())).filter(m => m.state === 'deliverable'); } catch { return []; }
}

function params(m: Inbound) {
  const msg = hexBytes(m.payload);
  return cat(le32(m.srcEid), hexBytes(m.sender), le64(BigInt(m.nonce)), hexBytes(m.guid), le32(msg.length), msg, le32(0));
}
async function simulate(payer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash } = await solConn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  return (await solConn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })).value;
}
const logTail = (l?: string[] | null) => (l || []).filter(x => /rror|failed|insufficient/i.test(x)).slice(-2).join(' | ');
/** The exact lz_receive instruction for `m`, with the accounts the program itself lists (V1 lz_receive_types). */
export async function deliveryIx(m: Inbound, payer: PublicKey): Promise<TransactionInstruction> {
  const P = pid(), store = O.storePda(P), data = params(m);
  const r = await simulate(payer, [new TransactionInstruction({ programId: P, keys: [{ pubkey: store, isSigner: false, isWritable: false }], data: Buffer.from(cat(le64(I_LZ_RECEIVE_TYPES), data)) })]);
  if (r.err || !r.returnData?.data?.[0]) throw new Error(`Could not read the delivery accounts from the program: ${JSON.stringify(r.err)}${logTail(r.logs) ? ' · ' + logTail(r.logs) : ''}`);
  const rd = Uint8Array.from(atob(r.returnData.data[0]), c => c.charCodeAt(0)); const n = new DataView(rd.buffer).getUint32(0, true);
  const keys = Array.from({ length: n }, (_, i) => { const o = 4 + i * 34;
    return { pubkey: i === 0 ? payer : new PublicKey(rd.subarray(o, o + 32)), isSigner: i === 0 || !!rd[o + 32], isWritable: i === 0 || !!rd[o + 33] }; });
  return new TransactionInstruction({ programId: P, keys, data: Buffer.from(cat(le64(I_LZ_RECEIVE), data)) });
}
/** Connected Solana wallet signs + sends the delivery. Resumes from chain state: already delivered = no transaction. */
export async function deliver(m: Inbound, onStatus: (s: string) => void = () => {}): Promise<{ sig: string | null; already: boolean }> {
  if (!solWallet.pubkey || !solWallet.prov) throw new Error('Connect Phantom or Solflare first (any Solana wallet can pay the ~0.00001 SOL fee).');
  const payer = solWallet.pubkey;
  for (let attempt = 0; ; attempt++) {
    const [st] = await onChainState([m]);
    if (st.state === 'delivered') return { sig: null, already: true };
    if (st.state !== 'deliverable') throw new Error('This message is not committed on Solana yet (LayerZero verification still running). Try again in a minute.');
    onStatus('Preparing the delivery…');
    const ix = await deliveryIx(m, payer);
    const fee = await priorityFee(solConn, [O.storePda(pid())], 50_000).catch(() => 2_000); // cap: at most ~0.000015 SOL total
    const ixs = [...budget(200_000, fee), ix];
    const pre = await simulate(payer, ixs);
    if (pre.err) throw new Error(`Delivery would fail, nothing sent: ${JSON.stringify(pre.err)}${logTail(pre.logs) ? ' · ' + logTail(pre.logs) : ''}`);
    onStatus('Approve the delivery in your Solana wallet…');
    try { const sig = await sendWallet(solConn, { publicKey: payer, signTransaction: (t: any) => solWallet.prov!.signTransaction(t) }, ixs, [], { onWait: onStatus }); return { sig, already: false }; }
    catch (e: any) { if (e?.name !== 'TxExpired' || attempt >= 2) throw e; onStatus('Not confirmed in time: re-checking the chain…'); }
  }
}
