import { createServer } from "node:http";
import { hex } from "@scure/base";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { Config } from "./config.js";
import { secret } from "./config.js";
import { log } from "./log.js";
import { Store, type Job } from "./store.js";
import { EsploraBackend, BitcoindRpcBackend, type BtcBackend } from "./btc/backend.js";
import { btcNet, CONTRACT_BTC_NETWORK } from "./btc/networks.js";
import { buildInscription, serviceWallet, assertTaprootAddress } from "./btc/inscribe.js";
import { renderContent } from "./content.js";
import { ESCROW_ABI, STATUS, makeEvm, account, signAttestation, typedData, txidToBytes32, type AttestMsg } from "./evm.js";
import { verifyDelivery } from "./verify.js";

export function makeBackend(c: Config): BtcBackend {
  return c.btc.backend === "rpc"
    ? new BitcoindRpcBackend(c.btc.rpcUrl, c.btc.rpcUser, c.btc.rpcPass, c.btc.rpcWatchWallet, c.btc.feeRateFallback)
    : new EsploraBackend(c.btc.esploraUrl, c.btc.feeApiUrl, c.btc.feeRateFallback);
}
const backoff = (attempts: number) => Date.now() + Math.min(5000 * 2 ** attempts, 10 * 60_000);
const benign = (e: any) => /already in (block chain|mempool)|already known|txn-already|Transaction already/i.test(String(e?.message));

export async function readOrder(evm: Awaited<ReturnType<typeof makeEvm>>, escrow: Hex, id: bigint) {
  const o = await evm.pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "orders", args: [id] });
  return { buyer: o[0], deadline: Number(o[3]), status: STATUS[o[4]], collectionId: o[5], btcAddress: o[6], btcTxid: o[7], inscriptionId: o[8] };
}

