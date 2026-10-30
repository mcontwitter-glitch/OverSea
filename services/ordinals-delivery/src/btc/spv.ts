import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";

/** SPV proof exactly as MultiSeaOrdinalEscrow.attestDelivery expects it (spec B2). */
export type SpvProof = { rawTx: `0x${string}`; index: bigint; siblings: `0x${string}`; headers: `0x${string}` };

export const hash256 = (b: Uint8Array) => sha256(sha256(b));
export const rev = (b: Uint8Array) => Uint8Array.from(b).reverse();
export const displayToInternal = (h: string) => rev(hex.decode(h));

/** Non-witness serialization (hash256 of it == txid). */
export function stripWitness(rawHex: string): Uint8Array {
  const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  return tx.toBytes(true, false);
}

/** Merkle branch (internal-order siblings, leaf upward) for leaf `index` given all block txids (display hex). */
export function merkleBranch(txidsDisplay: string[], index: number): Uint8Array[] {
  if (index < 0 || index >= txidsDisplay.length) throw new Error("index out of range");
  let level: Uint8Array[] = txidsDisplay.map(displayToInternal);
  const out: Uint8Array[] = [];
  let i = index;
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    out.push(level[i ^ 1]);
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(hash256(new Uint8Array([...level[k], ...level[k + 1]])));
    level = next; i >>= 1;
  }
  return out;
}

export function merkleRootFromBranch(leaf: Uint8Array, siblings: Uint8Array[], index: number) {
  let h = leaf;
  for (const s of siblings) { h = index & 1 ? hash256(new Uint8Array([...s, ...h])) : hash256(new Uint8Array([...h, ...s])); index >>= 1; }
  return h;
}

export function makeProof(rawNoWitness: Uint8Array, index: number, siblings: Uint8Array[], headers: Uint8Array[]): SpvProof {
  const cat = (xs: Uint8Array[]) => `0x${xs.map((x) => hex.encode(x)).join("")}` as `0x${string}`;
  return { rawTx: `0x${hex.encode(rawNoWitness)}`, index: BigInt(index), siblings: cat(siblings), headers: cat(headers) };
}

/** Local pre-check mirroring the contract (txid, output-0 program, merkle root vs header 0, header chaining). */
export function checkProof(p: SpvProof, expectedTxidDisplay: string, program32Hex: string) {
  const raw = hex.decode(p.rawTx.slice(2));
  const txid = hash256(raw);
  if (hex.encode(rev(txid)) !== expectedTxidDisplay) throw new Error("spv: txid mismatch");
  const tx = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  if (hex.encode(tx.getOutput(0).script!) !== "5120" + program32Hex) throw new Error("spv: output 0 does not pay the order's taproot program");
  const sib = hex.decode(p.siblings.slice(2)); const hs = hex.decode(p.headers.slice(2));
  const siblings = Array.from({ length: sib.length / 32 }, (_, i) => sib.slice(i * 32, i * 32 + 32));
  const root = merkleRootFromBranch(txid, siblings, Number(p.index));
  if (hex.encode(root) !== hex.encode(hs.slice(36, 68))) throw new Error("spv: merkle root mismatch");
  for (let i = 1; i < hs.length / 80; i++)
    if (hex.encode(hs.slice(i * 80 + 4, i * 80 + 36)) !== hex.encode(hash256(hs.slice((i - 1) * 80, i * 80)))) throw new Error("spv: headers not chained");
  return true;
}
