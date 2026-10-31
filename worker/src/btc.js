// Bitcoin / Ordinals routes (SOURCE ONLY in this preview: not deployed). Non-custodial: the Worker stores signed listing
// PSBTs (SIGHASH_SINGLE|ANYONECANPAY) after validating them, never keys or funds. Trading is signet-first; mainnet is
// refused unless config/btc.json mainnetTrading is true AND a fee address is set.
//   GET  /btc/<net>/listings?collection=&inscription=   active listings (stale ones are dropped lazily)
//   POST /btc/<net>/listings                            { inscriptionId, psbt, name?, collection? }
//   POST /btc/<net>/listings/<inscriptionId>/delete     { token, reason: 'cancel' | 'sold' | 'stale' }
//   POST /btc/auth/nonce  ->  { nonce, message }       POST /btc/auth/verify { address, message, signature, net } (BIP-322)
//   GET  /btc/ord/<net>/...                             read-only indexer proxy (mainnet: Ordinals Wallet; signet/testnet: ORD_*_URL)
// KV: COLLECTIONS (prefix btcl:<net>:), NONCES (btcn:, btcs:). Indexer keys, if one is ever needed, are Worker secrets (ORD_API_KEY).
import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { makeBtc, inscriptionTradable } from '../../src/btc/psbtcore.js';
import BTC from '../../config/btc.json';

globalThis.Buffer ??= Buffer; // psbtcore uses Buffer (nodejs_compat)
bitcoin.initEccLib(ecc);
const B = makeBtc(bitcoin, ecc);
const NETS = new Set(BTC.networks);
const ID = /^[0-9a-f]{64}i\d+$/;
const MAX_LISTINGS = 2000; // per network index size guard
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

