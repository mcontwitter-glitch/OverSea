// Screenshots of the 6 growth features against `vite preview` (:4173) with a mocked MultiSea API + mock EIP-6963 wallet
// (throwaway address, never signs or sends). Output: screens/new-features/<feature>-<view>-{desktop,mobile}.png
import { chromium } from 'playwright';
import fs from 'node:fs';
const U = 'http://localhost:4173', OUT = 'screens/new-features'; fs.mkdirSync(OUT, { recursive: true });
const ME = '0x7e57a11ce0000000000000000000000000c0ffee';
const FR = ['0x5a1e000000000000000000000000000000f00d01', '0x5a1e000000000000000000000000000000f00d02', '0x5a1e000000000000000000000000000000f00d03', '0x5a1e000000000000000000000000000000f00d04'];
const SEA = '0x0000000000000068f116a894984e2db1123eb395', FEE = '0x25411039f77529a543344603bd8acdd65faba4d0';
const LIL = { abstract: '0x22fc5bb9810ef92db35accea463693331bcd0a8a', base: '0x1ec054906b4a45deba936aa88492d725cb06508e', apechain: '0x1ec054906b4a45deba936aa88492d725cb06508e', ethereum: '0xf12476842ccbe4c7e6847eb67777f29f25419738' };
const E = x => BigInt(Math.round(x * 1e9)) * 10n ** 9n + '';
const now = Math.floor(Date.now() / 1000);
const order = (chain, id, priceEth) => { const p = BigInt(E(priceEth)); const fee = p * 50n / 10000n; return { chain, orderHash: '0x' + (id.toString(16).padStart(8, '0')).repeat(8), protocolAddress: SEA, priceWei: p + '', signature: '0x' + 'ab'.repeat(65), parameters: { offerer: FR[0], zone: '0x0000000000000000000000000000000000000000', offer: [{ itemType: 2, token: LIL[chain], identifierOrCriteria: String(id), startAmount: '1', endAmount: '1' }], consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: (p - fee) + '', endAmount: (p - fee) + '', recipient: FR[0] }, { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: fee + '', endAmount: fee + '', recipient: FEE }], orderType: 0, startTime: String(now - 60), endTime: String(now + 86400 * 7), zoneHash: '0x' + '0'.repeat(64), salt: '1', conduitKey: '0x' + '0'.repeat(64), totalOriginalConsiderationItems: 2, counter: '0' } }; };
const NATIVE = [order('base', 1201, 0.0029), order('abstract', 3310, 0.0031), order('apechain', 2210, 0.0033)];
const iso = d => new Date(Date.now() - d * 86400e3).toISOString();
const q = (c) => ({ address: ME, chains: ['ethereum', 'base', 'abstract', 'apechain', 'robinhood'].map(k => ({ chain: k, done: { buy: c[k]?.includes('buy') ? iso(3) : null, list: c[k]?.includes('list') ? iso(5) : null, bridge: c[k]?.includes('bridge') ? iso(1) : null, hold: c[k]?.includes('hold') ? iso(9) : null }, badge: !!c[k] })), count: Object.keys(c).length, total: 5, eligible: Object.keys(c).length === 5 });
const QUESTS = q({ base: ['buy', 'hold'], abstract: ['list', 'hold'], apechain: ['bridge'] });
const B = [
  { id: 'bmx01xc', title: 'LIL FOOTS cross-chain trio', seller: FR[1], kind: 'cross-chain', experimental: true, status: 'open', createdAt: iso(0.2), policy: 'Cross-chain bundles are filled one chain at a time (each chain\'s leg is a single Seaport order, so a leg is all-or-nothing). The buyer gets an exclusive 15-minute checkout lock and the signed orders are only revealed to that buyer. If a later leg fails or the lock expires after some legs were filled, the buyer keeps the filled legs at their listed per-leg prices and the bundle is marked "partially filled"; the remaining legs are withdrawn and the seller should cancel them on-chain.', legs: [{ chain: 'abstract', hash: '0x1', priceWei: E(0.006), status: 'open', items: [{ token: LIL.abstract, id: '412' }, { token: LIL.abstract, id: '1888' }] }, { chain: 'base', hash: '0x2', priceWei: E(0.004), status: 'open', items: [{ token: LIL.base, id: '77' }] }, { chain: 'apechain', hash: '0x3', priceWei: E(9), status: 'open', items: [{ token: LIL.apechain, id: '3021' }] }] },
  { id: 'bmx02sc', title: 'Abstract floor pack', seller: FR[2], kind: 'same-chain', experimental: false, status: 'open', createdAt: iso(1), policy: 'Single Seaport order with multiple offer items: all-or-nothing.', legs: [{ chain: 'abstract', hash: '0x4', priceWei: E(0.0105), status: 'open', items: [{ token: LIL.abstract, id: '2396' }, { token: LIL.abstract, id: '3958' }, { token: LIL.abstract, id: '1010' }, { token: LIL.abstract, id: '64' }] }] },
  { id: 'bmx03pf', title: 'Base + Ethereum pair', seller: FR[3], kind: 'cross-chain', experimental: true, status: 'partial', createdAt: iso(3), policy: '…', legs: [{ chain: 'base', hash: '0x5', priceWei: E(0.003), status: 'filled', items: [{ token: LIL.base, id: '501' }] }, { chain: 'ethereum', hash: '0x6', priceWei: E(0.01), status: 'withdrawn', items: [{ token: LIL.ethereum, id: '9' }] }] },
];
function api(path, method) {
  const p = path.split('?')[0];
  if (p === '/health') return { ok: true, features: ['buy', 'siwe', 'submit', 'admin', 'edit', 'sell', 'native', 'growth', 'media'] };
  if (p === '/collections/lil-foots') return { collection: { slug: 'lil-foots', name: 'LIL FOOTS', royalty: { recipient: FR[3], bps: 250 } } };
  if (p.endsWith('/can-edit')) return { ok: true, why: 'admin' };
  if (p === '/os/lil-foots/listings') return { listings: [] };
  if (p === '/native/lil-foots/listings') return { listings: NATIVE.map(o => ({ source: 'multisea', chain: o.chain, id: +o.parameters.offer[0].identifierOrCriteria, price: Number(o.priceWei) / 1e18, currency: o.chain === 'apechain' ? 'APE' : 'ETH', orderHash: o.orderHash, protocolAddress: SEA, seller: FR[0] })) };
  if (p.startsWith('/native/order/')) { const h = p.split('/')[4]; return NATIVE.find(o => o.orderHash === h) || null; }
  if (p.startsWith('/native/config/')) return { seaport: SEA, feeRecipient: FEE, feeBps: 50, royalty: { recipient: FR[3], bps: 250 } };
  if (p === '/revshare') return { capBps: 5000, payouts: { enabled: false, reason: 'Mainnet payouts are disabled until funded.' }, collections: [{ slug: 'lil-foots', name: 'LIL FOOTS', enabled: true, feeShareBps: 5000, royaltyShareBps: 2000, supply: 4404 }] };
  if (p === '/revshare/lil-foots') return { slug: 'lil-foots', name: 'LIL FOOTS', config: { enabled: true, feeShareBps: 5000, royaltyShareBps: 2000, supply: 4404, acceptedTerms: true }, acc: { perChain: { abstract: { total: E(0.0812) }, base: { total: E(0.0391) }, apechain: { total: E(61.5) } }, sales: 214 }, capBps: 5000, payouts: { enabled: false, reason: 'Mainnet payouts are disabled until funded (set REVSHARE_MAINNET=on after funding).' } };
  if (p === '/revshare/lil-foots/claimable') return { perToken: {}, total: { abstract: E(0.0000737), base: E(0.0000355), apechain: E(0.0558) } };
  if (p === '/revshare/lil-foots/claim') return { ok: true, executed: false, status: 'queued', requestId: 'mx3k9a2f', reason: 'Mainnet payouts are disabled until funded (set REVSHARE_MAINNET=on after funding).', quotes: [{ out: { amountFormatted: '0.3712', currency: { symbol: 'USDC' }, amountUsd: '0.37' } }] };
  if (p.startsWith('/ref/stats/')) return { code: '3fa9c21b', path: '/r/3fa9c21b', referredBy: null, refBps: 2000, friends: FR.map((a, i) => ({ address: a, at: iso(20 - i * 4), sales: [3, 1, 4, 0][i], perChain: {} })), earnings: { perChain: { base: E(0.000052), abstract: E(0.000031), apechain: E(0.041) }, sales: 8 } };
  if (p === '/admin/growth') return { config: { refBps: 2000, rsFeeCapBps: 5000 }, referrers: [{ address: ME, sales: 8, perChain: { base: E(0.000052), abstract: E(0.000031) } }, { address: FR[2], sales: 3, perChain: { base: E(0.00002) } }], refSales: [{ referrer: ME, buyer: FR[0], chain: 'base', amount: E(0.0000058), refBps: 2000 }, { referrer: ME, buyer: FR[2], chain: 'abstract', amount: E(0.0000062), refBps: 2000 }], revshareClaims: [{ slug: 'lil-foots', ids: ['12', '845'], status: 'queued', who: FR[1], dest: { chain: 'base' }, legs: [{ chain: 'abstract', wei: E(0.00004) }] }], payouts: { enabled: false, reason: 'Payouts are disabled until the payout wallet is funded.' }, badgeSigner: false };
  if (p === `/quests/${ME}`) return QUESTS;
  if (p === `/quests/${ME}/eligibility`) return { eligible: false, count: 3, total: 5 };
  if (p === `/profile/${ME}`) return { address: ME, quests: QUESTS, referrals: { code: '3fa9c21b', friends: 4, earnings: { sales: 8 } }, bundles: [{ ...B[1], seller: ME }] };
  if (p === '/bundles') return { bundles: B };
  if (p.startsWith('/bundles/')) return { bundle: B.find(b => b.id === p.split('/')[2]) };
  if (p.startsWith('/rpc/')) return 'rpc';
  return { error: 'mock: ' + p };
}
const b = await chromium.launch();
async function shot(name, path, { wallet = true, session = false, act = null, h = 900 } = {}) {
  for (const [vp, tag] of [[{ width: 1440, height: h }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']]) {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: tag === 'mobile' ? 2 : 1 });
    const pg = await ctx.newPage(); pg.on('pageerror', e => console.log('  pageerror', name, e.message));
    await pg.route('https://api.multisea.io/**', async r => { const u = new URL(r.request().url()); const res = api(u.pathname, r.request().method());
      if (res === 'rpc') { const body = JSON.parse(r.request().postData() || '{}'); const one = x => ({ jsonrpc: '2.0', id: x.id, result: x.method === 'eth_getBalance' ? '0x' + (6n * 10n ** 16n).toString(16) : x.method === 'eth_chainId' ? '0x2105' : '0x0' }); return r.fulfill({ json: Array.isArray(body) ? body.map(one) : one(body) }); }
      return r.fulfill({ status: res?.error ? 404 : 200, json: res ?? { error: 'not found' } }); });
    await pg.route('https://api.coingecko.com/**', r => r.fulfill({ json: { ethereum: { usd: 2650 }, apecoin: { usd: 0.62 }, binancecoin: { usd: 590 } } }));
    await pg.route('**/data/lil-foots/owners.min.json', async r => { const res = await r.fetch(); const j = await res.json(); const ai = j.addrs.push(ME) - 1; for (const [id, c] of [[12, 0], [845, 0], [2001, 0], [77, 4], [300, 2]]) j.d[id] = [c, ai]; r.fulfill({ json: j }); });
    await pg.addInitScript(({ ME, wallet, session }) => {
      if (wallet) localStorage.setItem('multisea-wallet', 'test'); else localStorage.removeItem('multisea-wallet');
      localStorage.setItem('multisea-cart', localStorage.getItem('multisea-cart') || '[]');
      if (session) sessionStorage.setItem('multisea-session', JSON.stringify({ token: 'a'.repeat(64), address: ME, isAdmin: true, exp: Date.now() + 3600e3 }));
      let chainId = 8453;
      const provider = { request: async ({ method, params }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ME]; if (method === 'eth_chainId') return '0x' + chainId.toString(16); if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; } throw Object.assign(new Error('mock wallet: ' + method), { code: 4001 }); }, on() {} };
      const info = { uuid: 'mock', name: 'Test Wallet', icon: '', rdns: 'test' };
      const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', ann); ann();
    }, { ME, wallet, session });
    await pg.goto(U + path, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await pg.waitForTimeout(1800);
    if (act) await act(pg, tag).catch(e => console.log('  act fail', name, tag, e.message));
    await pg.screenshot({ path: `${OUT}/${name}-${tag}.png` }); console.log(`${OUT}/${name}-${tag}.png`); await ctx.close();
  }
}
const only = process.argv[2];
const S = [
  ['1-social-signin-connect', '/', { wallet: false, act: async pg => { await pg.click('.wbtn'); await pg.waitForSelector('.socials'); await pg.waitForTimeout(400); } }],
  ['1-social-signin-setup-note', '/', { wallet: false, act: async pg => { await pg.click('.wbtn'); await pg.click('[data-social=x]'); await pg.waitForTimeout(400); } }],
  ['2-revenue-share', '/revenue-share', { session: true, h: 1500 }],
  ['2-revenue-share-claim', '/revenue-share', { session: true, h: 1200, act: async pg => { await pg.selectOption('[data-k=payChain]', 'base'); await pg.waitForTimeout(300); await pg.selectOption('[data-k=payCur]', { label: 'USDC' }); await pg.click('[data-act=claim]'); await pg.waitForTimeout(800); await pg.locator('[data-act=claim]').scrollIntoViewIfNeeded(); } }],
  ['3-referrals', '/referrals', { h: 1100 }],
  ['3-referrals-admin', '/referrals', { session: true, h: 1700, act: async pg => { await pg.locator('.fcard.admin').scrollIntoViewIfNeeded(); } }],
  ['3-referral-invite-toast', '/r/3fa9c21b', { act: async pg => { await pg.waitForSelector('.reftoast', { timeout: 5000 }); } }],
  ['4-sweep-modal', '/c/lil-foots', { act: async pg => { await pg.waitForTimeout(1500); await pg.click('[data-act=sweep]'); await pg.waitForSelector('.swlist'); await pg.waitForTimeout(500); } }],
  ['4-cart', '/cart', { h: 1200, act: async pg => { await pg.evaluate(n => { localStorage.setItem('multisea-cart', JSON.stringify(n)); }, NATIVE.map(o => ({ key: o.chain + ':' + o.parameters.offer[0].token + ':' + o.parameters.offer[0].identifierOrCriteria, chain: o.chain, contract: o.parameters.offer[0].token, id: +o.parameters.offer[0].identifierOrCriteria, name: 'LIL FOOTS #' + o.parameters.offer[0].identifierOrCriteria, img: '/img/lil-foots/s/' + o.parameters.offer[0].identifierOrCriteria + '.webp', price: Number(o.priceWei) / 1e18, currency: o.chain === 'apechain' ? 'APE' : 'ETH', source: 'multisea', orderHash: o.orderHash, protocolAddress: SEA, slug: 'lil-foots' }))); await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(1200); } }],
  ['4-cart-checkout', '/cart', { act: async pg => { await pg.evaluate(n => { localStorage.setItem('multisea-cart', JSON.stringify(n)); }, NATIVE.slice(0, 2).map(o => ({ key: o.chain + ':' + o.parameters.offer[0].token + ':' + o.parameters.offer[0].identifierOrCriteria, chain: o.chain, contract: o.parameters.offer[0].token, id: +o.parameters.offer[0].identifierOrCriteria, name: 'LIL FOOTS #' + o.parameters.offer[0].identifierOrCriteria, img: '/img/lil-foots/s/' + o.parameters.offer[0].identifierOrCriteria + '.webp', price: Number(o.priceWei) / 1e18, currency: 'ETH', source: 'multisea', orderHash: o.orderHash, protocolAddress: SEA, slug: 'lil-foots' }))); await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(1000); await pg.click('[data-act=checkout]'); await pg.waitForSelector('.bbody .go', { timeout: 15000 }); await pg.waitForTimeout(300); } }],
  ['5-bundles', '/bundles', { h: 1000 }],
  ['5-bundle-crosschain-detail', '/bundles?id=bmx01xc', { h: 1200 }],
  ['5-bundle-create', '/bundles?new=1', { h: 1300, act: async pg => { await pg.waitForSelector('.pick'); const p = pg.locator('.pick'); await p.nth(0).click(); await p.nth(3).click(); await p.nth(4).click(); await pg.waitForTimeout(200); await pg.fill('.bt', 'My LIL FOOTS cross-chain set'); for (const k of ['abstract', 'base', 'apechain']) { const i = pg.locator(`[data-price=${k}]`); if (await i.count()) await i.fill(k === 'apechain' ? '8' : '0.005'); } } }],
  ['6-quests', '/quests', { h: 1500 }],
  ['6-profile-badges', `/u/${ME}`, { h: 1000 }],
];
for (const [n, p, o] of S) if (!only || n.startsWith(only)) await shot(n, p, o);
await b.close();
