// Prepares fork.sh: #33's message (LayerZero Scan), the live program + programdata as account files (authority -> a throwaway
// local key, nothing else changed), and the clone list (the accounts the program's own V1 lookup names for #33, read-only).
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import fs from "node:fs";
const RPC = process.argv[2]; const c = new Connection(RPC, "confirmed");
const PID = new PublicKey("ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH");
const TX = "0x55db4e57032d56aaf361c66e0cf1dc58b6a153373aea66d856bd73eefd84d056";
const m = (await (await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${TX}`)).json()).data[0];
const msg = { srcEid: m.pathway.srcEid, sender: m.pathway.sender.address, nonce: m.pathway.nonce, guid: m.guid, payload: m.source.tx.payload };
fs.writeFileSync("/tmp/fork-msg.json", JSON.stringify(msg));
const auth = Keypair.generate(); fs.writeFileSync("/tmp/fork-auth.json", JSON.stringify(Array.from(auth.secretKey)), { mode: 0o600 });
fs.rmSync("/tmp/fork-accts", { recursive: true, force: true }); fs.mkdirSync("/tmp/fork-accts");
const dump = (k: PublicKey, a: any, data: Buffer) => fs.writeFileSync(`/tmp/fork-accts/${k.toBase58()}.json`, JSON.stringify({ pubkey: k.toBase58(),
  account: { lamports: a.lamports, data: [data.toString("base64"), "base64"], owner: a.owner.toBase58(), executable: a.executable, rentEpoch: 0, space: data.length } }));
const prog = (await c.getAccountInfo(PID))!; const pdk = new PublicKey(prog.data.subarray(4, 36)); const pd = (await c.getAccountInfo(pdk))!;
const pdData = Buffer.from(pd.data); pdData.fill(0, 4, 12); pdData[12] = 1; pdData.set(auth.publicKey.toBytes(), 13); // slot 0 (mainnet's is in the fork's future), local authority
dump(PID, prog, Buffer.from(prog.data)); dump(pdk, pd, pdData);
// the program's own V1 lookup on mainnet (simulation, no signature) -> every account #33's delivery touches
const le32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }, le64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const h = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex"); const body = h(msg.payload);
const params = Buffer.concat([le32(msg.srcEid), h(msg.sender.replace(/^0x/, "").padStart(64, "0")), le64(BigInt(msg.nonce)), h(msg.guid), le32(body.length), body, le32(0)]);
const [store] = PublicKey.findProgramAddressSync([Buffer.from("Store")], PID);
const payer = new PublicKey("HeD3GA1aRCZpG1sLQP4heqh8PHyAramxCuqpY39yZkvf");
const { blockhash } = await c.getLatestBlockhash();
const r = (await c.simulateTransaction(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [new TransactionInstruction({ programId: PID, keys: [{ pubkey: store, isSigner: false, isWritable: false }], data: Buffer.concat([le64(0x601f80f89ff611ddn), params]) })] }).compileToV0Message()), { sigVerify: false, replaceRecentBlockhash: true })).value;
const rd = Buffer.from(r.returnData!.data[0], "base64"); const keys = new Set<string>();
for (let i = 1; i < rd.readUInt32LE(0); i++) keys.add(new PublicKey(rd.subarray(4 + i * 34, 36 + i * 34)).toBase58());
keys.add(PublicKey.findProgramAddressSync([Buffer.from("LzReceiveTypes"), store.toBuffer()], PID)[0].toBase58());
// #33 was delivered on mainnet (Deliver button, Nov 18 10:03 PM EST): rewind the fork to just before delivery so the upgraded
// program's executor path is tested on a real committed message: the endpoint's PayloadHash account (discriminator | keccak256(guid ‖
// message) | bump, as the DVN commit left it) and #33's copy back in the Store.
const at = (i: number) => new PublicKey(rd.subarray(4 + i * 34, 36 + i * 34));
const phKey = at(11), assetKey = at(rd.readUInt32LE(0) - 1), EP = new PublicKey("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
const rewound: string[] = [];
if (!(await c.getAccountInfo(phKey))) {
  const { keccak256 } = await import("ethers");
  const seeds = [Buffer.from("PayloadHash"), store.toBuffer(), Buffer.from(new Uint8Array(new DataView(new ArrayBuffer(4)).buffer)), h(msg.sender.replace(/^0x/, "").padStart(64, "0"))];
  const be32 = Buffer.alloc(4); be32.writeUInt32BE(msg.srcEid); const be64 = Buffer.alloc(8); be64.writeBigUInt64BE(BigInt(msg.nonce));
  const [k2, bump] = PublicKey.findProgramAddressSync([seeds[0], seeds[1], be32, seeds[3], be64], EP); if (!k2.equals(phKey)) throw new Error("PayloadHash PDA mismatch");
  const d = Buffer.concat([Buffer.from([96, 28, 106, 145, 103, 32, 186, 70]), h(keccak256(Buffer.concat([h(msg.guid), body]))), Buffer.from([bump])]);
  dump(phKey, { lamports: await c.getMinimumBalanceForRentExemption(d.length), owner: EP, executable: false }, d); keys.delete(phKey.toBase58()); rewound.push("PayloadHash");
}
{ const a = (await c.getAccountInfo(assetKey))!; if (!new PublicKey(a.data.subarray(1, 33)).equals(store)) { const d = Buffer.from(a.data); d.set(store.toBytes(), 1); dump(assetKey, a, d); keys.delete(assetKey.toBase58()); rewound.push("asset #33 owner -> Store"); } }
console.log("rewound:", rewound.join(", ") || "nothing (message still pending on mainnet)");
const skip = new Set(["11111111111111111111111111111111", "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6", "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", PID.toBase58()]);
fs.writeFileSync("/tmp/fork-clone.txt", [...keys].filter((k) => !skip.has(k)).map((k) => `--maybe-clone ${k}`).join(" "));
console.log("mainnet programdata lamports", pd.lamports, "rent-exempt minimum", await c.getMinimumBalanceForRentExemption(pd.data.length), "-> upgrade top-up on mainnet:", Math.max(0, await c.getMinimumBalanceForRentExemption(pd.data.length) - pd.lamports));
console.log("cloning", [...keys].filter((k) => !skip.has(k)).length, "accounts; programdata", pd.data.length, "B");
