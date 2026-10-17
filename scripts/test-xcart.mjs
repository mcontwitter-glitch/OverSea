// One cart across chains: E2E against the local preview build with REAL Relay quotes via the live Worker proxy.
// Read-only: the mock wallet never signs or sends. Usage: node scripts/test-xcart.mjs [batch=1]
import { chromium } from 'playwright';
const USER = process.env.XUSER || '0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5'; // public address with ETH on Ethereum + USDC on Base that OpenSea lets trade
const BATCH = process.env.BATCH !== '0';
const C = { base: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e', apechain: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e', robinhood: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' };
const SP = '0x0000000000000068f116a894984e2db1123eb395';
const it = (chain, id, price, currency, source, orderHash) => ({ key: `${chain}:${C[chain].toLowerCase()}:${id}`, chain, contract: C[chain], id, name: `LIL FOOT #${id}`, img: `/img/lil-foots/s/${id}.webp`, price, currency, source, orderHash, protocolAddress: SP, slug: 'lil-foots' });
const FULL = [
  it('base', 1942, 101, 'ETH', 'opensea', '0x76b3f7400cce579b73db72913687f02fe420c0b2ade6167a580deb17e75c278e'),
  it('apechain', 3751, 160, 'APE', 'opensea', '0x4cf2d0bccf8b6119116398f0025826f30b05221cedc450c9c5101b900d7a126e'),
  it('robinhood', 976, 0.02, 'ETH', 'multisea', '0xf221570b726d417609df804f367afd475b9e8f0e1dabdc444e64c30296a02396'),
  it('robinhood', 2750, 0.009, 'ETH', 'opensea', '0xbbac583e0302c5c56fdc45c37b1a8d7cb846e4510c679741c11268dc14c306b1'),
];
const MIX = FULL.slice(1);            // ApeChain + Robinhood (1-step + 2-step)
const RH = FULL.slice(2);             // Robinhood only: 1-step MultiSea + 2-step OpenSea
const b = await chromium.launch();
async function run(name, cartItems, pay, vp) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr || 1, isMobile: vp.w < 700, hasTouch: vp.w < 700 });
  const relay = [];
  await ctx.route('https://api.multisea.io/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); if (r.request().url().includes('/relay/')) relay.push(resp.status() + ' ' + r.request().url().replace('https://api.multisea.io', '')); return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } }); } catch { return r.abort(); }
  });
  await ctx.addInitScript(([acct, batch, items]) => {
    localStorage.setItem('multisea-cart', JSON.stringify(items));
    let chainId = 1; window.__sent = [];
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; }
      if (method === 'wallet_getCapabilities') { if (!batch) throw Object.assign(new Error('unsupported'), { code: 4200 }); const o = {}; for (const c of params[1] || []) o[c] = { atomic: { status: 'supported' } }; return o; }
      window.__sent.push(method); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); // never signs
    }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    localStorage.setItem('multisea-wallet', 'test.mock');
  }, [USER, BATCH, cartItems]);
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message.slice(0, 200)));
  await p.goto('http://localhost:4173/cart?pay=' + pay, { waitUntil: 'networkidle', timeout: 60000 }); await p.waitForTimeout(800);
  if (!(await p.textContent('.wbtn')).includes('0x')) { await p.click('.wbtn'); await p.click('.wopt[data-uuid="mock-1"]'); await p.waitForTimeout(800); }
  await p.click('[data-act=checkout]');
  await p.waitForFunction(() => window.__xplan || window.__xerr, null, { timeout: 120000 }).catch(() => {});
  const res = await p.evaluate(() => { const x = window.__xplan; if (!x) return { err: window.__xerr || document.querySelector('.wbox')?.textContent?.slice(0, 300) };
    const qi = q => q ? { in: q.details.currencyIn.amountFormatted + ' ' + q.details.currencyIn.currency.symbol + '@' + q.details.currencyIn.currency.chainId, out: q.details.currencyOut.amountFormatted + ' ' + q.details.currencyOut.currency.symbol + '@' + q.details.currencyOut.currency.chainId, usd: q.details.currencyIn.amountUsd, relayer: q.fees.relayer.amountUsd, app: q.fees.app.amountUsd, steps: q.steps.map(s => s.kind + ':' + s.id).join('+') } : null;
    return { src: x.src.symbol + '@' + x.src.chain, batch: x.batch, confirmations: x.confirmations, subtotalUsd: x.subtotalUsd.toFixed(2), feeUsd: x.feeUsd.toFixed(2), gasUsd: x.gasUsd.toFixed(2), totalUsd: x.totalUsd.toFixed(2), gone: x.gone.map(g => g.name), legs: x.legs.map(l => ({ chain: l.chain, direct: l.direct, oneStep: l.one.map(o => o.item.name), twoStep: l.restCalls.map(c => c.label), call: qi(l.callQ), bridge: qi(l.bridgeQ) })) }; });
  console.log('\n=== ' + name + ' ===\n' + JSON.stringify(res, null, 1)); console.log('relay calls:', relay.join(' | ')); console.log('button:', await p.textContent('.xco .go').catch(() => '-'), '| wallet calls:', await p.evaluate(() => window.__sent.join(',')));
  // capture the whole checkout sheet: grow the viewport to the sheet's height, then screenshot the page
  const h = await p.evaluate(() => { const w = document.querySelector('.wbox'); return w ? Math.ceil(w.scrollHeight + 60) : 0; });
  if (h > vp.h) await p.setViewportSize({ width: vp.w, height: h });
  await p.waitForTimeout(400); await p.screenshot({ path: `screens/xcart/${name}.png` });
  await ctx.close();
}
const D = { w: 1440, h: 1100 }, M = { w: 390, h: 844, dpr: 2 };
const only = process.argv[2];
const S = [
  ['xcart-full-base-ape-rh-eth-desktop', FULL, 'ethereum:ETH', D],
  ['xcart-eth-on-ethereum-desktop', MIX, 'ethereum:ETH', D], ['xcart-eth-on-ethereum-mobile', MIX, 'ethereum:ETH', M],
  ['xcart-usdc-on-base-desktop', RH, 'base:USDC', D], ['xcart-usdc-on-base-mobile', RH, 'base:USDC', M],
  ['xcart-full-usdc-on-base-desktop', MIX, 'base:USDC', D],
];
for (const [n, c, pay, vp] of S) if (!only || n.includes(only)) { await run(n, c, pay, vp); await new Promise(r => setTimeout(r, +(process.env.GAP || 15000))); }
await b.close();
