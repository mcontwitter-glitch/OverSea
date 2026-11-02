// Pay-with-card smoke test: mock wallet with 0 balance -> Buy -> "Pay with card" -> thirdweb onramp quote -> provider page (no card entry).
// BASE=http://localhost:4331 node scripts/shots-card-pay.mjs
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4331';
const ADDR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const b = await chromium.launch(); let bad = 0;
for (const [tag, opt] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['mobile', devices['iPhone 13']]]) {
  const ctx = await b.newContext(opt);
  await ctx.addInitScript(a => {
    let cid = '0x1';
    const p = { request: async ({ method, params }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [a]; if (method === 'eth_chainId') return cid; if (method === 'wallet_switchEthereumChain') { cid = params[0].chainId; return null; } throw Object.assign(new Error('mock: ' + method), { code: 4200 }); }, on() {}, removeListener() {} };
    const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'mock', name: 'Test Wallet', icon: '', rdns: 'test.mock' }, provider: p }) }));
    window.addEventListener('eip6963:requestProvider', ann); ann();
  }, ADDR);
  const pg = await ctx.newPage();
  await pg.goto(BASE + '/c/lil-foots/'); await pg.waitForSelector('[data-buy]', { timeout: 60000 });
  await pg.locator('[data-buy]').first().click();
  const w = pg.locator('[data-uuid="mock"]'); if (await w.count().then(n => n > 0).catch(() => false) || await w.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await w.click(); await pg.waitForTimeout(500); await pg.locator('[data-buy]').first().click(); }
  const btn = pg.locator('.cardpay'); await btn.waitFor({ timeout: 60000 });
  await btn.scrollIntoViewIfNeeded(); await pg.screenshot({ path: `screens/card-pay/${tag}-1-buy-modal.png` });
  await btn.click();
  await pg.waitForSelector('.cardgo, .cardpay-body .err', { timeout: 45000 });
  const err = await pg.locator('.cardpay-body .err').textContent().catch(() => null);
  const total = await pg.locator('.cardpay-body .xtot').textContent().catch(() => null);
  await pg.screenshot({ path: `screens/card-pay/${tag}-2-quote.png` });
  let host = null;
  if (!err) {
    const popP = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    await pg.click('.cardgo'); const pop = await popP;
    if (pop) { await pop.waitForLoadState('domcontentloaded').catch(() => {}); await pop.waitForTimeout(7000); host = new URL(pop.url()).host; await pop.screenshot({ path: `screens/card-pay/${tag}-3-provider.png` }); }
    await pg.waitForTimeout(1500); await pg.screenshot({ path: `screens/card-pay/${tag}-4-waiting.png` });
  }
  console.log(tag, JSON.stringify({ quoteTotal: total, err, providerHost: host }));
  if (err || !host) bad++;
  await ctx.close();
}
await b.close(); console.log(bad ? 'FAIL' : 'ALL PASS'); process.exit(bad ? 1 : 0);
