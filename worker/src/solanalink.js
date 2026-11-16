// Link a Solana wallet to an EVM profile. Two signatures, no transaction: the Solana wallet signs a server-issued message
// (profile address + one-time nonce) and the profile's EVM wallet signs a confirm message for the same nonce, so nobody can
// attach a Solana wallet to someone else's profile, nor claim someone else's Solana wallet.
//   GET  /profile/solana-link/nonce?address=<evm>&sol=<base58>   -> { nonce, message, confirm }   (unlink: &unlink=1 -> { nonce, confirm })
//   POST /profile/solana-link   { nonce, solSignature (base64), evmSignature (0x…) } -> { address, sol, linkedAt }
//   POST /profile/solana-unlink { nonce, evmSignature }                              -> { address, sol: null }
//   GET  /profile/<evm>/solana  -> { address, sol, linkedAt }      GET /profile/solana/<base58> -> { sol, address }
// KV (COLLECTIONS): 'profile:sol:'+evm = { sol, linkedAt }, 'solprofile:'+sol = evm. Nonces (NONCES): 'sl:'+nonce, 10 min.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function verifyEd25519(pub, msg, sig) {
  for (const alg of [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }]) {
    try { const k = await crypto.subtle.importKey('raw', pub, alg, false, ['verify']); return await crypto.subtle.verify(alg, k, sig, msg); } catch { /* try next */ }
  }
  return false;
}
export function makeSolanaLink({ lc, bad, ADDR, rand, verifyEvm }) {
  const fwd = a => 'profile:sol:' + lc(a), rev = s => 'solprofile:' + s;
  const linkMsg = (evm, sol, n, t) => `MultiSea: link Solana wallet\nProfile: ${evm}\nSolana: ${sol}\nNonce: ${n}\nIssued: ${t}`;
  const confirmMsg = (evm, sol, n, t) => `MultiSea: confirm Solana wallet link\nProfile: ${evm}\nSolana: ${sol}\nNonce: ${n}\nIssued: ${t}\n\nOnly sign this on multisea.io.`;
  const unlinkMsg = (evm, sol, n, t) => `MultiSea: unlink Solana wallet\nProfile: ${evm}\nSolana: ${sol}\nNonce: ${n}\nIssued: ${t}`;
  async function get(env, evm) { const r = await env.COLLECTIONS.get(fwd(evm), 'json'); return { address: lc(evm), sol: r?.sol || null, linkedAt: r?.linkedAt || null }; }
  async function take(env, nonce, kind) {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{24}$/.test(nonce)) bad('invalid nonce');
    const r = await env.NONCES.get('sl:' + nonce, 'json'); if (!r || r.kind !== kind) bad('nonce expired or unknown, start again', 401);
    return r;
  }
  async function handle(req, env, url, p, M, body) {
    if (p[0] !== 'profile') return;
    if (M === 'GET' && p[1] === 'solana-link' && p[2] === 'nonce' && p.length === 3) {
      const evm = url.searchParams.get('address') || ''; if (!ADDR.test(evm)) bad('invalid address');
      const unlink = url.searchParams.get('unlink') === '1';
      const sol = unlink ? (await get(env, evm)).sol : url.searchParams.get('sol') || '';
      if (unlink && !sol) bad('no Solana wallet linked to this profile', 404);
      if (!SOL_ADDR.test(sol) || b58decode(sol).length !== 32) bad('invalid Solana address');
      const n = rand(12), t = new Date().toISOString(), a = lc(evm);
      const r = unlink ? { kind: 'unlink', evm: a, sol, confirm: unlinkMsg(a, sol, n, t) } : { kind: 'link', evm: a, sol, message: linkMsg(a, sol, n, t), confirm: confirmMsg(a, sol, n, t) };
      await env.NONCES.put('sl:' + n, JSON.stringify(r), { expirationTtl: 600 });
      return { nonce: n, ...(r.message ? { message: r.message } : {}), confirm: r.confirm };
    }
    if (M === 'POST' && p[1] === 'solana-link' && p.length === 2) {
      const { nonce, solSignature, evmSignature } = await body();
      const r = await take(env, nonce, 'link');
      let sig; try { sig = b64(String(solSignature || '')); } catch { bad('invalid Solana signature'); }
      if (sig.length !== 64) bad('invalid Solana signature');
      if (!(await verifyEd25519(b58decode(r.sol), new TextEncoder().encode(r.message), sig))) bad('Solana signature does not match that wallet', 401);
      if (!/^0x[0-9a-fA-F]+$/.test(evmSignature || '') || !(await verifyEvm(r.evm, r.confirm, evmSignature))) bad('EVM confirm signature does not match the profile wallet', 401);
      await env.NONCES.delete('sl:' + nonce);
      const prevOwner = await env.COLLECTIONS.get(rev(r.sol)); if (prevOwner && prevOwner !== r.evm) await env.COLLECTIONS.delete(fwd(prevOwner));
      const prev = await get(env, r.evm); if (prev.sol && prev.sol !== r.sol) await env.COLLECTIONS.delete(rev(prev.sol));
      const linkedAt = Date.now();
      await env.COLLECTIONS.put(fwd(r.evm), JSON.stringify({ sol: r.sol, linkedAt })); await env.COLLECTIONS.put(rev(r.sol), r.evm);
      return { address: r.evm, sol: r.sol, linkedAt };
    }
    if (M === 'POST' && p[1] === 'solana-unlink' && p.length === 2) {
      const { nonce, evmSignature } = await body();
      const r = await take(env, nonce, 'unlink');
      if (!/^0x[0-9a-fA-F]+$/.test(evmSignature || '') || !(await verifyEvm(r.evm, r.confirm, evmSignature))) bad('EVM signature does not match the profile wallet', 401);
      await env.NONCES.delete('sl:' + nonce);
      const cur = await get(env, r.evm); if (cur.sol) { await env.COLLECTIONS.delete(rev(cur.sol)); await env.COLLECTIONS.delete(fwd(r.evm)); }
      return { address: r.evm, sol: null };
    }
    if (M === 'GET' && p[1] === 'solana' && p.length === 3) { if (!SOL_ADDR.test(p[2])) bad('invalid Solana address'); return { sol: p[2], address: (await env.COLLECTIONS.get(rev(p[2]))) || null }; }
    if (M === 'GET' && p.length === 3 && p[2] === 'solana' && ADDR.test(p[1])) return get(env, p[1]);
  }
  return { handle };
}
