// Unit tests: MultiSea Ordinals PSBT construction (src/btc/psbtcore.js). Signet/testnet keys only, no real funds, no network.
// Run: node scripts/test-btc-psbt.mjs
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import { makeBtc, inscriptionTradable, SIGHASH_SINGLE_ACP } from '../src/btc/psbtcore.js';
const B = makeBtc(bitcoin, ecc); const ECPair = ECPairFactory(ecc); const N = bitcoin.networks.testnet; const NET = 'signet';
let pass = 0, fail = 0; const t = (name, f) => { try { f(); pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} expected ${b}, got ${a}`); };
const throws = (f, re) => { try { f(); } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return; } throw new Error('did not throw'); };
const key = n => ECPair.fromPrivateKey(Buffer.alloc(32, n), { network: N });
const xo = k => Buffer.from(k.publicKey.subarray(1, 33));
const tweaked = k => k.tweak(bitcoin.crypto.taggedHash('TapTweak', xo(k)));
const p2tr = k => bitcoin.payments.p2tr({ internalPubkey: xo(k), network: N }).address;
const p2wpkh = k => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(k.publicKey), network: N }).address;
const p2shw = k => bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(k.publicKey), network: N }), network: N }).address;
const txid = n => Buffer.alloc(32, n).toString('hex');
const seller = key(1), sellerPay = key(2), buyerOrd = key(3), buyerPay = key(4), feeK = key(5);
const FEE_ADDR = p2wpkh(feeK);
const ins = { txid: txid(0xaa), vout: 0, value: 546, address: p2tr(seller), pubkey: Buffer.from(seller.publicKey).toString('hex'), offset: 0 };
const PRICE = 150_000;
function signedListing(price = PRICE) {
  const b64 = B.createListing({ network: NET, ins, priceSats: price, sellerPayAddress: p2wpkh(sellerPay) });
  const p = bitcoin.Psbt.fromBase64(b64, { network: N }); p.signInput(0, tweaked(seller), [SIGHASH_SINGLE_ACP]); return p.toBase64();
}
t('signet addresses are tb1', () => { eq(p2tr(seller).slice(0, 4), 'tb1p'); eq(B.addrType(p2tr(seller), NET), 'p2tr'); eq(B.addrType(p2shw(buyerPay), NET), 'p2sh'); });
t('listing: 1-in/1-out, SIGHASH_SINGLE|ANYONECANPAY, valid seller sig', () => {
  const v = B.validateListing(signedListing(), NET, { txid: ins.txid, vout: 0, value: 546, address: ins.address, priceSats: PRICE, sellerPayAddress: p2wpkh(sellerPay) });
  if (!v.ok) throw new Error(v.errs.join(';'));
});
t('listing: unsigned listing rejected', () => { const b = B.createListing({ network: NET, ins, priceSats: PRICE, sellerPayAddress: p2wpkh(sellerPay) }); eq(B.validateListing(b, NET, {}).ok, false); });
t('listing: SIGHASH_ALL signature rejected', () => { const p = bitcoin.Psbt.fromBase64(B.createListing({ network: NET, ins, priceSats: PRICE, sellerPayAddress: p2wpkh(sellerPay) }), { network: N });
  delete p.data.inputs[0].sighashType; p.signInput(0, tweaked(seller)); const v = B.validateListing(p.toBase64(), NET, {}); eq(v.ok, false); if (!v.errs.some(e => /SINGLE/.test(e))) throw new Error(v.errs.join(';')); });
t('listing: tampered price breaks the signature', () => { const p = bitcoin.Psbt.fromBase64(signedListing(), { network: N }); p.data.globalMap.unsignedTx.tx.outs[0].value = 1000; const v = B.validateListing(p.toBase64(), NET, {}); eq(v.ok, false); });
t('listing: input must match the indexer UTXO', () => { const v = B.validateListing(signedListing(), NET, { txid: txid(0xbb), vout: 0 }); eq(v.ok, false); });
t('listing: inscription not at offset 0 is refused', () => { throws(() => B.createListing({ network: NET, ins: { ...ins, offset: 330 }, priceSats: PRICE, sellerPayAddress: p2wpkh(sellerPay) }), /offset 0/); });
t('satpoint check', () => { eq(inscriptionTradable({ satpoint: txid(1) + ':0:0' }).ok, true); eq(inscriptionTradable({ satpoint: txid(1) + ':0:12' }).ok, false); eq(inscriptionTradable({}).ok, false); });
t('listing: price below dust refused', () => { throws(() => B.createListing({ network: NET, ins, priceSats: 100, sellerPayAddress: p2wpkh(sellerPay) }), /price/); });

const dummies = [{ txid: txid(0x11), vout: 0, value: 600 }, { txid: txid(0x12), vout: 1, value: 600 }];
const pays = [{ txid: txid(0x21), vout: 0, value: 120_000 }, { txid: txid(0x22), vout: 2, value: 90_000 }, { txid: txid(0x23), vout: 0, value: 5_000 }];
function buyFlow(payKey, payAddr, opts = {}) {
  const buyer = { ordAddress: p2tr(buyerOrd), payAddress: payAddr, payPubkey: Buffer.from(payKey.publicKey).toString('hex') };
  const r = B.buildPurchase({ network: NET, listingPsbt: signedListing(), buyer, dummies, payUtxos: pays, feeRate: 12, feeAddress: FEE_ADDR, feeBps: 50, ...opts });
  const p = bitcoin.Psbt.fromBase64(r.psbt, { network: N }); const signer = B.addrType(payAddr, NET) === 'p2tr' ? tweaked(payKey) : payKey;
  for (const i of r.signIndexes) p.signInput(i, signer);
  const f = B.finalizePurchase(p.toBase64(), NET, { ordAddress: buyer.ordAddress, sellerPayout: p2wpkh(sellerPay), priceSats: PRICE });
  return { r, f, tx: bitcoin.Transaction.fromHex(f.hex), buyer };
}
function checkBuy(name, payKey, payAddr) {
  t(`buy (${name} payment): layout, fee output, offset 0, seller sig valid at index 2`, () => {
    const { r, f, tx, buyer } = buyFlow(payKey, payAddr); const o = tx.outs;
    const addr = i => bitcoin.address.fromOutputScript(o[i].script, N);
    eq(addr(0), payAddr, 'out0'); eq(o[0].value, 1200, 'padding'); eq(addr(1), buyer.ordAddress, 'out1'); eq(o[1].value, 546, 'ins value');
    eq(addr(2), p2wpkh(sellerPay), 'seller'); eq(o[2].value, PRICE); eq(o[3].value, 600); eq(o[4].value, 600);
    eq(addr(5), FEE_ADDR, 'fee addr'); eq(o[5].value, 750, '0.5% fee'); eq(r.breakdown.marketFee, 750);
    // inscription offset: sats before output 1 == sats of inputs before input 2 -> inscription is sat 0 of output 1
    eq(o[0].value, dummies[0].value + dummies[1].value);
    const ins_ = tx.ins.map((_, i) => i); const prev = bitcoin.Psbt.fromBase64(r.psbt, { network: N }).data.inputs.map(x => x.witnessUtxo);
    const h = tx.hashForWitnessV1(2, prev.map(x => x.script), prev.map(x => x.value), SIGHASH_SINGLE_ACP);
    const w = tx.ins[2].witness[0]; eq(w.length, 65); eq(w[64], SIGHASH_SINGLE_ACP);
    if (!ecc.verifySchnorr(h, bitcoin.payments.p2tr({ internalPubkey: xo(seller), network: N }).pubkey, w.subarray(0, 64))) throw new Error('seller sig invalid in final tx');
    const inSum = prev.reduce((a, x) => a + x.value, 0), outSum = o.reduce((a, x) => a + x.value, 0);
    eq(inSum - outSum, r.breakdown.networkFee, 'fee'); const rate = r.breakdown.networkFee / f.vsize; if (rate < 11.5 || rate > 14) throw new Error('fee rate off: ' + rate.toFixed(2));
    void ins_;
  });
}
checkBuy('p2wpkh', buyerPay, p2wpkh(buyerPay));
checkBuy('p2sh-p2wpkh (Xverse-style)', buyerPay, p2shw(buyerPay));
checkBuy('p2tr (UniSat single address)', buyerPay, p2tr(buyerPay));
t('buy: no BTC fee address configured -> refused (never sends to a made-up address)', () => { throws(() => buyFlow(buyerPay, p2wpkh(buyerPay), { feeAddress: '' }), /fee address/); });
t('buy: quote-only fee preview works without a fee address and builds no PSBT', () => {
  const buyer = { ordAddress: p2tr(buyerOrd), payAddress: p2wpkh(buyerPay), payPubkey: Buffer.from(buyerPay.publicKey).toString('hex') };
  const q = B.buildPurchase({ network: NET, listingPsbt: signedListing(), buyer, dummies, payUtxos: pays, feeRate: 12, feeAddress: '', feeBps: 50, quoteOnly: true });
  eq(q.psbt, null); eq(q.breakdown.marketFee, 750); if (!(q.breakdown.networkFee > 0)) throw new Error('no fee');
});
t('buy: needs 2 dummy UTXOs', () => { throws(() => buyFlow(buyerPay, p2wpkh(buyerPay), { dummies: dummies.slice(0, 1) }), /dummy/); });
t('buy: dummy > 1000 sats refused', () => { throws(() => buyFlow(buyerPay, p2wpkh(buyerPay), { dummies: [dummies[0], { ...dummies[1], value: 5000 }] }), /546-1000/); });
t('buy: insufficient funds', () => { throws(() => buyFlow(buyerPay, p2wpkh(buyerPay), { payUtxos: [pays[2]] }), /insufficient/); });
t('buy: tampering output 1 (inscription receiver) is caught', () => {
  const buyer = { ordAddress: p2tr(buyerOrd), payAddress: p2wpkh(buyerPay), payPubkey: Buffer.from(buyerPay.publicKey).toString('hex') };
  const r = B.buildPurchase({ network: NET, listingPsbt: signedListing(), buyer, dummies, payUtxos: pays, feeRate: 5, feeAddress: FEE_ADDR, feeBps: 50 });
  throws(() => B.finalizePurchase(r.psbt, NET, { ordAddress: p2tr(key(9)) }), /output 1/);
});
t('fee: 0.5% with dust floor', () => { eq(B.marketFee(150000, 50), 750); eq(B.marketFee(20000, 50), 546); eq(B.marketFee(1e8, 50), 500000); eq(B.marketFee(1000, 0), 0); });
t('padding tx: 2x600 + change, finalizes', () => {
  const r = B.buildPadding({ network: NET, payAddress: p2wpkh(buyerPay), payPubkey: Buffer.from(buyerPay.publicKey).toString('hex'), payUtxos: pays, feeRate: 3 });
  const p = bitcoin.Psbt.fromBase64(r.psbt, { network: N }); r.signIndexes.forEach(i => p.signInput(i, buyerPay)); p.finalizeAllInputs(); const tx = p.extractTransaction(); eq(tx.outs[0].value, 600); eq(tx.outs[1].value, 600);
});
t('cancel tx: inscription back to own taproot address at offset 0', () => {
  const r = B.buildCancel({ network: NET, ins, ordPubkey: ins.pubkey, payAddress: p2wpkh(sellerPay), payPubkey: Buffer.from(sellerPay.publicKey).toString('hex'), payUtxos: [{ txid: txid(0x31), vout: 0, value: 20000 }], feeRate: 4 });
  const p = bitcoin.Psbt.fromBase64(r.psbt, { network: N }); p.signInput(0, tweaked(seller)); p.signInput(1, sellerPay); p.finalizeAllInputs(); const tx = p.extractTransaction();
  eq(bitcoin.address.fromOutputScript(tx.outs[0].script, N), ins.address); eq(tx.outs[0].value, 546);
});
// BIP-322 official vectors (p2wpkh, key L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k)
const V_ADDR = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
t('BIP-322 vector: "" (p2wpkh)', () => eq(B.verifyBip322({ network: 'mainnet', address: V_ADDR, message: '', signature: 'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=' }), true));
t('BIP-322 vector: "Hello World" (p2wpkh)', () => eq(B.verifyBip322({ network: 'mainnet', address: V_ADDR, message: 'Hello World', signature: 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=' }), true));
t('BIP-322 vector: wrong message fails', () => eq(B.verifyBip322({ network: 'mainnet', address: V_ADDR, message: 'Hello World!', signature: 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=' }), false));
t('BIP-322 vector: taproot "Hello World"', () => eq(B.verifyBip322({ network: 'mainnet', address: 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3', message: 'Hello World', signature: 'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==' }), true));
t('BIP-322 signet taproot round trip', () => {
  const spk = B.spkOf(p2tr(buyerOrd), NET); const tx = B.bip322ToSign(spk, 'Sign in to MultiSea'); const h = tx.hashForWitnessV1(0, [spk], [0], bitcoin.Transaction.SIGHASH_DEFAULT);
  const sig = Buffer.from(tweaked(buyerOrd).signSchnorr(h)); const wit = Buffer.concat([Buffer.from([1, 64]), sig]).toString('base64');
  eq(B.verifyBip322({ network: NET, address: p2tr(buyerOrd), message: 'Sign in to MultiSea', signature: wit }), true);
  eq(B.verifyBip322({ network: NET, address: p2tr(buyerOrd), message: 'Sign in to EvilSea', signature: wit }), false);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
