// Admin nav link: visible only for the admin / fee wallet (mock EIP-6963 wallet; never signs). Usage: node scripts/test-admin-nav.mjs [baseUrl]
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:4173';
const ADMIN = '0xCa89AE48a5C61D13E78236DAA4Ac29EE588ea475', FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0', RANDOM = '0x1234567890123456789012345678901234567891';
const b = await chromium.launch(); let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function page(vp, acct, restore) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: vp.width < 700 ? 2 : 1, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
  await ctx.route('https://api.multisea.io/**', async r => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } }); try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } }); } catch { return r.abort(); } });
  await ctx.addInitScript(([acct, restore]) => {
    window.__signed = [];
    const provider = { request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x1';
      window.__signed.push(method); throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    if (restore) localStorage.setItem('multisea-wallet', 'test.mock'); else localStorage.removeItem('multisea-wallet');
  }, [acct, restore]);
  const p = await ctx.newPage(); p.on('pageerror', e => { console.log('pageerror', e.message.slice(0, 150)); fails++; }); return { ctx, p };
}
const vis = p => p.evaluate(() => [...document.querySelectorAll('nav.top [data-admin-nav]')].map(e => ({ menu: !!e.closest('.navmenu'), shown: !e.hidden && getComputedStyle(e).display !== 'none' })));
const openMore = async p => { await p.click('details.navmore > summary'); await p.waitForTimeout(250); };
const connect = async p => { await p.click('.wbtn'); await p.click('.wopt[data-uuid="mock-1"]'); await p.waitForTimeout(600); };
for (const [tag, vp] of [['desktop', { width: 1440, height: 900 }], ['mobile-390', { width: 390, height: 844 }]]) {
  const mob = vp.width < 700;
  // 1) disconnected -> hidden
  let { ctx, p } = await page(vp, ADMIN, false);
  await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
  ok((await vis(p)).every(x => !x.shown), `${tag}: disconnected -> Admin hidden`);
  // 2) connect as admin (live, no reload) -> visible (top nav on desktop, More menu on both)
  await connect(p); let v = await vis(p);
  ok(v.find(x => !x.menu)?.shown === !mob, `${tag}: admin connected -> top-nav link ${mob ? 'hidden (menu only)' : 'visible'}`);
  await openMore(p); v = await vis(p);
  ok(v.find(x => x.menu)?.shown === true, `${tag}: admin connected -> More menu link visible`);
  await p.screenshot({ path: `screens/admin-nav/admin-connected-${tag}.png` });
  // disconnect -> hidden again without reload
  p.once('dialog', d => d.accept()); await p.click('.wbtn'); await p.waitForTimeout(500);
  ok((await vis(p)).every(x => !x.shown), `${tag}: after disconnect -> Admin hidden`);
  // 3) /admin: active state, link target
  await ctx.close(); ({ ctx, p } = await page(vp, ADMIN, true));
  await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
  await openMore(p); await p.click('.navmenu a[data-admin-nav]'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(1200);
  ok(new URL(p.url()).pathname.replace(/\/$/, '') === '/admin', `${tag}: menu link goes to /admin (${new URL(p.url()).pathname})`);
  const act = await p.evaluate(() => ({ top: document.querySelector('nav.top .navl > a[data-admin-nav]')?.classList.contains('on'), menu: document.querySelector('.navmenu a[data-admin-nav]')?.classList.contains('on'), more: document.querySelector('details.navmore')?.classList.contains('on') }));
  ok(act.top && act.menu && act.more, `${tag}: active on /admin ${JSON.stringify(act)}`);
  await p.screenshot({ path: `screens/admin-nav/admin-page-active-${tag}.png` });
  ok((await p.evaluate(() => window.__signed)).length === 0, `${tag}: no signature requested`);
  await ctx.close();
  // 4) fee wallet -> visible; random -> hidden
  ({ ctx, p } = await page(vp, FEE, true)); await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200);
  ok((await vis(p)).some(x => x.menu) && (await (async () => { await openMore(p); return (await vis(p)).find(x => x.menu).shown; })()), `${tag}: fee wallet -> menu link visible`); await ctx.close();
  ({ ctx, p } = await page(vp, RANDOM, false)); await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(800); await connect(p); await openMore(p);
  ok((await vis(p)).every(x => !x.shown), `${tag}: random address connected -> Admin hidden`);
  await p.screenshot({ path: `screens/admin-nav/non-admin-connected-${tag}.png` }); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
