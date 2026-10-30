import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { hex, utf8 } from "@scure/base";
import { keccak256, encodeAbiParameters, concat, toBytes, hashTypedData, recoverTypedDataAddress } from "viem";
import { buildInscription, decodeReveal, serviceWallet, assertTaprootAddress } from "../src/btc/inscribe.js";
import { REGTEST } from "../src/btc/networks.js";
import { typedData, account, signAttestation, txidToBytes32 } from "../src/evm.js";
import { renderContent } from "../src/content.js";
import { Store } from "../src/store.js";

const svcKey = hex.decode("11".repeat(32));
const buyerAddr = serviceWallet(hex.decode("22".repeat(32)), REGTEST).address;

test("commit/reveal build, sign, parse and envelope decodes to content", () => {
  const w = serviceWallet(svcKey, REGTEST);
  assert.match(w.address, /^bcrt1p/);
  const content = renderContent({ orderId: 7n, collectionId: "0x" + "ab".repeat(32), buyer: "0xB0B" });
  const p = buildInscription({ priv: svcKey, net: REGTEST, dest: buyerAddr, feeRate: 3, postage: 546n, contentType: "image/svg+xml", content,
    utxos: [{ txid: "aa".repeat(32), vout: 1, value: 50_000n, confirmed: true }] });
  const commit = btc.Transaction.fromRaw(hex.decode(p.commitHex));
  assert.equal(commit.id, p.commitTxid);
  assert.equal(commit.getOutput(0).amount, 546n + p.revealFee);
  assert.equal(btc.Address(REGTEST).encode(btc.OutScript.decode(commit.getOutput(0).script!)), p.revealAddress);
  assert.equal(commit.getOutput(1).amount, 50_000n - 546n - p.revealFee - p.commitFee); // change conserved
  const r = btc.Transaction.fromRaw(hex.decode(p.revealHex), { allowUnknownOutputs: true });
  assert.equal(hex.encode(r.getInput(0).txid!), p.commitTxid);
  assert.ok(Number(p.revealFee) >= r.vsize * 3, "reveal pays >= feeRate");
  assert.ok(Number(p.commitFee) >= commit.vsize * 3, "commit pays >= feeRate");
  const d = decodeReveal(p.revealHex, REGTEST);
  assert.equal(d.dest, buyerAddr);
  assert.equal(d.postage, 546n);
  assert.equal(d.inscriptions[0].tags.contentType, "image/svg+xml");
  assert.equal(utf8.encode(d.inscriptions[0].body), utf8.encode(content));
  assert.equal(p.inscriptionId, `${r.id}i0`);
  assert.deepEqual(p.spent, ["aa".repeat(32) + ":1"]);
});

test("insufficient funds and non-taproot destinations are rejected", () => {
  const content = utf8.decode("x");
  assert.throws(() => buildInscription({ priv: svcKey, net: REGTEST, dest: buyerAddr, feeRate: 2, postage: 546n, contentType: "text/plain", content,
    utxos: [{ txid: "aa".repeat(32), vout: 0, value: 600n, confirmed: true }] }), /insufficient/);
  const p2wpkh = btc.p2wpkh(secp256k1.getPublicKey(svcKey, true), REGTEST).address!;
  assert.throws(() => assertTaprootAddress(p2wpkh, REGTEST), /not a taproot/);
  assert.throws(() => assertTaprootAddress(buyerAddr.slice(0, -1) + (buyerAddr.endsWith("q") ? "p" : "q"), REGTEST)); // bad checksum
});

test("EIP-712 digest matches SketchEscrow encoding and signer recovers", async () => {
  const escrow = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
  const m = { orderId: 1n, btcTxid: txidToBytes32("cd".repeat(32)), inscriptionId: "cd".repeat(32) + "i0", sigDeadline: 1_900_000_000n };
  const TYPEHASH = keccak256(toBytes("Attest(uint256 orderId,bytes32 btcTxid,bytes32 inscriptionIdHash,uint256 deadline)"));
  const DOMAIN_TYPEHASH = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const ds = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [DOMAIN_TYPEHASH, keccak256(toBytes("MultiSeaOrdinalEscrow")), keccak256(toBytes("1")), 31337n, escrow]));
  const sh = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [TYPEHASH, m.orderId, m.btcTxid, keccak256(toBytes(m.inscriptionId)), m.sigDeadline]));
  const manual = keccak256(concat(["0x1901", ds, sh]));
  assert.equal(hashTypedData(typedData(31337, escrow, m)), manual);
  const a = account("0x" + "01".repeat(32));
  const sig = await signAttestation(a, 31337, escrow, m);
  assert.equal(await recoverTypedDataAddress({ ...typedData(31337, escrow, m), signature: sig }), a.address);
});

