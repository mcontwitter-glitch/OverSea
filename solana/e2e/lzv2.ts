// The LayerZero Solana executor's discovery path (LzReceiveTypesV2), via LayerZero's own SDK:
// lz_receive_types_info([store, LzReceiveTypes PDA]) -> version 2 + accounts, then lz_receive_types_v2(those accounts)
// -> LzReceiveTypesV2Result -> the lz_receive instruction(s) the executor submits.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createUmi, publicKey } from "@metaplex-foundation/umi";
import { createWeb3JsRpc } from "@metaplex-foundation/umi-rpc-web3js";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { buildLzReceiveExecutionPlan, getLzReceiveTypesInfo } from "@layerzerolabs/lz-solana-sdk-v2/umi";
const EXECUTOR = publicKey("6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn"); // only used for the Context locator (unused by us)
export type P = { srcEid: number; sender: Uint8Array; nonce: bigint; guid: Uint8Array; message: Uint8Array };
export async function v2Plan(url: string, payer: PublicKey, receiver: PublicKey, program: PublicKey, p: P) {
  const rpc = createWeb3JsRpc(createUmi(), url);
  const params = { ...p, callerParams: new Uint8Array() };
  const info = await getLzReceiveTypesInfo(rpc, publicKey(payer.toBase58()), publicKey(receiver.toBase58()), publicKey(program.toBase58()), params);
  const plan = await buildLzReceiveExecutionPlan(rpc, EXECUTOR, publicKey(payer.toBase58()), publicKey(receiver.toBase58()), publicKey(program.toBase58()), params, info);
  return { info, plan, ixs: plan.instructions.map((i) => toWeb3JsInstruction(i)) as TransactionInstruction[] };
}
// Same program + same accounts (pubkey, signer, writable). Data is not compared: the SDK's V1 helper appends caller params with a
// different length prefix (2 bytes longer); the program reads LzReceiveParams only up to the message.
export const sameKeys = (a: TransactionInstruction, b: TransactionInstruction) => a.programId.equals(b.programId) && a.keys.length === b.keys.length
  && a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey) && k.isWritable === b.keys[i].isWritable && k.isSigner === b.keys[i].isSigner);
