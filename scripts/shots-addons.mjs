// Add-ons preview: holders tab + names, Insight activity, holder gate, wallet activity (/me), launchpad mint rules.
// BASE=http://localhost:4331 node scripts/shots-addons.mjs   (screens -> screens/addons/, not committed)
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4331'; const D = 'screens/addons/';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const mock = (addr) => { const p = { request: async ({ method }) => method === 'eth_chainId' ? '0x1' : method === 'eth_call' ? '0x' : [addr], on() {}, removeListener() {} };
  localStorage.setItem('multisea-wallet', 'test.mock');
  const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'u1', name: 'MetaMask', icon: '', rdns: 'test.mock' }, provider: p }) }));
  window.addEventListener('eip6963:requestProvider', ann); ann(); };
const b = await chromium.launch(); const res = {}; let ok = true; const chk = (k, v) => { res[k] = v; if (!v) ok = false; };
for (const [dev, opts] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['mobile', devices['iPhone 13']]]) {
  const ctx = await b.newContext(opts); const p = await ctx.newPage();
  // 1. Holders tab, names hydrate
  await p.goto(BASE + '/c/lil-foots?tab=holders'); await p.waitForSelector('.hold .actr', { timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('.hold [data-named]').length > 0, null, { timeout: 45000 }).catch(() => {});
  const named = await p.locator('.hold [data-named]').count(); res[dev + '.holdersNamed'] = named; chk(dev + '.holdersRows', await p.locator('.hold .actr').count() > 50);
  await p.screenshot({ path: D + `${dev}-1-holders.png` });
  const holder = await p.locator('.hold .actr [data-addr]').first().getAttribute('data-addr');
  // 2. Activity with Insight merged
  await p.goto(BASE + '/c/lil-foots?tab=activity'); await p.waitForFunction(() => +(document.documentElement.dataset.activityInsight || 0) > 0, null, { timeout: 60000 }).catch(() => {});
  chk(dev + '.activityInsightChains', +(await p.evaluate(() => document.documentElement.dataset.activityInsight || 0)) >= 3); await p.waitForTimeout(2500);
  await p.screenshot({ path: D + `${dev}-2-activity.png` });
  // 3. Gate: locked (no wallet), unlocked (preview as a holder)
  await p.goto(BASE + '/holders/lil-foots'); await p.waitForSelector('[data-gate="noconnect"]'); await p.screenshot({ path: D + `${dev}-3-gate-locked.png` });
  await p.goto(BASE + '/holders/lil-foots?as=' + VITALIK); await p.waitForSelector('[data-gate="locked"]', { timeout: 30000 }).then(() => chk(dev + '.gateLockedNonHolder', true), () => chk(dev + '.gateLockedNonHolder', false));
  await p.screenshot({ path: D + `${dev}-3b-gate-nonholder.png` });
  await p.goto(BASE + '/holders/lil-foots?as=' + holder); await p.waitForSelector('[data-gate="open"]', { timeout: 30000 }).then(() => chk(dev + '.gateOpenHolder', true), () => chk(dev + '.gateOpenHolder', false));
  await p.screenshot({ path: D + `${dev}-4-gate-open.png` });
  // 4. Wallet activity
  await p.goto(BASE + '/me?as=' + holder); await p.waitForFunction(() => document.documentElement.dataset.meLoaded === '1', null, { timeout: 90000 }).catch(() => {});
  const n = await p.locator('.wact .r[data-row]').count(); chk(dev + '.meRows', n > 0); res[dev + '.meRowCount'] = n;
  res[dev + '.meExplorerLink'] = await p.locator('.wact .r[data-row] a[href*="/tx/0x"]').first().getAttribute('href').catch(() => null);
  await p.screenshot({ path: D + `${dev}-5-me.png` });
  const pill = p.locator('.wact .pills button[data-f="base"]'); await pill.click(); const nb = await p.locator('.wact .r[data-row]').count();
  chk(dev + '.meFilter', await p.evaluate(() => [...document.querySelectorAll('.wact .r[data-row] img.cl')].every(i => i.alt === 'Base'))); res[dev + '.meBaseRows'] = nb;
  await p.screenshot({ path: D + `${dev}-5b-me-base.png` });
  await ctx.close();
  // 5. Wallet chip name (mock wallet = vitalik.eth)
  const c2 = await b.newContext(opts); await c2.addInitScript(mock, VITALIK); const p2 = await c2.newPage();
  await p2.goto(BASE + '/'); await p2.waitForFunction(() => /vitalik\.eth/.test(document.querySelector('[data-act="wallet"]')?.textContent || ''), null, { timeout: 45000 }).then(() => chk(dev + '.chipName', true), () => chk(dev + '.chipName', false));
  await p2.screenshot({ path: D + `${dev}-6-chip-name.png`, clip: dev === 'desktop' ? { x: 0, y: 0, width: 1280, height: 120 } : undefined });
  // 6. Launchpad mint rules
  await p2.goto(BASE + '/launchpad/create'); await p2.click('[data-act="demo"]'); const nx = async () => { await p2.$eval('[data-act="next"]', e => e.click()); await p2.waitForTimeout(250); }; await p2.waitForSelector('[data-k="name"]'); for (let i = 0; i < 3; i++) await nx(); if (!/Step 4/.test(await p2.locator('.ldstepn').textContent())) console.log('LPSTEP', await p2.locator('.ldstepn').textContent(), await p2.locator('.msg').textContent());
  await p2.fill('[data-ph="0"][data-f="maxSupply"]', '500');
  await p2.setInputFiles('[data-csv="0"]', { name: 'al.csv', mimeType: 'text/csv', buffer: Buffer.from('address,qty\n0x1111111111111111111111111111111111111111,1\n0x2222222222222222222222222222222222222222,1\nnot-an-address,1\n') });
  await p2.waitForTimeout(400); const root = await p2.locator('[data-root="0"] [data-rootv]').textContent(); chk(dev + '.merkleRoot', /^0x[0-9a-f]{64}$/.test(root || '')); res[dev + '.root'] = root;
  await p2.locator('[data-root="0"]').scrollIntoViewIfNeeded(); await p2.screenshot({ path: D + `${dev}-7-lp-phases.png` });
  await nx(); await nx(); res[dev + '.lpStepMsg'] = await p2.locator('.msg').textContent();
  await p2.locator('details:has([data-txdata])').first().evaluate(e => (e.open = true)); await p2.locator('details:has([data-txdata])').first().scrollIntoViewIfNeeded();
  chk(dev + '.txBuilt', (await p2.locator('[data-txdata]').count()) >= 2); await p2.screenshot({ path: D + `${dev}-8-lp-tx.png` });
  await c2.close();
}
console.log(JSON.stringify(res, null, 1)); console.log(ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
