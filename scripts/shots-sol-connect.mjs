// Solana wallet connect + profile link, locally against `wrangler dev --local` (local KV, nothing live).
// Fake wallets: an EIP-6963 EVM wallet, Phantom (window.phantom.solana) and a Wallet Standard "Backpack". Their keys are
// generated here in memory for this run only and never printed; the page asks Node to sign via exposeFunction.
// BASE=http://localhost:4331 OUT=/workspace/shots node scripts/shots-sol-connect.mjs
import { chromium, devices } from 'playwright';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const BASE = process.env.BASE || 'http://localhost:4331', OUT = process.env.OUT || '/workspace/shots';
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = u => { let n = 0n; for (const x of u) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of u) { if (x) break; s = '1' + s; } return s; };
const evm = privateKeyToAccount(generatePrivateKey());
const mk = async () => { const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); return { k, addr: b58(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))) }; };
const ph = await mk(), bp = await mk();
const res = {}; const fail = []; const check = (n, v) => { res[n] = v; if (!v) fail.push(n); };

const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['iPhone 13'] });
await ctx.exposeFunction('__evmSign', hex => evm.signMessage({ message: { raw: hex } }));
await ctx.exposeFunction('__solSign', async (who, arr) => [...new Uint8Array(await crypto.subtle.sign('Ed25519', (who === 'bp' ? bp : ph).k.privateKey, Uint8Array.from(arr)))]);
await ctx.addInitScript(([evmAddr, phAddr, bpAddr]) => {
  const evmProv = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evmAddr];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'personal_sign') return window.__evmSign(params[0]);
    throw new Error('unsupported ' + method); }, on() {} };
  const info = { uuid: 'test-evm', name: 'Test EVM Wallet', icon: '', rdns: 'test.evm' };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: evmProv }) })));
  const pk = a => ({ toBase58: () => a });
  window.phantom = { solana: { isPhantom: true, publicKey: null,
    async connect(o) { if (o?.onlyIfTrusted && !localStorage.getItem('fake-ph-trusted')) throw new Error('not trusted'); localStorage.setItem('fake-ph-trusted', '1'); this.publicKey = pk(phAddr); return { publicKey: this.publicKey }; },
    async disconnect() { this.publicKey = null; localStorage.removeItem('fake-ph-trusted'); },
    async signTransaction() { throw new Error('test wallet: no transactions'); },
    async signMessage(m) { return { signature: Uint8Array.from(await window.__solSign('ph', [...m])) }; } } };
  const acct = { address: bpAddr, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signMessage'] };
  const bpw = { version: '1.0.0', name: 'Backpack', icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#e33e3f"/><text x="14" y="19.5" font-family="Arial" font-weight="900" font-size="15" fill="#fff" text-anchor="middle">B</text></svg>'),
    chains: ['solana:mainnet'], accounts: [],
    features: { 'standard:connect': { version: '1.0.0', connect: async () => { bpw.accounts = [acct]; return { accounts: [acct] }; } }, 'standard:disconnect': { version: '1.0.0', disconnect: async () => { bpw.accounts = []; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: Uint8Array.from(await window.__solSign('bp', [...message])) }] } } };
  const reg = api => api.register(bpw);
  window.addEventListener('wallet-standard:app-ready', e => reg(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: reg }));
}, [evm.address, ph.addr, bp.addr]);
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const shot = async n => p.screenshot({ path: `${OUT}/sol-connect-live-${n}.png` });

