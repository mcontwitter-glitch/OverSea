import { chromium } from 'playwright';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
const acct = privateKeyToAccount(generatePrivateKey()); // throwaway
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await p.exposeFunction('__sign', hex => acct.signMessage({ message: { raw: hex } }));
await p.addInitScript(addr => { const provider = { request: async ({ method, params }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr]; if (method === 'eth_chainId') return '0x1'; if (method === 'personal_sign') return window.__sign(params[0]); throw new Error('mock ' + method); }, on() {} };
  const info = { uuid: 'mock', name: 'Test Wallet', icon: '', rdns: 'test' }; const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })); window.addEventListener('eip6963:requestProvider', ann); ann(); }, acct.address);
await p.goto('https://multisea.io/submit', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
console.log('submit:', await p.evaluate(() => ({ soon: !!document.querySelector('.soon'), disabled: document.querySelector('fieldset').disabled, uploads: document.body.innerText.includes('Image uploads coming soon') })));
await p.screenshot({ path: 'screens/live-submit.png' });
await p.goto('https://multisea.io/admin', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
await p.click('.wbtn'); await p.click('.wopt[data-uuid=mock]'); await p.waitForTimeout(500);
await p.click('[data-act=signin]'); await p.waitForTimeout(4000);
console.log('admin after live SIWE (throwaway, non-admin):', (await p.textContent('.page')).replace(/\s+/g, ' ').slice(0, 160));
await p.screenshot({ path: 'screens/live-admin.png' }); await b.close();
