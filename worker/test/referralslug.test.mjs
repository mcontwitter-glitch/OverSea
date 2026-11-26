// Name-based referral links, old numeric codes, renames, share-card HTML, and the 1200x630 PNG card.
// Run: node --test test/referralslug.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeGrowth, refCode } from '../src/growth.js';
import { makeProfiles } from '../src/profiles.js';
import { makeShare } from '../src/share.js';
import { rawSlug, slugify, isHexCode, resolveRef } from '../src/refslug.js';
import { refCardSvg, REF_CARD, monogramOf } from '../src/ogsvg.js';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const lc = s => String(s || '').toLowerCase();
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
const ADDR = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/;
function kv() {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : t === 'arrayBuffer' ? new TextEncoder().encode(v).buffer : v; },
    async put(k, v) { m.set(k, typeof v === 'string' || v instanceof ArrayBuffer ? v : String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }; },
  };
}
globalThis.caches = { default: { match: async () => null, put: async () => true } };

function setup() {
  const env = { COLLECTIONS: kv(), NONCES: kv(), OG_CARD: '1' };
  const sessions = {};
  const g = makeGrowth({
    CFG: { seaport: '0x' + '11'.repeat(20), collections: [], chains: {}, revshareVaults: { factories: {} } },
    chains: {}, lc, bad, ADDR, HASH,
    getCollection: async () => null, feeWallet: () => '0x' + '22'.repeat(20), admins: () => [],
    requireSession: async req => { const s = sessions[req.headers.get('authorization')]; if (!s) bad('sign in', 401); return { address: lc(s) }; },
    canEdit: async () => ({ ok: false }), relayFetch: async () => ({ ok: false }),
  });
  const P = makeProfiles({
    CFG: { chains: {} }, lc, bad, ADDR, wl: null,
    requireSession: async req => { const s = sessions[req.headers.get('authorization')]; if (!s) bad('sign in', 401); return { address: lc(s) }; },
    rpcFanout: async () => null, osFetch: async () => null,
  });
  const callG = async (method, path, b, auth) => {
    const url = new URL('https://x' + path); const p = url.pathname.split('/').filter(Boolean);
    const req = new Request(url, { method, headers: auth ? { authorization: auth } : {}, body: b ? JSON.stringify(b) : undefined });
    try { return { s: 200, j: await g.handle(req, env, url, p, method, async () => b, null) }; } catch (e) { return { s: e.status || 500, j: { error: e.message } }; }
  };
  const callP = async (method, path, b, auth) => {
    const url = new URL('https://x' + path); const p = url.pathname.split('/').filter(Boolean);
    const req = new Request(url, { method, headers: auth ? { authorization: auth } : {} });
    try { return { s: 200, j: await P.handle(req, env, url, p, method, async () => b) }; } catch (e) { return { s: e.status || 500, j: { error: e.message } }; }
  };
  const share = makeShare({ getCollection: async () => null, STATIC: {}, osStats: async () => ({}), cached: async (k, t, f) => f() });
  const hit = async (href, ua) => {
    const url = new URL(href); const req = new Request(url, { headers: ua ? { 'user-agent': ua } : { 'user-agent': 'Mozilla/5.0' } });
    return share(req, env, url, url.pathname.split('/').filter(Boolean), {});
  };
  return { env, g, sessions, callG, callP, hit };
}

test('slugify: spaces/dots/underscores, 8-hex reserved, short names', () => {
  assert.equal(rawSlug('Clay Mons'), 'clay-mons');
  assert.equal(slugify('Clay Mons'), 'clay-mons');
  assert.equal(slugify('Hello.World_2'), 'hello-world-2');
  assert.equal(isHexCode('deadbeef'), true);
  assert.equal(slugify('DeadBeef'), '');
  assert.equal(rawSlug('DeadBeef'), 'deadbeef');
  assert.equal(slugify('A'), '');
  assert.equal(slugify('李明'), '');
});

