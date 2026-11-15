// Screenshots of the Solana option (local only). SOL build: VITE_SOLANA_OMNI_ID=<devnet id> npx vite build --outDir /tmp/dist-sol
// && npx vite preview --outDir /tmp/dist-sol --port 4290. Production build (no program id): npx vite preview --port 4291.
// The API and the Phantom provider are mocked; no transaction is sent.
import { chromium } from 'playwright';
const SOL = process.env.SOL_PORT || 4290, PROD = process.env.PROD_PORT || 4291, out = process.env.OUT || '/workspace/screens-solana';
const now = Math.floor(Date.now() / 1000), SOLW = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const drop = { slug: 'sol-steps', name: 'Sol Steps', symbol: 'SSTP', mode: 'multichain', copyMode: 'at-mint', description: 'Multichain drop minting on Base, BNB and Solana from day one.', maxSupply: 3000, royaltyBps: 500, reveal: 'instant', logo: '/img/lil-foots/m/7.webp',
  creator: '0xca89ae48a5c61d13e78236daa4ac29ee588ea475', chains: ['base', 'bnb'], status: 'live', deployed: true, deployments: [{ chain: 'base', address: '0x' + '22'.repeat(20) }, { chain: 'bnb', address: '0x' + '33'.repeat(20) }],
  solana: { creator: SOLW, payout: SOLW, drop: 'Fq1ZsXbW9jV4n7m3x2qkdJ9w1u5Z3a8c6e2r4t7y9u1i' },
  phases: [{ name: 'Public', kind: 'public', price: '3000000000000000', prices: { base: '3000000000000000', bnb: '10000000000000000', solana: '50000000' }, start: now - 3600, end: 0, maxPerWallet: 5 }] };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
const draft = { step: 2, mode: 'multichain', copyMode: 'at-mint', batchK: '50', batchT: '30', total: '3000', name: 'Sol Steps', symbol: 'SSTP', slug: 'sol-steps', description: 'x', website: '', x: '', storage: 'own', baseURI: 'ipfs://bafyfinal/', reveal: 'instant', preRevealURI: '', files: 0,
  chains: { base: '', bnb: '' }, reserve: '0', royalty: '5', payout: '', royaltyReceiver: '', agree: false, solana: true, solCreator: SOLW,
  phases: [{ name: 'Public', kind: 'public', start: '2026-12-01T12:00', end: '', price: '', maxPerWallet: '5', allowlist: '', usd: '10' }], nftType: 'erc721', ag: {} };
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function ctxFor(port) {
  const ctx = await b.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.addInitScript(([d, w]) => { sessionStorage.setItem('multisea-lp-draft', JSON.stringify(d));
    window.phantom = { solana: { isPhantom: true, publicKey: null, async connect() { this.publicKey = { toBase58: () => w }; }, async signTransaction(t) { throw new Error('mock wallet: no signing in screenshots'); } } }; }, [draft, SOLW]);
  await ctx.route('https://api.multisea.io/**', async r => { const u = new URL(r.request().url());
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/health') return r.fulfill({ headers: cors, body: JSON.stringify({ ok: true, features: ['launchpad'] }) });
    if (u.pathname === '/launchpad/drops') return r.fulfill({ headers: cors, body: JSON.stringify({ drops: [drop] }) });
    return r.fulfill({ status: 404, headers: cors, body: '{}' }); });
  await ctx.route('https://api.coingecko.com/**', r => r.fulfill({ headers: cors, body: JSON.stringify({ ethereum: { usd: 3000 }, apecoin: { usd: 0.6 }, binancecoin: { usd: 600 }, solana: { usd: 200 } }) }));
  return ctx;
}
const fs = await import('node:fs'); fs.mkdirSync(out, { recursive: true });
{ const ctx = await ctxFor(SOL); const p = await ctx.newPage();
  await p.goto(`http://localhost:${SOL}/launchpad/create`); await p.waitForSelector('[data-solchain]', { timeout: 30000 }); await p.waitForTimeout(600);
  await p.locator('[data-solchain]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${out}/create-chains-solana.png`, fullPage: true });
  await p.click('[data-act="next"]'); await p.waitForTimeout(600); const t = await p.locator('#app').innerText();
  if (!/0\.05 SOL/.test(t)) throw new Error('USD -> SOL conversion missing: ' + t.slice(0, 400));
  await p.screenshot({ path: `${out}/create-phases-usd-sol.png`, fullPage: true });
  await p.goto(`http://localhost:${SOL}/launchpad/sol-steps`); await p.waitForSelector('[data-solcard] .fcard', { timeout: 30000 }); await p.waitForTimeout(800);
  await p.click('[data-sc="connect"][data-w="phantom"]'); await p.waitForTimeout(400);
  await p.locator('[data-solcard]').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${out}/drop-solana-mint.png`, fullPage: true });
  await p.click('[data-sc="tab"][data-t="from"]'); await p.waitForTimeout(300); await p.screenshot({ path: `${out}/drop-solana-bridge-from.png`, fullPage: true });
  await ctx.close(); console.log('sol build ok'); }
{ const ctx = await ctxFor(PROD); const p = await ctx.newPage();
  await p.goto(`http://localhost:${PROD}/launchpad/create`); await p.waitForSelector('[data-chain="base"]', { timeout: 30000 }); await p.waitForTimeout(600);
  if (await p.locator('[data-solchain]').count()) throw new Error('Solana must be hidden in the production build');
  await p.screenshot({ path: `${out}/prod-create-chains-hidden.png`, fullPage: true });
  await p.goto(`http://localhost:${PROD}/launchpad/sol-steps`); await p.waitForSelector('.ldmintbox', { timeout: 30000 }); await p.waitForTimeout(800);
  if (await p.locator('[data-solcard]').count()) throw new Error('Solana card must be hidden in the production build');
  await ctx.close(); console.log('prod build: Solana hidden ok'); }
await b.close();
