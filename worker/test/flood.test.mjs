// Flood cap: FLOOD binding (~2000 / 10s per IP). Run: node --test test/flood.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeTtl, floodBlock } from '../src/flood.js';

function limiter(max) {
  const n = new Map();
  return { async limit({ key }) { const c = (n.get(key) || 0) + 1; n.set(key, c); return { success: c <= max }; }, counts: n };
}
const req = (path = '/health', { ip = '203.0.113.9', origin = 'https://multisea.io' } = {}) =>
  new Request('https://api.multisea.io' + path, { headers: { origin, 'cf-connecting-ip': ip } });
const cors = { 'access-control-allow-origin': 'https://multisea.io', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

test('edgeTtl covers public heavy GETs and skips session or mutating routes', () => {
  const get = (path) => edgeTtl(new URL('https://api.multisea.io' + path), { method: 'GET' });
  assert.equal(get('/activity/multi-islands'), 30);
  assert.equal(get('/islands/wallet-nfts'), 30);
  assert.equal(get('/os/multi-islands/stats'), 60);
  assert.equal(get('/wallet/0xca89ae48a5c61d13e78236daa4ac29ee588ea475/nfts'), 15);
  assert.equal(get('/collections'), 30);
  assert.equal(get('/profiles?addresses=0xca89ae48a5c61d13e78236daa4ac29ee588ea475'), 15);
  assert.equal(get('/health'), 15);
  assert.equal(get('/activity/multi-islands?fresh=1'), 0);
  assert.equal(get('/profile/nfts'), 0);
  assert.equal(get('/auth/nonce'), 0);
  assert.equal(get('/admin/launchpad/pending'), 0);
  assert.equal(edgeTtl(new URL('https://api.multisea.io/activity/multi-islands'), { method: 'POST' }), 0);
});

test('a burst over the flood cap returns 429 with Retry-After and CORS; normal traffic does not', async () => {
  const env = { FLOOD: limiter(20) }; // stand-in for 2000/10s so the test stays small
  for (let i = 0; i < 20; i++) {
    const r = await floodBlock(env, req(), cors);
    assert.equal(r, null, 'normal volume must not be flood-limited');
  }
  const blocked = await floodBlock(env, req(), cors);
  assert.ok(blocked);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '10');
  assert.equal(blocked.headers.get('access-control-allow-origin'), 'https://multisea.io');
  assert.equal((await blocked.json()).error, 'rate limited');
  const other = await floodBlock(env, req('/health', { ip: '203.0.113.10' }), cors);
  assert.equal(other, null);
});

test('without a FLOOD binding requests proceed (tests / older deploys)', async () => {
  assert.equal(await floodBlock({}, req(), cors), null);
  assert.equal(await floodBlock({ FLOOD: {} }, req(), cors), null);
});
