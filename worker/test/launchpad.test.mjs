// Unit tests for worker/src/launchpad.js: in-memory KV, THROWAWAY keys only. Run: node --test test/launchpad.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, keccak256, concat } from 'viem';
import { makeLaunchpad, configHash, omniConfigHash, collectionIdOf, merkle, proofFor, leafOf, APPROVAL_TYPES, OMNI_APPROVAL_TYPES } from '../src/launchpad.js';
const CFG = JSON.parse(fs.readFileSync(new URL('../../config/collections.json', import.meta.url)));
const LP0 = JSON.parse(fs.readFileSync(new URL('../../config/launchpad.json', import.meta.url)));
const lc = s => String(s || '').toLowerCase();
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ADMIN = '0xca89ae48a5c61d13e78236daa4ac29ee588ea475';
function kv() { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list({ prefix = '' }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })) }; } }; }
const creator = privateKeyToAccount(generatePrivateKey());
const FACTORY = '0x' + '11'.repeat(20); const ESC = '0x' + '33'.repeat(20);
function setup(over = {}) {
  const LP = { ...LP0, factories: { ...LP0.factories, base: FACTORY, bnb: FACTORY }, omniEscrows: { ...LP0.omniEscrows, base: ESC, bnb: ESC } };
  const env = { COLLECTIONS: kv(), ADMIN_ADDRESSES: ADMIN, ...over.env };
  let who = lc(creator.address);
  const L = makeLaunchpad({ LP, chains: CFG.chains, lc, bad, ADDR, admins: e => [ADMIN], requireSession: async () => ({ address: who }), isDropOnChain: async (k, f, a) => over.isDrop ?? true, now: () => 1_800_000_000_000 });
  const call = (M, path, b) => L.handle({ json: async () => b ?? {} }, env, null, path.split('/').filter(Boolean), M, async () => b);
  return { env, call, as: a => { who = lc(a); } };
}
const AL = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2', '0x00000000000000000000000000000000000000c3'];
const drop = (o = {}) => ({ slug: 'lil-foots-drop', name: 'LIL FOOTS', symbol: 'foot', chains: ['base'], maxSupply: 4404, creatorReserve: 4, royaltyBps: 500, reveal: 'delayed', preRevealURI: 'ipfs://bafyplaceholder/hidden.json',
  phases: [{ name: 'Foot holders', kind: 'allowlist', start: 1800000000, end: 1800086400, price: '2000000000000000', maxPerWallet: 2, allowlist: AL }, { name: 'Public', kind: 'public', start: 1800086400, end: 0, price: '3000000000000000', maxPerWallet: 5 }], ...o });

test('configHash matches the Solidity vector (contracts/test/Launchpad.t.sol)', () => {
  const C = '0x0000000000000000000000000000000000c0ffee';
  const h = configHash({ name: 'LIL FOOTS', symbol: 'FOOT', owner: C, payout: C, feeWallet: '0x000000000000000000000000000000000000dEaD', platformFeeBps: 77, maxSupply: 4404, creatorReserve: 4, royaltyReceiver: C, royaltyBps: 500n, baseURI: '', preRevealURI: 'ipfs://placeholder.json',
    phases: [{ start: 1800000000n, end: 1800086400n, price: 2000000000000000n, maxPerWallet: 2, merkleRoot: '0x' + '0'.repeat(60) + '1234' }, { start: 1800086400n, end: 0n, price: 3000000000000000n, maxPerWallet: 5, merkleRoot: '0x' + '0'.repeat(64) }] });
  assert.equal(h, '0x82b8279731e21087b8c73de97a07d66a0fc9ba869eaded0078005130b068ccef');
});

test('merkle proofs verify (OZ sorted-pair) and reject outsiders', () => {
  const { root, layers } = merkle(AL);
  for (const a of AL) { let h = leafOf(a); for (const s of proofFor(layers, a)) h = keccak256(h < s ? concat([h, s]) : concat([s, h])); assert.equal(h, root); }
  assert.equal(proofFor(layers, '0x00000000000000000000000000000000000000d4'), null);
});

test('submit validates input', async () => {
  const { call } = setup();
  await assert.rejects(call('POST', '/launchpad/submit', drop({ chains: ['abstract'] })), /supported chains/);
  await assert.rejects(call('POST', '/launchpad/submit', drop({ royaltyBps: 2000 })), /royalty/);
  await assert.rejects(call('POST', '/launchpad/submit', drop({ reveal: 'instant', baseURI: '' })), /instant reveal/);
  await assert.rejects(call('POST', '/launchpad/submit', drop({ phases: [{ kind: 'allowlist', start: 1, price: '1', allowlist: ['nope'] }] })), /allowlist/);
  await assert.rejects(call('POST', '/launchpad/submit', drop({ preRevealURI: 'javascript:alert(1)' })), /ipfs/);
  await assert.rejects(call('POST', '/launchpad/submit', drop({ chains: ['base', 'bnb'], allocations: { base: 4000, bnb: 300 } })), /add up/);
  const ok = await call('POST', '/launchpad/submit', drop({ slug: 'multi-chain', chains: ['base', 'bnb'], allocations: { base: 3404, bnb: 1000 } })); assert.equal(ok.status, 'pending');
});

