// Local UI test with a mock EIP-6963 wallet backed by a THROWAWAY key (signs SIWE in Node). Never sends transactions.
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
const U = 'http://localhost:4174';
const keys = JSON.parse(fs.readFileSync('/tmp/multisea-test-keys.json', 'utf8'));
const b = await chromium.launch();
async function page(key, vp = { width: 390, height: 844 }) {
  const acct = privateKeyToAccount(key);
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2 });
  p.on('pageerror', e => console.log('pageerror', e.message));
  await p.exposeFunction('__sign', hex => acct.signMessage({ message: { raw: hex } }));
  await p.addInitScript(addr => {
    let chainId = 1;
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'eth_chainId') return '0x' + chainId.toString(16);
      if (method === 'wallet_switchEthereumChain') { chainId = parseInt(params[0].chainId, 16); return null; }
      if (method === 'personal_sign') return window.__sign(params[0]);
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected'), { code: 4001 });
      throw new Error('mock: ' + method);
    }, on() {} };
    const info = { uuid: 'mock', name: 'Test Wallet', icon: '', rdns: 'test' };
    const ann = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', ann); ann();
  }, acct.address);
  return p;
}
const connect = async p => { await p.click('.wbtn'); await p.click('.wopt[data-uuid=mock]'); await p.waitForTimeout(500); };
// 1) submit as user
let p = await page(keys.user);
await p.goto(U + '/submit', { waitUntil: 'networkidle' }); await connect(p);
const slug = 'ui-test-' + Date.now().toString(36);
await p.fill('[name=name]', 'UI Test Twins'); await p.fill('[name=slug]', slug); await p.fill('textarea[name=description]', 'Submitted through the UI test with a throwaway wallet.');
await p.fill('[name=website]', 'https://example.com');
await p.setInputFiles('input[data-f=logo]', 'public/brand/logo-256.png'); await p.waitForSelector('.msg:has-text("logo uploaded")', { timeout: 20000 });
await p.selectOption('select[data-row="0"]', 'base'); await p.fill('input[data-row="0"]', '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e'); await p.press('input[data-row="0"]', 'Tab');
await p.waitForSelector('#chk0:has-text("ERC-721")', { timeout: 20000 });
await p.screenshot({ path: 'screens/submit-local-form.png', fullPage: true });
await p.click('[data-act=submit]'); await p.waitForSelector('.okbox', { timeout: 30000 });
console.log('submit:', await p.textContent('.okbox')); await p.screenshot({ path: 'screens/submit-local-done.png' }); await p.close();
// 2) admin approves
p = await page(keys.admin);
await p.goto(U + '/admin', { waitUntil: 'networkidle' }); await connect(p); await p.click('[data-act=signin]');
await p.waitForSelector(`[data-approve="${slug}"]`, { timeout: 20000 }); await p.screenshot({ path: 'screens/admin-local.png' });
await p.click(`[data-approve="${slug}"]`); await p.waitForTimeout(1500); console.log('admin queue after approve:', (await p.textContent('.page')).includes(slug) ? 'still there' : 'cleared');
// 3) admin = LIL FOOTS editor (throwaway key set as STATIC_EDITORS in local wrangler dev) edits LIL FOOTS
await p.goto(U + '/c/lil-foots', { waitUntil: 'networkidle' }); await p.waitForSelector('[data-act=edit]', { timeout: 20000 });
await p.click('[data-act=edit]'); await p.fill('textarea[name=description]', 'LIL FOOTS: the children of BIGFOOT404, living on six chains. (Edited locally by the editor wallet.)');
await p.fill('input[name=x]', 'https://x.com/bigfoot404'); await p.setInputFiles('.wbox input[data-f=banner]', 'brand/banner-src.png'); await p.waitForSelector('.msg:has-text("banner uploaded")', { timeout: 20000 });
await p.screenshot({ path: 'screens/edit-local.png' });
await p.click('.save'); await p.waitForTimeout(1500); console.log('lil-foots desc now:', (await p.textContent('.desc')).slice(0, 60));
await p.screenshot({ path: 'screens/edit-local-saved.png' }); await p.close();
// 4) home shows community collection; dyn page renders
p = await page(keys.user, { width: 1280, height: 900 });
await p.goto(U + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500); console.log('home cards:', await p.$$eval('.ccard .ccname', e => e.map(x => x.textContent)));
await p.screenshot({ path: 'screens/home-local.png' });
await p.goto(U + '/c/' + slug, { waitUntil: 'networkidle' }); await p.waitForTimeout(3000); console.log('dyn page items:', await p.$$eval('.card', e => e.length));
await p.screenshot({ path: 'screens/dyn-local.png' });
await b.close();
