import { createServer } from "node:http";
import { hex } from "@scure/base";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { Config } from "./config.js";
import { secret } from "./config.js";
import { log } from "./log.js";
import { Store, type Job } from "./store.js";
import { EsploraBackend, BitcoindRpcBackend, type BtcBackend } from "./btc/backend.js";
import { btcNet, CONTRACT_BTC_NETWORK } from "./btc/networks.js";
import { buildInscription, buildRevealAtRate, buildCpfp, serviceWallet, assertTaprootAddress } from "./btc/inscribe.js";
import type { Utxo } from "./btc/backend.js";
import { checkProof } from "./btc/spv.js";
import { decideBump, budgetSats, quoteUsdc6, budgetRate, signalsRbf } from "./feebump.js";
import * as btcsig from "@scure/btc-signer";
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
  const o = await evm.pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getOrder", args: [id] });
  return { buyer: o.buyer, token: o.token, amount: o.amount, inscriptionFee: o.inscriptionFee, createdAt: Number(o.createdAt),
    deadline: Number(o.deadline), status: STATUS[o.status], collectionId: o.collectionId, btcProgram: o.btcProgram,
    btcAddress: o.btcAddress, btcTxid: o.btcTxid, inscriptionId: o.inscriptionId };
}

/** BTC/USD in cents: BTC_USD_PRICE override, else the configured prices API (mempool.space /api/v1/prices -> {USD}). */
export async function btcUsdCents(c: Config): Promise<bigint> {
  if (c.btc.btcUsdPrice && c.btc.btcUsdPrice > 0) return BigInt(Math.round(c.btc.btcUsdPrice * 100));
  const r = await fetch(c.btc.priceApiUrl);
  if (!r.ok) throw new Error(`price api HTTP ${r.status}`);
  const usd = Number((await r.json() as any).USD);
  if (!(usd > 1000 && usd < 10_000_000)) throw new Error(`implausible BTC/USD ${usd}`);
  return BigInt(Math.round(usd * 100));
}
const toUtxo = (u: { txid: string; vout: number; value: string; confirmed: boolean }): Utxo => ({ ...u, value: BigInt(u.value) });
const seqs = (rawHex: string) => { const t = btcsig.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  return Array.from({ length: t.inputsLength }, (_, i) => t.getInput(i).sequence ?? 0xffffffff); };

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
  if (c.deadlineSafetySecs >= c.deliveryWindowSecs)
    throw new Error(`DEADLINE_SAFETY_SECS (${c.deadlineSafetySecs}) must be < DELIVERY_WINDOW_SECS (${c.deliveryWindowSecs})`);
  for (const cid of c.collectionIds) {
    const col = await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "collections", args: [cid as Hex] });
    if (col[4] !== c.deliveryWindowSecs) throw new Error(`collection ${cid} deliveryWindow=${col[4]} != DELIVERY_WINDOW_SECS=${c.deliveryWindowSecs}`);
  }
  const onchainConfs = Number(await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "minBtcConfs" }));
  const needConfs = Math.max(c.btc.minConfs, onchainConfs);
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

  // ---------- B7: stuck-tx handling (RBF pair / RBF reveal / CPFP), bounded by budget + MAX_FEE_RATE ----------
  async function maybeBump(j: Job) {
    const commit = await btc.tx(j.commitTxid!);
    const market = await btc.feeRate();
    const d = decideBump({ commitConfirmed: !!commit && commit.confirmations > 0, revealConfirmed: false,
      commitSignalsRbf: signalsRbf(seqs(j.commitHex!)), revealSignalsRbf: signalsRbf(seqs(j.revealHex!)),
      paidRate: Math.max(j.feeRate ?? 0, ...(j.cpfp ?? []).map((x) => x.feeRate)), marketRate: market, maxFeeRate: c.btc.maxFeeRate,
      budgetRate: j.budgetRate ?? 0, hasRevealChange: !!j.revealChange, hasCommitChange: !!j.commitChange });
    log.info("bump decision", { orderId: j.orderId, ...d, market });
    if (d.action === "none" || d.action === "over-budget") return store.update(j.orderId, { lastBroadcastAt: Date.now() });
    const content = renderContent({ orderId: BigInt(j.orderId), collectionId: j.collectionId, buyer: j.buyer }, c.contentTemplate);
    if (d.action === "rbf-pair") {
      const plan = buildInscription({ priv: btcKey, net, utxos: [], inputs: j.inputs!.map(toUtxo), commitAmount: BigInt(j.commitAmount!),
        dest: j.btcAddress, feeRate: d.rate, postage: c.btc.postageSats, contentType: c.contentType, content });
      const alt = { commitTxid: plan.commitTxid, commitHex: plan.commitHex, revealTxid: plan.revealTxid, revealHex: plan.revealHex, feeRate: d.rate };
      store.update(j.orderId, { alts: [...(j.alts ?? []), alt] }); // persist before broadcast
      await btc.broadcast(plan.commitHex); try { await btc.broadcast(plan.revealHex); } catch (e) { if (!benign(e)) throw e; }
      return store.update(j.orderId, { ...alt, inscriptionId: plan.inscriptionId, revealFee: plan.revealFee.toString(), commitFee: plan.commitFee.toString(),
        revealChange: plan.revealChange?.toString() ?? null, commitChange: plan.commitChange?.toString() ?? null, bumps: (j.bumps ?? 0) + 1, lastBroadcastAt: Date.now() });
    }
    if (d.action === "rbf-reveal") {
      const r = buildRevealAtRate({ priv: btcKey, net, contentType: c.contentType, content, commitTxid: j.commitTxid!, commitAmount: BigInt(j.commitAmount!),
        dest: j.btcAddress, postage: c.btc.postageSats, feeRate: d.rate });
      const alt = { commitTxid: j.commitTxid!, commitHex: j.commitHex!, revealTxid: r.tx.id, revealHex: r.tx.hex, feeRate: d.rate };
      store.update(j.orderId, { alts: [...(j.alts ?? []), alt] });
      await btc.broadcast(r.tx.hex);
      return store.update(j.orderId, { ...alt, inscriptionId: `${r.tx.id}i0`, revealFee: r.fee.toString(), revealChange: r.change?.toString() ?? null,
        bumps: (j.bumps ?? 0) + 1, lastBroadcastAt: Date.now() });
    }
    // cpfp
    const viaReveal = d.via === "reveal:1";
    const child = buildCpfp({ priv: btcKey, net, parentTxid: viaReveal ? j.revealTxid! : j.commitTxid!, vout: 1,
      value: BigInt(viaReveal ? j.revealChange! : j.commitChange!), parentVsize: viaReveal ? j.revealVsize! : j.commitVsize!,
      parentFee: BigInt(viaReveal ? j.revealFee! : j.commitFee!), targetRate: d.rate });
    const spent = BigInt(j.commitFee!) + BigInt(j.revealFee!) + c.btc.postageSats + child.fee;
    if (spent > BigInt(j.budgetSats ?? "0")) { log.warn("cpfp would exceed budget; not bumping", { orderId: j.orderId, spent });
      return store.update(j.orderId, { lastBroadcastAt: Date.now() }); }
    store.update(j.orderId, { cpfp: [...(j.cpfp ?? []), { txid: child.txid, hex: child.hex, parent: viaReveal ? j.revealTxid! : j.commitTxid!, feeRate: d.rate }] });
    await btc.broadcast(child.hex);
    return store.update(j.orderId, { bumps: (j.bumps ?? 0) + 1, lastBroadcastAt: Date.now() });
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
        if (o.deadline - o.createdAt !== c.deliveryWindowSecs)
          log.warn("order window differs from DELIVERY_WINDOW_SECS", { orderId: j.orderId, window: o.deadline - o.createdAt, expected: c.deliveryWindowSecs });
        const feeRate = await btc.feeRate();
        if (feeRate > c.btc.maxFeeRate) { log.warn("fee rate above cap, deferring", { feeRate, cap: c.btc.maxFeeRate });
          return store.update(j.orderId, { nextAttemptAt: Date.now() + 60_000 }); }
        // B13: buyer-paid inscriptionFee (USDC) is the hard sats budget for this order
        const cents = await btcUsdCents(c);
        const budget = budgetSats(o.inscriptionFee, cents);
        const utxos = (await btc.utxos(wallet.address)).filter((u) => !store.isReserved(`${u.txid}:${u.vout}`));
        const content = renderContent({ orderId: id, collectionId: j.collectionId, buyer: j.buyer }, c.contentTemplate);
        const probe = buildInscription({ priv: btcKey, net, utxos, dest: j.btcAddress, feeRate, postage: c.btc.postageSats, contentType: c.contentType, content });
        const q = quoteUsdc6({ commitVsize: probe.commitVsize, revealVsize: probe.revealVsize, postage: c.btc.postageSats, quoteRate: feeRate, btcUsdCents: cents, headroomPct: 0 });
        const bRate = budgetRate({ budgetSats: budget, postage: c.btc.postageSats, commitVsize: probe.commitVsize, revealVsize: probe.revealVsize, maxFeeRate: c.btc.maxFeeRate });
        if (o.inscriptionFee < q.usdc6 || bRate < feeRate) {
          log.warn("inscriptionFee below current cost, deferring", { orderId: j.orderId, paid: o.inscriptionFee, needUsdc6: q.usdc6, feeRate, budgetRate: bRate });
          return store.update(j.orderId, { nextAttemptAt: Date.now() + 60_000, lastError: "inscriptionFee below network cost" });
        }
        // fund commit:0 for the budget rate so the reveal alone can be RBF-bumped later; unused budget is reveal change
        const plan = buildInscription({ priv: btcKey, net, utxos, dest: j.btcAddress, feeRate, budgetRate: bRate, postage: c.btc.postageSats, contentType: c.contentType, content });
        if (plan.commitFee + plan.commitAmount - (plan.revealChange ?? 0n) > budget)
          return store.update(j.orderId, { nextAttemptAt: Date.now() + 60_000, lastError: "plan exceeds budget" });
        store.reserve(plan.spent);
        log.info("inscription built", { orderId: j.orderId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, feeRate, budgetRate: bRate,
          commitFee: plan.commitFee, revealFee: plan.revealFee, budgetSats: budget });
        // persist signed txs BEFORE broadcasting -> restart rebroadcasts the same pair, never double-inscribes
        return store.update(j.orderId, { state: "built", feeRate, commitHex: plan.commitHex, commitTxid: plan.commitTxid,
          revealHex: plan.revealHex, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId,
          inscriptionFee: o.inscriptionFee.toString(), budgetSats: budget.toString(), budgetRate: bRate, commitAmount: plan.commitAmount.toString(),
          inputs: plan.inputs.map((u) => ({ ...u, value: u.value.toString() })), commitVsize: plan.commitVsize, revealVsize: plan.revealVsize,
          commitFee: plan.commitFee.toString(), revealFee: plan.revealFee.toString(),
          revealChange: plan.revealChange?.toString() ?? null, commitChange: plan.commitChange?.toString() ?? null, bumps: 0,
          alts: [{ commitTxid: plan.commitTxid, commitHex: plan.commitHex, revealTxid: plan.revealTxid, revealHex: plan.revealHex, feeRate }], cpfp: [] });
      }
      case "built":
        try { await btc.broadcast(j.commitHex!); } catch (e) { if (!benign(e)) throw e; }
        log.info("commit broadcast", { orderId: j.orderId, txid: j.commitTxid });
        return store.update(j.orderId, { state: "commit_sent" });
      case "commit_sent":
        try { await btc.broadcast(j.revealHex!); } catch (e) { if (!benign(e)) throw e; }
        log.info("reveal broadcast", { orderId: j.orderId, txid: j.revealTxid, inscriptionId: j.inscriptionId });
        return store.update(j.orderId, { state: "reveal_sent", lastBroadcastAt: Date.now() });
      case "reveal_sent": {
        // adopt whichever broadcast version of the reveal is on chain (RBF replacements change the txid)
        for (const v of [...(j.alts ?? [])].reverse()) {
          if (v.revealTxid === j.revealTxid) continue;
          const tv = await btc.tx(v.revealTxid);
          if (tv && tv.confirmations > 0) { log.info("adopting confirmed reveal version", { orderId: j.orderId, txid: v.revealTxid });
            j = store.update(j.orderId, { ...v, inscriptionId: `${v.revealTxid}i0` }); break; }
        }
        const t = await btc.tx(j.revealTxid!);
        if (!t) { log.warn("reveal missing (dropped/reorg) — rebroadcasting pair", { orderId: j.orderId });
          return store.update(j.orderId, { state: "built" }); }
        if (t.confirmations === 0 && Date.now() - (j.lastBroadcastAt ?? 0) > c.btc.bumpAfterSecs * 1000) {
          const r = await maybeBump(j); if (r) return r;
        }
        if (t.confirmations < needConfs) { log.debug("waiting confs", { orderId: j.orderId, confs: t.confirmations });
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
        // B2: on-chain SPV — reveal + merkle branch + inclusion header and (minBtcConfs-1) successors
        const proof = await btc.spvProof(j.revealTxid!, onchainConfs);
        checkProof(proof, j.revealTxid!, o.btcProgram.slice(2));
        await evm.pub.readContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "verifySpv", args: [id, proof] }); // simulate
        const m: AttestMsg = { orderId: id, btcTxid: txidToBytes32(j.revealTxid!), inscriptionId: j.inscriptionId!,
          sigDeadline: BigInt(Math.floor(Date.now() / 1000) + c.attest.sigTtlSecs) };
        const sigs = await collectSigs(m);
        const hash = await submitWallet.writeContract({ address: c.evm.escrow, abi: ESCROW_ABI, functionName: "attestDelivery",
          args: [m.orderId, proof, m.sigDeadline, sigs] });
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
