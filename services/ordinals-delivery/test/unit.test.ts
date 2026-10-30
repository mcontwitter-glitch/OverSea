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
