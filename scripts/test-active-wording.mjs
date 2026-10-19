// "Active" wording on /w/<id> + item modal, and NFT-list resilience (retry, per-chain gaps, unreachable API).
// Mock EIP-6963 wallet, never signs. Usage: node scripts/test-active-wording.mjs [baseUrl]
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:4173', ID = 2071, ACCT = '0x1234567890123456789012345678901234567891';
const b = await chromium.launch(); let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function page(vp, nftMode = 'live') {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: vp.width < 700 ? 2 : 1, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
  let nftHits = 0;
  await ctx.route('https://api.multisea.io/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const u = new URL(r.request().url());
    if (/^\/foot\/\d+\/nfts$/.test(u.pathname)) { nftHits++;
      if (nftMode === 'down') return r.abort();
      if (nftMode === 'flaky' && nftHits === 1) return r.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"internal"}' });
      if (nftMode === 'partial') return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: ID, nfts: [], failed: ['robinhood'], unsupported: [] }) });
    }
    try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } }); } catch { return r.abort(); }
  });
  await ctx.addInitScript(acct => {
    window.__signed = [];
    const provider = { request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct]; if (method === 'eth_chainId') return '0x1'; window.__signed.push(method); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); localStorage.setItem('multisea-wallet', 'test.mock');
  }, ACCT);
  const p = await ctx.newPage(); p.on('pageerror', e => { console.log('pageerror', e.message.slice(0, 150)); fails++; });
  return { ctx, p, hits: () => nftHits };
}
const freeWord = t => /\bfree (here|on)\b|not free/i.test(t);
for (const [tag, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile-390', { width: 390, height: 844 }]]) {
  let { ctx, p, hits } = await page(vp);
  await p.goto(`${BASE}/w/${ID}`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => !document.body.innerText.includes('Reading 5 chains'), null, { timeout: 45000 }).catch(() => {});
  await p.waitForFunction(() => !/NFTs inside[\s\S]{0,40}Loading…/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1500);
  let t = await p.evaluate(() => document.querySelector('.fw')?.innerText || '');
  ok(/Active on Robinhood/.test(t), `${tag}: status "Active on Robinhood"`);
  ok(/Active here/.test(t), `${tag}: "Active here" shown`);
  ok(!freeWord(t), `${tag}: no bridge-sense "free" left on /w/${ID}`);
  ok(await p.evaluate(() => [...document.querySelectorAll('.fwst b.ok')].some(e => e.textContent === 'Active here' && getComputedStyle(e).color !== 'rgb(0, 0, 0)')), `${tag}: active chain keeps green .ok styling`);
  ok(!/NFT list unavailable/.test(t) && (await p.locator('.fwnftg .nftc').count()) >= 1, `${tag}: NFT list loads (${await p.locator('.fwnftg .nftc').count()} item(s), ${hits()} request(s))`);
  await p.screenshot({ path: `screens/active-wording/w-${ID}-${tag}.png`, fullPage: true });
  ok((await p.evaluate(() => window.__signed)).length === 0, `${tag}: no signature requested`); await ctx.close();

  // item modal on the collection page
  ({ ctx, p } = await page(vp)); await p.goto(`${BASE}/c/lil-foots`, { waitUntil: 'networkidle' });
  await p.fill('input.search', String(ID)); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  await p.locator(`.grid .card[data-id="${ID}"]`).first().click(); await p.waitForSelector('.modal', { timeout: 15000 }); await p.waitForTimeout(3000);
  t = await p.evaluate(() => document.querySelector('.modal')?.innerText || '');
  ok(!freeWord(t), `${tag}: item modal has no bridge-sense "free"`);
  ok((await p.locator('.modal .fwwbtn').count()) === 1, `${tag}: item modal Wallet button present`);
  await p.screenshot({ path: `screens/active-wording/item-${ID}-${tag}.png` }); await ctx.close();
}
// resilience (desktop)
for (const [mode, re, minHits] of [['flaky', /^(?![\s\S]*NFT list unavailable)/, 2], ['partial', /Couldn't load NFTs on Robinhood right now/, 1], ['down', /couldn't reach api\.multisea\.io/, 2]]) {
  const { ctx, p, hits } = await page({ width: 1440, height: 900 }, mode);
  await p.goto(`${BASE}/w/${ID}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(4000);
  const t = await p.evaluate(() => document.querySelector('.fw')?.innerText || '');
  ok(re.test(t) && hits() >= minHits, `nft ${mode}: ${mode === 'flaky' ? 'retry recovers' : 'clear note'} (${hits()} request(s))`);
  if (mode !== 'flaky') await p.locator('.fwnftg, .sechd:has-text("NFTs")').first().screenshot({ path: `screens/active-wording/nft-${mode}-note-desktop.png` }).catch(() => {});
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
