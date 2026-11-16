// Client for the MultiSea Solana program (solana/programs/multisea_omni, native). Instructions: 8-byte discriminators
// (sha256("global:<name>")[..8]) + Borsh params. Accounts: fixed little-endian layouts (see the Rust offsets).
// Used by the launchpad, bridge and deploy pages (lazy-loaded) and by the local end-to-end harness in solana/e2e.
import { Buffer } from "buffer";
import { PublicKey, TransactionInstruction, SystemProgram, type AccountMeta } from "@solana/web3.js";
import { keccak256, getBytes, concat, hashMessage, hexlify, SigningKey } from "ethers";

/** Devnet/local build. Mainnet: MC deploys with his own program keypair; set VITE_SOLANA_OMNI_ID to that id. */
export const OMNI_PROGRAM_ID = new PublicKey(
  (import.meta as any).env?.VITE_SOLANA_OMNI_ID || "Abu55rcZKUwUvuMDbpNrHy28RF9A8PBasZa5BGGNWiA7",
);
export const LZ_ENDPOINT_ID = new PublicKey("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");
export const MPL_CORE_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const SOLANA_EID = { mainnet: 30168, devnet: 40168 } as const;
/** MultiSea's 0.5% fee recipient on Solana (MC, Nov 15 2026). */
export const SOLANA_FEE_RECIPIENT = new PublicKey("85W3XVZqLs15MUEKZE3wRHE3gL1tEiwzkBYLQgrbbZSS");
export const SOL_MAX_QTY = 8;
export const KIND = { MOVE: 1, REQUEST: 2, CONFIRM: 3, REJECT: 4, COPY: 5 } as const;

const D = {
  init_store: [250, 74, 6, 95, 163, 188, 19, 181], set_config: [108, 158, 154, 175, 212, 98, 52, 66],
  transfer_admin: [42, 242, 66, 106, 228, 10, 111, 156], set_peer: [32, 70, 184, 229, 200, 115, 227, 177],
  create_drop: [157, 142, 145, 247, 92, 73, 59, 48], mint: [51, 57, 225, 47, 182, 146, 137, 166],
  claim_refund: [15, 16, 30, 161, 255, 228, 97, 60], move_out: [70, 225, 254, 16, 221, 233, 233, 59],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34], set_paused: [91, 60, 125, 192, 176, 225, 166, 218],
  reveal: [9, 35, 59, 190, 167, 249, 76, 115], refresh_uris: [190, 184, 138, 150, 61, 0, 175, 157],
  set_mover: [10, 202, 182, 143, 171, 208, 63, 204], register_existing: [2, 5, 61, 110, 9, 247, 100, 5], existing_copies: [40, 198, 111, 251, 244, 232, 14, 97],
};
/** Locked copies per existing_copies transaction (the program's MAX_COPIES_TX). */
export const MAX_COPIES_TX = 20;

// ------------------------------------------------------------------ borsh
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.b.push(v & 255, (v >> 8) & 255); return this; }
  u32(v: number) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 255); return this; }
  u64(v: bigint | number) { let x = BigInt(v); for (let i = 0; i < 8; i++) { this.b.push(Number(x & 255n)); x >>= 8n; } return this; }
  i64(v: bigint | number) { return this.u64(BigInt.asUintN(64, BigInt(v))); }
  u128(v: bigint | number) { let x = BigInt(v); for (let i = 0; i < 16; i++) { this.b.push(Number(x & 255n)); x >>= 8n; } return this; }
  bytes(a: Uint8Array | number[]) { for (const x of a) this.b.push(x); return this; }
  str(s: string) { const e = new TextEncoder().encode(s); this.u32(e.length); return this.bytes(e); }
  pk(p: PublicKey) { return this.bytes(p.toBytes()); }
  out() { return Uint8Array.from(this.b); }
}
class R {
  o = 0; constructor(public d: Uint8Array) {}
  u8() { return this.d[this.o++]; }
  u16() { const v = this.d[this.o] | (this.d[this.o + 1] << 8); this.o += 2; return v; }
  u32() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 4).getUint32(0, true); this.o += 4; return v; }
  u64() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 8).getBigUint64(0, true); this.o += 8; return v; }
  i64() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, 8).getBigInt64(0, true); this.o += 8; return v; }
  bytes(n: number) { const v = this.d.slice(this.o, this.o + n); this.o += n; return v; }
  pk() { return new PublicKey(this.bytes(32)); }
  str() { const n = this.u32(); return new TextDecoder().decode(this.bytes(n)); }
  bool() { return this.u8() !== 0; }
}
const le32 = (n: number) => new W().u32(n).out();
const le64 = (n: bigint | number) => new W().u64(n).out();
const be32 = (n: number) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const hex32 = (h: string) => { const b = getBytes(h); if (b.length !== 32) throw new Error("expected 32 bytes"); return b; };

