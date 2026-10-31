// Unified collection view with Bitcoin Ordinals as one more chain (DEMO flag, ?demo=1) -> /workspace/launchpad/preview-btc/09, 10
// Needs `npm run build && npx vite preview --port 4319`.
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4319', OUT = '/workspace/launchpad/preview-btc';
const b = await chromium.launch();
for (const [k, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const pg = await b.newPage({ viewport: vp, deviceScaleFactor: k === 'mobile' ? 2 : 1 });
  await pg.goto(BASE + '/c/lil-foots?demo=1'); await pg.waitForSelector('[data-chain="bitcoin"]', { timeout: 40000 });
  await pg.waitForTimeout(3500);
  const r = await pg.evaluate(() => ({ ord: document.querySelectorAll('.card.ordc').length, first: [...document.querySelectorAll('.grid .card')].slice(0, 8).map(c => c.querySelector('.cn')?.textContent + ' ' + c.querySelector('.cp')?.textContent), chip: document.querySelector('[data-chain="bitcoin"]')?.textContent, ow: document.documentElement.scrollWidth }));
  console.log(k, JSON.stringify(r));
  await pg.screenshot({ path: `${OUT}/09-collection-all-chains-with-btc-${k}.png` });
  // Price low->high across chains: the BTC listings (~$77-162) sort in between EVM listings, past the first 60 -> Load more.
  while (!(await pg.$('.grid .card.ordc')) && await pg.$('[data-act="more"]')) { await pg.click('[data-act="more"]'); await pg.waitForTimeout(800); }
  console.log(k, 'mixed', await pg.evaluate(() => { const c = [...document.querySelectorAll('.grid .card')]; const i = c.findIndex(x => x.classList.contains('ordc')); return c.slice(i - 3, i + 4).map(x => (x.classList.contains('ordc') ? 'BTC ' : 'EVM ') + x.querySelector('.cp')?.textContent).join(' | '); }));
  await pg.waitForTimeout(2500); await pg.evaluate(() => document.querySelector('.grid .card.ordc').scrollIntoView({ block: 'center' })); await pg.waitForTimeout(1500); await pg.evaluate(() => document.querySelector('.grid .card.ordc').scrollIntoView({ block: 'center' }));
  await pg.waitForTimeout(500); await pg.screenshot({ path: `${OUT}/09b-collection-all-chains-btc-mixed-${k}.png` }); await pg.evaluate(() => scrollTo(0, 0));
  await pg.click('.chips [data-chain="bitcoin"]'); await pg.waitForTimeout(1500);
  console.log(k, 'btc-only', await pg.evaluate(() => document.querySelectorAll('.grid .card').length + ' cards, ' + document.querySelectorAll('.grid .card.ordc').length + ' ord'));
  await pg.screenshot({ path: `${OUT}/10-collection-bitcoin-chip-${k}.png` });
  if (k === 'desktop') { await pg.click('[data-tab="activity"]'); await pg.waitForTimeout(1500); console.log('activity rows', await pg.evaluate(() => document.querySelectorAll('.actr').length));
    await pg.click('[data-tab="items"]'); await pg.click('.grid .card.ordc'); await pg.waitForURL(/\/btc\/i\//); console.log('click ->', pg.url()); }
  await pg.close();
}
await b.close();
