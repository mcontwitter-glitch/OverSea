// Staging UI screenshots with REAL testnet transactions. Serves nothing itself: run the staging build on :4300 first.
// The page gets an EIP-6963 test wallet whose requests are forwarded to Node; Node signs with the testnet deployer key
// (contracts/.secrets/deployer.key, never printed or sent to the page) and refuses any chain not in launchpad.testnet.json.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const U = process.env.U || 'http://localhost:4300'; const OUT = 'screens/launchpad/';
const T = JSON.parse(fs.readFileSync('config/launchpad.testnet.json', 'utf8'));
const acct = privateKeyToAccount(fs.readFileSync('contracts/.secrets/deployer.key', 'utf8').trim());
const byId = Object.fromEntries(Object.entries(T.chains).map(([k, c]) => [c.chainId, { k, ...c }]));
let cur = T.chains.baseSepolia.chainId; const txs = [];
const chainOf = c => defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
async function rpc(method, params) {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.address];
  if (method === 'eth_chainId') return '0x' + cur.toString(16);
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') { const id = parseInt(params[0].chainId, 16); if (!byId[id]) throw new Error('testnet wallet: chain not allowed'); cur = id; return null; }
  const c = byId[cur]; if (!c) throw new Error('testnet wallet: unknown chain');
  if (method === 'eth_sendTransaction') { const t = params[0]; const w = createWalletClient({ chain: chainOf(c), transport: http(c.rpc), account: acct });
    const pub = createPublicClient({ chain: chainOf(c), transport: http(c.rpc) }); const gas = await pub.estimateGas({ account: acct, to: t.to, data: t.data, value: BigInt(t.value || 0) });
    const h = await w.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || 0), gas: gas * 13n / 10n }); txs.push({ chain: c.k, hash: h }); console.log('  tx', c.k, `${c.explorer}/tx/${h}`); return h; }
  if (/^(eth_sign|personal_sign|eth_signTypedData)/.test(method)) throw new Error('testnet wallet: signing disabled in screenshots');
  const r = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) }).then(r => r.json());
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data }); return r.result;
}
const INJECT = () => { const listeners = {}; const provider = { isMultiSeaTest: true, request: async ({ method, params }) => { const r = await window.__tnRpc(method, params || []); if (r && r.__err) throw Object.assign(new Error(r.__err), { code: r.code }); if (method === 'wallet_switchEthereumChain') (listeners.chainChanged || []).forEach(f => f(params[0].chainId)); return r; }, on: (e, f) => ((listeners[e] ??= []).push(f)), removeListener: () => {} };
  const info = { uuid: 'multisea-testnet-wallet', name: 'Testnet wallet (staging)', icon: '', rdns: 'io.multisea.testnet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce(); };
const b = await chromium.launch(); const errs = [];
const VPS = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } };
const sv = async (p, sel) => { await p.evaluate(q => document.querySelector(q)?.scrollIntoView({ block: 'center', behavior: 'instant' }), sel); await p.waitForTimeout(300); };
const until = async (p, fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn).catch(() => false)) return true; await p.waitForTimeout(2000); } return false; };
for (const vp of (process.env.VPS || 'mobile,desktop').split(',')) {
  const ctx = await b.newContext({ viewport: VPS[vp], deviceScaleFactor: vp === 'mobile' ? 2 : 1 });
  await ctx.exposeFunction('__tnRpc', async (m, p) => { try { return await rpc(m, p); } catch (e) { return { __err: e.shortMessage || e.message, code: e.code }; } });
  await ctx.addInitScript(INJECT);
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(`${vp}: ${e.message}`)); p.on('console', m => { if (m.type() === 'error') errs.push(`${vp} console: ${m.text()}`); });
  cur = T.chains.baseSepolia.chainId;
  await p.goto(U + '/launchpad/testnet', { waitUntil: 'domcontentloaded' }); await until(p, () => !document.querySelector('.ldmintbox .spin'), 30000);
  await p.screenshot({ path: `${OUT}testnet-drop-${vp}.png` }); await sv(p, '.ldmintbox .ldkv'); await p.screenshot({ path: `${OUT}testnet-cost-line-base-${vp}.png` });
  await p.click('[data-act=mint]'); await p.waitForTimeout(600); await p.click('.wov [data-uuid="multisea-testnet-wallet"]'); await p.waitForTimeout(3000);
  await until(p, () => !!document.querySelector('.ldmintbox .ldkv') && !document.querySelector('.ldmintbox .spin'), 30000);
  await p.click('[data-act=mint]'); await p.waitForTimeout(1500); await sv(p, '.ldpend'); await p.screenshot({ path: `${OUT}testnet-mint-sent-base-${vp}.png` });
  await until(p, () => /Escrow copies queued/.test(document.querySelector('.ldpend')?.textContent || ''), 90000);
  await sv(p, '.ldpend'); await p.screenshot({ path: `${OUT}testnet-minted-queued-base-${vp}.png` }); await p.screenshot({ path: `${OUT}testnet-minted-full-${vp}.png`, fullPage: true });
  if (vp === 'desktop') {
    await p.click('[data-ch="sepolia"]'); await until(p, () => !document.querySelector('.ldmintbox .spin'), 30000); await sv(p, '.ldmintbox .ldkv'); await p.screenshot({ path: `${OUT}testnet-cost-line-sepolia-${vp}.png` });
    await p.click('[data-act=mint]'); await until(p, () => /confirming across chains/.test(document.querySelector('.ldpend')?.textContent || ''), 60000); await p.waitForTimeout(4000);
    await sv(p, '.ldpend'); await p.screenshot({ path: `${OUT}testnet-mint-pending-sepolia-${vp}.png` });
    const ok = await until(p, () => /✓ Minted/.test(document.querySelector('.ldpend')?.textContent || ''), 600000);
    await sv(p, '.ldpend'); await p.screenshot({ path: `${OUT}testnet-mint-confirmed-sepolia-${vp}.png` }); console.log('  sepolia confirm in UI:', ok);
  }
  await ctx.close();
}
fs.writeFileSync(OUT + 'testnet-ui-txs.json', JSON.stringify(txs, null, 1) + '\n');
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors'); await b.close();
