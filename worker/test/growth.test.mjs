// Unit tests for worker/src/growth.js: in-memory KV + stubbed chain reads, THROWAWAY keys only. Run: node --test test/growth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { makeGrowth, refCode, MINTPASS_TYPES, QUEST_CHAINS } from '../src/growth.js';
import { makeNative } from '../src/native.js';
const CFG = JSON.parse(fs.readFileSync(new URL('../../config/collections.json', import.meta.url)));
const chains = CFG.chains; const lc = s => String(s || '').toLowerCase();
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/;
const FEE = '0x25411039f77529a543344603bd8acdd65faba4d0';
const LIL = CFG.collections[0]; const LILBASE = lc(LIL.deployments.find(d => d.chain === 'base')?.address || LIL.deployments[0].address); const LILCHAIN = LIL.deployments.find(d => d.chain === 'base') ? 'base' : LIL.deployments[0].chain;
function kv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix = '' }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }; } };
}
globalThis.caches = { default: { delete: async () => true } };
function setup(over = {}) {
  const env = { COLLECTIONS: kv(), NONCES: kv(), FEE_WALLET: FEE, ADMIN_ADDRESSES: '0xca89ae48a5c61d13e78236daa4ac29ee588ea475', ...over.env };
  const owners = over.owners || {}; const sessions = over.sessions || {};
  const getCollection = async (e, slug) => slug === LIL.slug ? { slug, name: LIL.name, deployments: LIL.deployments, royalty: over.royalty || null } : null;
  const chainStub = { ownerOf: async (k, t, id) => owners[`${k}:${lc(t)}:${id}`] || null, balanceOf: async (k, t, a) => (over.holds?.[k] === lc(a) ? 1n : 0n), approved: async () => true,
    status: async () => [false, false, 0n, 0n], counter: async () => 0n, verify: async (k, args) => verifyTypedData(args).catch(() => false), receipt: async (k, h) => over.receipts?.[h] || null, tx: async (k, h) => over.txs?.[h] || null, relayStatus: async (e, id) => over.relay?.[id] || null };
  const relayFetch = async () => ({ ok: false, status: 503, json: async () => ({ message: 'offline' }) });
  const native = makeNative({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet: e => lc(e.FEE_WALLET), cached: async (k, t, f) => f() });
  const g = makeGrowth({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet: e => lc(e.FEE_WALLET), admins: e => e.ADMIN_ADDRESSES.split(','), requireSession: async req => { const s = sessions[req.headers.get('authorization')]; if (!s) bad('sign in', 401); return { address: lc(s) }; }, canEdit: async (e, slug, a) => ({ ok: lc(a) === '0xca89ae48a5c61d13e78236daa4ac29ee588ea475' }), relayFetch, chain: chainStub });
  const call = async (method, path, b, auth) => { const url = new URL('https://x' + path); const p = url.pathname.split('/').filter(Boolean); const req = new Request(url, { method, headers: auth ? { authorization: auth } : {}, body: b ? JSON.stringify(b) : undefined }); try { return { s: 200, j: await g.handle(req, env, url, p, method, async () => b, native) }; } catch (e) { return { s: e.status || 500, j: { error: e.message } }; } };
  return { env, g, native, call };
}
const W = n => (10n ** 18n * BigInt(Math.round(n * 1e6))) / 1000000n;