export function makeBtcRoutes({ bad }) {
  const tradeOk = n => n !== 'mainnet' || BTC.mainnetTrading === true;
  const mempool = n => BTC.mempool[n];
  const ordBase = (env, n) => n === 'mainnet' ? 'https://ordinals.com' : n === 'signet' ? env.ORD_SIGNET_URL : env.ORD_TESTNET_URL;
  const getJ = async (u, h = {}) => { const r = await fetch(u, { headers: { accept: 'application/json', ...h } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
  async function inscription(env, n, id) { const b = ordBase(env, n); if (!b) bad(`no ${n} indexer configured (set ORD_${n.toUpperCase()}_URL)`, 503); return getJ(`${b}/r/inscription/${id}`); }
  const outspend = async (n, txid, vout) => getJ(`${mempool(n)}/tx/${txid}/outspend/${vout}`);
  const kIdx = n => `btcl:${n}:index`; const kL = (n, id) => `btcl:${n}:${id}`;
  const readIdx = async (env, n) => JSON.parse((await env.COLLECTIONS.get(kIdx(n))) || '[]');
  const writeIdx = (env, n, l) => env.COLLECTIONS.put(kIdx(n), JSON.stringify(l));

  async function session(env, token) { if (!/^[0-9a-f]{48}$/.test(token || '')) return null; const s = await env.NONCES.get('btcs:' + token); return s ? JSON.parse(s) : null; }

  async function handle(req, env, url, p, M, body) {
    if (p[0] !== 'btc') return undefined;
    // ---- BIP-322 sign-in ----
    if (p[1] === 'auth' && M === 'POST' && p[2] === 'nonce') { const nonce = rand(12); await env.NONCES.put('btcn:' + nonce, '1', { expirationTtl: 600 }); return { nonce, message: `Sign in to MultiSea\nNonce: ${nonce}` }; }
    if (p[1] === 'auth' && M === 'POST' && p[2] === 'verify') {
      const { address, message, signature, net } = await body(); const n = NETS.has(net) ? net : 'signet';
      if (typeof message !== 'string' || message.length > 500 || typeof signature !== 'string' || signature.length > 400 || !B.isAddr(address, n)) bad('invalid input');
      const nonce = /Nonce: ([0-9a-f]{24})/.exec(message)?.[1]; if (!nonce || !(await env.NONCES.get('btcn:' + nonce))) bad('nonce expired', 401);
      await env.NONCES.delete('btcn:' + nonce);
      if (!B.verifyBip322({ address, message, signature, network: n })) bad('bad signature', 401);
      const token = rand(24); await env.NONCES.put('btcs:' + token, JSON.stringify({ address, net: n }), { expirationTtl: 86400 }); return { token, address };
    }
    // ---- indexer proxy (GET only, cached) ----
    if (p[1] === 'ord' && M === 'GET') {
      const n = p[2]; if (!NETS.has(n)) bad('unknown network');
      const rest = p.slice(3).map(encodeURIComponent).join('/');
      if (n === 'mainnet' && p[3] === 'collection' && p[5] === 'inscriptions') { // Ordinals Wallet returns the whole list; page it here
        const off = Math.max(0, +url.searchParams.get('offset') || 0), lim = Math.min(200, Math.max(1, +url.searchParams.get('limit') || 100));
        const ck = `btco:${p[4]}`; let all = await env.COLLECTIONS.get(ck, 'json');
        if (!all) { all = (await getJ(`${BTC.indexer.mainnet}/collection/${encodeURIComponent(p[4])}/inscriptions`)).map(x => ({ id: x.id, num: x.num, name: x.meta?.name })); await env.COLLECTIONS.put(ck, JSON.stringify(all), { expirationTtl: 3600 }); }
        return { total: all.length, items: all.slice(off, off + lim) };
      }
      if (n === 'mainnet') return getJ(`${BTC.indexer.mainnet}/${rest}`, env.ORD_API_KEY ? { 'x-api-key': env.ORD_API_KEY } : {});
      const b = ordBase(env, n); if (!b) bad(`no ${n} indexer configured`, 503);
      if (p[3] === 'wallet') { const a = p[4]; if (!B.isAddr(a, n)) bad('bad address'); const j = await getJ(`${b}/address/${a}`); const items = await Promise.all((j.inscriptions || []).slice(0, 100).map(async id => { const r = await getJ(`${b}/r/inscription/${id}`).catch(() => null); return r && { id, num: r.number, contentType: r.content_type, outpoint: r.satpoint?.split(':').slice(0, 2).join(':'), value: r.value }; })); return { balance: j.sat_balance ?? null, items: items.filter(Boolean) }; }
      return getJ(`${b}/${rest}`);
    }
    // ---- listings ----
    const n = p[1]; if (!NETS.has(n) || p[2] !== 'listings') return undefined;
    if (M === 'GET' && p.length === 3) {
      const col = url.searchParams.get('collection'), ins = url.searchParams.get('inscription');
      const idx = (await readIdx(env, n)).filter(l => (!col || l.collection === col) && (!ins || l.inscriptionId === ins)).slice(0, 200);
      const full = (await Promise.all(idx.map(l => env.COLLECTIONS.get(kL(n, l.inscriptionId), 'json')))).filter(Boolean);
      return { listings: full };
    }
    if (M === 'POST' && p.length === 3) {
      if (!tradeOk(n)) bad('mainnet trading is disabled', 403);
      const b = await body(); const id = b.inscriptionId;
      if (!ID.test(id || '') || typeof b.psbt !== 'string' || b.psbt.length > 20000) bad('invalid input');
      const ins = await inscription(env, n, id); const t = inscriptionTradable(ins); if (!t.ok) bad(t.why);
      const v = B.validateListing(b.psbt, n, { txid: t.txid, vout: t.vout }); if (!v.ok) bad('listing rejected: ' + v.errs.join('; '));
      const os = await outspend(n, v.txid, v.vout); if (os.spent) bad('that UTXO is already spent');
      const seller = ins.address; const idx = (await readIdx(env, n)).filter(l => l.inscriptionId !== id);
      if (idx.length >= MAX_LISTINGS) bad('listing book full', 503);
      const L = { inscriptionId: id, net: n, psbt: b.psbt, priceSats: v.priceSats, seller, payout: v.payout, txid: v.txid, vout: v.vout, value: v.value, fee: { bps: BTC.marketplaceFeeBps, sats: B.marketFee(v.priceSats, BTC.marketplaceFeeBps), waived: B.feeWaived(v.priceSats, BTC.marketplaceFeeBps) }, createdAt: Date.now(), name: String(b.name || '').slice(0, 80), collection: String(b.collection || '').slice(0, 60) };
      await env.COLLECTIONS.put(kL(n, id), JSON.stringify(L)); idx.push({ inscriptionId: id, collection: L.collection, priceSats: L.priceSats }); await writeIdx(env, n, idx);
      return { ok: true, listing: L };
    }
    // Fee policy check for a buyer's purchase PSBT: exactly 0.5% (floor) at output 5, or NO fee output when that is below dust.
    if (M === 'POST' && p.length === 5 && p[4] === 'purchase-check' && ID.test(p[3])) {
      if (!tradeOk(n)) bad('mainnet trading is disabled', 403);
      const { psbt } = await body(); if (typeof psbt !== 'string' || psbt.length > 40000) bad('invalid input');
      const L = await env.COLLECTIONS.get(kL(n, p[3]), 'json'); if (!L) bad('listing not found', 404);
      const fa = (BTC.feeAddress?.[n] || '').trim() || null; let r;
      try { r = B.checkPurchaseFee(psbt, n, { feeAddress: fa, feeBps: BTC.marketplaceFeeBps }); } catch { bad('invalid psbt'); }
      if (!r.ok) bad('purchase rejected: ' + r.err);
      if (r.price !== L.priceSats) bad('purchase rejected: seller output does not match the listing');
      return { ok: true, fee: r.fee, waived: r.waived };
    }
    if (M === 'POST' && p.length === 5 && p[4] === 'delete' && ID.test(p[3])) {
      const id = p[3]; const { token, reason } = await body(); const L = await env.COLLECTIONS.get(kL(n, id), 'json'); if (!L) return { ok: true };
      // Anyone may clear a listing whose UTXO is spent (sold / stale); only the seller's BIP-322 session may cancel a live one.
      const os = await outspend(n, L.txid, L.vout).catch(() => ({}));
      if (!os.spent) { const s = await session(env, token); if (!s || s.address !== L.seller || s.net !== n) bad('sign in as the seller to cancel', 401); }
      await env.COLLECTIONS.delete(kL(n, id)); await writeIdx(env, n, (await readIdx(env, n)).filter(l => l.inscriptionId !== id));
      return { ok: true, reason: os.spent ? 'spent' : reason || 'cancel' };
    }
    return undefined;
  }
  return { handle };
}
