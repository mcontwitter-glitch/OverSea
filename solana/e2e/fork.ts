// Mainnet-fork test of the LzReceiveTypesV2 upgrade (Agave 4.2.2, mainnet feature set):
//   the live program ELFn27… at its real address with its exact mainnet programdata (same bytes, same 106,784-byte
//   capacity), only the upgrade authority swapped for a throwaway local key; the real Store / drop / collection / peer /
//   asset #33 and the endpoint's committed message for #33 (Robinhood tx 0x55db4e57…) cloned from mainnet.
//   1. old program: lz_receive_types_info fails (the executor's "not using LzReceiveTypesV2")
//   2. upgrade with the site's browser flow (src/solprogdeploy.ts upgradeProgram): approvals, extend, net cost
//   3. LayerZero SDK executor path (info -> v2 -> plan) returns the V1 accounts; the plan's lz_receive delivers #33 to HeD3…
// Run: solana/e2e/fork.sh
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";
import { lzReceive } from "@layerzerolabs/lz-solana-sdk-v2";
import * as PD from "../../src/solprogdeploy.ts";
import * as O from "../../src/solanaomni.ts";
import { v2Plan, sameKeys } from "./lzv2";
const PID = new PublicKey("ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH");
const store = O.storePda(PID);
const NEW = process.argv[2];
const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/fork-auth.json", "utf8")))); fs.rmSync("/tmp/fork-auth.json");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const M = JSON.parse(fs.readFileSync("/tmp/fork-msg.json", "utf8")); // #33's message from LayerZero Scan
const hex = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
const p = { srcEid: M.srcEid, sender: hex(M.sender.replace(/^0x/, "").padStart(64, "0")), nonce: BigInt(M.nonce), guid: hex(M.guid), message: hex(M.payload) };
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };
await conn.confirmTransaction(await conn.requestAirdrop(auth.publicKey, 10 * LAMPORTS_PER_SOL));
const asset = O.assetPda("0x" + M.payload.replace(/^0x/, "").slice(64, 128), 33, PID);
const ownerOf33 = async () => O.coreAssetOwner((await conn.getAccountInfo(asset))!.data)!.toBase58();
{ const o = await ownerOf33().catch((e: any) => "err " + e?.message); check("fork: #33's Solana copy is held by the Store (locked), as on mainnet", o === store.toBase58(), o); }

// 1. old program
let oldErr = ""; try { await v2Plan(conn.rpcEndpoint, auth.publicKey, store, PID, p); } catch (e: any) { oldErr = String(e?.message || e).slice(0, 140); }
check("before: the LayerZero SDK's V2 discovery fails on the live program (what the executor reports)", !!oldErr, oldErr);

// 2. upgrade with the site's flow
const so = new Uint8Array(fs.readFileSync(NEW)); let ks: string | null = null; const KS = { get: () => ks, set: (v: string) => { ks = v; }, clear: () => { ks = null; } };
const st0 = await PD.upgradeState(conn, so, KS, "sha-new", PID.toBase58());
check("upgrade plan: fits the program's current space, no ExtendProgram, no extra rent", st0.phase === "new" && st0.capacity === 106784 && st0.extend === 0 && st0.extendRent === 0, `capacity ${st0.capacity}, new file ${so.length}, extend ${st0.extend}, buffer deposit ${(st0.bufferRent / LAMPORTS_PER_SOL).toFixed(6)} SOL (refunded)`);
const w = { publicKey: auth.publicKey, approvals: 0, async signTransaction(t: Transaction) { this.approvals++; t.partialSign(auth); return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })); } };
const b0 = await conn.getBalance(auth.publicKey); const pdBefore = (await conn.getAccountInfo(PD.programDataOf(PID)))!;
await PD.upgradeProgram(conn, so, w as any, KS, "sha-new", PID.toBase58(), () => {}, { parallel: 8, delayMs: 0 });
const pd = (await conn.getAccountInfo(PD.programDataOf(PID)))!; const spent = b0 - await conn.getBalance(auth.publicKey);
// the fork's rent rate is the validator default (not cloned) and higher than mainnet's: the loader tops programdata up to the fork's
// rent-exempt minimum. On mainnet programdata already holds exactly its rent-exempt minimum (checked in fork-prep), so no top-up there.
const forkRent = await conn.getMinimumBalanceForRentExemption(pdBefore.data.length), topUp = Math.max(0, forkRent - pdBefore.lamports);
check("upgraded: programdata = new file + zero padding, same size, 2 wallet approvals", w.approvals === 2 && pd.data.length === pdBefore.data.length && pd.lamports === Math.max(pdBefore.lamports, forkRent)
  && Buffer.from(pd.data.subarray(45, 45 + so.length)).equals(Buffer.from(so)) && pd.data.subarray(45 + so.length).every((x) => x === 0), `${w.approvals} approvals, programdata ${pd.data.length} B, ${pd.lamports} lamports`);
check("net cost of the upgrade = network fees only (buffer deposit refunded; fork-only rent top-up excluded)", spent - topUp > 0 && spent - topUp < 0.01 * LAMPORTS_PER_SOL, `fees ${((spent - topUp) / LAMPORTS_PER_SOL).toFixed(6)} SOL; fork-only programdata rent top-up ${(topUp / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
await new Promise((r) => setTimeout(r, 1500));

// 3. executor path on the upgraded program
const v2 = await v2Plan(conn.rpcEndpoint, auth.publicKey, store, PID, p);
const v1 = await lzReceive(conn, auth.publicKey, { message: p.message, sender: p.sender, srcEid: p.srcEid, guid: p.guid, receiver: store.toBase58(), nonce: p.nonce } as any);
check("lz_receive_types_info: version 2, accounts [store]", v2.info.accounts.length === 1 && v2.info.accounts[0] === store.toBase58());
check("lz_receive_types_v2: context version 1, no lookup tables, one lz_receive with the 17 V1 accounts (payer = executor)", v2.plan.contextVersion === 1 && v2.plan.addressLookupTables.length === 0 && v2.ixs.length === 1
  && v2.ixs[0].keys.length === 17 && v2.ixs[0].keys[0].pubkey.equals(auth.publicKey) && v2.ixs[0].keys[0].isSigner && sameKeys(v2.ixs[0], v1), `${v2.ixs[0].keys.length} accounts, recipient ${v2.ixs[0].keys[15].pubkey.toBase58()}`);
const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...v2.ixs), [auth], { commitment: "confirmed" });
const cu = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.computeUnitsConsumed;
check("executor-built lz_receive delivers #33 to HeD3… on Solana, message cleared on the endpoint", await ownerOf33() === "HeD3GA1aRCZpG1sLQP4heqh8PHyAramxCuqpY39yZkvf"
  && !(await conn.getAccountInfo(new PublicKey(v2.ixs[0].keys[11].pubkey)))?.data.subarray(8, 40).some((x) => x !== 0), `${cu} CU`);
let again = ""; try { await sendAndConfirmTransaction(conn, new Transaction().add(...v2.ixs), [auth]); } catch (e: any) { again = "refused"; }
check("delivering the same message twice is refused", again === "refused");
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
