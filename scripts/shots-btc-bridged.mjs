// LIL FOOTS with the first real bridged Ordinal (#3973). The delivery Worker listing is mocked (route) until the new endpoint is deployed.
// BASE=http://localhost:4327 node scripts/shots-btc-bridged.mjs  -> screens/ordinals-bridged/*.png
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4327', OUT = new URL('../screens/ordinals-bridged/', import.meta.url).pathname;
const IID = '87c187cbfa3106e64cc82e2846ee652c6002c31b95c78d1ef15f136bf94dd885i0';
const MOCK = { collection: 'lil-foots', contract: '0x22fc5bb9810ef92db35accea463693331bcd0a8a', count: 1, items: [{ tokenId: '3973', inscriptionId: IID, recipient: 'bc1pqhkwh863ssxvlceqtm6huea8c54cfpjyew4w9krdjlgd4h46qhpsh37j0p', revealTxid: IID.slice(0, 64), status: 'delivered', deliveredAt: '2026-10-31T12:00:00Z', network: 'mainnet' }] };
const b = await chromium.launch(); let bad = 0;
for (const [k, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const mode of ['bridged', 'empty']) {
    const pg = await b.newPage({ viewport: vp, deviceScaleFactor: k === 'mobile' ? 2 : 1 });
    await pg.route('https://ordinals.bigfoot404.biz/api/ordinals/collections/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(mode === 'bridged' ? MOCK : { ...MOCK, count: 0, items: [] }) }));
    await pg.goto(BASE + '/c/lil-foots/'); await pg.waitForSelector('.chips'); await pg.waitForTimeout(6000);
    const r = await pg.evaluate(() => ({ soon: !!document.querySelector('.chip[data-btcsoon]'), ord: document.querySelectorAll('.ordc.bridged').length, by: document.querySelector('.by span')?.textContent }));
    if (mode === 'empty') { const ok = r.soon && !r.ord; if (!ok) bad++; console.log(ok ? 'OK' : 'FAIL', k, mode, JSON.stringify(r)); await pg.close(); continue; }
    await pg.screenshot({ path: `${OUT}lilfoots-all-${k}.png` });
    const chip = pg.locator('.chips .chip', { hasText: 'Bitcoin' }).first(); const hasChip = await chip.count(); if (hasChip) { await chip.click(); await pg.waitForTimeout(4000); }
    const ordN = await pg.evaluate(() => document.querySelectorAll('.ordc.bridged').length); await pg.screenshot({ path: `${OUT}lilfoots-bitcoin-chip-${k}.png`, fullPage: true });
    if (hasChip) { await chip.click(); await pg.waitForTimeout(500); }
    const s = pg.locator('input.search'); await s.fill('3973'); await pg.waitForTimeout(3000);
    const r2 = await pg.evaluate(() => ({ cards: document.querySelectorAll('.grid .card').length, onbtc: document.querySelectorAll('.onbtc').length }));
    await pg.screenshot({ path: `${OUT}lilfoots-3973-on-bitcoin-${k}.png` });
    const ok = !r.soon && ordN === 1 && r2.onbtc >= 1; if (!ok) bad++;
    console.log(ok ? 'OK' : 'FAIL', k, mode, JSON.stringify({ ...r, ordN, ...r2 })); await pg.close();
  }
}
await b.close(); console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