// ------------------------------------------------------------------ PDAs
const pda = (seeds: (Uint8Array | Buffer)[], pid = OMNI_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds as any, pid)[0];
const S = (s: string) => new TextEncoder().encode(s);
export const storePda = (pid = OMNI_PROGRAM_ID) => pda([S("Store")], pid);
export const lzReceiveTypesPda = (pid = OMNI_PROGRAM_ID) => pda([S("LzReceiveTypes"), storePda(pid).toBytes()], pid);
export const peerPda = (eid: number, pid = OMNI_PROGRAM_ID) => pda([S("Peer"), storePda(pid).toBytes(), be32(eid)], pid);
export const dropPda = (cid: string, pid = OMNI_PROGRAM_ID) => pda([S("Drop"), hex32(cid)], pid);
export const collectionPda = (cid: string, pid = OMNI_PROGRAM_ID) => pda([S("Collection"), hex32(cid)], pid);
export const assetPda = (cid: string, id: number, pid = OMNI_PROGRAM_ID) => pda([S("Asset"), hex32(cid), le32(id)], pid);
export const requestPda = (cid: string, rid: bigint | number, pid = OMNI_PROGRAM_ID) => pda([S("Req"), hex32(cid), le64(rid)], pid);

// ------------------------------------------------------------------ types
export type Gas = { requestBase: bigint; requestPerId: bigint; moveGas: bigint };
export type Phase = { start: bigint; end: bigint; maxPerWallet: number; maxSupply: number; merkleRoot: Uint8Array; price: bigint };
export type DropParams = {
  name: string; collectionUri: string; baseUri: string; preRevealUri: string; payout: PublicKey; royaltyBps: number;
  maxSupply: number; hubEid: number; eids: number[]; phases: Phase[];
};
export const DEFAULT_GAS: Gas = { requestBase: 2_400_000n, requestPerId: 60_000n, moveGas: 150_000n }; // = MultiSeaOmniEscrowV2 gasOf (AT_MINT REQUEST, MOVE)

const gas = (w: W, g: Gas) => w.u64(g.requestBase).u64(g.requestPerId).u64(g.moveGas);
export function encodeDropParams(p: DropParams): Uint8Array {
  const w = new W().str(p.name).str(p.collectionUri).str(p.baseUri).str(p.preRevealUri).pk(p.payout).u16(p.royaltyBps)
    .u32(p.maxSupply).u32(p.hubEid).u32(p.eids.length);
  p.eids.forEach((e) => w.u32(e));
  w.u32(p.phases.length);
  for (const ph of p.phases) w.i64(ph.start).i64(ph.end).u32(ph.maxPerWallet).u32(ph.maxSupply).bytes(ph.merkleRoot).u64(ph.price);
  return w.out();
}
/** What MultiSea's approver signs for a Solana drop (the worker does this after the admin review). */
export function dropApprovalDigest(creator: PublicKey, cid: string, p: DropParams, deadline: bigint, pid = OMNI_PROGRAM_ID): string {
  const cfg = keccak256(encodeDropParams(p));
  return keccak256(concat([S("MultiSeaSolanaDrop"), pid.toBytes(), creator.toBytes(), cfg, hex32(cid), new W().i64(deadline).out()]));
}
/** The program checks an EIP-191 personal signature over the digest (wallet signMessage({ message: { raw: digest } })). */
export function signDropApproval(key: SigningKey, digest: string): { sig: Uint8Array; recoveryId: number } {
  const s = key.sign(hashMessage(getBytes(digest)));
  return { sig: getBytes(concat([s.r, s.s])), recoveryId: s.v - 27 };
}
/** Split a 65-byte 0x r|s|v signature (from a wallet or the worker) into create_drop's sig + recovery id. */
export function splitApprovalSig(sig65: string): { sig: Uint8Array; recoveryId: number } {
  const b = getBytes(sig65); if (b.length !== 65) throw new Error("bad signature");
  return { sig: b.slice(0, 64), recoveryId: b[64] >= 27 ? b[64] - 27 : b[64] };
}

