import * as btc from "@scure/btc-signer";
import * as ord from "micro-ordinals";
import { hex } from "@scure/base";
import type { Utxo } from "./backend.js";

export type Net = { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };
export const RBF_SEQUENCE = 0xfffffffd; // opt-in RBF so a stuck commit can be fee-bumped
export const P2TR_DUST = 330n;

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
  commitAmount: bigint; commitVsize: number; revealVsize: number; commitChange: bigint | null; revealChange: bigint | null;
  spent: string[]; // "txid:vout" outpoints consumed by commit
  inputs: Utxo[];
};

const feeAt = (vsize: number, feeRate: number) => (BigInt(vsize) * BigInt(Math.ceil(feeRate * 1000)) + 999n) / 1000n;

function revealSpend(priv: Uint8Array, net: Net, contentType: string, content: Uint8Array) {
  const pub = btc.utils.pubSchnorr(priv);
  return btc.p2tr(undefined, ord.p2tr_ord_reveal(pub, [{ tags: { contentType }, body: content }]), net, false, [ord.OutOrdinalReveal]);
}

function buildReveal(priv: Uint8Array, reveal: ReturnType<typeof btc.p2tr>, commitTxid: string, commitAmount: bigint,
                     dest: string, postage: bigint, change: bigint | null, net: Net) {
  const tx = new btc.Transaction({ customScripts: [ord.OutOrdinalReveal] });
  tx.addInput({ ...reveal, txid: commitTxid, index: 0, sequence: RBF_SEQUENCE,
                witnessUtxo: { script: reveal.script, amount: commitAmount } });
  tx.addOutputAddress(dest, postage, net); // inscription sits on first sat of output 0 -> buyer
  if (change !== null) tx.addOutputAddress(serviceWallet(priv, net).address, change, net); // [1] service change: enables RBF-by-shrink and CPFP
  tx.sign(priv);
  tx.finalize();
  return tx;
}

/** Reveal at `feeRate` spending a commit output of `commitAmount`. Change (>= dust) returns to the service. */
export function buildRevealAtRate(p: { priv: Uint8Array; net: Net; contentType: string; content: Uint8Array; commitTxid: string;
  commitAmount: bigint; dest: string; postage: bigint; feeRate: number }) {
  const reveal = revealSpend(p.priv, p.net, p.contentType, p.content);
  const probe = buildReveal(p.priv, reveal, p.commitTxid, p.postage + P2TR_DUST + 100_000_000n, p.dest, p.postage, P2TR_DUST, p.net);
  const fee = feeAt(probe.vsize, p.feeRate);
  let change: bigint | null = p.commitAmount - p.postage - fee;
  if (change < 0n) throw new Error(`commit output ${p.commitAmount} cannot fund reveal at ${p.feeRate} sat/vB`);
  if (change < P2TR_DUST) change = null;
  const tx = buildReveal(p.priv, reveal, p.commitTxid, p.commitAmount, p.dest, p.postage, change, p.net);
  return { tx, fee: p.commitAmount - p.postage - (change ?? 0n), change, revealAddress: reveal.address! };
}

/**
 * Build (but do not broadcast) a commit+reveal pair:
 *   commit: service P2TR UTXOs -> [0] reveal-script P2TR, [1] change -> service
 *   reveal: commit:0 via inscription tapleaf -> [0] buyer (postage), [1] change -> service  => inscription id = <revealTxid>i0
 * The commit output is funded at `budgetRate` (>= feeRate) so the reveal can later be RBF-bumped up to budgetRate
 * without touching the commit; unused budget returns to the service as reveal change.
 * `inputs` + `commitAmount` pin a replacement (RBF) of an earlier pair: same inputs, same reveal funding, higher rate.
 */
export function buildInscription(p: {
  priv: Uint8Array; net: Net; utxos: Utxo[]; content: Uint8Array; contentType: string;
  dest: string; feeRate: number; postage: bigint; budgetRate?: number; inputs?: Utxo[]; commitAmount?: bigint;
}): InscriptionPlan {
  assertTaprootAddress(p.dest, p.net);
  if (p.postage < P2TR_DUST) throw new Error("postage below dust");
  const budgetRate = Math.max(p.budgetRate ?? p.feeRate, p.feeRate);
  const w = serviceWallet(p.priv, p.net);
  const reveal = revealSpend(p.priv, p.net, p.contentType, p.content);

  // reveal size does not depend on commit txid; size it with a dummy txid (with change output = worst case)
  const dummy = buildReveal(p.priv, reveal, "00".repeat(32), p.postage + 100_000n, p.dest, p.postage, 1000n, p.net);
  const commitAmount = p.commitAmount ?? p.postage + feeAt(dummy.vsize, budgetRate);

  const pool = p.inputs ?? [...p.utxos].sort((a, b) => (b.confirmed === a.confirmed ? Number(b.value - a.value) : b.confirmed ? 1 : -1));
  if (p.inputs) {
    const plan = tryCommit(p.inputs, p.inputs.reduce((s, u) => s + u.value, 0n));
    if (!plan) throw new Error("replacement inputs cannot fund the pair at this rate");
    return plan;
  }
  const chosen: Utxo[] = [];
  let total = 0n;
  for (const u of pool) {
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
    let fee = feeAt(probe.vsize, p.feeRate);
    let change: bigint | null = sum - commitAmount - fee;
    if (change < 0n) return null;
    if (change < 546n) { fee += change; change = null; } // dust change -> fee
    const commit = make(change);
    const commitTxid = commit.id;
    const r = buildRevealAtRate({ priv: p.priv, net: p.net, contentType: p.contentType, content: p.content, commitTxid,
      commitAmount, dest: p.dest, postage: p.postage, feeRate: p.feeRate });
    return {
      commitHex: commit.hex, commitTxid, revealHex: r.tx.hex, revealTxid: r.tx.id, inscriptionId: `${r.tx.id}i0`,
      revealAddress: r.revealAddress, commitFee: fee, revealFee: r.fee, commitAmount, commitVsize: commit.vsize,
      revealVsize: r.tx.vsize, commitChange: change, revealChange: r.change,
      spent: ins.map((u) => `${u.txid}:${u.vout}`), inputs: ins,
    };
  }
}

/** CPFP child: spends a service-owned output of an unconfirmed parent (reveal:1 or commit:1) back to the service,
 *  paying enough that parent+child reach `targetRate`. */
export function buildCpfp(p: { priv: Uint8Array; net: Net; parentTxid: string; vout: number; value: bigint;
  parentVsize: number; parentFee: bigint; targetRate: number }) {
  const w = serviceWallet(p.priv, p.net);
  const make = (out: bigint) => {
    const tx = new btc.Transaction();
    tx.addInput({ txid: p.parentTxid, index: p.vout, sequence: RBF_SEQUENCE, witnessUtxo: { script: w.script, amount: p.value }, tapInternalKey: w.pub });
    tx.addOutputAddress(w.address, out, p.net); tx.sign(p.priv); tx.finalize(); return tx;
  };
  const probe = make(P2TR_DUST);
  let fee = feeAt(p.parentVsize + probe.vsize, p.targetRate) - p.parentFee;
  const minChild = feeAt(probe.vsize, 1);
  if (fee < minChild) fee = minChild;
  const out = p.value - fee;
  if (out < P2TR_DUST) throw new Error(`cpfp: output ${p.value} too small for fee ${fee}`);
  const tx = make(out);
  return { hex: tx.hex, txid: tx.id, fee, vsize: tx.vsize };
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
