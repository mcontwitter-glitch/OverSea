// Screenshots of the launchpad "Coming soon" state against a local build (npm run build && npx vite preview --port 4283).
// The API is mocked: one approved drop with no verified contract (Coming soon) and one deployed drop (normal Live display).
import { chromium } from 'playwright';
const port = process.env.PORT || 4283, out = 'screens/launchpad';
const now = Math.floor(Date.now() / 1000);
const base = { mode: 'single', symbol: 'NSTP', description: 'Approved drop waiting for its contract to be deployed.', maxSupply: 3000, royaltyBps: 500, reveal: 'instant', logo: '/img/lil-foots/m/7.webp', submitter: undefined };
const drops = [
  { ...base, slug: 'neon-steps', name: 'Neon Steps', chains: ['base'], status: 'approved', deployed: false, deployments: [],
    phases: [{ name: 'Allowlist', price: '2000000000000000', currency: 'ETH', start: now - 3600, end: now + 86400, perWallet: 2 }, { name: 'Public', price: '4000000000000000', currency: 'ETH', start: now + 86400, perWallet: 5 }] },
  { ...base, slug: 'night-walk', name: 'Night Walk', symbol: 'NWLK', logo: '/img/lil-foots/m/3.webp', chains: ['base'], status: 'live', deployed: true, deployments: [{ chain: 'base', address: '0x' + '22'.repeat(20) }],
    phases: [{ name: 'Public', price: '3000000000000000', currency: 'ETH', start: now - 3600, perWallet: 5 }] },
];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
const b = await chromium.launch();
for (const [tag, vp, mobile] of [['desktop', { width: 1366, height: 900 }, false], ['mobile', { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.route('https://api.multisea.io/**', async r => {
    const u = new URL(r.request().url());
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/health') return r.fulfill({ headers: cors, body: JSON.stringify({ ok: true, features: ['launchpad'] }) });
    if (u.pathname === '/launchpad/drops') return r.fulfill({ headers: cors, body: JSON.stringify({ drops }) });
    if (u.pathname.startsWith('/img/')) return r.fetch({ url: `http://localhost:${port}${u.pathname}` }).then(resp => r.fulfill({ response: resp }));
    return r.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}/launchpad/`); await p.waitForSelector('a[href="/launchpad/night-walk"]', { timeout: 30000 });
  // Live tab: deployed drop shows the normal Live status, the LIL FOOTS demo card keeps its DEMO badge, coming-soon drop is not listed as live.
  if (!/Live/.test(await p.locator('a[href="/launchpad/night-walk"]').innerText())) throw new Error('deployed drop should show Live');
  if (!/demo/i.test(await p.locator('a[href="/launchpad/lil-foots"]').innerText())) throw new Error('LIL FOOTS demo badge missing');
  if (await p.locator('a[href="/launchpad/neon-steps"]').count()) throw new Error('coming-soon drop listed under Live');
  await p.click('[data-tab="upcoming"]'); await p.waitForSelector('a[href="/launchpad/neon-steps"]'); await p.waitForTimeout(800);
  const card = await p.locator('a[href="/launchpad/neon-steps"]').innerText();
  if (!/Coming soon/i.test(card) || /Live|Starts in/.test(card)) throw new Error('coming-soon card wrong: ' + card);
  await p.screenshot({ path: `${out}/coming-soon-list-${tag}.png`, fullPage: true });
  await p.goto(`http://localhost:${port}/launchpad/neon-steps`); await p.waitForSelector('.ldmintbox', { timeout: 30000 }); await p.waitForTimeout(800);
  const btn = p.locator('.ldmintbox button'); if (!(await btn.isDisabled()) || !/Minting opens soon/.test(await btn.innerText())) throw new Error('mint button not disabled');
  const main = await p.locator('#app').innerText(); if (/demo \(no transaction\)|Ends in|Starts in/i.test(main)) throw new Error('drop page shows countdown/stub');
  await p.screenshot({ path: `${out}/coming-soon-drop-${tag}.png`, fullPage: true });
  await ctx.close(); console.log('ok', tag);
}
await b.close();
