import assert from 'node:assert/strict';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeWalletLink } from '../src/walletlink.js';
import { makeSolanaLink } from '../src/solanalink.js';
import { makeProfiles } from '../src/profiles.js';
// Throwaway keys generated in memory for this test only (never printed or saved).
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = u => { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; };
const b64 = u => Buffer.from(u).toString('base64');
const kv = () => { const m = new Map(); return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) }; };
const env = { COLLECTIONS: kv(), NONCES: kv() };
class E extends Error { constructor(m, s) { super(m); this.status = s; } }
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const deps = { lc: s => String(s).toLowerCase(), bad: (m, s = 400) => { throw new E(m, s); }, ADDR: /^0x[0-9a-fA-F]{40}$/, rand, verifyEvm: (address, message, signature) => verifyMessage({ address, message, signature }).catch(() => false) };
const W = makeWalletLink(deps), SL = makeSolanaLink({ ...deps, wl: W });
let session = null;
const P = makeProfiles({ CFG: { chains: {} }, ...deps, wl: W, requireSession: async () => session || deps.bad('sign in', 401), rpcFanout: async () => null, osFetch: async () => null });
const call = async (M, path, b) => { const url = new URL('https://api.multisea.io' + path), p = url.pathname.split('/').filter(Boolean), body = async () => b;
  for (const h of [W, SL, P]) { const r = await h.handle(new Request(url, { method: M }), env, url, p, M, body); if (r !== undefined) return r; } };
const status = async (pr, code, re) => { try { await pr; } catch (e) { assert.equal(e.status, code, e.message); if (re) assert.match(e.message, re); return; } assert.fail('expected ' + code); };
const acct = () => privateKeyToAccount(generatePrivateKey());
const solAcct = async () => { const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); return { address: b58(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))), sign: async m => b64(new Uint8Array(await crypto.subtle.sign('Ed25519', k.privateKey, new TextEncoder().encode(m)))) }; };
const evmSign = a => ({ address: a.address, sign: m => a.signMessage({ message: m }) });
async function link(primary, w, { primarySigner = primary, walletSigner = w } = {}) {
  const n = await call('GET', `/profile/link/nonce?profile=${primary.address}`);
  await call('POST', '/profile/link/authorize', { nonce: n.nonce, profileSignature: await primarySigner.sign(n.confirm) });
  const { message } = await call('GET', `/profile/link/message?nonce=${n.nonce}&wallet=${w.address}`);
  return call('POST', '/profile/link', { nonce: n.nonce, wallet: w.address, walletSignature: await walletSigner.sign(message) });
}
async function unlink(primary, w, by) {
  const n = await call('GET', `/profile/unlink/nonce?profile=${primary.address}&wallet=${w.address}&by=${by.address}`);
  return call('POST', '/profile/unlink', { nonce: n.nonce, signature: await by.sign(n.message) });
}
const lc = a => a.startsWith('0x') ? a.toLowerCase() : a;

const main = evmSign(acct()), evm2 = evmSign(acct()), stranger = evmSign(acct()), s1 = await solAcct(), s2 = await solAcct();
// EVM wallet link: needs the primary's authorize signature AND the new wallet's signature
await status(link(main, evm2, { primarySigner: stranger }), 401, /profile wallet/);
await status(link(main, evm2, { walletSigner: stranger }), 401, /that wallet/);
let r = await link(main, evm2);
assert.equal(r.profile, lc(main.address)); assert.deepEqual(r.wallets.map(w => [w.addr, w.kind]), [[lc(evm2.address), 'evm']]);
// Solana wallet link (Ed25519)
const badSol = await solAcct();
await status(link(main, s1, { walletSigner: badSol }), 401);
r = await link(main, s1); assert.deepEqual(r.wallets.map(w => w.kind), ['evm', 'sol']);
// replay of a used nonce
{ const n = await call('GET', `/profile/link/nonce?profile=${main.address}`); await call('POST', '/profile/link/authorize', { nonce: n.nonce, profileSignature: await main.sign(n.confirm) });
  const { message } = await call('GET', `/profile/link/message?nonce=${n.nonce}&wallet=${s2.address}`); const sig = await s2.sign(message);
  await call('POST', '/profile/link', { nonce: n.nonce, wallet: s2.address, walletSignature: sig });
  await status(call('POST', '/profile/link', { nonce: n.nonce, wallet: s2.address, walletSignature: sig }), 401, /expired/);
  // a link signature is bound to the wallet named in it
  await status(call('POST', '/profile/link/authorize', { nonce: n.nonce, profileSignature: await main.sign(n.confirm) }), 401); }
