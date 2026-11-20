// Launchpad mint rules -> transactions (build only; nothing is sent). Merkle tree is byte-identical to the Worker's
// (worker/src/launchpad.js merkle/leafOf/proofFor) and OpenZeppelin MerkleProof: sorted pairs, odd node carried up.
// EVM leaf = keccak(keccak(abi.encode(address))). Solana leaf = keccak(keccak(32-byte pubkey)) — the same leaf the
// existing omni program checks, so one tree can hold both kinds of address without a program upgrade.
import { keccak256, encodeAbiParameters, concat, encodeFunctionData, parseEther, toHex, type Hex } from 'viem';
export const ZH = ('0x' + '0'.repeat(64)) as Hex;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const isEvmAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
/** base58 -> 32 bytes (Solana public key); throws on anything else. Mirrors worker/src/solanadrop.js solKey. */
export function solKey(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error('not a Solana address');
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('not a Solana address'); n = n * 58n + BigInt(i); }
  const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  if (n !== 0n) throw new Error('not a Solana address');
  let lead = 0; while (s[lead] === '1') lead++;
  let z = 0; while (z < 32 && out[z] === 0) z++;
  if (z !== lead) throw new Error('not a Solana address');
  return out;
}
export const isSolAddr = (s: string) => { try { solKey(s); return true; } catch { return false; } };
export const normAllow = (a: string) => (isEvmAddr(a) ? a.toLowerCase() : a);
export const leafOf = (a: string): Hex => isEvmAddr(a)
  ? keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [a as Hex])))
  : keccak256(keccak256(toHex(solKey(a))));
const hpair = (a: Hex, b: Hex) => keccak256(a < b ? concat([a, b]) : concat([b, a]));
export function merkle(addrs: string[]): { root: Hex; layers: Hex[][] } {
  let lvl = [...new Set(addrs.map(normAllow))].map(leafOf).sort() as Hex[];
  if (!lvl.length) return { root: ZH, layers: [[]] };
  const layers = [lvl];
  while (lvl.length > 1) { const n: Hex[] = []; for (let i = 0; i < lvl.length; i += 2) n.push(i + 1 < lvl.length ? hpair(lvl[i], lvl[i + 1]) : lvl[i]); layers.push(lvl = n); }
  return { root: lvl[0], layers };
}
export function proofFor(layers: Hex[][], addr: string): Hex[] | null {
  let i = layers[0].indexOf(leafOf(normAllow(addr))); if (i < 0) return null; const out: Hex[] = [];
  for (let l = 0; l < layers.length - 1; l++) { const sib = i ^ 1; if (sib < layers[l].length) out.push(layers[l][sib]); i >>= 1; }
  return out;
}
/** Addresses from pasted text or a CSV (any column; header rows and non-address cells ignored). solOk also accepts Solana pubkeys (case-sensitive). */
export function parseAllowlist(text: string, solOk = false): { ok: string[]; bad: string[] } {
  const cells = text.split(/[\s,;\t]+/).map(c => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const ok = new Set<string>(), bad: string[] = [];
  for (const c of cells) {
    if (isEvmAddr(c)) ok.add(c.toLowerCase());
    else if (solOk && isSolAddr(c)) ok.add(c);
    else if (/^0x/i.test(c) || (solOk && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c))) bad.push(c);
  }
  return { ok: [...ok].sort(), bad };
}
export const PHASE_T = [{ name: 'start', type: 'uint64' }, { name: 'end', type: 'uint64' }, { name: 'price', type: 'uint128' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'maxSupply', type: 'uint32' }, { name: 'merkleRoot', type: 'bytes32' }] as const;
const SET_PHASES = [{ type: 'function', name: 'setPhases', stateMutability: 'nonpayable', inputs: [{ name: 'ph', type: 'tuple[]', components: PHASE_T }], outputs: [] }] as const;
export type RuleIn = { name: string; start: number; end: number; price: string; maxPerWallet: number; maxSupply: number; allowlist?: string[] };
export const onchainPhases = (rs: RuleIn[]) => rs.map(r => ({ start: BigInt(r.start), end: BigInt(r.end), price: parseEther(r.price || '0'), maxPerWallet: r.maxPerWallet, maxSupply: r.maxSupply || 0, merkleRoot: r.allowlist?.length ? merkle(r.allowlist).root : ZH }));
/** MultiSeaDrop.setPhases(Phase[]) calldata (owner-only on the deployed drop). */
export const setPhasesCalldata = (rs: RuleIn[]) => encodeFunctionData({ abi: SET_PHASES, functionName: 'setPhases', args: [onchainPhases(rs)] });
/** Same rules as thirdweb DropERC721 claim conditions (setClaimConditions input). Allowlist phases there need thirdweb's
 *  snapshot format (leaf = address+limit+price+currency) uploaded to IPFS; MultiSea's root above is NOT interchangeable. */
export const thirdwebClaimConditions = (rs: RuleIn[], native = 'ETH') => rs.map(r => ({
  startTime: new Date(r.start * 1000).toISOString(), maxClaimableSupply: r.maxSupply ? String(r.maxSupply) : 'unlimited', maxClaimablePerWallet: r.maxPerWallet ? String(r.maxPerWallet) : 'unlimited',
  price: r.price || '0', currencyAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', metadata: { name: r.name },
  ...(r.allowlist?.length ? { snapshot: r.allowlist.map(address => ({ address, maxClaimable: r.maxPerWallet ? String(r.maxPerWallet) : 'unlimited', price: r.price || '0' })), note: 'thirdweb uploads this snapshot and computes its own merkle root' } : {}),
  ...(r.end ? { note_end: `thirdweb has no end time: next phase start (or a later condition) must close it at ${new Date(r.end * 1000).toISOString()}` } : {}), currency: native }));
