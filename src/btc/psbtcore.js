// MultiSea Bitcoin Ordinals marketplace: PSBT construction (non-custodial). Plain JS so the browser, the Worker and the
// Node unit tests (scripts/test-btc-psbt.mjs) share ONE implementation. bitcoinjs-lib v6 + an ecc lib are injected.
//
// Listing (seller): 1 input (the inscription UTXO) + 1 output (seller payout = price), signed SIGHASH_SINGLE|ANYONECANPAY.
//   The signature commits only to that input and the output at the same index, and (BIP143 / BIP341 with ANYONECANPAY)
//   not to the input index, so the buyer can place the pair at index 2 of the purchase tx.
// Purchase (buyer) layout, sats flow first-in-first-out:
//   in : [0] dummy A  [1] dummy B  [2] seller inscription UTXO (signed)  [3..] buyer payment UTXOs
//   out: [0] padding = A + B -> buyer payment address   (consumes exactly the dummy sats)
//        [1] inscription UTXO value -> buyer ordinals (taproot) address   (inscription lands at offset 0)
//        [2] price -> seller payout   (matches seller input 2: SIGHASH_SINGLE)
//        [3] [4] new dummies (600 sats) -> buyer payment address, so the next purchase needs no padding tx
//        [5] marketplace fee -> MultiSea BTC fee address
//        [6] change -> buyer payment address (dropped into the fee when below dust)
// Safety: the inscription must sit at offset 0 of the seller UTXO, and the UTXO must match the indexer's current location.
export const SIGHASH_SINGLE_ACP = 0x83;
export const DUST = 546;
export const DUMMY = 600;
export const DUMMY_MAX = 1000;
const VB_IN = { p2tr: 57.5, p2wpkh: 68, p2sh: 91, p2pkh: 148 };
const VB_OUT = { p2tr: 43, p2wpkh: 31, p2sh: 32, p2pkh: 34, p2wsh: 43, unknown: 43 };
const hex = b => Buffer.from(b).toString('hex');

