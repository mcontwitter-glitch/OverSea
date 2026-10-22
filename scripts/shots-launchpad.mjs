// Launchpad preview screenshots (local build only). Run against `vite preview` on :4199:
//   npx vite preview --outDir <build> --port 4199 & node scripts/shots-launchpad.mjs
import { chromium } from 'playwright';
const U = process.env.U || 'http://localhost:4199';
const OUT = 'screens/launchpad/';
const b = await chromium.launch();
const errs = [];
const VPS = { mobile: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } };
async function page(vp) {
  const ctx = await b.newContext({ viewport: VPS[vp], deviceScaleFactor: vp === 'mobile' ? 2 : 1 });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(`${vp} ${p.url()}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/api\.multisea\.io|CORS|Failed to load resource|coingecko|ERR_|net::/i.test(m.text())) errs.push(`${vp} console: ${m.text()}`); });
  return p;
}
const go = async (p, path) => { await p.goto(U + path, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500); };
const shot = (p, n, full = false) => p.screenshot({ path: OUT + n + '.png', fullPage: full });
for (const vp of ['mobile', 'desktop']) {
  const p = await page(vp);
  await go(p, '/launchpad'); await shot(p, `list-live-${vp}`, true);
  await p.click('[data-tab="upcoming"]'); await p.waitForTimeout(300); await shot(p, `list-upcoming-${vp}`);
  await p.click('[data-tab="ended"]'); await p.waitForTimeout(300); await shot(p, `list-ended-${vp}`);
  await go(p, '/launchpad/lil-foots'); await p.waitForTimeout(4000); await shot(p, `drop-${vp}`); await shot(p, `drop-full-${vp}`, true);
  await p.click('[data-q="1"]'); await p.click('[data-q="1"]'); await p.click('input[name=pay][value=relay]'); await p.waitForTimeout(300);
  await p.locator('.ldmintbox').scrollIntoViewIfNeeded(); await shot(p, `drop-qty3-relay-${vp}`);
  await p.click('[data-act=mint]'); await p.waitForTimeout(300); await p.locator('.ldmintbox').scrollIntoViewIfNeeded(); await shot(p, `drop-mint-demo-${vp}`);
  await p.fill('[data-al]', '0xca89ae48a5c61d13e78236daa4ac29ee588ea475'); await p.click('[data-act=alcheck]'); await p.waitForTimeout(200);
  // multichain (escrow): shared supply bar, chain picker, Active explainer, Your NFTs + Move to chain
  await go(p, '/launchpad/lil-foots'); await p.evaluate(() => sessionStorage.removeItem('multisea-lp-held')); await go(p, '/launchpad/lil-foots'); await p.waitForTimeout(3000);
  await p.locator('.ldprog.big').scrollIntoViewIfNeeded(); await shot(p, `mc-shared-supply-${vp}`);
  await p.click('[data-ch="apechain"]'); await p.waitForTimeout(300); await p.locator('.ldmintbox').scrollIntoViewIfNeeded(); await shot(p, `mc-mint-apechain-${vp}`);
  await p.locator('.ldheld').scrollIntoViewIfNeeded(); await shot(p, `mc-your-nfts-${vp}`);
  await p.click('[data-move="2396"]'); await p.waitForTimeout(2500); await shot(p, `mc-move-modal-${vp}`);
  await p.click('.ldmodal [data-dst="ethereum"]'); await p.waitForTimeout(300); await shot(p, `mc-move-modal-eth-${vp}`);
  await p.click('.ldmodal [data-dst="bnb"]'); await p.click('[data-act=domove]'); await p.waitForTimeout(300); await p.locator('.ldheld').scrollIntoViewIfNeeded(); await shot(p, `mc-moving-${vp}`);
  await p.waitForTimeout(3000); await p.locator('.ldheld').scrollIntoViewIfNeeded(); await shot(p, `mc-moved-${vp}`);
  await go(p, '/launchpad/lil-foots-robinhood'); await shot(p, `drop-upcoming-${vp}`);
  // create flow
  await p.evaluate(() => { sessionStorage.clear(); localStorage.removeItem('multisea-lp-preview'); });
  await go(p, '/launchpad/create'); await shot(p, `create-step1-empty-${vp}`);
  await p.click('[data-act=next]'); await p.waitForTimeout(200); await shot(p, `create-validation-${vp}`);
  await p.click('[data-act=demo]'); await p.waitForTimeout(200); await shot(p, `create-step1-${vp}`, true);
  for (let i = 2; i <= 6; i++) {
    await p.click('[data-act=next]'); await p.waitForTimeout(250); await shot(p, `create-step${i}-${vp}`, true);
    if (i === 3) { await shot(p, `create-mode-multichain-${vp}`); await p.click('label:has(input[name=mode][value=single])'); await p.waitForTimeout(200); await shot(p, `create-mode-single-${vp}`); await p.click('label:has(input[name=mode][value=multichain])'); await p.waitForTimeout(200); }
  }
  await p.check('[data-agree]'); await p.click('[data-act=submit]'); await p.waitForTimeout(400); await shot(p, `create-submitted-${vp}`);
  await go(p, '/admin'); await shot(p, `admin-queue-drop-${vp}`, true);
  await go(p, '/launchpad'); await shot(p, `list-with-submission-${vp}`, true);
  await go(p, '/admin'); p.once('dialog', d => d.accept()); await p.click('[data-dapprove]'); await p.waitForTimeout(300); await shot(p, `admin-after-approve-${vp}`);
  await go(p, '/launchpad'); await p.click('[data-tab="upcoming"]'); await p.waitForTimeout(300); await shot(p, `list-upcoming-approved-${vp}`, true);
  await p.context().close();
}
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors');
await b.close();
