// Headless UI test of /deploy-solana against the local validator: a test keypair stands in for Phantom (window.phantom.solana
// mock; signatures made in Node). Deploys the program through the page (2 approvals), sets it up (1 "Approve all"),
// and checks the EVM chain rows (read-only from mainnet RPCs) and that "Turn Solana on" stays disabled. Screenshots to /workspace/shots.
// Needs: the validator from solprog-local.sh (endpoint initialised) and a dev server:
//   VITE_SOLANA_RPC=http://127.0.0.1:8899 VITE_SOLANA_MSGLIB=6GsmxMTHAAiFKfemuM4zBjumTjNSX5CAiw4xSSXM2Toy npx vite --port 5199
import { chromium } from 'playwright';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
const BASE = process.argv[2] || 'http://127.0.0.1:5199';
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const kp = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL));
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const calls = { sign: 0, signAll: 0 };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.exposeFunction('__signMsg', (b64, all) => { calls[all ? 'signAll' : 'sign'] += all ? 0 : 1; return Buffer.from(ed25519.sign(Buffer.from(b64, 'base64'), kp.secretKey.slice(0, 32))).toString('base64'); });
await page.exposeFunction('__countAll', () => { calls.signAll++; });
await page.addInitScript(pk => {
  const sig = async (tx, all) => { const m = tx.serializeMessage(); const s = await window.__signMsg(btoa(String.fromCharCode(...m)), all);
    const pub = tx.signatures.find(x => x.publicKey.toBase58() === pk).publicKey; tx.addSignature(pub, Uint8Array.from(atob(s), c => c.charCodeAt(0)));
    // like Phantom mobile: hand back a re-built transaction (no lastValidBlockHeight)
    return all ? tx : tx.constructor.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); };
  window.phantom = { solana: { isPhantom: true, publicKey: null,
    async connect() { this.publicKey = { toBase58: () => pk }; return { publicKey: this.publicKey }; },
    signTransaction: tx => sig(tx, false),
    async signAllTransactions(txs) { await window.__countAll(); for (const t of txs) await sig(t, true); return txs; } } };
}, kp.publicKey.toBase58());
await page.goto(BASE + '/deploy-solana'); await page.waitForSelector('.sdstep');
await page.waitForFunction(() => document.querySelectorAll('.sdch .sdbar i').length === 5 && !document.querySelector('.sdch .spin'), null, { timeout: 120_000 });
await page.screenshot({ path: '/workspace/shots/sol-ui-local-start.png', fullPage: true });
const txt = async () => page.evaluate(() => document.querySelector('.sdp').innerText);
let t = await txt();
ok(/Turn on Solana/.test(t) && (await page.locator('.sdstep').count()) === 5, '5 steps rendered');
ok(/SOL needed/.test(t) && /stays locked/.test(t), 'deploy cost from live rent figures shown');
ok((await page.locator('[data-act="on"]').isDisabled()), '"Turn Solana on" disabled');
ok(/Next: Start the 48-hour safety wait/.test(t) && /in gas left/.test(t), 'chain rows: next step + live-gas estimate (mainnet read-only)');
await page.click('[data-act="solw:phantom"]'); await page.waitForFunction(() => /Connected/.test(document.querySelector('.sdstep').innerText));
await page.click('[data-act="deploy"]');
await page.waitForFunction(() => /Uploaded \d+ of/.test(document.querySelector('.sdp').innerText), null, { timeout: 60_000 });
await page.screenshot({ path: '/workspace/shots/sol-ui-local-uploading.png', fullPage: true });
// mid-upload tab reload (phone suspends / closes the in-app browser): the page must pick up the half-written upload account
await page.waitForFunction(() => +((document.querySelector('.sdp').innerText.match(/Uploaded (\d+) of/) || [])[1] || 0) >= 20, null, { timeout: 120_000 });
await page.reload(); await page.waitForSelector('.sdstep');
await page.click('[data-act="solw:phantom"]'); await page.waitForFunction(() => /Connected/.test(document.querySelector('.sdstep').innerText));
await page.waitForFunction(() => /Continue deploy/.test(document.querySelector('[data-act="deploy"]')?.innerText || ''), null, { timeout: 60_000 });
t = await txt(); const m = t.match(/Uploaded (\d+) of (\d+)/);
ok(!!m && +m[1] >= 20 && +m[1] < +m[2], `after a reload mid-upload: "Continue deploy", ${m?.[0]}`); ok(calls.sign === 1, `only approval 1 so far (${calls.sign})`);
await page.click('[data-act="deploy"]');
await page.waitForFunction(() => /✓ Deployed/.test(document.querySelector('.sdp').innerText) || /class="err"/.test(document.querySelector('.sdmsg')?.innerHTML || ''), null, { timeout: 300_000 });
t = await txt(); ok(/✓ Deployed/.test(t), 'program deployed through the page'); ok(calls.sign === 2, `exactly 2 wallet approvals for the deploy, reload included (${calls.sign})`);
await page.waitForFunction(() => !document.querySelector('[data-act="setup"]')?.disabled, null, { timeout: 60_000 });
await page.click('[data-act="setup"]');
await page.waitForFunction(() => /settings saved/.test(document.querySelector('.sdp').innerText) || /class="err"/.test(document.querySelector('.sdmsg')?.innerHTML || ''), null, { timeout: 180_000 });
t = await txt(); ok(/settings saved · 5 of 5 chains linked/.test(t), 'program set up through the page'); ok(calls.signAll === 1, `one "Approve all" for the setup (${calls.signAll})`);
await page.waitForFunction(() => !document.querySelector('.sdch .spin'), null, { timeout: 120_000 });
t = await txt(); ok(!/Deploy the Solana program first/.test(t), 'after the deploy, Solana-linked EVM steps unblock');
ok((await page.locator('[data-act="on"]').isDisabled()) && /Waiting for: Base/.test(t), '"Turn Solana on" still disabled while chains are pending');
await page.screenshot({ path: '/workspace/shots/sol-ui-local-setup.png', fullPage: true });
// reload: everything detected from chain + this browser
await page.reload(); await page.waitForFunction(() => /settings saved/.test(document.querySelector('.sdp')?.innerText || ''), null, { timeout: 60_000 });
ok(true, 'reload picks up deployed + set-up state from the chain');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); await browser.close(); process.exit(fails ? 1 : 0);
