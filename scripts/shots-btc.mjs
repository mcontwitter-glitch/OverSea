// Screenshots for the Bitcoin / Ordinals preview (desktop 1440 + mobile 390) -> /workspace/launchpad/preview-btc/
// Needs `npm run build && npx vite preview --port 4319`. The BTC wallet is a MOCK: window.XverseProviders.BitcoinProvider
// is injected and signs in Node with throwaway signet/testnet keys (sha256-free fill 0x61 / 0x62). No real funds, nothing broadcast.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import { makeBtc } from '../src/btc/psbtcore.js';
bitcoin.initEccLib(ecc);
const B = makeBtc(bitcoin, ecc); const EC = ECPairFactory(ecc); const N = bitcoin.networks.testnet;
const ordK = EC.fromPrivateKey(Buffer.alloc(32, 0x61), { network: N }), payK = EC.fromPrivateKey(Buffer.alloc(32, 0x62), { network: N });
const xo = k => Buffer.from(k.publicKey.subarray(1, 33)); const tw = k => k.tweak(bitcoin.crypto.taggedHash('TapTweak', xo(k)));
const ORD = bitcoin.payments.p2tr({ internalPubkey: xo(ordK), network: N }).address;
const PAY = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(payK.publicKey), network: N }), network: N }).address;
const BASE = process.env.BASE || 'http://localhost:4319', OUT = '/workspace/launchpad/preview-btc'; mkdirSync(OUT, { recursive: true });
const HELD_ID = '411db620602ff29313c34cb77b8c9ee71cb9cef1f4f0420ed1f231445898ab9ei0';
const LISTED_ID = '02be9befaf2c023b82b2bbb16b99a5091950b0f9d60a291234f2e79ac3fdbfcfi0';

async function wallet(method, params) {
  if (method === 'getAccounts') return { result: [{ purpose: 'ordinals', address: ORD, publicKey: xo(ordK).toString('hex'), addressType: 'p2tr' }, { purpose: 'payment', address: PAY, publicKey: Buffer.from(payK.publicKey).toString('hex'), addressType: 'p2sh' }] };
  if (method === 'signMessage') { const spk = B.spkOf(ORD, 'signet'); const tx = B.bip322ToSign(spk, params.message); const h = tx.hashForWitnessV1(0, [spk], [0], bitcoin.Transaction.SIGHASH_DEFAULT);
    return { result: { signature: Buffer.concat([Buffer.from([1, 64]), Buffer.from(tw(ordK).signSchnorr(h))]).toString('base64') } }; }
  if (method === 'signPsbt') { const p = bitcoin.Psbt.fromBase64(params.psbt, { network: N });
    for (const [addr, idx] of Object.entries(params.signInputs)) for (const i of idx) { const k = addr === ORD ? tw(ordK) : payK; const sh = p.data.inputs[i].sighashType; p.signInput(i, k, sh ? [sh] : undefined); }
    return { result: { psbt: p.toBase64() } }; }
  return { error: { message: 'unsupported ' + method } };
}
const sizes = [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]];
const br = await chromium.launch();
for (const [tag, vp] of sizes) {
  const ctx = await br.newContext({ viewport: vp, deviceScaleFactor: tag === 'mobile' ? 2 : 1 });
  await ctx.exposeFunction('__mockBtc', async (m, p) => wallet(m, JSON.parse(p || 'null')));
  await ctx.addInitScript(() => { window.XverseProviders = { BitcoinProvider: { request: (m, p) => window.__mockBtc(m, JSON.stringify(p ?? null)) } }; });
  const pg = await ctx.newPage(); pg.on('pageerror', e => console.log(tag, 'pageerror', e.message));
  const shot = async (name, full = false) => { await pg.waitForTimeout(600); await pg.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: full }); console.log('saved', name, tag); };
  const idle = () => pg.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  // 1. home chain filter with Bitcoin selected (live mainnet Ordinals data)
  await pg.goto(BASE + '/?chain=bitcoin'); await idle(); await pg.waitForSelector('.btcc', { timeout: 25000 }).catch(() => {});
  await pg.locator('.hchips').scrollIntoViewIfNeeded(); await pg.evaluate(() => window.scrollBy(0, -90)); await shot('01-chain-filter-bitcoin');
  // 2. BTC wallet connect (mock Xverse detected), then connect + BIP-322 sign-in, then account modal
  await pg.goto(BASE + '/btc?demo=1&connect=1'); await idle(); await pg.waitForSelector('.btcconn'); await shot('02-btc-wallet-connect');
  await pg.click('.btcconn [data-w="xverse"]'); await pg.waitForSelector('.btcconn .bkv, .btcconn p.ok', { timeout: 15000 }).catch(() => {}); await shot('02b-btc-wallet-connected');
  await pg.keyboard.press('Escape'); await pg.goto(BASE + '/btc'); await idle();
  // 3. collection page
  await pg.goto(BASE + '/btc/c/nodemonkes'); await idle(); await pg.waitForSelector('.btci', { timeout: 30000 }).catch(() => {}); await shot('03-ordinals-collection');
  // 4. inscription detail with Buy
  await pg.goto(BASE + '/btc/i/' + LISTED_ID); await idle(); await pg.waitForSelector('[data-act="buy"]', { timeout: 20000 }).catch(() => {}); await shot('04-inscription-detail-buy');
  // 6. buy confirm with fee breakdown
  await pg.click('[data-act="buy"]'); await pg.waitForSelector('.bkv.fees', { timeout: 20000 }).catch(() => {}); await shot('06-buy-confirm-fees');
  await pg.keyboard.press('Escape');
  // 5. list for sale (held demo inscription): sign & list
  await pg.goto(BASE + '/btc/i/' + HELD_ID); await idle(); await pg.waitForSelector('[data-act="list"]', { timeout: 20000 }).catch(() => {});
  await pg.click('[data-act="list"]'); await pg.waitForSelector('.btcflow'); await shot('05a-list-for-sale');
  await pg.click('.btcflow [data-go]'); await pg.waitForSelector('.btcflow .ok, .btcflow .err', { timeout: 20000 }).catch(() => {}); await shot('05b-list-for-sale-signed');
  // 7. profile holdings
  await pg.goto(BASE + '/btc/me'); await idle(); await pg.waitForSelector('.btci', { timeout: 20000 }).catch(() => {}); await shot('07-profile-holdings');
  // 8. create form with Bitcoin Ordinals drop type + review
  const draft = { step: 2, mode: 'ordinals', name: 'Signet Monkes', symbol: 'SMONK', slug: 'signet-monkes', description: 'Pixel monkes inscribed on Bitcoin.', total: '1000', ordPrice: '25', ordLimit: '50', chains: { base: '' } };
  await pg.goto(BASE + '/launchpad'); await pg.evaluate(d => sessionStorage.setItem('multisea-lp-draft', JSON.stringify(d)), draft);
  await pg.goto(BASE + '/launchpad/create'); await idle(); await pg.waitForSelector('.ldord', { timeout: 15000 }).catch(() => {}); await pg.locator('.ldmode').scrollIntoViewIfNeeded(); await shot('08a-create-bitcoin-ordinals');
  await pg.evaluate(d => sessionStorage.setItem('multisea-lp-draft', JSON.stringify({ ...JSON.parse(sessionStorage.getItem('multisea-lp-draft')), step: 5 })), draft);
  await pg.reload(); await idle(); await shot('08b-create-review-ordinals');
  await ctx.close();
}
await br.close();