export async function createService(c: Config) {
  const net = btcNet(c.btc.network);
  const btc = makeBackend(c);
  const evm = await makeEvm(c.evm.rpcUrl);
  const store = new Store(c.statePath, c.evm.startBlock);
  const btcKey = hex.decode(secret("BTC_SERVICE_PRIVKEY")!.replace(/^0x/, ""));
  const wallet = serviceWallet(btcKey, net);

  const attesterKeys = c.attest.mode === "dev"
    ? (secret("ATTESTER_PRIVATE_KEYS")!).split(",").map((s) => account(s.trim()))
    : [account(secret("ATTESTER_PRIVATE_KEY")!)];
  const submitter = account(secret("SUBMITTER_PRIVATE_KEY", true) ?? (c.attest.mode === "dev"
    ? secret("ATTESTER_PRIVATE_KEYS")!.split(",")[0] : secret("ATTESTER_PRIVATE_KEY")!));
  const submitWallet = evm.wallet(submitter);

  const onchainNet = await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "btcNetwork" });
  if (onchainNet !== CONTRACT_BTC_NETWORK[c.btc.network])
    throw new Error(`escrow btcNetwork=${onchainNet} does not match BTC_NETWORK=${c.btc.network}`);
  await btc.init?.(wallet.address);
  log.info("service up", { btcNetwork: c.btc.network, backend: c.btc.backend, serviceAddress: wallet.address,
    escrow: c.evm.escrow, chainId: evm.chainId, attesters: attesterKeys.map((a) => a.address), mode: c.attest.mode });

  // ---------- 1) ingest OrderCreated, `confirmations` blocks behind head ----------
  async function ingest() {
    const head = (await evm.pub.getBlockNumber()) - c.evm.confirmations;
    let from = store.lastBlock + 1n;
    while (from <= head) {
      const to = from + c.evm.maxBlockRange - 1n > head ? head : from + c.evm.maxBlockRange - 1n;
      const logs = await evm.pub.getContractEvents({ address: c.evm.escrow, abi: ESCROW_ABI, eventName: "OrderCreated", fromBlock: from, toBlock: to });
      for (const l of logs) {
        const a = l.args as any;
        const fresh = store.insertIfAbsent({ orderId: a.orderId.toString(), collectionId: a.collectionId, buyer: a.buyer,
          btcAddress: a.btcAddress, deadline: Number(a.deadline), state: "queued", attempts: 0, nextAttemptAt: 0 });
        if (fresh) log.info("order queued", { orderId: a.orderId, btcAddress: a.btcAddress, block: l.blockNumber });
      }
      store.setLastBlock(to);
      from = to + 1n;
    }
  }

  // ---------- signatures ----------
  async function collectSigs(m: AttestMsg): Promise<Hex[]> {
    const threshold = Number(await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "threshold" }));
    const got = new Map<string, Hex>();
    for (const a of attesterKeys) got.set(a.address.toLowerCase(), await signAttestation(a, evm.chainId, c.evm.escrow, m));
    for (const url of c.attest.peerUrls) {
      if (got.size >= threshold) break;
      try {
        const r = await fetch(`${url.replace(/\/$/, "")}/attest`, { method: "POST",
          headers: { "content-type": "application/json", ...(c.attest.peerToken ? { authorization: `Bearer ${c.attest.peerToken}` } : {}) },
          body: JSON.stringify({ orderId: m.orderId.toString(), btcTxid: m.btcTxid, inscriptionId: m.inscriptionId, sigDeadline: m.sigDeadline.toString() }) });
        const j: any = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        const signer = await recoverTypedDataAddress({ ...typedData(evm.chainId, c.evm.escrow, m), signature: j.signature });
        const ok = await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "isAttester", args: [signer] });
        if (!ok) throw new Error(`peer signer ${signer} is not an attester`);
        got.set(signer.toLowerCase(), j.signature);
        log.info("peer signature", { peer: url, signer });
      } catch (e) { log.warn("peer refused/failed", { peer: url, err: e }); }
    }
    if (got.size < threshold) throw new Error(`only ${got.size}/${threshold} signatures`);
    // contract requires strictly ascending signer addresses
    return [...got.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, threshold).map(([, s]) => s);
  }

  // ---------- 2/3) per-order state machine ----------
  async function step(j: Job) {
    const id = BigInt(j.orderId);
    switch (j.state) {
      case "queued": {
        const o = await readOrder(evm, c.evm.escrow, id);
        if (o.status !== "Pending") return store.update(j.orderId, { state: "closed", lastError: `onchain status ${o.status}` });
        try { assertTaprootAddress(j.btcAddress, net); }
        catch (e: any) { return store.update(j.orderId, { state: "failed", lastError: e.message }); } // refund path stays open
        if (o.deadline - Date.now() / 1000 < c.deadlineSafetySecs)
          return store.update(j.orderId, { state: "failed", lastError: "too close to deadline; leaving refund path" });
        const feeRate = await btc.feeRate();
        if (feeRate > c.btc.maxFeeRate) { log.warn("fee rate above cap, deferring", { feeRate, cap: c.btc.maxFeeRate });
          return store.update(j.orderId, { nextAttemptAt: Date.now() + 60_000 }); }
        const utxos = (await btc.utxos(wallet.address)).filter((u) => !store.isReserved(`${u.txid}:${u.vout}`));
        const plan = buildInscription({ priv: btcKey, net, utxos, dest: j.btcAddress, feeRate, postage: c.btc.postageSats,
          contentType: c.contentType, content: renderContent({ orderId: id, collectionId: j.collectionId, buyer: j.buyer }, c.contentTemplate) });
        store.reserve(plan.spent);
        log.info("inscription built", { orderId: j.orderId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, feeRate,
          commitFee: plan.commitFee, revealFee: plan.revealFee });
        // persist signed txs BEFORE broadcasting -> restart rebroadcasts the same pair, never double-inscribes
        return store.update(j.orderId, { state: "built", feeRate, commitHex: plan.commitHex, commitTxid: plan.commitTxid,
          revealHex: plan.revealHex, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId });
      }
      case "built":
        try { await btc.broadcast(j.commitHex!); } catch (e) { if (!benign(e)) throw e; }
        log.info("commit broadcast", { orderId: j.orderId, txid: j.commitTxid });
        return store.update(j.orderId, { state: "commit_sent" });
      case "commit_sent":
        try { await btc.broadcast(j.revealHex!); } catch (e) { if (!benign(e)) throw e; }
        log.info("reveal broadcast", { orderId: j.orderId, txid: j.revealTxid, inscriptionId: j.inscriptionId });
        return store.update(j.orderId, { state: "reveal_sent" });
      case "reveal_sent": {
        const t = await btc.tx(j.revealTxid!);
        if (!t) { log.warn("reveal missing (dropped/reorg) — rebroadcasting pair", { orderId: j.orderId });
          return store.update(j.orderId, { state: "built" }); }
        if (t.confirmations < c.btc.minConfs) { log.debug("waiting confs", { orderId: j.orderId, confs: t.confirmations });
          return store.update(j.orderId, { nextAttemptAt: Date.now() + c.evm.pollMs }); }
        log.info("reveal confirmed", { orderId: j.orderId, confs: t.confirmations });
        return store.update(j.orderId, { state: "confirmed" });
      }
      case "confirmed": {
        const o = await readOrder(evm, c.evm.escrow, id);
        if (o.status === "Attested" && o.inscriptionId === j.inscriptionId) return store.update(j.orderId, { state: "attested" });
        if (o.status !== "Pending") return store.update(j.orderId, { state: "closed", lastError: `onchain status ${o.status} after delivery — needs operator review` });
        await verifyDelivery({ btc, net, minConfs: c.btc.minConfs, revealTxid: j.revealTxid!, inscriptionId: j.inscriptionId!,
          order: { orderId: id, collectionId: j.collectionId, buyer: j.buyer, btcAddress: j.btcAddress }, contentType: c.contentType, template: c.contentTemplate });
        const m: AttestMsg = { orderId: id, btcTxid: txidToBytes32(j.revealTxid!), inscriptionId: j.inscriptionId!,
          sigDeadline: BigInt(Math.floor(Date.now() / 1000) + c.attest.sigTtlSecs) };
        const sigs = await collectSigs(m);
        const hash = await submitWallet.writeContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "attestDelivery",
          args: [m.orderId, m.btcTxid, m.inscriptionId, m.sigDeadline, sigs] });
        const r = await evm.pub.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`attestDelivery reverted ${hash}`);
        log.info("attested", { orderId: j.orderId, tx: hash });
        return store.update(j.orderId, { state: "attested", attestTx: hash });
      }
      case "attested": {
        if (!c.attest.autoRelease) return store.update(j.orderId, { state: "released", lastError: "auto-release disabled" });
        const hash = await submitWallet.writeContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "release", args: [id] });
        const r = await evm.pub.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`release reverted ${hash}`);
        log.info("released", { orderId: j.orderId, tx: hash });
        return store.update(j.orderId, { state: "released", releaseTx: hash });
      }
    }
  }

  async function tick() {
    await ingest();
    for (const j of store.active()) {
      if (j.nextAttemptAt > Date.now()) continue;
      try {
        let cur: Job | undefined = j, prev: string | undefined;
        while (cur && cur.state !== prev && cur.nextAttemptAt <= Date.now() && !["released", "failed", "closed"].includes(cur.state)) {
          prev = cur.state; cur = (await step(cur)) ?? undefined;
        }
      } catch (e: any) {
        const cur = store.get(j.orderId);
        const attempts = cur.attempts + 1;
        const broadcastStarted = !["queued", "built"].includes(cur.state) || !!cur.commitHex;
        if (attempts >= c.maxAttempts && !broadcastStarted) {
          log.error("order failed permanently; buyer can refund after deadline", { orderId: j.orderId, err: e });
          store.update(j.orderId, { state: "failed", attempts, lastError: e.message });
        } else {
          // once BTC txs exist we never give up (inscription may already be on-chain); escalate via logs
          log.warn("step failed, will retry", { orderId: j.orderId, state: cur.state, attempts, err: e.message });
          store.update(j.orderId, { attempts, lastError: e.message, nextAttemptAt: backoff(attempts) });
        }
      }
    }
  }

  async function run(signal?: AbortSignal) {
    while (!signal?.aborted) {
      try { await tick(); } catch (e) { log.error("tick failed", { err: e }); }
      await new Promise((r) => setTimeout(r, c.evm.pollMs));
    }
  }
  return { tick, run, store, wallet, btc, evm };
}

