import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeHolderChat } from '../src/holderchat.js';
import { makeProfiles } from '../src/profiles.js';
const CFG = JSON.parse(fs.readFileSync(new URL('../../config/collections.json', import.meta.url)));
const lc = s => String(s || '').toLowerCase(); const bad = (m, s = 400) => { throw Object.assign(new Error(m), { status: s }); };
const ADDR = /^0x[0-9a-fA-F]{40}$/; const ADMIN = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const USER = privateKeyToAccount(generatePrivateKey()).address;
function kv() { const m = new Map(); return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list({ prefix = '', limit = 1000, reverse = false, end = '' }) { let keys = [...m.keys()].filter(k => k.startsWith(prefix) && (!end || k < end)).sort().map(name => ({ name })); if (reverse) keys.reverse(); return { keys: keys.slice(0, limit), list_complete: true }; } }; }
function setup(osNfts = {}) {
  const env = { COLLECTIONS: kv(), ADMIN_ADDRESSES: ADMIN, OPENSEA_API_KEY: 'test' }; const balances = new Map(); let reads = 0;
  const owners = new Map(); const bal1155 = new Map();
  const rpcFanout = async (chain, payload) => {
    reads++; const data = payload.params[0].data; const chainKey = Object.keys(CFG.chains).find(k => CFG.chains[k] === chain); const to = lc(payload.params[0].to);
    if (data.startsWith('0x70a08231')) return { result: '0x' + BigInt(balances.get(lc('0x' + data.slice(-40))) || 0).toString(16).padStart(64, '0') };
    if (data.startsWith('0x00fdd58e')) { // ERC-1155 balanceOf(address,id)
      const who = lc('0x' + data.slice(10 + 24, 10 + 64)); const id = BigInt('0x' + data.slice(10 + 64));
      return { result: '0x' + BigInt(bal1155.get(`${chainKey}:${to}:${id}:${who}`) || 0).toString(16).padStart(64, '0') };
    }
    return { result: '0x' + (owners.get(`${chainKey}:${to}:${BigInt('0x' + data.slice(10))}`) || '0'.repeat(40)).padStart(64, '0') };
  };
  const osFetch = async (_env, path) => {
    const m = path.match(/\/chain\/([^/]+)\/account\/([^/]+)\/nfts/);
    if (!m) return new Response('{}', { status: 404 });
    const os = m[1]; const key = Object.keys(CFG.chains).find(k => CFG.chains[k].openseaSlug === os);
    const list = osNfts[key] || [];
    return new Response(JSON.stringify({ nfts: list, next: osNfts.next?.[key] || null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sessions = {};
  const common = { CFG, lc, bad, ADDR, rpcFanout };
  const chat = makeHolderChat({ ...common, admins: e => e.ADMIN_ADDRESSES.split(','), requireSession: async req => { const a = sessions[req.headers.get('authorization')]; if (!a) bad('sign in', 401); return { address: lc(a) }; }, getCollection: async (e, slug) => CFG.collections.find(c => c.slug === slug) });
  const profiles = makeProfiles({ ...common, osFetch, requireSession: async req => { const a = sessions[req.headers.get('authorization')]; if (!a) bad('sign in', 401); return { address: lc(a) }; } });
  const call = async (mod, method, path, b, auth) => { const url = new URL('https://x' + path); try { return { s: 200, j: await mod.handle(new Request(url, { method, headers: auth ? { authorization: auth } : {} }), env, url, url.pathname.split('/').filter(Boolean), method, async () => b) }; } catch (e) { return { s: e.status || 500, j: { error: e.message } }; } };
  return { env, chat, profiles, balances, owners, bal1155, sessions, call, reads: () => reads };
}
const bearer = a => 'Bearer ' + a;
test('chat: sign-in gate is cached, reads/writes require current holder, HTML stripped and cap enforced', async () => {
  const x = setup(), col = CFG.collections.find(c => c.slug === 'lil-foots'); x.sessions.U = USER;
  x.balances.set(lc(USER), 2);
  assert.equal((await x.chat.verifyHolderSignature(x.env, { address: USER, resources: ['multisea:holders:lil-foots'] })), undefined);
  const posted = await x.call(x.chat, 'POST', '/holders/lil-foots/messages', { text: 'hello <b>holders</b>', name: 'Foot <i>friend</i>' }, 'U');
  assert.equal(posted.s, 200); assert.equal(posted.j.message.text, 'hello holders'); assert.equal(posted.j.message.address, lc(USER));
  assert.equal((await x.call(x.chat, 'POST', '/holders/lil-foots/messages', { text: 'x'.repeat(501) }, 'U')).s, 400);
  const list = await x.call(x.chat, 'GET', '/holders/lil-foots/messages', null, 'U'); assert.equal(list.j.messages.length, 1); assert.equal(list.j.isAdmin, false);
  assert.equal((await x.call(x.chat, 'GET', '/holders/lil-foots/messages')).s, 401);
  x.balances.set(lc(USER), 0); assert.equal((await x.call(x.chat, 'POST', '/holders/lil-foots/messages', { text: 'still cached' }, 'U')).s, 200, '5-minute gate cache');
  assert.equal(col.slug, 'lil-foots');
});
test('chat: pagination newest last, admin delete and mute, non-admin forbidden', async () => {
  const x = setup(); x.sessions.U = USER; x.sessions.A = ADMIN; x.balances.set(lc(USER), 1);
  let clock = Date.now(); const realNow = Date.now; Date.now = () => clock;
  const ids = []; for (let i = 0; i < 6; i++) { clock++; ids.push((await x.call(x.chat, 'POST', '/holders/lil-foots/messages', { text: 'message ' + i }, 'U')).j.message.id); }
  assert.equal((await x.call(x.chat, 'POST', `/holders/lil-foots/messages/${ids[0]}/delete`, {}, 'U')).s, 403);
  assert.equal((await x.call(x.chat, 'POST', `/holders/lil-foots/messages/${ids[0]}/delete`, {}, 'A')).s, 200);
  const list = await x.call(x.chat, 'GET', '/holders/lil-foots/messages', null, 'U'); assert.equal(list.j.messages.length, 5); assert.equal(list.j.messages.at(-1).text, 'message 5');
  await x.call(x.chat, 'POST', '/holders/lil-foots/mute', { address: USER, minutes: 30 }, 'A');
  assert.equal((await x.call(x.chat, 'POST', '/holders/lil-foots/messages', { text: 'muted' }, 'U')).s, 403); Date.now = realNow;
});
test('profiles: authed owner-verified NFT avatar, name uniqueness, batch reads, removal', async () => {
  const x = setup(); x.sessions.U = USER; const other = privateKeyToAccount(generatePrivateKey()).address; x.sessions.O = other;
  const col = CFG.collections[0].deployments[0];
  assert.equal((await x.call(x.profiles, 'POST', '/profile', { name: 'Sea Fan', nft: { chain: col.chain, contract: col.address, id: '9', image: '/media/' + 'ab'.repeat(32) + '.png' } }, 'U')).s, 403);
  x.owners.set(`${col.chain}:${lc(col.address)}:9`, lc(USER));
  const saved = await x.call(x.profiles, 'POST', '/profile', { name: 'Sea Fan', nft: { chain: col.chain, contract: col.address, id: '9', image: '/media/' + 'ab'.repeat(32) + '.png' } }, 'U');
  assert.equal(saved.s, 200); assert.equal(saved.j.profile.name, 'Sea Fan');
  assert.equal((await x.call(x.profiles, 'POST', '/profile', { name: 'sea fan' }, 'O')).s, 409);
  const batch = await x.call(x.profiles, 'GET', `/profiles?addresses=${USER},${other}`); assert.equal(batch.j.profiles[lc(USER)].name, 'Sea Fan');
  assert.equal((await x.call(x.profiles, 'POST', '/profile', { name: 'Sea Fan' }, 'U')).j.profile.avatar, '');
});

test('profiles: gallery lists session wallet NFTs across OpenSea chains and paginates', async () => {
  const sample = [{ contract: '0x1111111111111111111111111111111111111111', identifier: '7', name: 'Foot #7', collection: 'lil-foots', display_image_url: 'https://img/7.png', token_standard: 'erc721' }];
  const x = setup({ base: sample, ethereum: [], apechain: [], robinhood: [], next: { base: 'cursor-base-2' } });
  x.sessions.U = USER;
  assert.equal((await x.call(x.profiles, 'GET', '/profile/nfts')).s, 401);
  const all = await x.call(x.profiles, 'GET', '/profile/nfts', null, 'U');
  assert.equal(all.s, 200); assert.equal(all.j.address, lc(USER));
  assert.equal(all.j.nfts.length, 1); assert.equal(all.j.nfts[0].chain, 'base'); assert.equal(all.j.nfts[0].id, '7');
  assert.deepEqual(all.j.unsupported.sort(), ['bnb']);
  assert.equal(all.j.cursors.base, 'cursor-base-2');
  const page = await x.call(x.profiles, 'GET', '/profile/nfts?chain=base&next=cursor-base-2', null, 'U');
  assert.equal(page.s, 200); assert.equal(page.j.nfts[0].id, '7');
  assert.equal((await x.call(x.profiles, 'GET', '/profile/nfts?chain=solana', null, 'U')).s, 400);
});
test('profiles: ERC-1155 avatars use balanceOf', async () => {
  const x = setup(); x.sessions.U = USER; const col = CFG.collections[0].deployments[0];
  const img = '/media/' + 'cd'.repeat(32) + '.png';
  assert.equal((await x.call(x.profiles, 'POST', '/profile', { name: 'Bag', nft: { chain: col.chain, contract: col.address, id: '3', image: img, standard: 'erc1155' } }, 'U')).s, 403);
  x.bal1155.set(`${col.chain}:${lc(col.address)}:3:${lc(USER)}`, 2);
  const saved = await x.call(x.profiles, 'POST', '/profile', { name: 'Bag', nft: { chain: col.chain, contract: col.address, id: '3', image: img, standard: 'erc1155' } }, 'U');
  assert.equal(saved.s, 200); assert.equal(saved.j.profile.nft.standard, 'erc1155');
});