test('referrals: numeric links still work; name slug; rename keeps old slug; collisions', async () => {
  const ref = privateKeyToAccount(generatePrivateKey()).address;
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const buyer = privateKeyToAccount(generatePrivateKey()).address;
  const buyer2 = privateKeyToAccount(generatePrivateKey()).address;
  const { env, sessions, callG, callP } = setup();
  sessions.R = ref; sessions.O = other; sessions.A = buyer; sessions.B = buyer2;

  const before = await callG('GET', '/ref/stats/' + ref);
  assert.equal(before.j.code, refCode(ref));
  assert.equal(before.j.path, '/r/' + refCode(ref));
  assert.equal(before.j.slug, null);

  const named = await callP('POST', '/profile', { name: 'Clay Mons' }, 'R');
  assert.equal(named.s, 200, named.j.error);
  const st = await callG('GET', '/ref/stats/' + ref);
  assert.equal(st.j.slug, 'clay-mons');
  assert.equal(st.j.path, '/r/clay-mons');
  assert.equal(st.j.code, refCode(ref));

  // bind by the name slug
  const b1 = await callG('POST', '/ref/bind', { code: 'Clay-Mons' }, 'A');
  assert.equal(b1.s, 200, b1.j.error);
  assert.equal(b1.j.bound, true);
  assert.equal(b1.j.referrer, lc(ref));

  // old numeric link still binds a different buyer to the same referrer
  const bNum = await callG('POST', '/ref/bind', { code: refCode(ref) }, 'B');
  assert.equal(bNum.s, 200, bNum.j.error);
  assert.equal(bNum.j.bound, true);
  assert.equal(bNum.j.referrer, lc(ref));

  // rename: new slug, old slug still resolves to the same wallet
  const ren = await callP('POST', '/profile', { name: 'Alice' }, 'R');
  assert.equal(ren.s, 200, ren.j.error);
  const st2 = await callG('GET', '/ref/stats/' + ref);
  assert.equal(st2.j.slug, 'alice');
  assert.equal(st2.j.path, '/r/alice');
  const old = await resolveRef(env, 'clay-mons');
  assert.equal(old.address, lc(ref));
  const neu = await resolveRef(env, 'alice');
  assert.equal(neu.address, lc(ref));
  const stillNum = await resolveRef(env, refCode(ref));
  assert.equal(stillNum.address, lc(ref));
  assert.equal(stillNum.kind, 'code');

  // another user cannot take the old name or a name that slugs to it
  const take = await callP('POST', '/profile', { name: 'Clay Mons' }, 'O');
  assert.equal(take.s, 409);
  const take2 = await callP('POST', '/profile', { name: 'clay-mons' }, 'O');
  assert.equal(take2.s, 409);

  // 8-hex display names are rejected so they cannot clash with numeric codes
  const hex = await callP('POST', '/profile', { name: 'DeadBeef' }, 'O');
  assert.equal(hex.s, 400);
  assert.match(hex.j.error, /referral code/);
});

test('share: Twitterbot gets the personal card tags; a browser is sent on with the invite', async () => {
  const ref = privateKeyToAccount(generatePrivateKey()).address;
  const { env, sessions, callP, hit } = setup();
  sessions.R = ref;
  assert.equal((await callP('POST', '/profile', { name: 'Claymons', avatar: '' }, 'R')).s, 200);

  const bot = await hit('https://multisea.io/r/claymons', 'Twitterbot/1.0');
  assert.equal(bot.status, 200);
  const html = await bot.text();
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /Claymons invited you to MultiSea/);
  assert.match(html, /og:image" content="https:\/\/api\.multisea\.io\/s\/og\/r\/claymons\.png/);
  assert.match(html, /og:url" content="https:\/\/multisea\.io\/r\/claymons"/);
  assert.match(html, /refresh" content="0;url=https:\/\/multisea\.io\/\?ref=claymons"/);

  const human = await hit('https://multisea.io/r/claymons', 'Mozilla/5.0');
  assert.equal(human.status, 302);
  assert.equal(human.headers.get('location'), 'https://multisea.io/?ref=claymons');

  // numeric code, after a name is set, still works
  await env.COLLECTIONS.put('refcode:' + refCode(ref), lc(ref));
  const num = await hit('https://multisea.io/r/' + refCode(ref), 'Mozilla/5.0');
  assert.equal(num.status, 302);
  assert.equal(num.headers.get('location'), 'https://multisea.io/?ref=' + refCode(ref));

  const unknown = await hit('https://multisea.io/r/nobody-here', 'Mozilla/5.0');
  assert.equal(unknown.status, 302);
  assert.equal(unknown.headers.get('location'), 'https://multisea.io/');
});

test('referral card SVG and 1200x630 PNG: MultiSea, name, invite line, cyan bar', async () => {
  const svg = refCardSvg({ name: 'Claymons' });
  assert.match(svg, /width="1200"/);
  assert.match(svg, /height="630"/);
  assert.match(svg, /Multi<tspan fill="#45bdfa">Sea<\/tspan>/);
  assert.match(svg, />multisea\.io</);
  assert.match(svg, />Claymons</);
  assert.match(svg, new RegExp(REF_CARD.subtitle));
  assert.match(svg, /fill="#45bdfa"/);
  assert.match(svg, /fill="#05070b"/);
  assert.equal(monogramOf('Claymons'), 'C');
  assert.equal(monogramOf('0x12ab…cdef'), 'M');

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const wasm = fs.readFileSync(path.join(dir, '../node_modules/@resvg/resvg-wasm/index_bg.wasm'));
  await initWasm(wasm);
  const f600 = fs.readFileSync(path.join(dir, '../src/og/inter-600.bin'));
  const f800 = fs.readFileSync(path.join(dir, '../src/og/inter-800.bin'));
  const rv = new Resvg(svg, { font: { fontBuffers: [f600, f800], defaultFontFamily: 'Inter', loadSystemFonts: false }, fitTo: { mode: 'width', value: 1200 } });
  let png;
  try { const img = rv.render(); try { png = img.asPng(); } finally { img.free(); } } finally { rv.free(); }
  assert.equal(png[0], 0x89); assert.equal(png[1], 0x50); assert.equal(png[2], 0x4e); assert.equal(png[3], 0x47);
  const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  const h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
  assert.equal(w, 1200);
  assert.equal(h, 630);
  const out = '/tmp/multisea-ref-card.png';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
});
