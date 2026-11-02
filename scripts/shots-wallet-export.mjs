// Wallet menu + private-key export UI. Uses mock EIP-6963 wallets (no real login): a "social" one flagged like the
// thirdweb in-app provider, and a plain external one. Checks: export option only for social, warning + consent gate,
// thirdweb export iframe mounts (origin embedded-wallet.thirdweb.com), and without a thirdweb session a visible error.
// BASE=http://localhost:4331 node scripts/shots-wallet-export.mjs
import { chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4331';
const mock = (social) => { const p = { isMultiSeaEmbedded: social, request: async ({ method }) => method === 'eth_chainId' ? '0x1' : ['0x1111111111111111111111111111111111111111'], on() {}, removeListener() {} };
  localStorage.setItem('multisea-wallet', 'test.mock');
  const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'u1', name: social ? 'Embedded wallet' : 'MetaMask', icon: '', rdns: 'test.mock' }, provider: p }) }));
  window.addEventListener('eip6963:requestProvider', ann); ann(); };
const b = await chromium.launch(); const res = {}; let ok = true;
for (const [dev, opts] of [['desktop', { viewport: { width: 1280, height: 860 } }], ['mobile', devices['iPhone 13']]]) {
  for (const social of [true, false]) {
    const ctx = await b.newContext(opts); await ctx.addInitScript(mock, social); const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForTimeout(1500);
    await p.locator('[data-act="wallet"]:visible').first().click();
    await p.waitForSelector('[data-wm=copy]'); const hasExport = await p.locator('[data-wm=export]').count() > 0;
    const k = `${dev}-${social ? 'social' : 'external'}`; await p.screenshot({ path: `screens/wallet-export/${k}-1-menu.png` });
    const r = { hasExport }; if (hasExport !== social) ok = false;
    if (social) {
      await p.click('[data-wm=export]'); r.gated = await p.locator('[data-wm=reveal]').isDisabled();
      await p.screenshot({ path: `screens/wallet-export/${k}-2-warning.png` });
      await p.check('[data-wm=ok]'); await p.click('[data-wm=reveal]');
      const f = await p.waitForSelector('iframe[title^="Export in-app"]', { timeout: 15000 }).catch(() => null);
      r.iframeOrigin = f ? new URL(await f.getAttribute('src')).origin : null;
      r.noSessionErr = await p.waitForSelector('text=session has expired', { timeout: 30000 }).then(() => true, () => false);
      await p.screenshot({ path: `screens/wallet-export/${k}-3-reveal.png` });
      if (!r.gated || r.iframeOrigin !== 'https://embedded-wallet.thirdweb.com' || !r.noSessionErr) ok = false;
    }
    res[k] = r; await ctx.close();
  }
}
await b.close(); console.log(JSON.stringify(res)); console.log(ok ? 'ALL PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
