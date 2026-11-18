// Multi-wallet profiles: one profile (its primary EVM address) + up to 10 linked wallets (EVM or Solana). No transactions,
// only signed messages. A wallet belongs to at most one profile.
// Link (primary first, so the same flow works for a second EVM wallet the user switches to, and for Phantom/Solflare):
//   GET  /profile/link/nonce?profile=<primary>                  -> { nonce, confirm }   primary signs `confirm`
//   POST /profile/link/authorize { nonce, profileSignature }     -> { nonce, issued }
//   GET  /profile/link/message?nonce=&wallet=<addr>              -> { message }          the new wallet signs it
//   POST /profile/link { nonce, wallet, walletSignature }        -> { profile, wallets }
// Unlink (signed by the primary OR by the linked wallet itself):
//   GET  /profile/unlink/nonce?profile=<primary>&wallet=<addr>&by=<primary|wallet> -> { nonce, message }
//   POST /profile/unlink { nonce, signature }                    -> { profile, wallets }
// Read: GET /profile/wallets/<addr> -> { profile, wallets }  (any linked address resolves to its profile)
//       GET /profile/resolve?addresses=a,b,… (<=100)            -> { map: { addr: primary } } (linked ones + primaries with links)
// KV (COLLECTIONS): 'profile:wallets:'+primary = [{ addr, kind: 'evm'|'sol', linkedAt }], 'walletprofile:'+addr = primary
// (EVM lowercased, Solana base58). Nonces (NONCES): 'pl:'+nonce, 10 min. The old single Solana link ('profile:sol:'+evm,
// 'solprofile:'+sol) is moved into the list the first time the profile is read (old endpoints keep working on the list).
import { b58decode, verifyEd25519, SOL_ADDR } from './solanalink.js';
export const MAX_WALLETS = 10;
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export function makeWalletLink({ lc, bad, ADDR, rand, verifyEvm }) {
  const LIST = p => 'profile:wallets:' + p, REV = a => 'walletprofile:' + a;
  const norm = a => (ADDR.test(a || '') ? lc(a) : SOL_ADDR.test(a || '') && b58decode(a).length === 32 ? a : null);
  const kindOf = a => (a.startsWith('0x') ? 'evm' : 'sol');
  const authMsg = (p, n, t) => `MultiSea: add a wallet to your profile\nProfile: ${p}\nNonce: ${n}\nIssued: ${t}\n\nOnly sign this on multisea.io.`;
  const linkMsg = (p, w, n, t) => `MultiSea: link wallet\nProfile: ${p}\nWallet: ${w}\nNonce: ${n}\nIssued: ${t}`;
  const unlinkMsg = (p, w, n, t) => `MultiSea: unlink wallet\nProfile: ${p}\nWallet: ${w}\nNonce: ${n}\nIssued: ${t}`;

  /** The profile's linked wallets (migrates the old single Solana link once). */
  async function list(env, primary) {
    const p = lc(primary); const cur = await env.COLLECTIONS.get(LIST(p), 'json');
    if (cur) return cur;
    const old = await env.COLLECTIONS.get('profile:sol:' + p, 'json');
    if (!old?.sol) return [];
    const ws = [{ addr: old.sol, kind: 'sol', linkedAt: old.linkedAt || Date.now() }];
    const taken = await env.COLLECTIONS.get(REV(old.sol));
    if (!taken || taken === p) {
      await env.COLLECTIONS.put(LIST(p), JSON.stringify(ws)); await env.COLLECTIONS.put(REV(old.sol), p);
      await env.COLLECTIONS.delete('profile:sol:' + p); await env.COLLECTIONS.delete('solprofile:' + old.sol);
      return ws;
    }
    return [];
  }
  /** Primary of any address (itself when it is not linked anywhere). */
  async function profileOf(env, addr) {
    const a = norm(addr); if (!a) return null;
    const r = await env.COLLECTIONS.get(REV(a)); if (r) return r;
    if (kindOf(a) === 'sol') { const o = await env.COLLECTIONS.get('solprofile:' + a); if (o) { await list(env, o); return o; } return null; }
    return a;
  }
  async function save(env, p, ws) { ws.length ? await env.COLLECTIONS.put(LIST(p), JSON.stringify(ws)) : await env.COLLECTIONS.delete(LIST(p)); }
  /** Link checks shared with the old Solana endpoint. Throws on conflict. */
  async function canLink(env, p, w) {
    if (w === p) bad('that is the profile wallet itself');
    if (await env.COLLECTIONS.get(REV(p))) bad('this wallet is linked to another profile; use that profile', 409);
    const owner = await env.COLLECTIONS.get(REV(w));
    if (owner === p) bad('already linked to this profile', 409);
    if (owner || (kindOf(w) === 'sol' && await env.COLLECTIONS.get('solprofile:' + w))) bad('that wallet is already linked to another profile; unlink it there first', 409);
    if (kindOf(w) === 'evm') {
      const own = await env.COLLECTIONS.get('profile:' + w, 'json');
      if (own?.name || (await list(env, w)).length) bad('that wallet has its own MultiSea profile (name or linked wallets); clear it first', 409);
    }
    const ws = await list(env, p); if (ws.length >= MAX_WALLETS) bad(`a profile can link at most ${MAX_WALLETS} wallets`, 409);
    return ws;
  }
  async function add(env, p, w) {
    const ws = await canLink(env, p, w);
    ws.push({ addr: w, kind: kindOf(w), linkedAt: Date.now() }); await save(env, p, ws); await env.COLLECTIONS.put(REV(w), p);
    return ws;
  }
  async function remove(env, p, w) {
    const ws = (await list(env, p)).filter(x => x.addr !== w); await save(env, p, ws);
    if ((await env.COLLECTIONS.get(REV(w))) === p) await env.COLLECTIONS.delete(REV(w));
    return ws;
  }
  async function verifyBy(addr, message, signature) {
    if (kindOf(addr) === 'evm') return /^0x[0-9a-fA-F]+$/.test(signature || '') && verifyEvm(addr, message, signature);
    let sig; try { sig = b64(String(signature || '')); } catch { return false; } if (sig.length !== 64) return false;
    return verifyEd25519(b58decode(addr), new TextEncoder().encode(message), sig);
  }
  async function take(env, nonce, kind) {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{24}$/.test(nonce)) bad('invalid nonce');
    const r = await env.NONCES.get('pl:' + nonce, 'json'); if (!r || r.kind !== kind) bad('one-time code expired or unknown, start again', 401);
    return r;
  }
  const view = (p, ws) => ({ profile: p, wallets: ws });

  async function handle(req, env, url, p, M, body) {
    if (p[0] !== 'profile') return;
    const q = k => url.searchParams.get(k) || '';
    if (M === 'GET' && p[1] === 'wallets' && p.length === 3) { const pr = await profileOf(env, p[2]); if (!pr) bad('invalid address'); return view(pr, kindOf(pr) === 'evm' ? await list(env, pr) : []); }
    if (M === 'GET' && p[1] === 'resolve' && p.length === 2) {
      const as = [...new Set(q('addresses').split(',').map(norm).filter(Boolean))]; if (!as.length || as.length > 100) bad('provide 1 to 100 valid addresses');
      const map = {}; await Promise.all(as.map(async a => { const r = await env.COLLECTIONS.get(REV(a)); if (r) map[a] = r; else if (kindOf(a) === 'evm' && (await list(env, a)).length) map[a] = a; }));
      return { map };
    }
    if (p[1] === 'link' && M === 'GET' && p[2] === 'nonce' && p.length === 3) {
      const pr = norm(q('profile')); if (!pr || kindOf(pr) !== 'evm') bad('invalid profile address');
      if (await env.COLLECTIONS.get(REV(pr))) bad('this wallet is linked to another profile; use that profile', 409);
      if ((await list(env, pr)).length >= MAX_WALLETS) bad(`a profile can link at most ${MAX_WALLETS} wallets`, 409);
      const n = rand(12), t = new Date().toISOString();
      await env.NONCES.put('pl:' + n, JSON.stringify({ kind: 'auth', profile: pr, t }), { expirationTtl: 600 });
      return { nonce: n, confirm: authMsg(pr, n, t) };
    }
    if (p[1] === 'link' && M === 'POST' && p[2] === 'authorize' && p.length === 3) {
      const { nonce, profileSignature } = await body(); const r = await take(env, nonce, 'auth');
      if (!(await verifyBy(r.profile, authMsg(r.profile, nonce, r.t), profileSignature))) bad('signature does not match the profile wallet', 401);
      await env.NONCES.put('pl:' + nonce, JSON.stringify({ ...r, kind: 'link' }), { expirationTtl: 600 });
      return { nonce, issued: r.t, profile: r.profile };
    }
    if (p[1] === 'link' && M === 'GET' && p[2] === 'message' && p.length === 3) {
      const r = await take(env, q('nonce'), 'link'); const w = norm(q('wallet')); if (!w) bad('invalid wallet address');
      await canLink(env, r.profile, w);
      return { message: linkMsg(r.profile, w, q('nonce'), r.t) };
    }
    if (p[1] === 'link' && M === 'POST' && p.length === 2) {
      const { nonce, wallet: w0, walletSignature } = await body(); const r = await take(env, nonce, 'link'); const w = norm(w0); if (!w) bad('invalid wallet address');
      if (!(await verifyBy(w, linkMsg(r.profile, w, nonce, r.t), walletSignature))) bad('signature does not match that wallet', 401);
      await env.NONCES.delete('pl:' + nonce);
      return view(r.profile, await add(env, r.profile, w));
    }
    if (p[1] === 'unlink' && M === 'GET' && p[2] === 'nonce' && p.length === 3) {
      const pr = norm(q('profile')), w = norm(q('wallet')), by = norm(q('by'));
      if (!pr || !w || !by || (by !== pr && by !== w)) bad('invalid unlink request');
      if (!(await list(env, pr)).some(x => x.addr === w)) bad('that wallet is not linked to this profile', 404);
      const n = rand(12), t = new Date().toISOString();
      await env.NONCES.put('pl:' + n, JSON.stringify({ kind: 'unlink', profile: pr, wallet: w, by, t }), { expirationTtl: 600 });
      return { nonce: n, message: unlinkMsg(pr, w, n, t) };
    }
    if (p[1] === 'unlink' && M === 'POST' && p.length === 2) {
      const { nonce, signature } = await body(); const r = await take(env, nonce, 'unlink');
      if (!(await verifyBy(r.by, unlinkMsg(r.profile, r.wallet, nonce, r.t), signature))) bad('signature does not match', 401);
      await env.NONCES.delete('pl:' + nonce);
      return view(r.profile, await remove(env, r.profile, r.wallet));
    }
  }
  return { handle, list, profileOf, add, remove, canLink };
}
