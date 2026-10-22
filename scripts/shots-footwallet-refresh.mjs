import { chromium } from 'playwright';
const OUT = '/workspace/multichain-dashboard/screens/foot-wallet';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
// "stale" = what the page got while OpenSea had not indexed the transfer yet (Worker cached it for 120 s).
const STALE = { id: 2753, account: '0x5a3a365AF0A8fF1Dd42447311a10eDa62dA146A2', nfts: [], failed: [], unsupported: ['bnb'], at: Date.now() - 60_000 };
const b = await chromium.launch();
async function page(port, staleCalls) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } }); let n = 0; const log = [];
  await ctx.route('https://api.multisea.io/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = r.request().url();
    if (/\/foot\/2753\/nfts/.test(u)) { n++; log.push(u.replace('https://api.multisea.io', '')); if (n <= staleCalls) return r.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(STALE) }); }
    try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' }, url: u.replace(/\?fresh=1$/, '') }); return r.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } }); } catch { return r.abort(); }
  });
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message.slice(0, 200)));
  await p.goto(`http://localhost:${port}/w/2753`); await p.waitForFunction(() => !document.body.innerText.includes('Reading 5 chains'), null, { timeout: 60000 });
  await p.waitForTimeout(2500); return { p, ctx, log };
}
const nftText = p => p.locator('.fwbot .fwsec').first().innerText();
// BEFORE: old build, stale answer -> "No NFTs inside yet.", no refresh control, no re-poll.
{ const { p, ctx, log } = await page(4281, 99); await p.screenshot({ path: `${OUT}/before-desktop.png`, fullPage: true });
  console.log('BEFORE nft section:', JSON.stringify(await nftText(p))); await p.waitForTimeout(35000); console.log('BEFORE nft requests after 35 s:', log); await ctx.close(); }
// AFTER: new build, same stale first answer; Refresh button -> live answer.
{ const { p, ctx, log } = await page(4282, 1); await p.screenshot({ path: `${OUT}/after-1-stale-desktop.png`, fullPage: true });
  console.log('AFTER (stale) nft section:', JSON.stringify(await nftText(p)));
  await p.click('[data-fw="refresh"]'); await p.waitForFunction(() => document.querySelector('.fwnftg'), null, { timeout: 60000 }); await p.waitForFunction(() => !document.querySelector('[data-fw="refresh"]')?.hasAttribute('disabled'), null, { timeout: 60000 }); await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/after-2-refreshed-desktop.png`, fullPage: true });
  await p.locator('.fwbot .fwsec').first().screenshot({ path: `${OUT}/after-2-refreshed-nft-section.png` });
  console.log('AFTER refresh nft section:', JSON.stringify(await nftText(p)), log); await ctx.close(); }
// AFTER, no click: auto re-poll at 30 s picks it up.
{ const { p, ctx, log } = await page(4282, 1); const t0 = Date.now();
  await p.waitForFunction(() => document.querySelector('.fwnftg'), null, { timeout: 45000 }); console.log(`AUTO-POLL: NFT appeared ~${Math.round((Date.now() - t0) / 1000) + 2.5}s after first render`, log);
  await p.screenshot({ path: `${OUT}/after-3-autopoll-desktop.png`, fullPage: true });
  await ctx.close(); }
// mobile view of the fixed page
{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route('https://api.multisea.io/**', async r => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors }); try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' }, url: r.request().url().replace(/\?fresh=1$/, '') }); return r.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } }); } catch { return r.abort(); } });
  const p = await ctx.newPage(); await p.goto('http://localhost:4282/w/2753'); await p.waitForFunction(() => document.querySelector('.fwnftg'), null, { timeout: 60000 }); await p.waitForTimeout(2000);
  await p.screenshot({ path: `${OUT}/after-mobile.png`, fullPage: true }); await ctx.close(); }
await b.close();
