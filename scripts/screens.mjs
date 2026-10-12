import { chromium } from 'playwright';
const b = await chromium.launch();
const U = 'http://localhost:4173/';
const shots = [
  ['desktop-items', { width: 1440, height: 900 }, U, null],
  ['desktop-activity', { width: 1440, height: 900 }, U + '?tab=activity', null],
  ['desktop-item-modal', { width: 1440, height: 900 }, U + '?item=2396', null],
  ['desktop-chains', { width: 1440, height: 900 }, U + '?tab=chains', null],
  ['mobile-items', { width: 390, height: 844 }, U, null],
  ['mobile-items-scrolled', { width: 390, height: 844 }, U, 'scroll'],
  ['mobile-filters', { width: 390, height: 844 }, U, 'filters'],
  ['mobile-activity', { width: 390, height: 844 }, U + '?tab=activity', null],
  ['mobile-item-modal', { width: 390, height: 844 }, U + '?item=2396', null],
];
for (const [n, vp, url, act] of shots) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1 });
  await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(3000);
  if (act === 'scroll') { await p.evaluate(() => window.scrollTo(0, 560)); await p.waitForTimeout(2500); }
  if (act === 'filters') { await p.click('.fbtn'); await p.click('details.grp summary'); await p.waitForTimeout(500); }
  await p.screenshot({ path: `screens/${n}.png` }); await p.close(); console.log(n);
}
await b.close();