test('submit -> admin queue -> approve -> proof -> approval signature -> deployed + auto-listed', async () => {
  const { call, env, as } = setup();
  const r = await call('POST', '/launchpad/submit', drop()); assert.equal(r.status, 'pending');
  await assert.rejects(call('POST', '/launchpad/submit', drop()), /slug already used/);
  await assert.rejects(call('GET', '/admin/launchpad/pending'), /admin only/);
  as(ADMIN); const q = await call('GET', '/admin/launchpad/pending'); assert.equal(q.pending.length, 1); assert.equal(q.pending[0].allowlistCounts[0], 3); assert.equal(q.pending[0].allowlists, undefined);
  const ap = await call('POST', '/admin/launchpad/approve/lil-foots-drop'); assert.equal(ap.status, 'approved');
  { const l = (await call('GET', '/launchpad/drops')).drops; assert.equal(l.length, 1); assert.equal(l[0].deployed, false, 'approved, no contract yet -> deployed: false'); }
  const pr = await call('GET', `/launchpad/proof/lil-foots-drop/0/${AL[1]}`); assert.ok(pr.eligible && pr.proof.length >= 1);
  assert.equal((await call('GET', `/launchpad/proof/lil-foots-drop/0/0x00000000000000000000000000000000000000d4`)).eligible, false);
  as(creator.address);
  await assert.rejects(call('POST', '/launchpad/approval/lil-foots-drop', { chain: 'base' }), /not enabled/); // no key -> 501
  env.LAUNCHPAD_APPROVER_KEY = (await import('viem/accounts')).generatePrivateKey(); const appr = privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY);
  const a = await call('POST', '/launchpad/approval/lil-foots-drop', { chain: 'base' });
  assert.equal(a.factory, FACTORY);
  const ok = await verifyTypedData({ address: appr.address, domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: CFG.chains.base.chainId, verifyingContract: FACTORY }, types: APPROVAL_TYPES, primaryType: 'DropApproval', message: { creator: creator.address, configHash: a.configHash, salt: a.salt, deadline: BigInt(a.deadline) }, signature: a.signature });
  assert.ok(ok, 'approval signature recovers to approver');
  await assert.rejects(call('POST', '/launchpad/approval/lil-foots-drop', { chain: 'ethereum' }), /no factory/);
  as(AL[0]); await assert.rejects(call('POST', '/launchpad/approval/lil-foots-drop', { chain: 'base' }), /only the creator/);
  as(creator.address);
  const dep = await call('POST', '/launchpad/deployed/lil-foots-drop', { chain: 'base', address: '0x' + '22'.repeat(20) });
  assert.equal(dep.drop.status, 'live'); assert.equal(dep.drop.deployed, true);
  assert.equal((await call('GET', '/launchpad/drops/lil-foots-drop')).drop.deployed, true);
  const col = await env.COLLECTIONS.get('col:lil-foots-drop', 'json'); assert.equal(col.status, 'approved'); assert.equal(col.source, 'launchpad'); assert.equal(col.deployments[0].chain, 'base');
});

test('deployed rejects addresses that are not factory drops', async () => {
  const { call, as } = setup({ isDrop: false });
  await call('POST', '/launchpad/submit', drop()); as(ADMIN); await call('POST', '/admin/launchpad/approve/lil-foots-drop'); as(creator.address);
  await assert.rejects(call('POST', '/launchpad/deployed/lil-foots-drop', { chain: 'base', address: '0x' + '22'.repeat(20) }), /not a MultiSea launchpad drop/);
});

test('reject stores reason and clears queue', async () => {
  const { call, env, as } = setup();
  await call('POST', '/launchpad/submit', drop()); as(ADMIN);
  await call('POST', '/admin/launchpad/reject/lil-foots-drop', { reason: 'art rights unclear' });
  assert.equal((await call('GET', '/admin/launchpad/pending')).pending.length, 0);
  assert.equal((await env.COLLECTIONS.get('lrejected:lil-foots-drop', 'json')).reason, 'art rights unclear');
});