/** The 192-byte cross-chain payload: abi.encode(uint8 kind, bytes32 cid, uint256 a, uint256 b, uint256 c, bytes32 to). */
export function encodeMsg(kind: number, cid: string, a: bigint, b: bigint, c: bigint, to: Uint8Array): Uint8Array {
  const m = new Uint8Array(192);
  m[31] = kind; m.set(hex32(cid), 32);
  const put = (off: number, v: bigint) => { for (let i = 0; i < 32; i++) { m[off + 31 - i] = Number(v & 255n); v >>= 8n; } };
  put(64, a); put(96, b); put(128, c); m.set(to, 160);
  return m;
}
export function decodeMsg(m: Uint8Array) {
  const w = (o: number) => BigInt("0x" + Buffer.from(m.slice(o, o + 32)).toString("hex"));
  return { kind: m[31], cid: "0x" + Buffer.from(m.slice(32, 64)).toString("hex"), a: w(64), b: w(96), c: w(128), to: m.slice(160, 192) };
}
/** EVM address -> bytes32 recipient; Solana key -> its 32 bytes. */
export const evmTo32 = (addr: string) => getBytes("0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0"));

// ------------------------------------------------------------------ instructions
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });
const ix = (keys: AccountMeta[], data: Uint8Array, pid = OMNI_PROGRAM_ID) => new TransactionInstruction({ programId: pid, keys, data: Buffer.from(data) });
const disc = (n: keyof typeof D) => new W().bytes(D[n]);