test('referrals: first-touch binding, no self-referral, 20% of fee accrues', async () => {
  const ref = privateKeyToAccount(generatePrivateKey()).address, buyer = privateKeyToAccount(generatePrivateKey()).address, other = privateKeyToAccount(generatePrivateKey()).address;
  const { env, g, call } = setup({ sessions: { A: buyer, R: ref } });
  const st = await call('GET', '/ref/stats/' + ref); assert.equal(st.j.code, refCode(ref)); assert.equal(st.j.path, '/r/' + refCode(ref));
  assert.equal((await call('POST', '/ref/bind', { code: refCode(ref) }, 'R')).s, 400, 'self-referral rejected');
  assert.equal((await call('POST', '/ref/bind', { code: refCode(ref) })).s, 401, 'bind needs SIWE');
  const b1 = await call('POST', '/ref/bind', { code: refCode(ref) }, 'A'); assert.equal(b1.j.bound, true);
  await g.registerCode(env, other);
  const b2 = await call('POST', '/ref/bind', { code: refCode(other) }, 'A'); assert.equal(b2.j.bound, false, 'first touch is permanent'); assert.equal(b2.j.referrer, lc(ref));
  const fee = W(1) * 50n / 10000n; // 0.5% of 1 ETH
  const r = await g.recordSale(env, { chain: 'base', orderHash: '0x' + '11'.repeat(32), buyer, seller: other, priceWei: W(1).toString(), feeWei: fee.toString(), royaltyWei: '0', items: [{ token: LILBASE, id: '5' }] });
  assert.equal(r.referral.amount, (fee * 2000n / 10000n).toString());
  const again = await g.recordSale(env, { chain: 'base', orderHash: '0x' + '11'.repeat(32), buyer, seller: other, priceWei: W(1).toString(), feeWei: fee.toString(), royaltyWei: '0', items: [] });
  assert.equal(again.referral, null, 'idempotent per orderHash');
  const s2 = await call('GET', '/ref/stats/' + ref); assert.equal(s2.j.friends.length, 1); assert.equal(s2.j.earnings.perChain.base, (fee / 5n).toString());
});

test('admin config: referral share configurable, admin only', async () => {
  const { env, g, call } = setup({ sessions: { ADM: '0xca89ae48a5c61d13e78236daa4ac29ee588ea475', U: '0x' + '12'.repeat(20) } });
  assert.equal((await call('POST', '/admin/growth/config', { refBps: 3000 }, 'U')).s, 403);
  assert.equal((await call('POST', '/admin/growth/config', { refBps: 9000 }, 'ADM')).s, 400);
  assert.equal((await call('POST', '/admin/growth/config', { refBps: 3000 }, 'ADM')).j.config.refBps, 3000);
  assert.equal((await g.cfgOf(env)).refBps, 3000);
  const a = await call('GET', '/admin/growth', null, 'ADM'); assert.ok(Array.isArray(a.j.referrers));
});

test('revenue share: opt-in, pro-rata accrual per token with remainder, ownership-checked claim, payouts disabled', async () => {
  const holder = privateKeyToAccount(generatePrivateKey()).address;
  const owners = { [`${LILCHAIN}:${LILBASE}:7`]: lc(holder) };
  const { env, g, call } = setup({ owners, sessions: { ADM: '0xca89ae48a5c61d13e78236daa4ac29ee588ea475', H: holder }, royalty: { recipient: '0x' + '33'.repeat(20), bps: 500 } });
  assert.equal((await call('POST', `/revshare/${LIL.slug}/optin`, { enabled: true, feeShareBps: 9000, royaltyShareBps: 0, supply: 3 }, 'ADM')).s, 400, 'fee share capped');
  assert.equal((await call('POST', `/revshare/${LIL.slug}/optin`, { enabled: true, feeShareBps: 5000, royaltyShareBps: 2000, supply: 3 }, 'ADM')).s, 400, 'terms required');
  assert.equal((await call('POST', `/revshare/${LIL.slug}/optin`, { enabled: true, feeShareBps: 5000, royaltyShareBps: 2000, supply: 3, acceptedTerms: true }, 'H')).s, 403, 'only owner/admin');
  assert.ok((await call('POST', `/revshare/${LIL.slug}/optin`, { enabled: true, feeShareBps: 5000, royaltyShareBps: 2000, supply: 3, acceptedTerms: true }, 'ADM')).j.ok);
  // sale: fee 100 wei, royalty 1000 wei -> pool = 50 + 200 = 250 -> 83/token, rem 1
  await g.recordSale(env, { chain: 'base', orderHash: '0x' + '22'.repeat(32), seller: '0x' + '44'.repeat(20), priceWei: '20000', feeWei: '100', royaltyWei: '1000', items: [{ token: LILBASE, id: '1', slug: LIL.slug }] });
  let c = await call('GET', `/revshare/${LIL.slug}/claimable?ids=7,8`); assert.equal(c.j.perToken['7'].base, '83'); assert.equal(c.j.total.base, '166');
  await g.recordSale(env, { chain: 'base', orderHash: '0x' + '23'.repeat(32), seller: '0x' + '44'.repeat(20), priceWei: '20000', feeWei: '100', royaltyWei: '1000', items: [{ token: LILBASE, id: '2', slug: LIL.slug }] });
  c = await call('GET', `/revshare/${LIL.slug}/claimable?ids=7`); assert.equal(c.j.perToken['7'].base, '166', 'remainder carried: (250+1)/3 = 83 r2');
  assert.equal((await call('POST', `/revshare/${LIL.slug}/claim`, { tokenIds: [8], chain: 'base' }, 'H')).s, 403, 'non-holder cannot claim');
  const cl = await call('POST', `/revshare/${LIL.slug}/claim`, { tokenIds: [7], chain: 'base' }, 'H');
  assert.equal(cl.j.executed, false); assert.equal(cl.j.status, 'queued'); assert.match(cl.j.reason, /disabled until/);
  c = await call('GET', `/revshare/${LIL.slug}/claimable?ids=7`); assert.equal(c.j.perToken['7'].base, '166', 'queued claim does not consume balance');
  assert.equal(g.payoutState({ REVSHARE_PAYOUTS: 'on', PAYOUT_KEY: '0x1' }, [{ chain: 'base' }]).enabled, false, 'mainnet still gated');
});

