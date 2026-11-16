// /deploy-solana, step 3: set up the MultiSea Solana program (settings + links to every EVM chain) with ONE wallet
// approval ("Approve all"). Every transaction is checked on-chain first, so a partly-done setup only signs what is missing.
// Transactions (each atomic):
//   init_store (settings + LayerZero OApp registration)
//   per chain: set_peer (V2 escrow) + LayerZero send/receive library + nonce + library config accounts
//   per chain: LayerZero DVN config (2-of-2, same policy as the EVM chains) - ULN302 only
//   per chain: set_mover (existing collections: the chain's MultiSeaSolanaMover + V1 escrow) + their nonces
// Pure module (no DOM): the page and the local-validator test both use it.
import { Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { priorityFee, budget, sendUntilConfirmed, TxExpired } from './soltx';
import { Buffer } from 'buffer';
import { EndpointProgram, EndpointPDADeriver, UlnProgram, SimpleMessageLibProgram, SetConfigType } from '@layerzerolabs/lz-solana-sdk-v2';
import * as O from './solanaomni';

// Solana-side DVNs (LayerZero metadata): LayerZero Labs + Horizen, the same 2-of-2 policy as the EVM chains.
export const SOL_DVNS = ['4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', 'HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX'];
export const ULN302 = '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH';
export const SEND_CONF = 32;
export type Link = { k: string; name: string; eid: number; escrow: string; mover?: string; v1?: string; confirmations: number };
export type SetupCfg = { pid: PublicKey; admin: PublicKey; localEid: number; approver: string; feeRecipient: PublicKey; feeBps: number; moveFee: bigint;
  links: Link[]; msgLib: PublicKey; /** false only on a local validator with the simple message lib (no DVN config there) */ dvnConfig: boolean };
export type SetupItem = { id: string; label: string; done: boolean; ixs?: () => Promise<TransactionInstruction[]> };
export type Signer = { publicKey: PublicKey; signAllTransactions(txs: Transaction[]): Promise<Transaction[]> };

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const dvns = () => SOL_DVNS.map(a => new PublicKey(a)).sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
const ulnCfg = (conf: number) => ({ confirmations: conf, requiredDvnCount: 2, optionalDvnCount: 0, optionalDvnThreshold: 0, requiredDvns: dvns(), optionalDvns: [] as PublicKey[] });
const ulnOk = (u: any, conf: number) => !!u && Number(u.confirmations) === conf && u.requiredDvnCount === 2 && u.requiredDvns.length === 2 && u.requiredDvns.map((x: PublicKey) => x.toBase58()).sort().join() === dvns().map(x => x.toBase58()).sort().join();

/** What the setup still needs, read from the chain. */
export async function setupPlan(conn: Connection, c: SetupCfg): Promise<SetupItem[]> {
  const ep = new EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID); const der = new EndpointPDADeriver(O.LZ_ENDPOINT_ID);
  const isUln = c.msgLib.toBase58() === ULN302; const lib: any = isUln ? new UlnProgram.Uln(c.msgLib) : new SimpleMessageLibProgram.SimpleMessageLib(c.msgLib);
  const store = O.storePda(c.pid);
  const keys: PublicKey[] = [store];
  for (const l of c.links) { const p32 = O.evmTo32(l.escrow);
    keys.push(O.peerPda(l.eid, c.pid), der.sendLibraryConfig(store, l.eid)[0], der.receiveLibraryConfig(store, l.eid)[0], der.nonce(store, l.eid, p32)[0]); }
  const acc = await conn.getMultipleAccountsInfo(keys);
  const items: SetupItem[] = [{ id: 'store', label: `Save the settings (fee ${c.feeBps / 100}% to ${c.feeRecipient.toBase58()}, approver ${c.approver}, move fee ${Number(c.moveFee) / 1e9} SOL)`, done: !!acc[0],
    ixs: async () => [O.initStoreIx({ payer: c.admin, admin: c.admin, localEid: c.localEid, approver: c.approver, feeRecipient: c.feeRecipient, feeBps: c.feeBps, moveFee: c.moveFee,
      registerAccounts: ep.getRegisterOappIxAccountMetaForCPI(c.admin, store) as any }, c.pid)] }];
  for (const [i, l] of c.links.entries()) {
    const [peer, sendL, recvL, nonce] = acc.slice(1 + i * 4, 5 + i * 4); const p32 = O.evmTo32(l.escrow);
    const peerOk = !!peer && eq(O.decodePeer(peer.data).address, p32);
    items.push({ id: 'link-' + l.k, label: `Link ${l.name}: peer ${l.escrow} + LayerZero libraries`, done: peerOk && !!sendL && !!recvL && !!nonce,
      ixs: async () => [...(peerOk ? [] : [O.setPeerIx(c.admin, l.eid, p32, c.pid)]), ...(sendL ? [] : [ep.initSendLibrary(c.admin, store, l.eid)]), ...(recvL ? [] : [ep.initReceiveLibrary(c.admin, store, l.eid)]),
        ...(nonce ? [] : [ep.initOAppNonce(c.admin, l.eid, store, p32)]), ...(sendL ? [] : [ep.initOAppConfig(c.admin, lib, c.admin, store, l.eid)])] });
    if (c.dvnConfig && isUln) {
      const [s, r] = await Promise.all([lib.getSendConfigState(conn, store, l.eid).catch(() => null), lib.getReceiveConfigState(conn, store, l.eid).catch(() => null)]);
      items.push({ id: 'dvn-' + l.k, label: `${l.name}: security settings (2-of-2 DVNs, ${SEND_CONF} / ${l.confirmations} confirmations)`, done: ulnOk(s?.uln, SEND_CONF) && ulnOk(r?.uln, l.confirmations),
        ixs: async () => [await ep.setOappConfig(conn as any, c.admin, store, c.msgLib, l.eid, { configType: SetConfigType.SEND_ULN, value: ulnCfg(SEND_CONF) } as any),
          await ep.setOappConfig(conn as any, c.admin, store, c.msgLib, l.eid, { configType: SetConfigType.RECEIVE_ULN, value: ulnCfg(l.confirmations) } as any)] });
    }
    if (l.mover && l.v1) { const mv = O.evmTo32(l.mover), v1 = O.evmTo32(l.v1);
      const p = peer ? O.decodePeer(peer.data) : null;
      items.push({ id: 'mover-' + l.k, label: `${l.name}: existing collections (mover ${l.mover}, V1 escrow ${l.v1})`, done: !!p && eq(p.mover, mv) && eq(p.v1Escrow, v1),
        ixs: async () => { const [n1, n2] = await conn.getMultipleAccountsInfo([der.nonce(store, l.eid, mv)[0], der.nonce(store, l.eid, v1)[0]]);
          return [O.setMoverIx(c.admin, l.eid, mv, v1, c.pid), ...(n1 ? [] : [ep.initOAppNonce(c.admin, l.eid, store, mv)]), ...(n2 ? [] : [ep.initOAppNonce(c.admin, l.eid, store, v1)])]; } });
    }
  }
  return items;
}