export function initStoreIx(a: { payer: PublicKey; admin: PublicKey; localEid: number; approver: string; feeRecipient: PublicKey; feeBps: number; moveFee: bigint; gas?: Gas; registerAccounts: AccountMeta[]; endpoint?: PublicKey }, pid = OMNI_PROGRAM_ID) {
  const w = disc("init_store").pk(a.admin).pk(a.endpoint || LZ_ENDPOINT_ID).u32(a.localEid).bytes(getBytes(a.approver)).pk(a.feeRecipient).u16(a.feeBps).u64(a.moveFee);
  gas(w, a.gas || DEFAULT_GAS);
  return ix([meta(a.payer, true, true), meta(storePda(pid), true), meta(lzReceiveTypesPda(pid), true), meta(SystemProgram.programId), ...a.registerAccounts], w.out(), pid);
}
export function setConfigIx(a: { admin: PublicKey; approver: string; feeRecipient: PublicKey; feeBps: number; moveFee: bigint; gas?: Gas }, pid = OMNI_PROGRAM_ID) {
  const w = disc("set_config").bytes(getBytes(a.approver)).pk(a.feeRecipient).u16(a.feeBps).u64(a.moveFee);
  gas(w, a.gas || DEFAULT_GAS);
  return ix([meta(a.admin, false, true), meta(storePda(pid), true)], w.out(), pid);
}
export function setPeerIx(admin: PublicKey, eid: number, peer32: Uint8Array, pid = OMNI_PROGRAM_ID) {
  return ix([meta(admin, true, true), meta(storePda(pid)), meta(peerPda(eid, pid), true), meta(SystemProgram.programId)], disc("set_peer").u32(eid).bytes(peer32).out(), pid);
}
export function createDropIx(a: { creator: PublicKey; cid: string; params: DropParams; deadline: bigint; sig: Uint8Array; recoveryId: number }, pid = OMNI_PROGRAM_ID) {
  const data = disc("create_drop").bytes(hex32(a.cid)).bytes(encodeDropParams(a.params)).i64(a.deadline).bytes(a.sig).u8(a.recoveryId).out();
  return ix([meta(a.creator, true, true), meta(storePda(pid)), meta(dropPda(a.cid, pid), true), meta(collectionPda(a.cid, pid), true), meta(MPL_CORE_ID), meta(SystemProgram.programId)], data, pid);
}
export function mintIx(a: { minter: PublicKey; cid: string; hubEid: number; nextRid: bigint; phaseId: number; qty: number; proof: Uint8Array[]; hubValue: bigint; nativeFee: bigint; sendAccounts: AccountMeta[] }, pid = OMNI_PROGRAM_ID) {
  const w = disc("mint").u8(a.phaseId).u32(a.qty).u32(a.proof.length);
  a.proof.forEach((p) => w.bytes(p));
  w.u128(a.hubValue).u64(a.nativeFee);
  return ix([meta(a.minter, true, true), meta(storePda(pid)), meta(dropPda(a.cid, pid), true), meta(peerPda(a.hubEid, pid)), meta(requestPda(a.cid, a.nextRid + 1n, pid), true), meta(SystemProgram.programId), ...a.sendAccounts], w.out(), pid);
}
export function claimRefundIx(payer: PublicKey, cid: string, rid: bigint, pid = OMNI_PROGRAM_ID) {
  return ix([meta(payer, true), meta(dropPda(cid, pid), true), meta(requestPda(cid, rid, pid), true)], disc("claim_refund").u64(rid).out(), pid);
}
export function moveOutIx(a: { holder: PublicKey; cid: string; tokenId: number; dstEid: number; to: Uint8Array; nativeFee: bigint; feeRecipient: PublicKey; sendAccounts: AccountMeta[] }, pid = OMNI_PROGRAM_ID) {
  const data = disc("move_out").u32(a.tokenId).u32(a.dstEid).bytes(a.to).u64(a.nativeFee).out();
  return ix([meta(a.holder, true, true), meta(storePda(pid)), meta(dropPda(a.cid, pid)), meta(peerPda(a.dstEid, pid)), meta(assetPda(a.cid, a.tokenId, pid), true),
    meta(collectionPda(a.cid, pid), true), meta(a.feeRecipient, true), meta(MPL_CORE_ID), meta(SystemProgram.programId), ...a.sendAccounts], data, pid);
}
export function withdrawIx(cid: string, feeRecipient: PublicKey, payout: PublicKey, pid = OMNI_PROGRAM_ID) {
  return ix([meta(dropPda(cid, pid), true), meta(feeRecipient, true), meta(payout, true)], disc("withdraw").out(), pid);
}
export function setPausedIx(owner: PublicKey, cid: string, paused: boolean, pid = OMNI_PROGRAM_ID) {
  return ix([meta(owner, false, true), meta(dropPda(cid, pid), true)], disc("set_paused").u8(paused ? 1 : 0).out(), pid);
}

/** Admin, existing V1 collections on chain `eid`: its MultiSeaSolanaMover (accepted as a sender of MOVE only) and its
 *  existing V1 escrow (where move_out sends them back). The peer (set_peer) must exist. */