test('quests: events + on-chain hold, 5 badges unlock a MintPass signature the contract can verify', async () => {
  const signer = privateKeyToAccount(generatePrivateKey()); const user = privateKeyToAccount(generatePrivateKey()).address;
  const BADGE = '0x' + '55'.repeat(20);
  const { env, g, call } = setup({ holds: { robinhood: lc(user) }, env: { BADGE_SIGNER_KEY: signer.address && undefined } });
  await g.questEvent(env, user, 'ethereum', 'buy'); await g.questEvent(env, user, 'base', 'list'); await g.questEvent(env, user, 'abstract', 'buy');
  let q = (await call('GET', '/quests/' + user)).j; assert.equal(q.count, 3); assert.equal(q.eligible, false);
  q = (await call('POST', `/quests/${user}/verify`)).j; assert.equal(q.count, 4, 'hold verified on-chain (robinhood)');
  assert.equal((await call('GET', `/quests/${user}/eligibility`)).j.eligible, false);
  await g.questEvent(env, user, 'apechain', 'bridge');
  let e = (await call('GET', `/quests/${user}/eligibility`)).j; assert.equal(e.eligible, true); assert.equal(e.setupNeeded, true);
  env.BADGE_SIGNER_KEY = generatePrivateKey(); const sAcct = privateKeyToAccount(env.BADGE_SIGNER_KEY); env.BADGE_CONTRACT = BADGE; env.BADGE_CHAIN_ID = '84532';
  e = (await call('GET', `/quests/${user}/eligibility`)).j;
  const ok = await verifyTypedData({ address: sAcct.address, domain: { name: 'MultiSeaChainBadges', version: '1', chainId: 84532, verifyingContract: BADGE }, types: MINTPASS_TYPES, primaryType: 'MintPass', message: { to: lc(user), deadline: BigInt(e.deadline) }, signature: e.signature });
  assert.ok(ok); assert.equal(QUEST_CHAINS.length, 5);
});

test('reportTx: parses OrderFulfilled, records buyer, referral and buy quest; ignores non-MultiSea tokens', async () => {
  const ref = privateKeyToAccount(generatePrivateKey()).address, buyer = privateKeyToAccount(generatePrivateKey()).address, seller = '0x' + '66'.repeat(20);
  const EV = parseAbi(['event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)']);
  const log = (hash, token) => ({ address: CFG.seaport, topics: encodeEventTopics({ abi: EV, eventName: 'OrderFulfilled', args: { offerer: seller, zone: '0x0000000000000000000000000000000000000000' } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }, { type: 'tuple[]', components: [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }] }],
      [hash, buyer, [[2, token, 9n, 1n]], [[0, '0x0000000000000000000000000000000000000000', 0n, 995n, seller], [0, '0x0000000000000000000000000000000000000000', 0n, 5n, FEE]]]) });
  const TX = '0x' + 'ab'.repeat(32);
  const { env, g, call } = setup({ sessions: { B: buyer }, receipts: { [TX]: { status: 'success', logs: [log('0x' + '77'.repeat(32), LILBASE), log('0x' + '78'.repeat(32), '0x' + '99'.repeat(20))] } } });
  await g.registerCode(env, ref); await call('POST', '/ref/bind', { code: refCode(ref) }, 'B');
  const r = await call('POST', '/native/filled', { chain: LILCHAIN, txHash: TX }); assert.equal(r.j.matched, 1);
  assert.equal(r.j.results[0].buyer, lc(buyer)); assert.equal(r.j.results[0].referral.amount, '1');
  const q = (await call('GET', '/quests/' + buyer)).j; assert.ok(q.chains.find(c => c.chain === LILCHAIN)?.badge || !QUEST_CHAINS.includes(LILCHAIN));
});

