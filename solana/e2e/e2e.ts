// Local end-to-end: MultiSea V2 EVM contracts on anvil (LayerZero EndpointV2 + a simple message lib) <-> the MultiSea
// Solana program on solana-test-validator running the REAL LayerZero Solana endpoint + simple message lib + Metaplex
// Core bytecode (dumped from devnet). The relayer plays DVN + executor: it verifies each packet on the destination
// and calls lzReceive exactly as the LayerZero executor would (Solana: accounts from our lz_receive_types).
// Run: solana/e2e/run.sh   (starts anvil + the validator, builds, runs this)
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { EndpointProgram, SimpleMessageLibProgram, lzReceive, extractSentPacketEventByTxHash } from "@layerzerolabs/lz-solana-sdk-v2";
import { PacketV1Codec } from "@layerzerolabs/lz-v2-utilities";
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import * as O from "../../src/solanaomni.ts";

const OUT = new URL("../../contracts/out/", import.meta.url).pathname;
const art = (f: string, c: string) => JSON.parse(readFileSync(`${OUT}${f}/${c}.json`, "utf8"));
const EVM_EID = 40245, SOL_EID = 40168;
const SIMPLE = new PublicKey("6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy");
const FEE_EVM = "0x25411039F77529A543344603bD8acdd65fABA4d0";
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const evm = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
// anvil's public, deterministic test accounts (local chain only)
const ANVIL = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"];
const [deployer, approverW, alice, bob] = ANVIL.map((k) => new ethers.NonceManager(new ethers.Wallet(k, evm)));
const approverKey = new ethers.SigningKey(ANVIL[1]);
const aliceAddr = new ethers.Wallet(ANVIL[2]).address, bobAddr = new ethers.Wallet(ANVIL[3]).address;

const admin = Keypair.generate(), creator = Keypair.generate(), solMinter = Keypair.generate(), solFee = Keypair.generate(), stranger = Keypair.generate();
const endpoint = new EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID);
const simple = new SimpleMessageLibProgram.SimpleMessageLib(SIMPLE);
const store = O.storePda();
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function sol(ixs: any[], signers: Keypair[], cu = 400_000) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs.filter(Boolean));
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function deploy(f: string, c: string, ...args: any[]) {
  const a = art(f, c); const k = await new ethers.ContractFactory(a.abi, a.bytecode.object, deployer).deploy(...args);
  await k.waitForDeployment(); return k as any;
}
const b32 = (pk: PublicKey) => ethers.hexlify(pk.toBytes());

// ------------------------------------------------------------------ relay (DVN + executor)
let epEvm: any, libEvm: any;
let lastCu = 0;
async function evmToSol(rcpt: any) {
  const topic = epEvm.interface.getEvent("PacketSent").topicHash;
  let n = 0;
  for (const l of rcpt.logs.filter((l: any) => l.topics[0] === topic)) {
    const ev = epEvm.interface.parseLog(l);
    const enc = ethers.getBytes(ev.args.encodedPayload);
    const p = PacketV1Codec.fromBytes(enc);
    if (p.dstEid() !== SOL_EID) continue;
    const init = await endpoint.initVerify(conn, admin.publicKey, new PublicKey(ethers.getBytes(p.sender())), store, p.srcEid(), p.nonce().toString());
    await sol([init, simple.validatePacket(conn, O.LZ_ENDPOINT_ID, admin.publicKey, enc)], [admin]);
    const ix = await lzReceive(conn, admin.publicKey, { message: p.message(), sender: p.sender(), srcEid: p.srcEid(), guid: p.guid(), receiver: store.toBase58(), nonce: p.nonce() });
    const sig = await sol([ix], [admin], 1_400_000);
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    lastCu = t?.meta?.computeUnitsConsumed || 0;
    n++;
  }
  return n;
}
async function solToEvm(sig: string, value = 0n) {
  const evs = (await extractSentPacketEventByTxHash(conn, O.LZ_ENDPOINT_ID, sig, "confirmed")) || [];
  const rcpts = [];
  for (const e of evs) {
    const p = PacketV1Codec.fromBytes(e.encodedPacket);
    await (await libEvm.validatePacket(e.encodedPacket)).wait();
    const origin = { srcEid: p.srcEid(), sender: p.sender(), nonce: BigInt(p.nonce()) };
    const r = await (await epEvm.lzReceive(origin, ethers.getAddress("0x" + p.receiver().slice(-40)), p.guid(), p.message(), "0x", { value, gasLimit: 8_000_000 })).wait();
    rcpts.push(r);
  }
  return rcpts;
}

