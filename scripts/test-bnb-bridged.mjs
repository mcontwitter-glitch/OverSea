// Bridged feet show on their live chain (BNB #4356). Mock EIP-6963 wallet (reads only, never signs).
// Usage: node scripts/test-bnb-bridged.mjs <before|after> [baseUrl]
import { chromium } from 'playwright';
const TAG = process.argv[2] || 'after', BASE = process.argv[3] || 'http://localhost:4173', ID = 4356;
const OWNER = '0xcfa91e557b07a81d0244cf902e27934b1a9bde74';
const b = await chromium.launch(); let fails = 0; const strict = TAG !== 'before';
const ok = (c, m) => { console.log((c ? 'PASS ' : (strict ? 'FAIL ' : 'INFO ')) + m); if (!c && strict) fails++; };
async function page(vp, acct = '0x1234567890123456789012345678901234567891') {
  const mob = vp.width < 700;
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: mob ? 2 : 1, isMobile: mob, hasTouch: mob });
  await ctx.route('https://api.multisea.io/**', async r => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } }); try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } }); } catch { return r.abort(); } });
  await ctx.addInitScript(acct => {
    window.__signed = [];
    const provider = { request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct]; if (method === 'eth_chainId') return '0x38'; window.__signed.push(method); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); localStorage.setItem('multisea-wallet', 'test.mock');
  }, acct);
  const p = await ctx.newPage(); p.on('pageerror', e => { console.log('pageerror', e.message.slice(0, 150)); fails++; }); return { ctx, p };
}
const waitLive = p => p.waitForFunction(() => document.documentElement.dataset.ownersLive, null, { timeout: 30000 }).catch(() => {});
for (const [vt, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile-390', { width: 390, height: 844 }]]) {
  // collection page, BNB chain chip
  let { ctx, p } = await page(vp);
  await p.goto(`${BASE}/c/lil-foots`, { waitUntil: 'networkidle', timeout: 60000 }); await waitLive(p); await p.waitForTimeout(1500);
  const chip = await p.locator('.chips .chip[data-chain="bnb"]').innerText(); ok(/\b2\b/.test(chip), `${vt}: BNB chip count = 2 ("${chip.replace(/\s+/g, ' ')}")`);
  await p.click('.chips .chip[data-chain="bnb"]'); await p.waitForTimeout(1200);
  const ids = await p.$$eval('.grid .card[data-id]', es => es.map(e => +e.dataset.id));
  ok(ids.includes(ID) && ids.includes(4088), `${vt}: BNB filter shows #4356 and #4088 (${ids.slice(0, 10).join(',')})`);
  await p.screenshot({ path: `screens/bnb-bridged/${TAG}-collection-bnb-${vt}.png` }); await ctx.close();
  // item modal for the bridged foot, owner connected
  ({ ctx, p } = await page(vp, OWNER));
  await p.goto(`${BASE}/c/lil-foots?item=${ID}`, { waitUntil: 'networkidle', timeout: 60000 }); await waitLive(p); await p.waitForTimeout(2500);
  const mt = await p.evaluate(() => document.querySelector('.modal .mrow')?.innerText || '');
  ok(/BNB Chain/.test(mt) && /0xcfa9/i.test(mt), `${vt}: item #4356 shows BNB Chain + owner 0xCFa9… ("${mt.replace(/\s+/g, ' ')}")`);
  await p.screenshot({ path: `screens/bnb-bridged/${TAG}-item-4356-${vt}.png` });
  if (await p.locator('.modal [data-sell]').count()) { await p.click('.modal [data-sell]'); await p.waitForTimeout(2500);
    const f = await p.evaluate(() => document.querySelector('.wbox')?.innerText || ''); ok(/BNB/.test(f) && !/Abstract/.test(f.split('\n').slice(0, 4).join(' ')), `${vt}: owner's "List for sale" targets BNB Chain ("${f.replace(/\s+/g, ' ').slice(0, 80)}")`); }
  else ok(false, `${vt}: owner sees "List for sale" on #4356`);
  await ctx.close();
  // My items for the owner
  ({ ctx, p } = await page(vp, OWNER));
  await p.goto(`${BASE}/c/lil-foots`, { waitUntil: 'networkidle', timeout: 60000 }); await waitLive(p); await p.waitForTimeout(1500);
  await p.evaluate(() => document.querySelector('input[value="mine"]')?.click()); await p.waitForTimeout(800);
  await p.fill('input.search', String(ID)); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
  const mine = await p.evaluate(id => ({ checked: document.querySelector('input[value="mine"]')?.checked, has: [...document.querySelectorAll('.grid .card[data-id]')].some(e => +e.dataset.id === id) }), ID).then(x => x.checked && x.has);
  ok(mine === true, `${vt}: owner's "My items" includes #4356 (${mine})`); await ctx.close();
  // foot wallet page
  ({ ctx, p } = await page(vp));
  await p.goto(`${BASE}/w/${ID}`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForFunction(() => !document.body.innerText.includes('Reading 5 chains'), null, { timeout: 60000 }).catch(() => {}); await p.waitForTimeout(3000);
  const wt = await p.evaluate(() => document.querySelector('.fw')?.innerText || '');
  ok(/Active on BNB Chain/.test(wt), `${vt}: /w/4356 "Active on BNB Chain"`);
  ok(await p.evaluate(() => [...document.querySelectorAll('.fwst > div')].some(r => /BNB/.test(r.innerText) && /Active here/.test(r.innerText))), `${vt}: /w/4356 BNB row "Active here"`);
  await p.screenshot({ path: `screens/bnb-bridged/${TAG}-w-4356-${vt}.png`, fullPage: true });
  ok((await p.evaluate(() => window.__signed)).length === 0, `${vt}: no signature requested`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : 'DONE'); process.exit(fails ? 1 : 0);
