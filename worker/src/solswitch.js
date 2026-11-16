// "Turn Solana on" (/deploy-solana step 5): the on-chain check the Worker runs before it switches Solana on for the site and
// the minting server. Everything is read from public RPCs; nothing is trusted from the request except the program id.
// Solana: the program is a deployed upgradeable program; its Store PDA is initialised (owned by the program, local eid,
// fee recipient, approver as configured); one Peer PDA per EVM chain pointing at that chain's V2 escrow.
// EVM (every chain): factory.omniEscrow() == V2 escrow, escrowV2.peers(Solana) == Store PDA, escrowV2.isSolana(Solana).
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { solKey } from './solanadrop.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(u) { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; }
const onCurve = b => { try { ed25519.ExtendedPoint.fromHex(b); return true; } catch { return false; } };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
/** Solana findProgramAddress (same as PublicKey.findProgramAddressSync). */
export function findPda(seeds, programId) {
  const pid = solKey(programId); const tag = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) { const h = sha256(cat(...seeds, Uint8Array.of(bump), pid, tag)); if (!onCurve(h)) return b58(h); }
  throw new Error('no PDA');
}
const S = s => new TextEncoder().encode(s);
const be32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
export const storePdaOf = pid => findPda([S('Store')], pid);
export const peerPdaOf = (pid, eid) => findPda([S('Peer'), solKey(storePdaOf(pid)), be32(eid)], pid);
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const hex = u => '0x' + [...u].map(x => x.toString(16).padStart(2, '0')).join('');
const u32le = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] * 2 ** 24);
const u16le = (d, o) => d[o] | (d[o + 1] << 8);
const ABI = parseAbi(['function omniEscrow() view returns (address)', 'function peers(uint32) view returns (bytes32)', 'function isSolana(uint32) view returns (bool)']);

/** @returns {{ ok: boolean, problems: string[], store: string, store32: string }} */
export async function verifySolanaSetup({ programId, LP, chains, solRpc = LP.solana.rpc, rpcOf = k => chains[k]?.rpc, fetchFn = fetch }) {
  const SL = LP.solana, V2 = SL.v2, problems = []; solKey(programId);
  const keys = Object.keys(V2.escrows); const eidOf = k => LP.mainnet?.chains?.[k]?.eid ?? LP.eids?.[k];
  const store = storePdaOf(programId), store32 = hex(solKey(store));
  const accs = [programId, store, ...keys.map(k => peerPdaOf(programId, eidOf(k)))];
  const r = await fetchFn(solRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [accs, { encoding: 'base64', commitment: 'confirmed' }] }) }).then(x => x.json());
  const vals = r?.result?.value; if (!Array.isArray(vals)) return { ok: false, problems: ['Solana RPC did not answer'], store, store32 };
  const data = v => (v ? Uint8Array.from(atob(v.data[0]), c => c.charCodeAt(0)) : null);
  const [prog, st, ...peers] = vals;
  if (!prog || prog.owner !== LOADER || !prog.executable) problems.push('Solana: the program is not deployed');
  const sd = data(st);
  if (!st || st.owner !== programId || !sd || sd[0] !== 1) problems.push('Solana: program settings not saved (step 3)');
  else {
    if (u32le(sd, 4) !== SL.eid) problems.push('Solana: settings have the wrong LayerZero id');
    if (u16le(sd, 2) !== (SL.feeBps ?? 50)) problems.push('Solana: settings have the wrong fee');
    if (b58(sd.subarray(92, 124)) !== SL.feeRecipient) problems.push('Solana: settings have the wrong fee recipient');
    const appr = hex(sd.subarray(72, 92)); if (appr.toLowerCase() !== String(LP.mainnet?.approver || LP.approver || '').toLowerCase()) problems.push('Solana: settings have the wrong approver');
  }
  keys.forEach((k, i) => { const v = peers[i], d = data(v);
    if (!v || v.owner !== programId || !d || d[0] !== 2 || u32le(d, 4) !== eidOf(k)) problems.push(`Solana: not linked to ${k} (step 3)`);
    else if (hex(d.subarray(8, 40)).toLowerCase() !== ('0x' + V2.escrows[k].slice(2).toLowerCase().padStart(64, '0'))) problems.push(`Solana: ${k} link points at the wrong escrow`); });
  await Promise.all(keys.map(async k => {
    try { const pc = createPublicClient({ transport: http(rpcOf(k)) }); const fac = LP.mainnet?.chains?.[k]?.factory || LP.factories?.[k]; const esc = getAddress(V2.escrows[k]);
      const [oe, peer, isSol] = await Promise.all([pc.readContract({ address: fac, abi: ABI, functionName: 'omniEscrow' }), pc.readContract({ address: esc, abi: ABI, functionName: 'peers', args: [SL.eid] }), pc.readContract({ address: esc, abi: ABI, functionName: 'isSolana', args: [SL.eid] })]);
      if (getAddress(oe) !== esc) problems.push(`${k}: new drops do not use the new escrow yet (last step)`);
      if (String(peer).toLowerCase() !== store32.toLowerCase()) problems.push(`${k}: escrow not linked to this Solana program`);
      if (!isSol) problems.push(`${k}: Solana not enabled on the escrow`);
    } catch (e) { const m = String(e?.shortMessage || e?.message || e); problems.push(/returned no data/.test(m) ? `${k}: the new escrow is not deployed yet` : `${k}: could not read the chain (${m.slice(0, 80)})`); }
  }));
  return { ok: problems.length === 0, problems, store, store32 };
}
