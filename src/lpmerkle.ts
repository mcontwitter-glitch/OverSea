// Launchpad mint rules -> transactions (build only; nothing is sent). Merkle tree is byte-identical to the Worker's
// (worker/src/launchpad.js merkle/leafOf/proofFor) and OpenZeppelin MerkleProof: sorted pairs, double-hashed
// abi.encode(address) leaves, odd node carried up.
import { keccak256, encodeAbiParameters, concat, encodeFunctionData, parseEther, type Hex } from 'viem';
export const ZH = ('0x' + '0'.repeat(64)) as Hex;
export const leafOf = (a: string) => keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [a as Hex])));
const hpair = (a: Hex, b: Hex) => keccak256(a < b ? concat([a, b]) : concat([b, a]));
export function merkle(addrs: string[]): { root: Hex; layers: Hex[][] } {
  let lvl = [...new Set(addrs.map(a => a.toLowerCase()))].map(leafOf).sort() as Hex[];
  if (!lvl.length) return { root: ZH, layers: [[]] };
  const layers = [lvl];
  while (lvl.length > 1) { const n: Hex[] = []; for (let i = 0; i < lvl.length; i += 2) n.push(i + 1 < lvl.length ? hpair(lvl[i], lvl[i + 1]) : lvl[i]); layers.push(lvl = n); }
  return { root: lvl[0], layers };
}
export function proofFor(layers: Hex[][], addr: string): Hex[] | null {
  let i = layers[0].indexOf(leafOf(addr.toLowerCase())); if (i < 0) return null; const out: Hex[] = [];
  for (let l = 0; l < layers.length - 1; l++) { const sib = i ^ 1; if (sib < layers[l].length) out.push(layers[l][sib]); i >>= 1; }
  return out;
}
/** Addresses from pasted text or a CSV (any column; header rows and non-address cells ignored). */
export function parseAllowlist(text: string): { ok: string[]; bad: string[] } {
  const cells = text.split(/[\s,;\t]+/).map(c => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const ok = new Set<string>(), bad: string[] = [];
  for (const c of cells) { if (/^0x[0-9a-fA-F]{40}$/.test(c)) ok.add(c.toLowerCase()); else if (/^0x/i.test(c)) bad.push(c); }
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