/** Signs every missing transaction with ONE wallet approval, then sends them in order (priority fee, polled confirmation). */
export async function runSetup(conn: Connection, w: Signer, items: SetupItem[], on: (m: string) => void = () => {}) {
  const todo = items.filter(i => !i.done && i.ixs); if (!todo.length) return [];
  const price = await priorityFee(conn, [w.publicKey], 20_000);
  const ixs = await Promise.all(todo.map(it => it.ixs!()));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'); // fresh, right before the approval
  const txs = ixs.map(x => new Transaction({ feePayer: w.publicKey, blockhash, lastValidBlockHeight }).add(...budget(400_000, price), ...x));
  on(`Approve ${txs.length} transaction${txs.length > 1 ? 's' : ''} in your wallet ("Approve all")`);
  const signed = await w.signAllTransactions(txs); const sigs: string[] = [];
  for (const [i, tx] of signed.entries()) {
    try { sigs.push(await sendUntilConfirmed(conn, tx, { lastValidBlockHeight: tx.recentBlockhash === blockhash ? lastValidBlockHeight : undefined, onWait: on })); }
    catch (e) { if (e instanceof TxExpired) throw new Error('The network is busy and some setup transactions were not confirmed. Tap "Set up program" again: only the missing ones are signed.'); throw new Error(`${todo[i].label}: ${(e as any)?.message || e}`); }
    on(`✓ ${todo[i].label}`);
  }
  return sigs;
}
