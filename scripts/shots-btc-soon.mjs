// LIL FOOTS Bitcoin "Coming soon" chip (no Ordinals data, no demo even with ?demo=1) -> preview-btc/11-lilfoots-btc-coming-soon-*.png
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4319', OUT = '/workspace/launchpad/preview-btc';
const b = await chromium.launch(); let bad = 0;
for (const [k, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const demo of [false, true]) {
    const pg = await b.newPage({ viewport: vp, deviceScaleFactor: k === 'mobile' ? 2 : 1 }); const btcReq = [];
    pg.on('request', r => { if (/ordinalswallet|unisat|mempool\.space|ordinals\.com|\/btc\//.test(r.url())) btcReq.push(r.url()); });
    await pg.goto(BASE + '/c/lil-foots' + (demo ? '?demo=1' : '')); await pg.waitForSelector('[data-btcsoon]'); await pg.waitForTimeout(4000);
    const r = await pg.evaluate(() => ({ chip: document.querySelector('.chip[data-btcsoon]')?.textContent, ord: document.querySelectorAll('.ordc,.btcdemo').length, by: document.querySelector('.by span')?.textContent, ow: document.documentElement.scrollWidth }));
    const tag = demo ? 'demo1' : 'all';
    await pg.evaluate(() => document.querySelector('.chips [data-btcsoon]').scrollIntoView({ inline: 'center', block: 'nearest' })); await pg.evaluate(() => scrollTo(0, 0));
    await pg.screenshot({ path: `${OUT}/11-lilfoots-btc-coming-soon-${tag}-${k}.png` });
    await pg.click('.chips [data-btcsoon]'); await pg.waitForTimeout(800);
    const e = await pg.evaluate(() => document.querySelector('.btcsoon h3')?.textContent);
    if (!demo) await pg.screenshot({ path: `${OUT}/11-lilfoots-btc-coming-soon-selected-${k}.png` });
    const ok = r.ord === 0 && !btcReq.length && /Coming soon/.test(r.chip) && !/\d/.test(r.chip) && e && r.ow <= vp.width; if (!ok) bad++;
    console.log(ok ? 'OK' : 'FAIL', k, tag, JSON.stringify({ ...r, empty: e, btcRequests: btcReq.length }));
    await pg.close();
  }
}
await b.close(); console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