test('bundles: same-chain multi-item order verified; cross-chain flagged experimental; checkout lock + partial policy', async () => {
  const seller = privateKeyToAccount(generatePrivateKey()); const buyer = privateKeyToAccount(generatePrivateKey()).address, rival = privateKeyToAccount(generatePrivateKey()).address;
  const ape = LIL.deployments.find(d => d.chain !== LILCHAIN) || LIL.deployments[0];
  const owners = {}; [1, 2, 3].forEach(i => owners[`${LILCHAIN}:${LILBASE}:${i}`] = lc(seller.address)); owners[`${ape.chain}:${lc(ape.address)}:4`] = lc(seller.address);
  const { env, g, native, call } = setup({ owners, sessions: { B: buyer, X: rival } });
  const now = Math.floor(Date.now() / 1000);
  const leg = async (k, token, ids, price) => { const fee = price * 50n / 10000n + 1n; const p = { offerer: lc(seller.address), zone: '0x0000000000000000000000000000000000000000', offer: ids.map(i => ({ itemType: 2, token, identifierOrCriteria: String(i), startAmount: '1', endAmount: '1' })), consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: (price - fee).toString(), endAmount: (price - fee).toString(), recipient: lc(seller.address) }, { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: fee.toString(), endAmount: fee.toString(), recipient: FEE }], orderType: 0, startTime: String(now - 60), endTime: String(now + 86400), zoneHash: '0x' + '0'.repeat(64), salt: '42', conduitKey: '0x' + '0'.repeat(64), totalOriginalConsiderationItems: 2, counter: '0' };
    return { chain: k, parameters: p, signature: await seller.signTypedData(native.typedData(k, p)) }; };
  const same = await call('POST', '/bundles', { title: 'Trio', legs: [await leg(LILCHAIN, LILBASE, [1, 2, 3], W(0.3))] }); assert.ok(same.j.ok, JSON.stringify(same.j)); assert.equal(same.j.kind, 'same-chain');
  const forged = await leg(LILCHAIN, LILBASE, [1], W(0.1)); forged.parameters.consideration[1].startAmount = forged.parameters.consideration[1].endAmount = '1';
  assert.equal((await call('POST', '/bundles', { legs: [forged] })).s, 400, 'fee too low / tampered rejected');
  const tam = await leg(LILCHAIN, LILBASE, [1], W(0.1)); tam.parameters.salt = '43'; assert.equal((await call('POST', '/bundles', { legs: [tam] })).s, 401, 'bad signature rejected');
  if (ape.chain !== LILCHAIN) {
    const x = await call('POST', '/bundles', { legs: [await leg(LILCHAIN, LILBASE, [1, 2], W(0.2)), await leg(ape.chain, lc(ape.address), [4], W(0.5))] }); assert.equal(x.j.kind, 'cross-chain');
    const list = (await call('GET', '/bundles')).j.bundles; const xb = list.find(b => b.id === x.j.id); assert.equal(xb.experimental, true); assert.ok(!JSON.stringify(xb).includes('signature'), 'signatures never public');
    const co = await call('POST', `/bundles/${x.j.id}/checkout`, null, 'B'); assert.equal(co.j.legs.length, 2); assert.equal(co.j.legs[0].chain, ape.chain, 'highest value leg first');
    assert.equal((await call('POST', `/bundles/${x.j.id}/checkout`, null, 'X')).s, 409, 'lock blocks other buyers');
    await g.bundleLegFilled(env, x.j.id, ape.chain, co.j.legs[0].orderHash, lc(buyer), '0x' + '01'.repeat(32));
    const rec = JSON.parse(env.COLLECTIONS.m.get('bundle:' + x.j.id)); rec.lock.until = Date.now() - 1; env.COLLECTIONS.m.set('bundle:' + x.j.id, JSON.stringify(rec));
    const after = (await call('GET', `/bundles/${x.j.id}`)).j.bundle; assert.equal(after.status, 'partial'); assert.deepEqual(after.legs.map(l => l.status).sort(), ['filled', 'withdrawn']);
  }
});