export function setMoverIx(admin: PublicKey, eid: number, mover32: Uint8Array, v1Escrow32: Uint8Array, pid = OMNI_PROGRAM_ID) {
  return ix([meta(admin, false, true), meta(storePda(pid)), meta(peerPda(eid, pid), true)], disc("set_mover").u32(eid).bytes(mover32).bytes(v1Escrow32).out(), pid);
}
export type ExistingParams = { name: string; collectionUri: string; baseUri: string; payout: PublicKey; royaltyBps: number; maxSupply: number; eids: number[] };
/** Admin: give an existing V1 collection (same collection id) a Solana side: Core collection with enforced royalties, no mint. */
export function registerExistingIx(a: { admin: PublicKey; cid: string; params: ExistingParams }, pid = OMNI_PROGRAM_ID) {
  const p = a.params;
  const w = disc("register_existing").bytes(hex32(a.cid)).str(p.name).str(p.collectionUri).str(p.baseUri).pk(p.payout).u16(p.royaltyBps).u32(p.maxSupply).u32(p.eids.length);
  p.eids.forEach((e) => w.u32(e));
  return ix([meta(a.admin, true, true), meta(storePda(pid)), meta(dropPda(a.cid, pid), true), meta(collectionPda(a.cid, pid), true), meta(MPL_CORE_ID), meta(SystemProgram.programId)], w.out(), pid);
}
/** Admin: create ids [start, start+qty) of an existing collection as locked copies owned by the Store (qty <= MAX_COPIES_TX). */
export function existingCopiesIx(admin: PublicKey, cid: string, start: number, qty: number, pid = OMNI_PROGRAM_ID) {
  const assets = Array.from({ length: qty }, (_, k) => meta(assetPda(cid, start + k, pid), true));
  return ix([meta(admin, true, true), meta(storePda(pid)), meta(dropPda(cid, pid)), meta(collectionPda(cid, pid), true), meta(MPL_CORE_ID), meta(SystemProgram.programId), ...assets],
    disc("existing_copies").u32(start).u32(qty).out(), pid);
}

// ------------------------------------------------------------------ accounts (fixed layouts, byte 0 = kind)
export function decodeStore(d: Uint8Array) {
  const r = new R(d); r.bytes(2);
  const feeBps = r.u16(), localEid = r.u32();
  return { feeBps, localEid, admin: r.pk(), endpoint: r.pk(), approver: hexlify(r.bytes(20)), feeRecipient: r.pk(), moveFee: r.u64(),
    gas: { requestBase: r.u64(), requestPerId: r.u64(), moveGas: r.u64() } as Gas };
}
export function decodePeer(d: Uint8Array) { return { eid: new R(d.slice(4)).u32(), address: d.slice(8, 40), mover: d.slice(40, 72), v1Escrow: d.slice(72, 104) }; }
export function decodeDrop(d: Uint8Array) {
  const r = new R(d); r.bytes(3);
  const flags = r.u8();
  const x = { paused: !!(flags & 1), revealed: !!(flags & 2), existing: !!(flags & 4), feeBps: r.u16(), royaltyBps: r.u16(), hubEid: r.u32(), maxSupply: r.u32(),
    mintedHere: r.u32(), pendingQty: r.u32(), held: r.u64(), nextRid: r.u64(), cid: "0x" + Buffer.from(r.bytes(32)).toString("hex"),
    owner: r.pk(), payout: r.pk(), collection: r.pk(), feeRecipient: r.pk(), name: "", baseUri: "", preRevealUri: "", eids: [] as number[], phases: [] as Phase[] };
  const [ne, np, nl, bl, pl] = [d[200], d[201], d[202], d[203], d[204]];
  const e = new R(d.slice(208)); for (let i = 0; i < ne; i++) x.eids.push(e.u32());
  const p = new R(d.slice(240)); for (let i = 0; i < np; i++) x.phases.push({ start: p.i64(), end: p.i64(), maxPerWallet: p.u32(), maxSupply: p.u32(), merkleRoot: p.bytes(32), price: p.u64() });
  const t = new TextDecoder();
  x.name = t.decode(d.slice(752, 752 + nl)); x.baseUri = t.decode(d.slice(784, 784 + bl)); x.preRevealUri = t.decode(d.slice(984, 984 + pl));
  return x;
}
export function decodeRequest(d: Uint8Array) {
  const r = new R(d.slice(4));
  const status = d[2], qty = r.u32(), start = r.u32(); r.bytes(4);
  return { status, qty, start, paid: r.u64(), to: r.pk(), payer: r.pk() };
}
/** Metaplex Core AssetV1: key (1) | owner (32) | update authority (enum) ... */
export const coreAssetOwner = (d: Uint8Array) => (d[0] === 1 ? new PublicKey(d.slice(1, 33)) : null);
export const hexOf = (b: Uint8Array) => hexlify(b) as `0x${string}`;