export function makeBtc(bitcoin, ecc) {
  bitcoin.initEccLib(ecc);
  const { Psbt, Transaction, payments, address: A, crypto, script: S, opcodes: O } = bitcoin;
  const net = n => (n === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet); // signet uses tb1 (testnet params)

  function scriptType(spk) {
    const s = Buffer.from(spk);
    if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return 'p2tr';
    if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return 'p2wpkh';
    if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return 'p2wsh';
    if (s.length === 23 && s[0] === 0xa9 && s[22] === 0x87) return 'p2sh';
    if (s.length === 25 && s[0] === 0x76) return 'p2pkh';
    return 'unknown';
  }
  const spkOf = (addr, n) => A.toOutputScript(addr, net(n));
  const addrType = (addr, n) => scriptType(spkOf(addr, n));
  const isAddr = (addr, n) => { try { spkOf(addr, n); return true; } catch { return false; } };
  const xonly = pk => { const b = Buffer.from(pk, 'hex'); return b.length === 33 ? b.subarray(1) : b; };
  const vsize = (ins, outs) => Math.ceil(10.5 + ins.reduce((a, t) => a + (VB_IN[t] ?? 68), 0) + outs.reduce((a, t) => a + (VB_OUT[t] ?? 43), 0));
  // Never more than bps of the price (floor). If that is below the dust limit the fee output is dropped: no fee on that sale.
  const marketFee = (price, bps) => { if (bps <= 0 || price <= 0) return 0; const f = Math.floor((price * bps) / 10000); return f >= DUST ? f : 0; };
  const feeWaived = (price, bps) => bps > 0 && price > 0 && marketFee(price, bps) === 0;
  // Checks the marketplace fee output of a purchase PSBT/tx against the policy: exactly marketFee() at output 5 to feeAddress,
  // or no output to feeAddress at all when the fee is waived (below dust).
  function checkPurchaseFee(b64, network, { feeAddress, feeBps }) {
    const p = Psbt.fromBase64(b64, { network: net(network) }); const o = p.txOutputs; const price = o[2]?.value;
    if (!(price > 0)) return { ok: false, err: 'missing seller output' };
    const want = marketFee(price, feeBps); const toFee = feeAddress ? o.map((x, i) => [x, i]).filter(([x]) => x.address === feeAddress) : [];
    if (!want) return toFee.length ? { ok: false, err: 'fee is waived below dust: purchase must not include a fee output' } : { ok: true, price, fee: 0, waived: true };
    if (!feeAddress) return { ok: false, err: 'BTC fee address not configured' };
    if (toFee.length !== 1 || toFee[0][1] !== 5 || toFee[0][0].value !== want) return { ok: false, err: `fee output must be ${want} sats at output 5` };
    return { ok: true, price, fee: want, waived: false };
  }

  // u = { txid, vout, value, address, pubkey? (hex; needed for p2tr internal key and p2sh-p2wpkh redeem script) }
  function inputOf(u, n) {
    const script = spkOf(u.address, n); const t = scriptType(script);
    const i = { hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value }, sequence: 0xffffffff };
    if (t === 'p2tr') { if (!u.pubkey) throw new Error('taproot input needs the public key'); i.tapInternalKey = xonly(u.pubkey);
      const p = payments.p2tr({ internalPubkey: i.tapInternalKey, network: net(n) }); if (!p.output.equals(script)) throw new Error('taproot key does not match ' + u.address); }
    else if (t === 'p2sh') { if (!u.pubkey) throw new Error('p2sh-p2wpkh input needs the public key');
      const r = payments.p2wpkh({ pubkey: Buffer.from(u.pubkey, 'hex'), network: net(n) }); const p = payments.p2sh({ redeem: r, network: net(n) });
      if (!p.output.equals(script)) throw new Error('p2sh key does not match ' + u.address); i.redeemScript = r.output; }
    else if (t !== 'p2wpkh') throw new Error('unsupported input type ' + t);
    return i;
  }
  const inType = u => (scriptType(u._spk) === 'p2sh' ? 'p2sh' : scriptType(u._spk));

  // ---- listing ----
  function createListing({ network, ins, priceSats, sellerPayAddress }) {
    if (!(Number.isInteger(priceSats) && priceSats >= DUST)) throw new Error(`price must be at least ${DUST} sats`);
    if (!isAddr(sellerPayAddress, network)) throw new Error('bad seller payout address');
    if (ins.offset !== 0) throw new Error('inscription is not at offset 0 of its UTXO: refuse to list (it could be lost as fee/padding)');
    const p = new Psbt({ network: net(network) }); p.setVersion(2); p.setLocktime(0);
    p.addInput({ ...inputOf(ins, network), sighashType: SIGHASH_SINGLE_ACP });
    p.addOutput({ address: sellerPayAddress, value: priceSats });
    return p.toBase64();
  }
  const sigOk = (pubkey, msghash, signature) => (pubkey.length === 32 ? ecc.verifySchnorr(msghash, pubkey, signature) : ecc.verify(msghash, pubkey, signature));
  // Checks a signed listing PSBT against what the indexer says (expect: { txid, vout, value, address, priceSats, sellerPayAddress }).
  function validateListing(b64, network, expect) {
    const p = Psbt.fromBase64(b64, { network: net(network) }); const errs = [];
    if (p.inputCount !== 1 || p.txOutputs.length !== 1) errs.push('listing must be 1 input + 1 output');
    const ti = p.txInputs[0], ii = p.data.inputs[0], o = p.txOutputs[0];
    if (!ti || !ii || !o) return { ok: false, errs };
    const txid = hex(Buffer.from(ti.hash).reverse());
    if (expect.txid && (txid !== expect.txid || ti.index !== expect.vout)) errs.push('input is not the inscription UTXO from the indexer');
    if (expect.value != null && ii.witnessUtxo?.value !== expect.value) errs.push('UTXO value mismatch');
    if (expect.address && !ii.witnessUtxo?.script.equals(spkOf(expect.address, network))) errs.push('UTXO script is not the owner address');
    if (expect.priceSats != null && o.value !== expect.priceSats) errs.push('payout output != listed price');
    if (expect.sellerPayAddress && o.address !== expect.sellerPayAddress) errs.push('payout address mismatch');
    const sh = ii.tapKeySig ? (ii.tapKeySig.length === 65 ? ii.tapKeySig[64] : 0) : ii.partialSig?.[0] ? ii.partialSig[0].signature[ii.partialSig[0].signature.length - 1] : ii.sighashType;
    if (sh !== SIGHASH_SINGLE_ACP) errs.push('signature must be SIGHASH_SINGLE|ANYONECANPAY');
    if (!ii.tapKeySig && !ii.partialSig?.length && !ii.finalScriptWitness) errs.push('listing is not signed');
    else if (!ii.finalScriptWitness) { try { if (!p.validateSignaturesOfInput(0, sigOk)) errs.push('bad seller signature'); } catch (e) { errs.push('bad seller signature: ' + e.message); } }
    return { ok: !errs.length, errs, txid, vout: ti.index, value: ii.witnessUtxo?.value, priceSats: o.value, payout: o.address };
  }

  // ---- purchase ----
  // buyer = { ordAddress, payAddress, payPubkey }, dummies = 2 UTXOs (546..1000 sats, no inscriptions), payUtxos = spendable
  function buildPurchase({ network, listingPsbt, buyer, dummies, payUtxos, feeRate, feeAddress, feeBps, quoteOnly }) {
    if (!quoteOnly && !feeAddress && marketFee(Psbt.fromBase64(listingPsbt, { network: net(network) }).txOutputs[0]?.value || 0, feeBps) > 0) throw new Error('BTC fee address not configured (config/btc.json feeAddress): buying is disabled');
    if (!(dummies?.length >= 2)) throw new Error('need 2 padding (dummy) UTXOs: run "Prepare wallet" first');
    const L = Psbt.fromBase64(listingPsbt, { network: net(network) });
    const v = validateListing(listingPsbt, network, {}); if (!v.ok) throw new Error('invalid listing: ' + v.errs.join('; '));
    const price = L.txOutputs[0].value, insVal = L.data.inputs[0].witnessUtxo.value; const sellerSpk = L.data.inputs[0].witnessUtxo.script;
    const pay = { ...buyer, address: buyer.payAddress, pubkey: buyer.payPubkey };
    const payT = addrType(buyer.payAddress, network), ordT = addrType(buyer.ordAddress, network);
    const mfee = marketFee(price, feeBps);
    const fixedOuts = [payT, ordT, scriptType(L.txOutputs[0].script), payT, payT, ...(mfee ? [feeAddress ? scriptType(spkOf(feeAddress, network)) : 'p2wpkh'] : [])];
    const d = dummies.slice(0, 2); const dSum = d[0].value + d[1].value;
    if (d.some(x => x.value > DUMMY_MAX || x.value < DUST)) throw new Error('dummy UTXOs must be 546-1000 sats');
    const pool = [...payUtxos].filter(u => !d.some(x => x.txid === u.txid && x.vout === u.vout)).sort((a, b) => b.value - a.value);
    const need0 = price + 2 * DUMMY + mfee; // buyer side, besides network fee (padding and inscription value pass through)
    const chosen = []; let sum = 0, fee = 0, change = 0;
    for (const u of pool) {
      chosen.push(u); sum += u.value;
      const ins = [payT, payT, scriptType(sellerSpk), ...chosen.map(() => payT)];
      fee = Math.ceil(vsize(ins, [...fixedOuts, payT]) * feeRate); change = sum - need0 - fee;
      if (change >= 0) { if (change < DUST) { fee = Math.ceil(vsize(ins, fixedOuts) * feeRate); fee += change; change = 0; } break; }
    }
    if (change < 0 || sum < need0 + fee) throw new Error(`insufficient funds: need ${need0 + fee} sats from the payment address`);
    const nOut = fixedOuts.length + (change ? 1 : 0), nIn = 3 + chosen.length;
    const bd = { price, marketFee: mfee, feeWaived: feeWaived(price, feeBps), feeBps, networkFee: fee, feeRate, newDummies: 2 * DUMMY, total: price + mfee + fee + 2 * DUMMY, totalSpent: price + mfee + fee, change, inscriptionValue: insVal, inputs: nIn, outputs: nOut };
    if (quoteOnly) return { psbt: null, signIndexes: [], breakdown: bd, quote: true }; // fee preview without a fee address (Buy stays disabled)
    const p = new Psbt({ network: net(network) }); p.setVersion(2); p.setLocktime(0);
    p.addInput(inputOf({ ...d[0], ...pay, txid: d[0].txid, vout: d[0].vout, value: d[0].value }, network));
    p.addInput(inputOf({ ...d[1], ...pay, txid: d[1].txid, vout: d[1].vout, value: d[1].value }, network));
    const si = L.data.inputs[0]; const sti = L.txInputs[0];
    p.addInput({ hash: sti.hash, index: sti.index, sequence: sti.sequence, witnessUtxo: si.witnessUtxo, sighashType: SIGHASH_SINGLE_ACP, ...(si.tapInternalKey ? { tapInternalKey: si.tapInternalKey } : {}), ...(si.redeemScript ? { redeemScript: si.redeemScript } : {}) });
    p.updateInput(2, { ...(si.tapKeySig ? { tapKeySig: si.tapKeySig } : {}), ...(si.partialSig ? { partialSig: si.partialSig } : {}), ...(si.finalScriptWitness ? { finalScriptWitness: si.finalScriptWitness } : {}), ...(si.finalScriptSig ? { finalScriptSig: si.finalScriptSig } : {}) });
    for (const u of chosen) p.addInput(inputOf({ ...u, ...pay, txid: u.txid, vout: u.vout, value: u.value }, network));
    p.addOutput({ address: buyer.payAddress, value: dSum });
    p.addOutput({ address: buyer.ordAddress, value: insVal });
    p.addOutput({ script: L.txOutputs[0].script, value: price });
    p.addOutput({ address: buyer.payAddress, value: DUMMY }); p.addOutput({ address: buyer.payAddress, value: DUMMY });
    if (mfee) p.addOutput({ address: feeAddress, value: mfee });
    if (change) p.addOutput({ address: buyer.payAddress, value: change });
    const signIndexes = [0, 1, ...chosen.map((_, i) => 3 + i)];
    return { psbt: p.toBase64(), signIndexes, breakdown: bd };
  }
  // After the buyer signs: re-check the layout, finalize every input and return the raw tx hex to broadcast.
  function finalizePurchase(b64, network, { ordAddress, sellerPayout, priceSats }) {
    const p = Psbt.fromBase64(b64, { network: net(network) });
    const o = p.txOutputs; if (o[1]?.address !== ordAddress) throw new Error('output 1 must pay the buyer ordinals address');
    if (priceSats != null && o[2]?.value !== priceSats) throw new Error('seller output changed');
    if (sellerPayout && o[2]?.address !== sellerPayout) throw new Error('seller payout changed');
    const pre = p.data.inputs[0].witnessUtxo.value + p.data.inputs[1].witnessUtxo.value; if (o[0].value !== pre) throw new Error('padding output must equal the 2 dummies (offset 0)');
    for (let i = 0; i < p.inputCount; i++) if (!p.data.inputs[i].finalScriptWitness) p.finalizeInput(i);
    const tx = p.extractTransaction(true); return { hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize() };
  }
  // Two 600-sat padding outputs for a buyer that has none (one-time).
  function buildPadding({ network, payAddress, payPubkey, payUtxos, feeRate }) {
    const t = addrType(payAddress, network); const pool = [...payUtxos].sort((a, b) => b.value - a.value); const ch = []; let sum = 0, fee = 0;
    for (const u of pool) { ch.push(u); sum += u.value; fee = Math.ceil(vsize(ch.map(() => t), [t, t, t]) * feeRate); if (sum >= 2 * DUMMY + fee + DUST) break; }
    if (sum < 2 * DUMMY + fee + DUST) throw new Error('insufficient funds for padding UTXOs');
    const p = new Psbt({ network: net(network) }); p.setVersion(2);
    ch.forEach(u => p.addInput(inputOf({ ...u, address: payAddress, pubkey: payPubkey }, network)));
    p.addOutput({ address: payAddress, value: DUMMY }); p.addOutput({ address: payAddress, value: DUMMY }); p.addOutput({ address: payAddress, value: sum - 2 * DUMMY - fee });
    return { psbt: p.toBase64(), signIndexes: ch.map((_, i) => i), fee };
  }
  // Cancel on-chain: move the inscription UTXO back to the seller's own ordinals address (offset stays 0), fee from the payment address.
  // This is the only cancel that kills an already-shared signed listing; removing it from MultiSea only hides it.
  function buildCancel({ network, ins, ordPubkey, payAddress, payPubkey, payUtxos, feeRate }) {
    const ordT = addrType(ins.address, network), payT = addrType(payAddress, network); const pool = [...payUtxos].sort((a, b) => b.value - a.value); const ch = []; let sum = 0, fee = 0;
    for (const u of pool) { ch.push(u); sum += u.value; fee = Math.ceil(vsize([ordT, ...ch.map(() => payT)], [ordT, payT]) * feeRate); if (sum >= fee + DUST) break; }
    if (sum < fee + DUST) throw new Error('insufficient funds for the cancel fee');
    const p = new Psbt({ network: net(network) }); p.setVersion(2);
    p.addInput(inputOf({ ...ins, pubkey: ordPubkey }, network)); ch.forEach(u => p.addInput(inputOf({ ...u, address: payAddress, pubkey: payPubkey }, network)));
    p.addOutput({ address: ins.address, value: ins.value }); p.addOutput({ address: payAddress, value: sum - fee });
    return { psbt: p.toBase64(), signIndexes: [0, ...ch.map((_, i) => 1 + i)], fee };
  }

  // ---- BIP-322 (simple) ----
  const tagged = (tag, msg) => { const t = crypto.sha256(Buffer.from(tag)); return crypto.sha256(Buffer.concat([t, t, Buffer.from(msg)])); };
  const bip322Hash = m => tagged('BIP0322-signed-message', m);
  function bip322ToSpend(spk, message) {
    const tx = new Transaction(); tx.version = 0; tx.locktime = 0;
    tx.addInput(Buffer.alloc(32), 0xffffffff, 0, S.compile([O.OP_0, bip322Hash(message)])); tx.addOutput(spk, 0); return tx;
  }
  function bip322ToSign(spk, message) {
    const ts = bip322ToSpend(spk, message); const tx = new Transaction(); tx.version = 0; tx.locktime = 0;
    tx.addInput(ts.getHash(), 0, 0); tx.addOutput(S.compile([O.OP_RETURN]), 0); return tx;
  }
  const readWitness = b => { let o = 0; const vi = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } throw new Error('witness too large'); };
    const n = vi(); const out = []; for (let i = 0; i < n; i++) { const l = vi(); out.push(b.subarray(o, o + l)); o += l; } return out; };
  function verifyBip322({ address, message, signature, network }) {
    try {
      const spk = spkOf(address, network); const t = scriptType(spk); const w = readWitness(Buffer.from(signature, 'base64')); const tx = bip322ToSign(spk, message);
      if (t === 'p2wpkh') { const [sig, pub] = w; if (!sig || !pub || !crypto.hash160(pub).equals(spk.subarray(2))) return false;
        const h = tx.hashForWitnessV0(0, payments.p2pkh({ hash: spk.subarray(2) }).output, 0, sig[sig.length - 1]);
        return ecc.verify(h, pub, S.signature.decode(sig).signature); }
      if (t === 'p2tr') { const [sig] = w; if (!sig || (sig.length !== 64 && sig.length !== 65)) return false;
        const ht = sig.length === 65 ? sig[64] : Transaction.SIGHASH_DEFAULT; const h = tx.hashForWitnessV1(0, [spk], [0], ht);
        return ecc.verifySchnorr(h, spk.subarray(2), sig.subarray(0, 64)); }
      return false; // p2sh-p2wpkh / legacy: not accepted for sign-in (use the taproot or native segwit address)
    } catch { return false; }
  }
  return { net, scriptType, addrType, isAddr, spkOf, vsize, marketFee, feeWaived, checkPurchaseFee, inputOf, createListing, validateListing, buildPurchase, finalizePurchase, buildPadding, buildCancel, bip322ToSign, bip322ToSpend, verifyBip322, Psbt, bitcoin };
}
// Inscription location check: satpoint "txid:vout:offset" from the indexer.
export function parseSatpoint(sp) { const m = /^([0-9a-f]{64}):(\d+):(\d+)$/.exec(sp || ''); return m ? { txid: m[1], vout: +m[2], offset: +m[3] } : null; }
export function inscriptionTradable(ins) {
  const s = parseSatpoint(ins?.satpoint); if (!s) return { ok: false, why: 'no satpoint from the indexer' };
  if (s.offset !== 0) return { ok: false, why: `inscription sits at offset ${s.offset} of its UTXO (must be 0)` };
  return { ok: true, ...s };
}
