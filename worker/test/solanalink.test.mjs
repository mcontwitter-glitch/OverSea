import assert from 'node:assert/strict';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeSolanaLink } from '../src/solanalink.js';
// Throwaway keys generated in memory for this test only (never printed or saved).
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = u => { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; };
const b64 = u => Buffer.from(u).toString('base64');
const kv = () => { const m = new Map(); return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; };
const env = { COLLECTIONS: kv(), NONCES: kv() };
class E extends Error { constructor(m, s) { super(m); this.status = s; } }
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const L = makeSolanaLink({ lc: s => String(s).toLowerCase(), bad: (m, s = 400) => { throw new E(m, s); }, ADDR: /^0x[0-9a-fA-F]{40}$/, rand, verifyEvm: (address, message, signature) => verifyMessage({ address, message, signature }).catch(() => false) });
const call = (M, path, b) => { const url = new URL('https://api.multisea.io' + path); return L.handle(new Request(url, { method: M }), env, url, url.pathname.split('/').filter(Boolean), M, async () => b); };

const evm = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const solKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const solPub = new Uint8Array(await crypto.subtle.exportKey('raw', solKey.publicKey)); const sol = b58(solPub);
const solSign = async m => b64(new Uint8Array(await crypto.subtle.sign('Ed25519', solKey.privateKey, new TextEncoder().encode(m))));

assert.deepEqual(await call('GET', `/profile/${evm.address}/solana`), { address: evm.address.toLowerCase(), sol: null, linkedAt: null });
let n = await call('GET', `/profile/solana-link/nonce?address=${evm.address}&sol=${sol}`);
assert.match(n.message, /^MultiSea: link Solana wallet\nProfile: 0x[0-9a-f]{40}\nSolana: /); assert.ok(n.message.includes(sol)); assert.ok(n.confirm.includes(n.nonce));
// wrong Solana signer / wrong EVM signer / replay are refused
const other2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const badSol = b64(new Uint8Array(await crypto.subtle.sign('Ed25519', other2.privateKey, new TextEncoder().encode(n.message))));
await assert.rejects(call('POST', '/profile/solana-link', { nonce: n.nonce, solSignature: badSol, evmSignature: await evm.signMessage({ message: n.confirm }) }), /Solana signature does not match/);
await assert.rejects(call('POST', '/profile/solana-link', { nonce: n.nonce, solSignature: await solSign(n.message), evmSignature: await other.signMessage({ message: n.confirm }) }), /EVM confirm signature/);
const ok = await call('POST', '/profile/solana-link', { nonce: n.nonce, solSignature: await solSign(n.message), evmSignature: await evm.signMessage({ message: n.confirm }) });
assert.equal(ok.sol, sol); assert.equal(ok.address, evm.address.toLowerCase());
await assert.rejects(call('POST', '/profile/solana-link', { nonce: n.nonce, solSignature: await solSign(n.message), evmSignature: await evm.signMessage({ message: n.confirm }) }), /nonce expired/);
assert.equal((await call('GET', `/profile/${evm.address}/solana`)).sol, sol);
assert.equal((await call('GET', `/profile/solana/${sol}`)).address, evm.address.toLowerCase());
// the same Solana wallet moved to another profile: old link removed
n = await call('GET', `/profile/solana-link/nonce?address=${other.address}&sol=${sol}`);
await call('POST', '/profile/solana-link', { nonce: n.nonce, solSignature: await solSign(n.message), evmSignature: await other.signMessage({ message: n.confirm }) });
assert.equal((await call('GET', `/profile/${evm.address}/solana`)).sol, null);
assert.equal((await call('GET', `/profile/solana/${sol}`)).address, other.address.toLowerCase());
// unlink needs the profile's EVM signature
n = await call('GET', `/profile/solana-link/nonce?address=${other.address}&unlink=1`);
await assert.rejects(call('POST', '/profile/solana-unlink', { nonce: n.nonce, evmSignature: await evm.signMessage({ message: n.confirm }) }), /EVM signature/);
await call('POST', '/profile/solana-unlink', { nonce: n.nonce, evmSignature: await other.signMessage({ message: n.confirm }) });
assert.equal((await call('GET', `/profile/${other.address}/solana`)).sol, null); assert.equal((await call('GET', `/profile/solana/${sol}`)).address, null);
await assert.rejects(call('GET', `/profile/solana-link/nonce?address=${evm.address}&sol=0OIl`), /invalid Solana address/);
assert.equal(await call('GET', `/profile/${evm.address}`), undefined, 'other /profile routes fall through');
console.log('PASS solana link: ed25519 + EVM confirm verified, replay/wrong signer refused, move + unlink, reverse lookup');