test('omniConfigHash matches the Solidity vector (contracts/test/LaunchpadOmniBatch.t.sol)', () => {
  const C = '0x0000000000000000000000000000000000c0ffee';
  const h = omniConfigHash({ name: 'LIL FOOTS', symbol: 'FOOT', owner: C, payout: C, feeWallet: '0x000000000000000000000000000000000000dEaD', platformFeeBps: 50, maxSupply: 30, royaltyReceiver: C, royaltyBps: 500n,
    baseURI: 'ipfs://bafyFINAL/', preRevealURI: '', phases: [{ start: 1800000000n, end: 0n, price: 0n, maxPerWallet: 0, merkleRoot: '0x' + '0'.repeat(64) }],
    eids: [1, 2, 3, 4], hubEid: 1, prices: [3000000000000000n, 12000000000000000000n, 12000000000000000n, 3000000000000000n], copyMode: 0, batchK: 10, batchT: 1800 });
  assert.equal(h, '0x6115664fee8498b1e1533fc5c415bc3861629814e6238bf7074b227638197050');
});

test('multichain drop: validation, shared supply via the Base hub, omni approval, escrow excluded on auto-list', async () => {
  const { call, env, as } = setup();
  const md = o => drop({ slug: 'omni-foots', mode: 'multichain', chains: ['base', 'bnb'], maxSupply: 4404, creatorReserve: 0,
    phases: [{ name: 'Public', kind: 'public', start: 1800000000, end: 0, price: '3000000000000000', prices: { bnb: '10000000000000000' }, maxPerWallet: 5 }], ...o });
  await assert.rejects(call('POST', '/launchpad/submit', md({ chains: ['base'] })), /at least 2 chains/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ chains: ['apechain', 'bnb'], phases: [{ kind: 'public', start: 1800000000, price: '1', prices: { apechain: '1', bnb: '1' } }] })), /supply hub/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ phases: [{ kind: 'public', start: 1800000000, price: '1' }] })), /price on bnb/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ creatorReserve: 4 })), /reserve/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ batchK: 5 })), /batch size K/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ batchTMin: 2000 })), /batch window T/);
  await assert.rejects(call('POST', '/launchpad/submit', md({ copyMode: 'pools' })), /copyMode/);
  const am = await call('POST', '/launchpad/submit', md({ slug: 'omni-atmint', copyMode: 'at-mint' })); assert.equal(am.status, 'pending');
  assert.equal((await call('POST', '/launchpad/submit', md({ slug: 'omni-alloc', allocations: { base: 1, bnb: 1 } }))).status, 'pending'); // per-chain splits are ignored: one shared supply
  await call('POST', '/launchpad/submit', md()); as(ADMIN); await call('POST', '/admin/launchpad/approve/omni-foots'); as(creator.address);
  env.LAUNCHPAD_APPROVER_KEY = (await import('viem/accounts')).generatePrivateKey(); const appr = privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY);
  const a = await call('POST', '/launchpad/approval/omni-foots', { chain: 'bnb' });
  assert.equal(a.mode, 'multichain'); assert.equal(a.params.allocEnd, undefined); assert.equal(a.params.hubEid, 30184); assert.equal(a.params.maxSupply, 4404); assert.deepEqual(a.params.eids, [30184, 30102]);
  assert.equal(a.params.copyMode, 0, 'BATCHED is the default'); assert.equal(a.params.batchK, 50); assert.equal(a.params.batchT, 1800);
  assert.deepEqual(a.params.prices, ['3000000000000000', '10000000000000000']);
  assert.equal(a.collectionId, collectionIdOf('omni-foots', creator.address.toLowerCase()));
  const b2 = await call('POST', '/launchpad/approval/omni-foots', { chain: 'base' }); assert.equal(b2.configHash, a.configHash, 'same config on every chain');
  assert.ok(await verifyTypedData({ address: appr.address, domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: CFG.chains.bnb.chainId, verifyingContract: FACTORY }, types: OMNI_APPROVAL_TYPES, primaryType: 'OmniDropApproval', message: { creator: creator.address, configHash: a.configHash, collectionId: a.collectionId, deadline: BigInt(a.deadline) }, signature: a.signature }));
  await call('POST', '/launchpad/deployed/omni-foots', { chain: 'base', address: '0x' + '44'.repeat(20) });
  await call('POST', '/launchpad/deployed/omni-foots', { chain: 'bnb', address: '0x' + '44'.repeat(20) });
  const col = await env.COLLECTIONS.get('col:omni-foots', 'json');
  assert.equal(col.deployments.length, 2); assert.deepEqual(col.escrow.map(e => e.chain), ['base', 'bnb']); assert.equal(col.escrow[0].address, ESC);
});
