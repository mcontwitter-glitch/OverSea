// /foot/<id>/nfts cache behaviour against a local `wrangler dev` (reads only; uses whatever OPENSEA_API_KEY .dev.vars has).
// Run: npx wrangler dev --port 8797 --local  then  API=http://localhost:8797 node test/footnfts.mjs
import assert from 'node:assert/strict';
const API = process.env.API || 'http://localhost:8787'; const ID = +(process.env.FOOT || 2753);
const get = async q => { const r = await fetch(`${API}/foot/${ID}/nfts${q}`); assert.equal(r.status, 200, `HTTP ${r.status}`); return r.json(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const a = await get('?fresh=1'); assert.ok(typeof a.at === 'number' && Array.isArray(a.nfts), 'fresh answer carries `at`');
const b = await get(''); assert.equal(b.cached, true); assert.equal(b.at, a.at, 'plain GET is served from the edge cache');
const c = await get('?fresh=1'); assert.equal(c.at, a.at, 'fresh=1 within 10 s of the last fetch is still served from cache (OpenSea throttle)');
await sleep(10_500);
const d = await get('?fresh=1'); assert.ok(d.at > a.at && !d.cached, 'fresh=1 after 10 s refetches from OpenSea');
console.log(`ok: foot #${ID} nfts=${d.nfts.length} failed=${JSON.stringify(d.failed)} (cache + fresh throttle behave)`);
