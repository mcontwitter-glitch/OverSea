// Mock-wallet UI test: connect via EIP-6963, open Buy confirm on a real listing (never sends a tx).
import { chromium } from 'playwright';
const U = process.argv[2] || 'http://localhost:4174/';
const ACCT = '0xd77d9836072FCF35990D0A6a34cE3c2Cd66520D8'; // a real LIL FOOTS holder (read-only; the mock never signs)
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
p.on('console', m => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
await p.addInitScript(acct => {
  let chainId = 1; const sent = [];
  const provider = { request: async ({ method, params }) => {
    window.__calls = (window.__calls || []).concat(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
    if (method === 'eth_chainId') return '0x' + chainId.toString(16);
    if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; }
    if (method === 'wallet_addEthereumChain') return null;
    if (method === 'eth_sendTransaction') { sent.push(params); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
    throw new Error('mock: unsupported ' + method);
  }, on() {} };
  const info = { uuid: 'mock-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%23f6851b%22/%3E%3C/svg%3E', rdns: 'test.mock' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
}, ACCT);
await p.goto(U, { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
await p.screenshot({ path: 'screens/buy-1-grid.png' });
await p.click('.wbtn'); await p.waitForTimeout(600);
await p.screenshot({ path: 'screens/buy-2-connect.png' });
await p.click('.wopt[data-uuid="mock-1"]'); await p.waitForTimeout(800);
console.log('wallet label:', await p.textContent('.wbtn'));
await p.screenshot({ path: 'screens/buy-3-connected.png' });
await p.click('.fbtn'); await p.click('input[value=mine]'); await p.waitForTimeout(300);
await p.click('[data-act=close-side]'); await p.waitForTimeout(1500);
console.log('my items:', await p.textContent('.count'));
await p.screenshot({ path: 'screens/buy-3b-myitems.png' });
await p.click('.fbtn'); await p.click('input[value=all]'); await p.click('[data-act=close-side]'); await p.waitForTimeout(800);
const card = await p.$('.card'); console.log('first card:', (await card.textContent()).replace(/\s+/g, ' '));
await p.click('.card [data-buy]');
await p.waitForSelector('.bbtn.go, .err', { timeout: 30000 });
console.log('confirm:', (await p.textContent('.wbox')).replace(/\s+/g, ' ').slice(0, 400));
await p.screenshot({ path: 'screens/buy-4-confirm.png' });
const go = await p.$('.bbtn.go:not([disabled])');
if (go) { await go.click(); await p.waitForSelector('.err', { timeout: 15000 }); console.log('after confirm (mock rejects):', await p.textContent('.err')); await p.screenshot({ path: 'screens/buy-5-rejected.png' }); }
console.log('wallet calls:', [...new Set(await p.evaluate(() => window.__calls))].join(','));
await b.close();
