// Per-chip invariant on /c/lil-foots: chip count == "N items" == rendered cards (capped by the 60-card page), chips single-select,
// Ordinals only under Bitcoin/All, and a chip picked BEFORE the Bitcoin data arrives stays exact (race).
// BASE=http://localhost:4327 MOCK=1|0 node scripts/shots-chip-counts.mjs   (MOCK=0 uses the live delivery Worker)
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4327', MOCK = process.env.MOCK !== '0';
const IID = '87c187cbfa3106e64cc82e2846ee652c6002c31b95c78d1ef15f136bf94dd885i0';
const BODY = JSON.stringify({ collection: 'lil-foots', count: 1, items: [{ tokenId: '3973', inscriptionId: IID, recipient: 'bc1pqhkwh863ssxvlceqtm6huea8c54cfpjyew4w9krdjlgd4h46qhpsh37j0p', revealTxid: IID.slice(0, 64), status: 'delivered', deliveredAt: '2026-11-01T21:26:17Z', network: 'mainnet' }] });
const b = await chromium.launch(); let bad = 0; const fail = (m) => { bad++; console.log('FAIL', m); };
const state = (pg) => pg.evaluate(() => { const on = [...document.querySelectorAll('.chips .chip.on')]; const n = +(document.querySelector('.count')?.textContent || '').replace(/[^\d]/g, '');
  const cards = [...document.querySelectorAll('.grid .card')]; return { on: on.map(e => e.dataset.chain ?? ''), chip: +(on[0]?.querySelector('em')?.textContent || 'NaN').replace(/[^\d]/g, ''), n, cards: cards.length, ord: cards.filter(c => c.classList.contains('ordc')).length }; });
async function page(delayBtc) {
  const pg = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (MOCK || delayBtc) await pg.route('https://ordinals.bigfoot404.biz/api/ordinals/collections/**', async r => { if (delayBtc) await new Promise(x => setTimeout(x, delayBtc));
    if (MOCK) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: BODY }); return r.continue(); });
  return pg;
}
const pg = await page(0); await pg.goto(BASE + '/c/lil-foots/'); await pg.waitForSelector('.chips'); await pg.waitForTimeout(9000);
const chains = await pg.evaluate(() => [...document.querySelectorAll('.chips .chip[data-chain]')].map(e => e.dataset.chain));
if (!chains.includes('bitcoin')) fail('no Bitcoin chip');
for (const c of chains) {
  await pg.click(`.chips .chip[data-chain="${c}"]`); await pg.waitForTimeout(700); const s = await state(pg);
  const ok = s.on.length === 1 && s.on[0] === c && s.chip === s.n && s.cards === Math.min(s.n, 60) && (c === 'bitcoin' || c === '' ? true : s.ord === 0) && (c !== 'bitcoin' || s.ord === s.cards);
  ok ? console.log('OK', c || 'All', JSON.stringify(s)) : fail(`${c || 'All'} ${JSON.stringify(s)}`);
}
// Picking another chip replaces the selection (no BNB+Bitcoin union), tapping it again returns to All.
await pg.click('.chips .chip[data-chain="bitcoin"]'); await pg.click('.chips .chip[data-chain="bnb"]'); await pg.waitForTimeout(500);
let s = await state(pg); (s.on.join() === 'bnb' && s.ord === 0) ? console.log('OK switch', JSON.stringify(s)) : fail('switch ' + JSON.stringify(s));
await pg.screenshot({ path: 'screens/ordinals-chipfix/after-bnb-mobile.png' });
await pg.locator('input.search').fill('3973'); await pg.waitForTimeout(800); s = await state(pg); s.ord === 0 && s.cards === 0 ? console.log('OK bnb+search', JSON.stringify(s)) : fail('bnb+search ' + JSON.stringify(s));
await pg.locator('input.search').fill(''); await pg.selectOption('select.sort', 'rarity'); await pg.waitForTimeout(500); s = await state(pg); s.ord === 0 && s.n === s.chip ? console.log('OK bnb+sort', JSON.stringify(s)) : fail('bnb+sort ' + JSON.stringify(s));
await pg.click('.chips .chip[data-chain="bitcoin"]'); await pg.waitForTimeout(3000); await pg.screenshot({ path: 'screens/ordinals-chipfix/after-bitcoin-mobile.png' });
await pg.close();
// Race: BNB picked before the Bitcoin listing resolves.
const pr = await page(8000); await pr.goto(BASE + '/c/lil-foots/'); await pr.waitForSelector('.chips .chip[data-chain="bnb"]'); await pr.click('.chips .chip[data-chain="bnb"]');
await pr.waitForTimeout(14000); s = await state(pr);
(s.on.join() === 'bnb' && s.ord === 0 && s.chip === s.n && s.cards === s.n) ? console.log('OK race', JSON.stringify(s)) : fail('race ' + JSON.stringify(s));
await b.close(); console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
