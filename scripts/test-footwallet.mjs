// Foot wallet (/w/<id>) E2E against the local preview build and LIVE mainnet reads (hubs, registry, RPC balances).
// Read-only: the mock wallet never signs or sends. /foot/<id>/nfts (new Worker route, not deployed yet) is served here
// with the same OpenSea query the Worker makes (needs OPENSEA_API_KEY in the env). Usage: node --env-file=.env scripts/test-footwallet.mjs
import { chromium } from 'playwright';
import { getContractAddress, concat, encodeAbiParameters } from 'viem';
const ADMIN = '0xCa89AE48a5C61D13E78236DAA4Ac29EE588ea475'; // live owner of #3004 (Base) and #259 (ApeChain)
const tba = id => getContractAddress({ opcode: 'CREATE2', from: '0x000000006551c19487814612e58FE06813775758', salt: '0x' + '0'.repeat(64), bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', '0x02e9fE944e1604160dac0fF5f35b8cE581D1e9b3', '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], ['0x' + '0'.repeat(64), 8453n, '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e', BigInt(id)])]) });
const OS = { base: 'base', ethereum: 'ethereum', apechain: 'ape_chain', robinhood: 'robinhood' };
async function footNfts(id) {
  const key = process.env.OPENSEA_API_KEY; if (!key) return { status: 503, body: { error: 'no key' } };
  const a = tba(id); const nfts = [];
  await Promise.all(Object.entries(OS).map(async ([k, os]) => { const r = await fetch(`https://api.opensea.io/api/v2/chain/${os}/account/${a}/nfts?limit=50`, { headers: { 'x-api-key': key, accept: 'application/json' } }); const j = await r.json().catch(() => ({}));
    for (const n of j.nfts || []) nfts.push({ chain: k, contract: n.contract.toLowerCase(), id: String(n.identifier), name: n.name, collection: n.collection, image: n.display_image_url || n.image_url, standard: n.token_standard }); }));
  return { status: 200, body: { id, account: a, nfts, unsupported: ['bnb'] } };
}
const b = await chromium.launch();
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
async function ctxFor(vp, acct) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr || 1, isMobile: vp.w < 700, hasTouch: vp.w < 700 });
  await ctx.route('https://api.multisea.io/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const m = r.request().url().match(/\/foot\/(\d+)\/nfts$/);
    if (m) { const x = await footNfts(+m[1]); return r.fulfill({ status: x.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(x.body) }); }
    try { const resp = await r.fetch({ headers: { ...r.request().headers(), origin: 'https://multisea.io' } }); return r.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } }); } catch { return r.abort(); }
  });
  await ctx.addInitScript(acct => {
    localStorage.setItem('multisea-debug', '1'); window.__sent = [];
    if (!acct) return; let chainId = 8453;
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; }
      window.__sent.push(method); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); // never signs
    }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce(); localStorage.setItem('multisea-wallet', 'test.mock');
  }, acct);
  const p = await ctx.newPage(); p.on('pageerror', e => console.log('pageerror', e.message.slice(0, 200)));
  return { ctx, p };
}
const loaded = p => p.waitForFunction(() => window.__fw?.S.loaded && (window.__fw.S.nfts !== null || window.__fw.S.nftNote), null, { timeout: 90000 });
const summary = p => p.evaluate(() => { const S = window.__fw.S; return { tba: S.tba, regOk: S.regOk, base: S.base, abs: S.abs, nfts: S.nfts?.length ?? null, chains: S.cs.map(c => ({ k: c.k, ok: c.ok, free: !!(c.live && !/^0x0+$/.test(c.live)), deployed: c.deployed, locked: c.lock?.locked, paused: c.paused, usd: c.usd })) }; });
async function shot(p, path, full = true) { await p.waitForTimeout(500); await p.screenshot({ path, fullPage: full }); console.log('  shot', path); }
const D = { w: 1440, h: 1000 }, M = { w: 390, h: 844, dpr: 2 };
const out = {};
// 1) #3958 visitor (foot on Abstract) and #3004 owner (free on Base), desktop + mobile
for (const [id, acct, tag] of [[3958, null, 'visitor'], [3004, ADMIN, 'owner']]) for (const [vn, vp] of [['desktop', D], ['mobile', M]]) {
  const { ctx, p } = await ctxFor(vp, acct);
  await p.goto(`http://localhost:4173/w/${id}`, { waitUntil: 'domcontentloaded' }); await loaded(p).catch(e => console.log('load timeout', id));
  if (acct && !(await p.textContent('.wbtn').catch(() => '')).includes('0x')) { await p.click('.wbtn').catch(() => {}); await p.click('.wopt[data-uuid="mock-1"]').catch(() => {}); await p.waitForTimeout(800); }
  if (vn === 'desktop') { out[id] = await summary(p); console.log(`#${id}`, JSON.stringify(out[id])); console.log('  ui:', (await p.textContent('.fwown')).replace(/\s+/g, ' ').trim()); }
  await shot(p, `screens/foot-wallet/wallet-${id}-${tag}-${vn}.png`);
  await ctx.close();
}
// 2) Owner quotes (no signing): local send on Base (#3004), remote send Base -> Ethereum, lock; mirror (#259 on ApeChain) remote 2-hop + reportArrival
const { ctx, p } = await ctxFor(D, ADMIN);
for (const id of [3004, 259]) {
  await p.goto(`http://localhost:4173/w/${id}`, { waitUntil: 'domcontentloaded' }); await loaded(p);
  if (!(await p.textContent('.wbtn').catch(() => '')).includes('0x')) { await p.click('.wbtn').catch(() => {}); await p.click('.wopt[data-uuid="mock-1"]').catch(() => {}); await p.waitForTimeout(800); }
  const free = await p.evaluate(() => window.__fw.S.cs.find(c => c.live && !/^0x0+$/.test(c.live))?.k);
  const targets = id === 3004 ? ['base', 'ethereum', 'apechain'] : ['apechain', 'base', 'bnb'];
  for (const T of targets) {
    const r = await p.evaluate(async T => { const fw = window.__fw; const a = { key: T + '|n', k: T, kind: 'native', label: 'native', bal: 10n ** 16n, decimals: 18 }; const to = fw.resolveRecipient('LIL FOOT #1204');
      try { const pl = await fw.plan(a, fw.callFor(a, to.address, 10n ** 15n)); return { route: pl.route, from: pl.from, steps: pl.steps.map(s => ({ label: s.label, chain: s.k, fee: s.fee == null ? null : (Number(s.fee) / 1e18).toFixed(8) })), notes: pl.notes }; } catch (e) { return { err: String(e.shortMessage || e.message).slice(0, 300) }; } }, T);
    console.log(`#${id} (free on ${free}) send native on ${T}:`, JSON.stringify(r));
  }
}
console.log('resolve:', await p.evaluate(() => ['LIL FOOT #3958', 'foot3958.multisea', 'foot3004', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'lil foot 99999', 'bob'].map(s => [s, window.__fw.resolveRecipient(s)?.address || null])));
// Send modal screenshot (#259, resolving a foot name), then lock modal (#3004)
await p.goto('http://localhost:4173/w/3004', { waitUntil: 'domcontentloaded' }); await loaded(p);
await p.evaluate(() => { const S = window.__fw.S; const c = S.cs.find(c => c.k === 'ethereum'); c.bal = { ...c.bal, native: 0n }; }); // keep real (empty) balances
await p.evaluate(() => window.__fw.openSend());
await p.fill('[data-k="to"]', 'LIL FOOT #3958'); await p.waitForTimeout(1200);
await shot(p, 'screens/foot-wallet/send-modal-empty-wallet-desktop.png', false);
await p.evaluate(() => document.querySelector('.wov')?.remove());
await p.evaluate(() => window.__fw.openLock(false)); await p.waitForFunction(() => !/Quoting/.test(document.querySelector('.wov [data-k=sum]')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
console.log('lock modal:', (await p.textContent('.wov [data-k=sum]')).replace(/\s+/g, ' '));
await shot(p, 'screens/foot-wallet/lock-modal-desktop.png', false);
await p.evaluate(() => document.querySelector('.wov')?.remove());
// Send modal with a real LayerZero quote (Base -> Ethereum). The wallet is empty on mainnet, so a 0.01 ETH Ethereum balance is
// injected into the page state for this screenshot only (quote, route and fees are live).
for (const [vn, vp] of [['desktop', D], ['mobile', M]]) {
  await p.setViewportSize({ width: vp.w, height: vp.h });
  await p.evaluate(() => { const c = window.__fw.S.cs.find(c => c.k === 'ethereum'); c.bal = { ...c.bal, native: 10n ** 16n }; window.__fw.openSend('ethereum|n'); });
  await p.fill('[data-k="amt"]', '0.001'); await p.fill('[data-k="to"]', 'foot1204.multisea');
  await p.waitForFunction(() => /You pay/.test(document.querySelector('.wov [data-k=sum]')?.textContent || '') || /Couldn/.test(document.querySelector('.wov [data-k=sum]')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
  console.log(vn, 'send quote:', (await p.textContent('.wov [data-k=sum]')).replace(/\s+/g, ' ').slice(0, 400));
  await shot(p, `screens/foot-wallet/send-modal-quote-base-to-ethereum-${vn}.png`, false);
  await p.evaluate(() => document.querySelector('.wov')?.remove());
}
console.log('wallet calls (must be empty):', await p.evaluate(() => window.__sent.join(',')));
await ctx.close();
// 3) Item page Wallet button + badge on the LIL FOOTS collection
for (const [vn, vp] of [['desktop', D], ['mobile', M]]) {
  const { ctx, p } = await ctxFor(vp, null);
  await p.goto('http://localhost:4173/c/lil-foots?item=3004', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.fwmrow', { timeout: 60000 }); await p.waitForFunction(() => !/…/.test(document.querySelector('.fwmval')?.textContent || '…'), null, { timeout: 60000 }).catch(() => {});
  console.log(vn, 'item modal badge:', await p.textContent('.fwmval'));
  await shot(p, `screens/foot-wallet/item-page-wallet-button-${vn}.png`, false);
  await ctx.close();
}
await b.close();