async function main() {
  for (const k of [admin, creator, solMinter, stranger]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL));
  await conn.confirmTransaction(await conn.requestAirdrop(solFee.publicKey, LAMPORTS_PER_SOL)); // rent-exempt fee recipient

  // ---------------- EVM (anvil = Base hub, eid 40245)
  epEvm = await deploy("E2eMessageLib.sol", "E2eEndpoint", EVM_EID, await deployer.getAddress());
  libEvm = await deploy("E2eMessageLib.sol", "E2eMessageLib", await epEvm.getAddress());
  const lib = await libEvm.getAddress();
  for (const t of [() => epEvm.registerLibrary(lib), () => epEvm.setDefaultSendLibrary(SOL_EID, lib), () => epEvm.setDefaultReceiveLibrary(SOL_EID, lib, 0)]) await (await t()).wait();
  const esc = await deploy("MultiSeaOmniEscrowV2.sol", "MultiSeaOmniEscrowV2", await epEvm.getAddress(), await deployer.getAddress(), FEE_EVM, ethers.parseEther("0.0001"));
  const fac = await deploy("MultiSeaLaunchpadFactory.sol", "MultiSeaLaunchpadFactory", await deployer.getAddress(), await (await deploy("MultiSeaDrop.sol", "MultiSeaDrop")).getAddress(), FEE_EVM, ethers.computeAddress(approverKey), 50);
  const impl = await deploy("MultiSeaOmniDropV2.sol", "MultiSeaOmniDropV2");
  const [facA, implA, escA] = [await fac.getAddress(), await impl.getAddress(), await esc.getAddress()];
  for (const t of [() => esc.setFactory(facA), () => fac.setOmni(implA, escA), () => esc.setSolana(SOL_EID, true), () => esc.setPeer(SOL_EID, b32(store))]) await (await t()).wait();
  console.log("EVM escrow V2", await esc.getAddress());

  // ---------------- Solana (local validator, eid 40168): endpoint + simple lib + our store
  await sol([endpoint.initEndpoint(SOL_EID, admin.publicKey, admin.publicKey), endpoint.registerLibrary(admin.publicKey, SIMPLE),
    simple.initSimpleMessageLib(O.LZ_ENDPOINT_ID, admin.publicKey, admin.publicKey, SOL_EID, 5000)], [admin]);
  await sol([simple.setWhitelistCaller(admin.publicKey, admin.publicKey), await endpoint.setDefaultSendLibrary(conn, admin.publicKey, SIMPLE, EVM_EID),
    await endpoint.setDefaultReceiveLibrary(conn, admin.publicKey, SIMPLE, EVM_EID)], [admin]);
  await sol([O.initStoreIx({ payer: admin.publicKey, admin: admin.publicKey, localEid: SOL_EID, approver: ethers.computeAddress(approverKey), feeRecipient: solFee.publicKey,
    feeBps: 50, moveFee: 1_000_000n, registerAccounts: endpoint.getRegisterOappIxAccountMetaForCPI(admin.publicKey, store) })], [admin]);
  const escB = ethers.getBytes(ethers.zeroPadValue(await esc.getAddress(), 32));
  await sol([O.setPeerIx(admin.publicKey, EVM_EID, escB), endpoint.initSendLibrary(admin.publicKey, store, EVM_EID), endpoint.initReceiveLibrary(admin.publicKey, store, EVM_EID),
    endpoint.initOAppNonce(admin.publicKey, EVM_EID, store, escB), endpoint.initOAppConfig(admin.publicKey, simple as any, admin.publicKey, store, EVM_EID)], [admin]);
  const st = O.decodeStore((await conn.getAccountInfo(store))!.data);
  check("Solana store initialised + registered as LayerZero OApp", st.feeRecipient.equals(solFee.publicKey) && st.feeBps === 50 && st.localEid === SOL_EID);

  // ---------------- one drop on both chains (same collectionId)
  const cid = ethers.keccak256(ethers.toUtf8Bytes("solana-e2e-" + Date.now()));
  const now = BigInt((await evm.getBlock("latest"))!.timestamp);
  const solNow = BigInt((await conn.getBlockTime(await conn.getSlot()))!);
  const p = {
    name: "SOL ISLANDS", symbol: "SISL", owner: await approverW.getAddress(), payout: await approverW.getAddress(), feeWallet: ethers.ZeroAddress, platformFeeBps: 0,
    maxSupply: 20, royaltyReceiver: await approverW.getAddress(), royaltyBps: 500, baseURI: "ipfs://bafyFINAL/", preRevealURI: "",
    phases: [{ start: now - 60n, end: 0n, price: 0n, maxPerWallet: 8, maxSupply: 0, merkleRoot: ethers.ZeroHash }],
    eids: [EVM_EID, SOL_EID], hubEid: EVM_EID, prices: [ethers.parseEther("0.001"), 0n], copyMode: 1, batchK: 0, batchT: 0,
  };
  const dl = now + 86400n;
  const cfgHash = await fac.omniConfigHash(p);
  const evmSig = approverKey.sign(await fac.omniDigest(p.owner, cfgHash, cid, dl)).serialized;
  await (await fac.createOmniDrop(p, cid, dl, evmSig)).wait();
  const drop = new ethers.Contract(await esc.dropOf(cid), art("MultiSeaOmniDropV2.sol", "MultiSeaOmniDropV2").abi, deployer);
  const PRICE = 50_000_000n; // 0.05 SOL
  const dp: O.DropParams = { name: "SOL ISLANDS", collectionUri: "ipfs://bafyCOLLECTION.json", baseUri: "ipfs://bafyFINAL/", preRevealUri: "", payout: creator.publicKey,
    royaltyBps: 500, maxSupply: 20, hubEid: EVM_EID, eids: [EVM_EID, SOL_EID],
    phases: [{ start: solNow - 60n, end: 0n, maxPerWallet: 8, maxSupply: 0, merkleRoot: new Uint8Array(32), price: PRICE }] };
  const sdl = solNow + 86400n;
  const { sig, recoveryId } = O.signDropApproval(approverKey, O.dropApprovalDigest(creator.publicKey, cid, dp, sdl));
  // a forged approval is refused
  let forged = false;
  try { await sol([O.createDropIx({ creator: creator.publicKey, cid, params: { ...dp, royaltyBps: 0 }, deadline: sdl, sig, recoveryId })], [creator]); } catch { forged = true; }
  check("create_drop rejects a config the approver did not sign", forged);
  await sol([O.createDropIx({ creator: creator.publicKey, cid, params: dp, deadline: sdl, sig, recoveryId })], [creator]);
  const colInfo = (await conn.getAccountInfo(O.collectionPda(cid)))!;
  check("Solana drop + Metaplex Core collection created", colInfo.owner.equals(O.MPL_CORE_ID) && colInfo.data[0] === 5);

  // ---------------- 1) hub mint on EVM -> COPY to Solana creates locked Core assets
  const hubLz = (await drop.quoteMint(0, 2, aliceAddr, 0))[1];
  const r1 = await (await drop.connect(alice).mint(aliceAddr, 0, 2, [], 0, { value: ethers.parseEther("0.002") + hubLz })).wait();
  await evmToSol(r1);
  const a1 = (await conn.getAccountInfo(O.assetPda(cid, 1)))!, a2 = (await conn.getAccountInfo(O.assetPda(cid, 2)))!;
  check("EVM mint #1-#2: escrow copies created on Solana at mint (locked, owned by the program)", O.coreAssetOwner(a1.data)!.equals(store) && O.coreAssetOwner(a2.data)!.equals(store));

  // ---------------- 2) Solana mint -> REQUEST -> hub assigns -> CONFIRM -> assets Active for the minter
  const d0 = O.decodeDrop((await conn.getAccountInfo(O.dropPda(cid)))!.data);
  const hubValue = (await esc.quoteHubValue(cid, SOL_EID, 3)) * 12n / 10n; // CONFIRM leg back to Solana (+20%)
  const sendAccts = await endpoint.getSendIXAccountMetaForCPI(conn, solMinter.publicKey, { sender: store.toBytes(), dstEid: EVM_EID, receiver: await esc.getAddress() }, simple as any);
  const minterBal0 = await conn.getBalance(solMinter.publicKey);
  const mintSig = await sol([O.mintIx({ minter: solMinter.publicKey, cid, hubEid: EVM_EID, nextRid: d0.nextRid, phaseId: 0, qty: 3, proof: [], hubValue, nativeFee: 5000n, sendAccounts: sendAccts })], [solMinter]);
  const held = O.decodeDrop((await conn.getAccountInfo(O.dropPda(cid)))!.data);
  check("Solana mint of 3: price held in the drop until the hub answers", held.held === 3n * PRICE && held.pendingQty === 3, `held ${held.held} lamports`);
  const [hubRcpt] = await solToEvm(mintSig, hubValue);
  check("hub (EVM) assigned #3-#5 to the Solana minter (escrow copies on the hub)", Number(await drop.totalAssigned()) === 5 && (await drop.ownerOf(3)) === (await esc.getAddress())
    && Number(await drop.mintedInPhase(0, b32(solMinter.publicKey))) === 3);
  await evmToSol(hubRcpt);
  const owners = await Promise.all([3, 4, 5].map(async (i) => O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, i)))!.data)!));
  const d1 = O.decodeDrop((await conn.getAccountInfo(O.dropPda(cid)))!.data);
  check("CONFIRM on Solana: #3-#5 minted Active to the minter as Core assets", owners.every((o) => o.equals(solMinter.publicKey)) && d1.held === 0n && d1.mintedHere === 3);

  // ---------------- 3) 0.5% fee: withdraw splits proceeds
  const fee0 = await conn.getBalance(solFee.publicKey), pay0 = await conn.getBalance(creator.publicKey);
  await sol([O.withdrawIx(cid, solFee.publicKey, creator.publicKey)], [admin]);
  const feeGot = BigInt(await conn.getBalance(solFee.publicKey) - fee0), payGot = BigInt(await conn.getBalance(creator.publicKey) - pay0);
  check("withdraw: 0.5% to the MultiSea fee recipient, 99.5% to the creator", feeGot === 3n * PRICE * 50n / 10000n && payGot === 3n * PRICE - feeGot, `fee ${feeGot} / creator ${payGot} lamports`);

  // ---------------- 4) royalties enforced (Core Royalties plugin, program allowlist)
  const { TransferV1 } = await coreTransfer();
  const colData = colInfo.data;
  check("collection carries the Royalties plugin (5%, creator 100%, ProgramAllowList)", hasRoyalties(colData, 500, creator.publicKey));
  let blocked = false;
  try { // move to an account owned by a program that is not on the allowlist (the Token program here)
    const tokenOwned = Keypair.generate();
    const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    await sol([SystemProgram.createAccount({ fromPubkey: solMinter.publicKey, newAccountPubkey: tokenOwned.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(0), space: 0, programId: TOKEN }),
      TransferV1(O.assetPda(cid, 5), O.collectionPda(cid), solMinter.publicKey, tokenOwned.publicKey)], [solMinter, tokenOwned]);
  } catch (e: any) { blocked = /Core|0x/i.test(String(e?.transactionLogs || e?.message)); console.log("    core said:", (e?.transactionLogs || []).filter((l: string) => /CoRE|log:|error/i.test(l)).slice(-3).join(" | ")); }
  check("royalty enforcement: transfer into a non-allowlisted program's account is rejected", blocked);
  await sol([TransferV1(O.assetPda(cid, 5), O.collectionPda(cid), solMinter.publicKey, stranger.publicKey)], [solMinter]);
  check("plain wallet-to-wallet transfer still works", O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, 5)))!.data)!.equals(stranger.publicKey));

  // ---------------- 5) bridge Solana -> EVM: lock on Solana, release on the hub
  const feeB = await conn.getBalance(solFee.publicKey);
  const moveAccts = await endpoint.getSendIXAccountMetaForCPI(conn, solMinter.publicKey, { sender: store.toBytes(), dstEid: EVM_EID, receiver: await esc.getAddress() }, simple as any);
  const mvSig = await sol([O.moveOutIx({ holder: solMinter.publicKey, cid, tokenId: 3, dstEid: EVM_EID, to: O.evmTo32(bobAddr), nativeFee: 5000n, feeRecipient: solFee.publicKey, sendAccounts: moveAccts })], [solMinter]);
  const locked = O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, 3)))!.data)!.equals(store);
  await solToEvm(mvSig);
  check("bridge Solana -> EVM: #3 locked on Solana (not burned), Active for bob on the hub", locked && (await drop.ownerOf(3)) === bobAddr);
  check("move fee (0.001 SOL) paid to the fee recipient", (await conn.getBalance(solFee.publicKey)) - feeB === 1_000_000);

  // ---------------- 6) bridge EVM -> Solana: lock on EVM, release the locked copy on Solana
  const [pf, lz] = await esc.quoteMove(cid, SOL_EID, 1, b32(solMinter.publicKey));
  const r6 = await (await drop.connect(alice).moveTo(SOL_EID, 1, b32(solMinter.publicKey), { value: pf + lz })).wait();
  await evmToSol(r6);
  check("bridge EVM -> Solana: #1 locked on the hub, released to the Solana wallet", (await drop.ownerOf(1)) === (await esc.getAddress())
    && O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, 1)))!.data)!.equals(solMinter.publicKey));
  // and back again: #3 returns from EVM to Solana (its locked Solana asset is released, never a second copy)
  const [pf3, lz3] = await esc.quoteMove(cid, SOL_EID, 3, b32(stranger.publicKey));
  await evmToSol(await (await drop.connect(bob).moveTo(SOL_EID, 3, b32(stranger.publicKey), { value: pf3 + lz3 })).wait());
  check("round trip: #3 back on Solana for a new wallet (same asset, released from escrow)", O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, 3)))!.data)!.equals(stranger.publicKey));

  // ---------------- 7) wallet limit is global: REJECT -> claimable refund on Solana
  const d2 = O.decodeDrop((await conn.getAccountInfo(O.dropPda(cid)))!.data);
  const hubValue6 = (await esc.quoteHubValue(cid, SOL_EID, 6)) * 12n / 10n;
  const sa = await endpoint.getSendIXAccountMetaForCPI(conn, solMinter.publicKey, { sender: store.toBytes(), dstEid: EVM_EID, receiver: await esc.getAddress() }, simple as any);
  const rejSig = await sol([O.mintIx({ minter: solMinter.publicKey, cid, hubEid: EVM_EID, nextRid: d2.nextRid, phaseId: 0, qty: 6, proof: [], hubValue: hubValue6, nativeFee: 5000n, sendAccounts: sa })], [solMinter]);
  const [rejRcpt] = await solToEvm(rejSig, hubValue6);
  await evmToSol(rejRcpt);
  const rq = O.decodeRequest((await conn.getAccountInfo(O.requestPda(cid, d2.nextRid + 1n)))!.data);
  const b0 = await conn.getBalance(solMinter.publicKey);
  await sol([O.claimRefundIx(solMinter.publicKey, cid, d2.nextRid + 1n)], [admin]);
  check("over the 8-per-wallet limit (3 + 6) across chains: hub REJECTs, minter reclaims the held price", rq.status === 3 && (await conn.getBalance(solMinter.publicKey)) - b0 >= Number(6n * PRICE));

  // ---------------- 8) the largest message Solana takes: a COPY of 8 ids in one lzReceive
  const lz8 = (await drop.quoteMint(0, 8, bobAddr, 0))[1];
  await evmToSol(await (await drop.connect(bob).mint(bobAddr, 0, 8, [], 0, { value: ethers.parseEther("0.008") + lz8 })).wait());
  const cuFor8 = lastCu;
  const allIn = await Promise.all([6, 7, 8, 9, 10, 11, 12, 13].map(async (i) => O.coreAssetOwner((await conn.getAccountInfo(O.assetPda(cid, i)))!.data)!.equals(store)));
  check("COPY of 8 ids (the max) in one LayerZero delivery fits Solana limits", allIn.every(Boolean), `${cuFor8} compute units of 1,400,000`);

  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// Metaplex Core TransferV1 (discriminator 14): asset, collection, payer, authority, new_owner, system, log_wrapper
async function coreTransfer() {
  const { TransactionInstruction } = await import("@solana/web3.js");
  const k = (pubkey: PublicKey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
  return { TransferV1: (asset: PublicKey, col: PublicKey, owner: PublicKey, to: PublicKey) => new TransactionInstruction({ programId: O.MPL_CORE_ID,
    keys: [k(asset, true), k(col), k(owner, true, true), k(owner, false, true), k(to), k(O.MPL_CORE_ID), k(O.MPL_CORE_ID)], data: Buffer.from([14, 0]) }) };
}
function hasRoyalties(d: Uint8Array, bps: number, creator: PublicKey) {
  const h = Buffer.from(d).toString("hex");
  const bpsLe = Buffer.from([bps & 255, bps >> 8]).toString("hex");
  return h.includes(bpsLe + "01000000" + creator.toBuffer().toString("hex") + "64" + "01"); // basis_points | creators[1]{addr,100} | RuleSet::ProgramAllowList
}

main().catch((e) => { console.error(e); process.exit(1); });