/** Peer attester: independently verifies delivery before signing. Run one per attester (3 operators). */
export async function startAttesterServer(c: Config) {
  const net = btcNet(c.btc.network);
  const btc = makeBackend(c);
  const evm = await makeEvm(c.evm.rpcUrl);
  const me = account(secret("ATTESTER_PRIVATE_KEY")!);
  const srv = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.url !== "/attest") return send(404, { error: "not found" });
    if (c.attest.peerToken && req.headers.authorization !== `Bearer ${c.attest.peerToken}`) return send(401, { error: "unauthorized" });
    let body = ""; for await (const ch of req) { body += ch; if (body.length > 10_000) return send(413, { error: "too large" }); }
    try {
      const b = JSON.parse(body);
      const orderId = BigInt(b.orderId), sigDeadline = BigInt(b.sigDeadline);
      if (sigDeadline > BigInt(Math.floor(Date.now() / 1000) + 2 * c.attest.sigTtlSecs)) throw new Error("sigDeadline too far");
      const revealTxid = String(b.btcTxid).replace(/^0x/, "");
      const o = await readOrder(evm, c.evm.escrow, orderId);
      if (o.status !== "Pending") throw new Error(`order status ${o.status}`);
      await verifyDelivery({ btc, net, minConfs: c.btc.minConfs, revealTxid, inscriptionId: b.inscriptionId,
        order: { orderId, collectionId: o.collectionId, buyer: o.buyer, btcAddress: o.btcAddress }, contentType: c.contentType, template: c.contentTemplate });
      const signature = await signAttestation(me, evm.chainId, c.evm.escrow, { orderId, btcTxid: txidToBytes32(revealTxid), inscriptionId: b.inscriptionId, sigDeadline });
      log.info("signed attestation", { orderId, signer: me.address });
      send(200, { signer: me.address, signature });
    } catch (e: any) { log.warn("refused to sign", { err: e.message }); send(400, { error: e.message }); }
  });
  await new Promise<void>((r) => srv.listen(c.attest.serverPort, "127.0.0.1", r));
  log.info("attester server listening", { port: c.attest.serverPort, signer: me.address });
  return srv;
}