// 1. Connect window: EVM part as before + Solana section
await p.goto(BASE + '/'); await p.click('[data-act="wallet"]'); await p.waitForSelector('.wov .solsec');
const evmPart = await p.$eval('.wov .wbox', el => { const c = el.cloneNode(true); c.querySelector('.solsec')?.remove(); return c.innerText.replace(/\s+/g, ' ').trim(); });
check('evmSectionUnchanged', evmPart.includes('New to crypto? Sign in') && evmPart.includes('Sign in with X') && evmPart.includes('Sign in with Google') && evmPart.includes('Creates a free embedded wallet for you') && evmPart.includes('Or connect a wallet') && evmPart.includes('Test EVM Wallet') && evmPart.includes('MetaMask app') && evmPart.includes('Coinbase Wallet app'));
const solOpts = await p.$$eval('.wov [data-solw]', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ').trim()));
check('solanaOptions', solOpts.some(t => /Phantom.*Detected/.test(t)) && solOpts.some(t => /Solflare.*Open app/.test(t)) && solOpts.some(t => /Backpack.*Detected/.test(t)));
check('privyHiddenWithoutConfig', !(await p.$('.wov [data-solsoc]')));
await p.$eval('.wov .solnote', el => el.scrollIntoView({ block: 'end' })); await shot('connect');
// EVM connect works as before
await p.click('.wov [data-uuid="test-evm"]'); await p.waitForFunction(a => document.querySelector('[data-act="wallet"]')?.textContent?.includes(a.slice(0, 6)), evm.address);
check('evmConnect', true);
// 2. Phantom + wallet menu with both
await p.click('[data-act="wallet"]'); await p.waitForSelector('.wov [data-solm="add"]'); check('menuOffersSolana', true);
await p.click('.wov [data-solm="add"]'); await p.waitForSelector('.wov [data-solw="phantom"]'); await p.click('.wov [data-solw="phantom"]');
await p.waitForSelector('[data-act="solwallet"]:not([hidden])'); check('solNavButton', true);
await p.click('[data-act="wallet"]'); await p.waitForSelector('.wov .solacct'); await p.waitForTimeout(2500);
const menu = await p.$eval('.wov .wbox', el => el.innerText);
check('menuBothAddresses', menu.includes(evm.address) && menu.includes(ph.addr) && /Disconnect Solana/.test(menu) && /\bDisconnect\b/.test(menu));
await shot('wallet-menu');
// 3. Profile: add Solana wallet (Phantom signs the worker message, EVM confirms), worker verifies + stores
await p.goto(`${BASE}/u/${evm.address.toLowerCase()}#add-solana`); await p.waitForSelector('.solcard [data-uwsol="go"]', { timeout: 30000 });
await p.$eval('.solcard', el => el.scrollIntoView({ block: 'center' })); await shot('add-solana');
await p.click('.solcard [data-uwsol="go"]');
await p.waitForSelector('.uwsol a.chipw.sol', { timeout: 30000 }).then(() => check('linked', true), () => check('linked', false));
const api = await (await fetch(`http://localhost:8787/profile/${evm.address}/solana`)).json(); check('workerStored', api.sol === ph.addr);
await p.$eval('.uwsol', el => el.scrollIntoView({ block: 'center' })); await shot('linked');
// 4. Profile grid with the Solana chain button (fixture: one Base Island's from the API mock + one Solana Island's in the session cache)
await p.route('**/wallet/*/nfts*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ nfts: [{ chain: 'base', contract: '0x5a54e10a40320d6285bdfa323e44b7abecfe87ef', id: '7', name: "Island's #7", image: null, standard: 'erc721' }], cursors: {}, failed: [], unsupported: [] }) }));
await p.evaluate(a => sessionStorage.setItem('msea-solnfts:' + a, JSON.stringify({ t: Date.now(), v: { nfts: [12, 47].map(id => ({ chain: 'solana', contract: 'x' + id, id: String(id), name: "Island's #" + id, image: `/img/multi-islands/s/${id}.webp`, standard: 'mpl-core', collection: 'multi-islands', msSlug: 'multi-islands', href: `/c/multi-islands?item=${id}` })), note: '' } })), ph.addr);
await p.goto(`${BASE}/u/${evm.address.toLowerCase()}`); await p.waitForSelector('[data-nft-chain="solana"]', { timeout: 30000 }).then(() => check('solanaChip', true), () => check('solanaChip', false));
await p.click('[data-nft-chain="solana"]').catch(() => {}); await p.waitForTimeout(1500);
const cards = await p.$$eval('.fwnftg .nftc', cs => cs.map(c => c.innerText.replace(/\s+/g, ' ')));
check('solanaFilter', cards.length === 2 && cards.every(t => /Solana/.test(t)));
await p.$eval('[data-nft-chain="solana"]', el => el.scrollIntoView({ block: 'center', inline: 'center' })); await p.evaluate(() => window.scrollBy(0, 120)); await shot('profile-grid');
// 5. Separate disconnects: Solana off, EVM stays
await p.click('[data-act="solwallet"]'); await p.waitForSelector('.wov [data-solm="out"]'); await p.click('.wov [data-solm="out"]');
await p.waitForSelector('[data-act="solwallet"][hidden]', { state: 'attached' }); check('solDisconnectKeepsEvm', await p.$eval('[data-act="wallet"]', el => el.textContent.includes('0x')));
// 6. Wallet Standard wallet connects too
await p.click('[data-act="wallet"]'); await p.click('.wov [data-solm="add"]'); await p.click('.wov [data-solw="std:Backpack"]');
await p.waitForSelector('[data-act="solwallet"]:not([hidden])'); check('walletStandardConnect', true);
// 7. Unlink with the EVM signature
await p.goto(`${BASE}/u/${evm.address.toLowerCase()}`); await p.waitForSelector('[data-uwsol="unlink"]', { timeout: 20000 }).catch(async () => { console.log('DEBUG', await p.$eval('.uwsol', e => e.outerHTML).catch(() => 'no .uwsol'), await p.evaluate(() => [location.href, localStorage.getItem('multisea-wallet'), document.querySelector('[data-act=wallet]')?.textContent])); await shot('debug'); }); await p.click('[data-uwsol="unlink"]');
await p.waitForSelector('[data-uwsol="add"]', { timeout: 30000 }).then(() => check('unlink', true), () => check('unlink', false));
check('noPageErrors', errs.length === 0);
console.log(JSON.stringify({ res, errs }, null, 1)); await b.close(); console.log(fail.length ? 'FAIL ' + fail.join(',') : 'ALL PASS'); process.exit(fail.length ? 1 : 0);
