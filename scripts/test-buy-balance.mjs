// Buy-balance repro: mock wallet (reads forwarded to public RPCs, NEVER signs/sends) against a MultiSea build.
// Usage: node scripts/test-buy-balance.mjs <tag> [baseUrl]   env: XUSER, ITEM (abstract OpenSea item id), FLOWS
import { chromium } from 'playwright';
import CFG from '../config/collections.json' with { type: 'json' };
const TAG = process.argv[2] || 'run'; const BASE = process.argv[3] || 'http://localhost:4173';
const USER = process.env.XUSER || '0xca89ae48a5c61d13e78236daa4ac29ee588ea475';
const ITEM = process.env.ITEM || '4272';
const FLOWS = (process.env.FLOWS || 'item,cart').split(',');
const RPCS = Object.fromEntries(Object.values(CFG.chains).map(c => [c.chainId, c.rpc]));
const b = await chromium.launch();
async function ctxFor(vp) {
  const ctx = await b.newContext({ viewport: vp });
  await ctx.route('https://api.multisea.io/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); return r.fulfill({ response: resp, headers: { ...resp.headers(), 'access-control-allow-origin': '*' } }); } catch { return r.abort(); }
  });
  await ctx.exposeBinding('__rpc', async (_s, chainId, method, params) => {
    const r = await fetch(RPCS[chainId], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  });
  await ctx.addInitScript(acct => {
    let chainId = 1; window.__sent = []; window.__calls = [];
    const provider = { request: async ({ method, params }) => {
      window.__calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; }
      if (method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_getCapabilities') throw Object.assign(new Error('unsupported'), { code: 4200 });
      if (method === 'eth_sendTransaction') { const t = params[0]; let est; try { est = parseInt(await window.__rpc(chainId, 'eth_estimateGas', [{ from: t.from, to: t.to, data: t.data, value: t.value }]), 16); } catch (e) { est = 'REVERT: ' + String(e.message || e).slice(0, 160); } window.__est = (window.__est || []).concat({ chainId, value: t.value, gas: t.gas, est }); }
      if (method === 'eth_sendTransaction' || method === 'wallet_sendCalls' || /^eth_sign|personal_sign/.test(method)) { window.__sent.push({ method, chainId, params }); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
      return window.__rpc(chainId, method, params || []);
    }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    localStorage.setItem('multisea-wallet', 'test.mock');
  }, USER);
  return ctx;
}
const shot = async (p, name) => { const h = await p.evaluate(() => { const w = document.querySelector('.wbox'); return w ? Math.ceil(w.scrollHeight + 80) : 0; }); const vp = p.viewportSize(); if (h > vp.height) await p.setViewportSize({ width: vp.width, height: h }); await p.waitForTimeout(300); await p.screenshot({ path: `screens/buy-balance-fix/${TAG}-${name}.png` }); };
const modal = p => p.evaluate(() => document.querySelector('.wbox')?.innerText || '');
const VP = { width: 1280, height: 900 };
if (FLOWS.includes('item')) {
  const ctx = await ctxFor(VP); const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message.slice(0, 200)));
  await p.goto(`${BASE}/c/lil-foots?item=${ITEM}`, { waitUntil: 'networkidle', timeout: 60000 }); await p.waitForTimeout(2500);
  await p.click(`.modal [data-buy="${ITEM}"]`);
  await p.waitForFunction(() => /Confirm purchase|Insufficient|need|Not enough|err/i.test(document.querySelector('.wbox')?.innerText || '') && !document.querySelector('.wbox .spin'), null, { timeout: 60000 }).catch(() => {});
  console.log('--- item modal ---\n' + await modal(p));
  await shot(p, 'item-confirm');
  const xp = await p.$('.wbox .xpay');
  if (xp) { await xp.click(); await p.waitForFunction(() => document.querySelector('.wbox .xq .go, .wbox .xq .err, .wbox > .bbody > .err'), null, { timeout: 90000 }).catch(() => {}); await p.waitForTimeout(500); console.log('--- xpay modal ---\n' + await modal(p)); await shot(p, 'item-xpay'); }
  const go = await p.$('.wbox .go:not([disabled])');
  if (go) { await go.click(); await p.waitForFunction(() => window.__sent.length || document.querySelector('.wbox .err'), null, { timeout: 60000 }).catch(() => {}); console.log('--- after confirm ---\n' + await modal(p)); (await import('fs')).writeFileSync(`/tmp/sent-${TAG}.json`, JSON.stringify(await p.evaluate(() => window.__sent))); console.log('wallet sim (eth_estimateGas on the real chain):', JSON.stringify(await p.evaluate(() => window.__est || []))); console.log('wallet got:', JSON.stringify(await p.evaluate(() => window.__sent.map(x => ({ ...x, params: (x.params || []).map(t => ({ ...t, data: t.data ? t.data.slice(0, 10) + '…' : undefined })) }))))); await shot(p, 'item-after-confirm'); }
  await ctx.close();
}
if (FLOWS.includes('cart')) {
  const ctx = await ctxFor(VP); const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message.slice(0, 200)));
  const L = (await (await fetch('https://api.multisea.io/os/lil-foots/listings', { headers: { origin: 'https://multisea.io' } })).json()).listings;
  const N = (await (await fetch('https://api.multisea.io/native/lil-foots/listings', { headers: { origin: 'https://multisea.io' } })).json()).listings;
  const ids = (process.env.CART || ITEM).split(',');
  const CT = '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e';
  const items = ids.map(x => { const [id, src] = x.split(':'); const l = (src === 'ms' ? N : L).find(y => String(y.id) === id); const c = CFG.collections[0].deployments.find(d => d.chain === l.chain).address; void CT;
    return { key: `${l.chain}:${c.toLowerCase()}:${id}`, chain: l.chain, contract: c, id: +id, name: `LIL FOOT #${id}`, img: `/img/lil-foots/s/${id}.webp`, price: l.price, currency: l.currency, source: src === 'ms' ? 'multisea' : 'opensea', orderHash: l.orderHash, protocolAddress: l.protocolAddress, slug: 'lil-foots' }; });
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }); await p.evaluate(it => localStorage.setItem('multisea-cart', JSON.stringify(it)), items);
  await p.goto(`${BASE}/cart${process.env.PAY ? '?pay=' + process.env.PAY : ''}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
  await p.click('[data-act=checkout]');
  await p.waitForFunction(() => window.__xplan || window.__xerr || /No single balance/.test(document.querySelector('.wbox')?.innerText || ''), null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(500);
  console.log('--- cart modal ---\n' + await modal(p));
  console.log('plan:', await p.evaluate(() => { const x = window.__xplan; return x ? JSON.stringify({ src: x.src.id, bal: x.src.bal.toString(), tokenTotal: x.tokenTotal.toString(), legs: x.legs.map(l => ({ chain: l.chain, direct: l.direct, restVal: l.restVal.toString(), bridgeNeed: l.bridgeNeed.toString() })) }) : window.__xerr; }));
  await shot(p, 'cart-checkout');
  const cgo = await p.$('.xco .go:not([disabled])');
  if (cgo && process.env.CLICK !== '0') { await cgo.click(); await p.waitForFunction(() => window.__sent.length || document.querySelector('.xst .err, .xst .ok, .bbody > .err'), null, { timeout: 120000 }).catch(() => {}); await p.waitForTimeout(1500);
    console.log('wallet sim (eth_estimateGas on the real chain):', JSON.stringify(await p.evaluate(() => window.__est || []))); console.log('sent:', JSON.stringify(await p.evaluate(() => window.__sent.map(x => ({ method: x.method, chainId: x.chainId, n: JSON.stringify(x.params).length })))));
    console.log('--- after buy ---\n' + (await modal(p)).slice(-600)); await shot(p, 'cart-after-buy'); }
  await ctx.close();
}
await b.close();