test("store is idempotent and survives reload", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ms-")), "state.json");
  const s = new Store(path, 10n);
  const j = { orderId: "1", collectionId: "0x", buyer: "0x", btcAddress: buyerAddr, deadline: 0, state: "queued" as const, attempts: 0, nextAttemptAt: 0 };
  assert.equal(s.insertIfAbsent(j), true);
  assert.equal(s.insertIfAbsent(j), false);
  s.update("1", { state: "built", commitHex: "00" });
  s.reserve(["a:0"]);
  const s2 = new Store(path, 0n);
  assert.equal(s2.get("1").state, "built");
  assert.equal(s2.lastBlock, 9n);
  assert.ok(s2.isReserved("a:0"));
});

// ---------------- v0.4.18: SPV (B2), fee bumping (B7), fee budget (B13) ----------------
import { readFileSync } from "node:fs";
import { checkProof, merkleBranch, merkleRootFromBranch, displayToInternal, stripWitness, hash256, rev } from "../src/btc/spv.js";
import { decideBump, budgetSats, satsToUsdc6, quoteUsdc6, budgetRate, signalsRbf } from "../src/feebump.js";
import { buildRevealAtRate, buildCpfp } from "../src/btc/inscribe.js";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/btc-mainnet-973775.json", import.meta.url), "utf8"));

test("SPV: real mainnet block 973775 proof passes local check (txid, P2TR output 0, merkle root, header chain)", () => {
  const program = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(FIX.address)).slice(2));
  const proof = { rawTx: FIX.rawTx, index: BigInt(FIX.index), siblings: FIX.siblings, headers: FIX.headers };
  assert.equal(checkProof(proof, FIX.txid, program), true);
  assert.throws(() => checkProof(proof, FIX.txid, "00".repeat(32)), /taproot program/);
  assert.throws(() => checkProof({ ...proof, index: proof.index ^ 1n }, FIX.txid, program), /merkle root/);
});

test("SPV: witness stripping reproduces the fixture's non-witness bytes and txid", () => {
  const raw = stripWitness(readFileSync(new URL("./fixtures/btc-mainnet-973775-tx.hex", import.meta.url), "utf8").trim());
  assert.equal(`0x${hex.encode(raw)}`, FIX.rawTx);
  assert.equal(hex.encode(rev(hash256(raw))), FIX.txid);
});

test("SPV: merkle branch builder matches full-tree root for every leaf, odd and even sizes", () => {
  for (const n of [1, 2, 3, 5, 8, 11]) {
    const ids = Array.from({ length: n }, (_, i) => hex.encode(hash256(new Uint8Array([i, n]))));
    let level: Uint8Array[] = ids.map(displayToInternal);
    while (level.length > 1) { if (level.length % 2) level.push(level[level.length - 1]);
      const nx: Uint8Array[] = []; for (let k = 0; k < level.length; k += 2) nx.push(hash256(new Uint8Array([...level[k], ...level[k + 1]]))); level = nx; }
    for (let i = 0; i < n; i++)
      assert.equal(hex.encode(merkleRootFromBranch(displayToInternal(ids[i]), merkleBranch(ids, i), i)), hex.encode(level[0]));
  }
});

test("fee budget: USDC<->sats conversions round safely and budgetRate respects MAX_FEE_RATE", () => {
  // $100,000 = 10,000,000 cents: 1 USDC (1e6) buys 1000 sats
  assert.equal(budgetSats(1_000_000n, 10_000_000n), 1000n);
  assert.equal(satsToUsdc6(1000n, 10_000_000n), 1_000_000n);
  assert.equal(satsToUsdc6(1n, 10_000_000n), 1000n);
  assert.equal(budgetSats(5n, 0n), 0n);
  const q = quoteUsdc6({ commitVsize: 154, revealVsize: 200, postage: 546n, quoteRate: 10, btcUsdCents: 10_000_000n, headroomPct: 0 });
  assert.equal(q.sats, 3540n + 546n);
  assert.equal(budgetRate({ budgetSats: 4086n, postage: 546n, commitVsize: 154, revealVsize: 200, maxFeeRate: 200 }), 10);
  assert.equal(budgetRate({ budgetSats: 10_000_000n, postage: 546n, commitVsize: 154, revealVsize: 200, maxFeeRate: 50 }), 50);
  assert.equal(budgetRate({ budgetSats: 100n, postage: 546n, commitVsize: 154, revealVsize: 200, maxFeeRate: 50 }), 0);
});

