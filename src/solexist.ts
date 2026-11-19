// Existing (V1) multichain collections on Solana, e.g. Island's: every id has a locked copy held by the Solana Store
// (registered + created from /deploy-solana). Read-only state for the collection page, plus the two bridge legs:
//   EVM -> Solana: the chain's MultiSeaSolanaMover.toSolana (holder approves the mover once; pays escrow move fee + LayerZero)
//   Solana -> EVM: the program's move_out, which routes existing collections back through that chain's V1 escrow.
import './btc/polyfill';
import { PublicKey } from '@solana/web3.js';
import { parseAbi, type Address } from 'viem';
import LP from '../config/launchpad.json';
import { solConn, solWallet, sendSol } from './solwallet';
import { SOLANA_ID, SOLANA_ON } from './solflag';
import * as O from './solanaomni';
const SL: any = (LP as any).solana || {};
export const SOL_EID: number = Number(SL.eid || 30168);
const MAX_LZ_FEE = BigInt(SL.maxLzFeeLamports || 50_000_000);
export const MAX_LZ_SOL = Number(MAX_LZ_FEE) / 1e9;
const SEND_LIB = new PublicKey(SL.sendLib || '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH');
export const MOVE_FEE_SOL = Number(SL.moveFeeLamports ?? 1_000_000) / 1e9;
const PID = () => new PublicKey(SOLANA_ID);
export const moverOf = (k: string) => (SL.v2?.movers?.[k] || '') as Address;
export const MOVER = parseAbi(['function enabled(bytes32) view returns (bool)', 'function quoteToSolana(bytes32,uint256,bytes32) view returns (uint256,uint256)', 'function toSolana(bytes32,uint256,bytes32) payable returns (bytes32)']);
export const DROP_CID = parseAbi(['function collectionId() view returns (bytes32)']);
export const isSolAddr = (s: string) => { try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && new PublicKey(s).toBytes().length === 32; } catch { return false; } };
export const sol32 = (s: string) => O.hexOf(new PublicKey(s).toBytes());

export const collectionOf = (cid: string) => O.collectionPda(cid, PID()).toBase58();
/** Does this collection id have its Solana side (registered drop)? */
export async function hasSolanaSide(cid: string) { if (!SOLANA_ON || !SOLANA_ID) return false; try { return !!(await solConn.getAccountInfo(O.dropPda(cid, PID()))); } catch { return false; } }
/** Owner of every Solana copy: 'locked' = held by the Store (escrow), a base58 owner = active on Solana, null = not created. */
export async function solCopies(cid: string, ids: number[]): Promise<Map<number, string | null>> {
  const store = O.storePda(PID()); const keys = ids.map(id => O.assetPda(cid, id, PID()));
  const out = new Map<number, string | null>(); const infos = await solConn.getMultipleAccountsInfo(keys);
  ids.forEach((id, i) => { const a = infos[i]; const o = a ? O.coreAssetOwner(a.data) : null; out.set(id, o ? (o.equals(store) ? 'locked' : o.toBase58()) : null); });
  return out;
}
async function sendAccounts(payer: PublicKey, dstEid: number, receiver: string) {
  const { EndpointProgram, UlnProgram } = await import('@layerzerolabs/lz-solana-sdk-v2');
  const ep = new EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID); const uln = new UlnProgram.Uln(SEND_LIB);
  return ep.getSendIXAccountMetaForCPI(solConn as any, payer, { sender: O.storePda(PID()).toBytes(), dstEid, receiver } as any, uln as any) as any;
}
/** Solana -> EVM: the connected Solana wallet sends copy `id` to `evmTo` on the chain with LayerZero id `dstEid`, whose V1
 *  escrow (`v1Escrow`) releases it. Pays the Solana move fee + the LayerZero fee (capped; the libraries charge their quote). */
export async function solToEvm(cid: string, id: number, dstEid: number, v1Escrow: string, evmTo: string): Promise<string> {
  if (!solWallet.pubkey) throw new Error('Connect Phantom or Solflare first.');
  const st = await solConn.getAccountInfo(O.storePda(PID())); if (!st) throw new Error('Solana program not initialised.');
  const store = O.decodeStore(st.data);
  const accts = await sendAccounts(solWallet.pubkey, dstEid, v1Escrow);
  return sendSol([O.moveOutIx({ holder: solWallet.pubkey, cid, tokenId: id, dstEid, to: O.evmTo32(evmTo), nativeFee: MAX_LZ_FEE, feeRecipient: store.feeRecipient, sendAccounts: accts }, PID())], 400_000);
}
