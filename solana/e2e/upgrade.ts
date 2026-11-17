// Local test of the browser upgrade flow (src/solprogdeploy.ts upgradeProgram) on an Agave 4.x validator (mainnet runs 4.x:
// ExtendProgram needs >= 10,240 bytes there). Deploys the CURRENT mainnet program file at its exact size, then upgrades it to
// the new build with a Phantom-like wallet. Throwaway local keys only.
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as PD from "../../src/solprogdeploy.ts";
import * as O from "../../src/solanaomni.ts";
import { sendAndConfirmTransaction } from "@solana/web3.js";
const [OLD, NEW, BIN] = process.argv.slice(2);
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const auth = Keypair.generate(), progKp = Keypair.generate();
fs.writeFileSync("/tmp/upg-auth.json", JSON.stringify(Array.from(auth.secretKey))); fs.writeFileSync("/tmp/upg-prog.json", JSON.stringify(Array.from(progKp.secretKey)));
await conn.confirmTransaction(await conn.requestAirdrop(auth.publicKey, 10 * LAMPORTS_PER_SOL));
execFileSync(`${BIN}/solana`, ["-u", "localhost", "program", "deploy", OLD, "--program-id", "/tmp/upg-prog.json", "--keypair", "/tmp/upg-auth.json", "--upgrade-authority", "/tmp/upg-auth.json"], { stdio: "ignore" });
fs.rmSync("/tmp/upg-auth.json"); fs.rmSync("/tmp/upg-prog.json");
const so = new Uint8Array(fs.readFileSync(NEW)); const pid = progKp.publicKey.toBase58();
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  (" + d + ")" : ""}`); };
let store: string | null = null; const ks = { get: () => store, set: (v: string) => { store = v; }, clear: () => { store = null; } };
await new Promise(r => setTimeout(r, 1500)); // let the deploy slot pass
const st0 = await PD.upgradeState(conn, so, ks, "sha-new", pid);
check("before: program at its exact old size, needs an extend of the 10,240-byte minimum", st0.phase === "new" && st0.capacity === fs.statSync(OLD).size && st0.extend === PD.MIN_EXTEND, `capacity ${st0.capacity}, extend ${st0.extend}, extend rent ${st0.extendRent}, buffer rent ${st0.bufferRent}`);
const probe0 = async () => { const i = O.setCollectionUriIx(auth.publicKey, "0x" + "11".repeat(32), "", "https://x/c.json", progKp.publicKey);
  try { await sendAndConfirmTransaction(conn, new Transaction().add(i), [auth]); return "ok"; } catch (e: any) { return String(e?.message || e).match(/custom program error: (0x[0-9a-f]+)/)?.[1] || String(e).slice(0, 80); } };
const code0 = await probe0(); check("before the upgrade the old program does not know set_collection_uri (0x1)", code0 === "0x1", code0);
const stranger = Keypair.generate();
const wallet = (kp: Keypair) => ({ publicKey: kp.publicKey, approvals: 0, async signTransaction(t: Transaction) { this.approvals++; t.partialSign(kp); return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })); } });
let refused = false; try { await PD.upgradeProgram(conn, so, wallet(stranger) as any, ks, "sha-new", pid); } catch (e: any) { refused = /upgrade authority/.test(e.message); }
check("a wallet that is not the upgrade authority is refused before any prompt", refused && store === null);
const w = wallet(auth); const b0 = await conn.getBalance(auth.publicKey); const stages: string[] = [];
await PD.upgradeProgram(conn, so, w as any, ks, "sha-new", pid, p => { if (!stages.includes(p.stage)) stages.push(p.stage); }, { parallel: 8, delayMs: 0 });
const st1 = await PD.upgradeState(conn, so, ks, "sha-new", pid);
const pd = (await conn.getAccountInfo(PD.programDataOf(progKp.publicKey)))!;
const spent = b0 - await conn.getBalance(auth.publicKey);
check("upgraded: programdata holds the new file byte-for-byte (+ zero padding), 2 wallet approvals, keys cleared", st1.phase === "upgraded" && w.approvals === 2 && store === null
  && Buffer.from(pd.data.subarray(45, 45 + so.length)).equals(Buffer.from(so)) && pd.data.length === 45 + st0.capacity + PD.MIN_EXTEND, `${w.approvals} approvals, stages ${stages.join(">")}`);
check("buffer deposit refunded: net cost = extend rent + fees only", spent >= st0.extendRent && spent < st0.extendRent + 0.003 * LAMPORTS_PER_SOL, `net ${(spent / LAMPORTS_PER_SOL).toFixed(6)} SOL, extend rent ${(st0.extendRent / LAMPORTS_PER_SOL).toFixed(6)}`);
await PD.upgradeProgram(conn, so, w as any, ks, "sha-new", pid); check("running it again is a no-op (no prompt)", w.approvals === 2);
// the upgraded program runs the new instruction: before = unknown instruction (E_PARAMS 0x1); after = account check (E_ACCOUNTS 0x2)
await new Promise(r => setTimeout(r, 1500));
const probe = async () => { const i = O.setCollectionUriIx(auth.publicKey, "0x" + "11".repeat(32), "", "https://x/c.json", progKp.publicKey);
  try { await sendAndConfirmTransaction(conn, new Transaction().add(i), [auth]); return "ok"; } catch (e: any) { return String(e?.message || e).match(/custom program error: (0x[0-9a-f]+)/)?.[1] || String(e).slice(0, 80); } };
const code = await probe(); check("after the upgrade the program dispatches set_collection_uri (fails on the account check 0x2, not 'unknown instruction' 0x1)", code === "0x2", code);
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
