// Solana side of a multichain drop (MultiSea omni program). Mirrors src/solanaomni.ts encodeDropParams / dropApprovalDigest.
// The approver key that signs EVM drop approvals signs this too, as an EIP-191 personal message over the 32-byte digest
// (wallet: signMessage({ message: { raw: digest } }); Worker on testnet: LAUNCHPAD_APPROVER_KEY).
import { keccak256, concat, toBytes, recoverMessageAddress } from 'viem';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** base58 -> 32 bytes (Solana public key); throws on anything else. */
export function solKey(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('not a Solana address');
  let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  if (n !== 0n) throw new Error('not a Solana address');
  let lead = 0; while (s[lead] === '1') lead++;
  let z = 0; while (z < 32 && out[z] === 0) z++;
  if (z !== lead) throw new Error('not a Solana address');
  return out;
}

class W { constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  le(v, n) { let x = BigInt(v); if (x < 0n) x += 1n << BigInt(8 * n); for (let i = 0; i < n; i++) { this.b.push(Number(x & 255n)); x >>= 8n; } return this; }
  u16(v) { return this.le(v, 2); } u32(v) { return this.le(v, 4); } u64(v) { return this.le(v, 8); } i64(v) { return this.le(v, 8); }
  bytes(u) { for (const x of u) this.b.push(x); return this; }
  str(s) { const u = new TextEncoder().encode(s); return this.u32(u.length).bytes(u); }
  out() { return new Uint8Array(this.b); } }

/** borsh(DropParams) exactly as the program's DropParams. */
export function encodeDropParams(p) {
  const w = new W().str(p.name).str(p.collectionUri).str(p.baseUri).str(p.preRevealUri).bytes(solKey(p.payout)).u16(p.royaltyBps)
    .u32(p.maxSupply).u32(p.hubEid).u32(p.eids.length);
  p.eids.forEach(e => w.u32(e));
  w.u32(p.phases.length);
  for (const ph of p.phases) w.i64(ph.start).i64(ph.end).u32(ph.maxPerWallet).u32(ph.maxSupply).bytes(toBytes(ph.merkleRoot)).u64(ph.price);
  return w.out();
}

export function dropApprovalDigest(programId, creator, cid, params, deadline) {
  const cfg = keccak256(encodeDropParams(params));
  return keccak256(concat([new TextEncoder().encode('MultiSeaSolanaDrop'), solKey(programId), solKey(creator), toBytes(cfg), toBytes(cid), new W().i64(deadline).out()]));
}

export const recoverSolApprover = (digest, signature) => recoverMessageAddress({ message: { raw: digest }, signature });

/** Solana asset names are capped at 32 bytes by the program. */
export function solName(name) { const e = new TextEncoder(); let s = name; while (e.encode(s).length > 32) s = s.slice(0, -1); return s; }
