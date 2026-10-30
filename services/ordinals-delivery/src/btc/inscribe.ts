import * as btc from "@scure/btc-signer";
import * as ord from "micro-ordinals";
import { hex } from "@scure/base";
import type { Utxo } from "./backend.js";

export type Net = { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };
export const RBF_SEQUENCE = 0xfffffffd; // opt-in RBF so a stuck commit can be fee-bumped
const P2TR_DUST = 330n;

export function serviceWallet(priv: Uint8Array, net: Net) {
  const pub = btc.utils.pubSchnorr(priv);
  const pay = btc.p2tr(pub, undefined, net);
  return { pub, address: pay.address!, script: pay.script };
}

/** Strict P2TR address check for the configured network (bech32m checksum + witness v1 + 32 bytes). */
export function assertTaprootAddress(addr: string, net: Net) {
  const d = btc.Address(net).decode(addr);
  if (d.type !== "tr") throw new Error(`not a taproot address: ${addr}`);
}

export type InscriptionPlan = {
  commitHex: string; commitTxid: string; revealHex: string; revealTxid: string;
  inscriptionId: string; revealAddress: string; commitFee: bigint; revealFee: bigint;
  spent: string[]; // "txid:vout" outpoints consumed by commit
};

function buildReveal(priv: Uint8Array, reveal: ReturnType<typeof btc.p2tr>, commitTxid: string, commitAmount: bigint,
                     dest: string, postage: bigint, net: Net) {
  const tx = new btc.Transaction({ customScripts: [ord.OutOrdinalReveal] });
  tx.addInput({ ...reveal, txid: commitTxid, index: 0, sequence: RBF_SEQUENCE,
                witnessUtxo: { script: reveal.script, amount: commitAmount } });
  tx.addOutputAddress(dest, postage, net); // inscription sits on first sat of output 0 -> buyer
  tx.sign(priv);
  tx.finalize();
  return tx;
}

/**
 * Build (but do not broadcast) a commit+reveal pair:
 *   commit: service P2TR UTXOs -> [0] reveal-script P2TR (postage + revealFee), [1] change -> service
 *   reveal: commit:0 via inscription tapleaf -> [0] buyer address (postage)  => inscription id = <revealTxid>i0
 */
export function buildInscription(p: {
  priv: Uint8Array; net: Net; utxos: Utxo[]; content: Uint8Array; contentType: string;
  dest: string; feeRate: number; postage: bigint;
}): InscriptionPlan {
  assertTaprootAddress(p.dest, p.net);
  if (p.postage < P2TR_DUST) throw new Error("postage below dust");
  const w = serviceWallet(p.priv, p.net);
  const inscription = { tags: { contentType: p.contentType }, body: p.content };
  const reveal = btc.p2tr(undefined, ord.p2tr_ord_reveal(w.pub, [inscription]), p.net, false, [ord.OutOrdinalReveal]);
  const rate = BigInt(Math.ceil(p.feeRate * 1000)); // milli-sat/vB for integer math
  const feeFor = (vsize: number) => (BigInt(vsize) * rate + 999n) / 1000n;

  // reveal size does not depend on commit txid; size it with a dummy txid
  const dummy = buildReveal(p.priv, reveal, "00".repeat(32), p.postage + 100_000n, p.dest, p.postage, p.net);
  const revealFee = feeFor(dummy.vsize);
  const commitAmount = p.postage + revealFee;

  const utxos = [...p.utxos].sort((a, b) => (b.confirmed === a.confirmed ? Number(b.value - a.value) : b.confirmed ? 1 : -1));
  const chosen: Utxo[] = [];
  let total = 0n;
  for (const u of utxos) {
    chosen.push(u); total += u.value;
    const plan = tryCommit(chosen, total);
    if (plan) return plan;
  }
  throw new Error(`insufficient funds: have ${total} sats, need > ${commitAmount} + fees (service wallet ${w.address})`);

  function tryCommit(ins: Utxo[], sum: bigint): InscriptionPlan | null {
    const make = (change: bigint | null) => {
      const tx = new btc.Transaction();
      for (const u of ins) tx.addInput({ txid: u.txid, index: u.vout, sequence: RBF_SEQUENCE,
                                          witnessUtxo: { script: w.script, amount: u.value }, tapInternalKey: w.pub });
      tx.addOutputAddress(reveal.address!, commitAmount, p.net);
      if (change !== null) tx.addOutputAddress(w.address, change, p.net);
      tx.sign(p.priv); tx.finalize();
      return tx;
    };
    if (sum <= commitAmount) return null;
    const probe = make(sum - commitAmount > P2TR_DUST ? 1000n : null);
    let fee = feeFor(probe.vsize);
    let change: bigint | null = sum - commitAmount - fee;
    if (change < 0n) return null;
    if (change < 546n) { fee += change; change = null; } // dust change -> fee
    const commit = make(change);
    const commitTxid = commit.id;
    const r = buildReveal(p.priv, reveal, commitTxid, commitAmount, p.dest, p.postage, p.net);
    return {
      commitHex: commit.hex, commitTxid, revealHex: r.hex, revealTxid: r.id, inscriptionId: `${r.id}i0`,
      revealAddress: reveal.address!, commitFee: fee, revealFee, spent: ins.map((u) => `${u.txid}:${u.vout}`),
    };
  }
}

/** Decode a reveal tx and return the inscription(s) + first output address. Used by attesters to verify delivery. */
export function decodeReveal(revealHex: string, net: Net) {
  const tx = btc.Transaction.fromRaw(hex.decode(revealHex), { allowUnknownOutputs: true });
  const wit = tx.getInput(0).finalScriptWitness;
  if (!wit) throw new Error("reveal has no witness");
  const inscriptions = ord.parseWitness(wit);
  if (!inscriptions?.length) throw new Error("no inscription envelope in witness");
  const out0 = tx.getOutput(0);
  const dest = btc.Address(net).encode(btc.OutScript.decode(out0.script!));
  return { txid: tx.id, inscriptions, dest, postage: out0.amount! };
}