// refusals: self, duplicate, wallet in another profile, primary that is itself linked, wallet with its own profile
await status(link(main, main), 400, /profile wallet itself/);
await status(link(main, evm2), 409, /already linked to this profile/);
await status(link(stranger, evm2), 409, /another profile/);
await status(call('GET', `/profile/link/nonce?profile=${evm2.address}`), 409, /linked to another profile/);
const named = evmSign(acct()); session = { address: lc(named.address) }; await call('POST', '/profile', { name: 'Named' }); session = null;
await status(link(main, named), 409, /own MultiSea profile/);
const hasLinks = evmSign(acct()); await link(hasLinks, await solAcct());
await status(link(main, hasLinks), 409, /own MultiSea profile/);
// a linked wallet cannot save its own profile
session = { address: lc(evm2.address) }; await status(call('POST', '/profile', { name: 'Sneaky' }), 409, /linked to another profile/);
session = { address: lc(main.address) }; await call('POST', '/profile', { name: 'Main' }); session = null;
// reads: any linked address resolves to the same profile; /profiles shows the profile name for a linked wallet
for (const a of [main, evm2, s1]) { const v = await call('GET', `/profile/wallets/${a.address}`); assert.equal(v.profile, lc(main.address)); assert.equal(v.wallets.length, 3); }
assert.deepEqual((await call('GET', `/profile/wallets/${stranger.address}`)).wallets, []);
const prof = (await call('GET', `/profiles?addresses=${evm2.address},${main.address},${stranger.address}`)).profiles;
assert.equal(prof[lc(evm2.address)].name, 'Main'); assert.equal(prof[lc(evm2.address)].primary, lc(main.address)); assert.equal(prof[lc(evm2.address)].address, lc(evm2.address));
assert.equal(prof[lc(main.address)].name, 'Main'); assert.equal(prof[lc(stranger.address)].name, '');
const map = (await call('GET', `/profile/resolve?addresses=${main.address},${evm2.address},${stranger.address},${s1.address}`)).map;
assert.deepEqual(map, { [lc(main.address)]: lc(main.address), [lc(evm2.address)]: lc(main.address), [s1.address]: lc(main.address) });
// legacy endpoint sees the first Solana wallet
assert.equal((await call('GET', `/profile/${main.address}/solana`)).sol, s1.address);
assert.equal((await call('GET', `/profile/solana/${s1.address}`)).address, lc(main.address));
// unlink: by the primary, by the wallet itself; a stranger cannot
await status(call('GET', `/profile/unlink/nonce?profile=${main.address}&wallet=${evm2.address}&by=${stranger.address}`), 400);
{ const n = await call('GET', `/profile/unlink/nonce?profile=${main.address}&wallet=${evm2.address}&by=${evm2.address}`);
  await status(call('POST', '/profile/unlink', { nonce: n.nonce, signature: await stranger.sign(n.message) }), 401); }
r = await unlink(main, evm2, evm2); assert.equal(r.wallets.length, 2);
r = await unlink(main, s1, s1); assert.deepEqual(r.wallets.map(w => w.addr), [s2.address]);
r = await unlink(main, s2, main); assert.deepEqual(r.wallets, []);
assert.equal((await call('GET', `/profile/wallets/${evm2.address}`)).profile, lc(evm2.address));
assert.equal((await call('GET', `/profiles?addresses=${evm2.address}`)).profiles[lc(evm2.address)].name, '');
// max 10
const big = evmSign(acct()); for (let i = 0; i < 10; i++) await link(big, i % 2 ? await solAcct() : evmSign(acct()));
await status(link(big, await solAcct()), 409, /at most 10/);
// migration of the old single Solana link (profile:sol:/solprofile:) on first read
const old = evmSign(acct()), oldSol = await solAcct();
await env.COLLECTIONS.put('profile:sol:' + lc(old.address), JSON.stringify({ sol: oldSol.address, linkedAt: 123 })); await env.COLLECTIONS.put('solprofile:' + oldSol.address, lc(old.address));
assert.equal((await call('GET', `/profile/wallets/${oldSol.address}`)).profile, lc(old.address));
assert.deepEqual(JSON.parse(env.COLLECTIONS.m.get('profile:wallets:' + lc(old.address))), [{ addr: oldSol.address, kind: 'sol', linkedAt: 123 }]);
assert.ok(!env.COLLECTIONS.m.has('profile:sol:' + lc(old.address)) && !env.COLLECTIONS.m.has('solprofile:' + oldSol.address));
assert.equal(env.COLLECTIONS.m.get('walletprofile:' + oldSol.address), lc(old.address));
assert.equal((await call('GET', `/profile/${old.address}/solana`)).sol, oldSol.address);
console.log('PASS wallet link: EVM + Ed25519 signatures, primary authorize, replay, refusals, resolve, /profiles, unlink by either side, max 10, migration');