test("bump decision: RBF pair -> RBF reveal -> CPFP, never above budget/cap", () => {
  const base = { commitConfirmed: false, revealConfirmed: false, commitSignalsRbf: true, revealSignalsRbf: true, paidRate: 5,
    marketRate: 20, maxFeeRate: 50, budgetRate: 30, hasRevealChange: true, hasCommitChange: true };
  assert.deepEqual(decideBump(base), { action: "rbf-pair", rate: 20 });
  assert.deepEqual(decideBump({ ...base, commitConfirmed: true }), { action: "rbf-reveal", rate: 20 });
  assert.deepEqual(decideBump({ ...base, revealSignalsRbf: false }), { action: "cpfp", rate: 20, via: "reveal:1" });
  assert.deepEqual(decideBump({ ...base, revealSignalsRbf: false, hasRevealChange: false }), { action: "cpfp", rate: 20, via: "commit:1" });
  assert.deepEqual(decideBump({ ...base, marketRate: 100 }), { action: "rbf-pair", rate: 30 });
  assert.equal(decideBump({ ...base, budgetRate: 5 }).action, "over-budget");
  assert.equal(decideBump({ ...base, marketRate: 5.5 }).action, "none");
  assert.equal(decideBump({ ...base, revealConfirmed: true }).action, "none");
  assert.equal(signalsRbf([0xfffffffd]), true); assert.equal(signalsRbf([0xffffffff, 0xfffffffe]), false);
});

test("reveal change output + RBF reveal + CPFP builders", () => {
  const priv = secp256k1.utils.randomSecretKey();
  const w = serviceWallet(priv, REGTEST);
  const dest = serviceWallet(secp256k1.utils.randomSecretKey(), REGTEST).address;
  const plan = buildInscription({ priv, net: REGTEST, utxos: [{ txid: "11".repeat(32), vout: 0, value: 200_000n, confirmed: true }],
    content: utf8.decode("hi"), contentType: "text/plain", dest, feeRate: 2, budgetRate: 40, postage: 546n });
  assert.ok(plan.revealChange! > 0n, "budget headroom returns as reveal change");
  const rv = btc.Transaction.fromRaw(hex.decode(plan.revealHex), { allowUnknownOutputs: true, disableScriptCheck: true });
  assert.equal(rv.outputsLength, 2);
  assert.equal(hex.encode(rv.getOutput(1).script!), hex.encode(w.script));
  assert.equal(signalsRbf([rv.getInput(0).sequence!]), true);
  // RBF reveal at 30 sat/vB from the same commit output: same postage, higher fee, still inscribes on output 0
  const r2 = buildRevealAtRate({ priv, net: REGTEST, contentType: "text/plain", content: utf8.decode("hi"), commitTxid: plan.commitTxid,
    commitAmount: plan.commitAmount, dest, postage: 546n, feeRate: 30 });
  assert.ok(r2.fee > plan.revealFee && r2.tx.id !== plan.revealTxid);
  assert.equal(decodeReveal(r2.tx.hex, REGTEST).inscriptions[0].tags.contentType, "text/plain");
  assert.throws(() => buildRevealAtRate({ priv, net: REGTEST, contentType: "text/plain", content: utf8.decode("hi"), commitTxid: plan.commitTxid,
    commitAmount: plan.commitAmount, dest, postage: 546n, feeRate: 1000 }), /cannot fund/);
  // RBF pair: same inputs + same commit funding at higher rate
  const p2 = buildInscription({ priv, net: REGTEST, utxos: [], inputs: plan.inputs, commitAmount: plan.commitAmount,
    content: utf8.decode("hi"), contentType: "text/plain", dest, feeRate: 10, postage: 546n });
  assert.deepEqual(p2.spent, plan.spent); assert.ok(p2.commitFee > plan.commitFee);
  // CPFP from reveal:1
  const ch = buildCpfp({ priv, net: REGTEST, parentTxid: plan.revealTxid, vout: 1, value: plan.revealChange!, parentVsize: plan.revealVsize,
    parentFee: plan.revealFee, targetRate: 20 });
  assert.ok(ch.fee + plan.revealFee >= BigInt(Math.ceil((plan.revealVsize + ch.vsize) * 20)));
});
