// MultiSea native marketplace: Seaport 1.6 listings stored in KV, validated server-side and re-checked on read.
import { createPublicClient, http, parseAbi, hashStruct, verifyTypedData } from 'viem';

export const NATIVE_FEE_BPS = 50; // 0.5%
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '0'.repeat(64);
const MAX_DAYS = 180;
const TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }],
  ConsiderationItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
};
const SEA = parseAbi(['function getCounter(address) view returns (uint256)', 'function getOrderStatus(bytes32) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)']);
const NFT = parseAbi(['function ownerOf(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)']);

export function makeNative({ CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet, cached }) {
  const SEAPORT = CFG.seaport;
  const client = k => createPublicClient({ transport: http(chains[k].rpc) });
  const message = p => ({ ...p, offer: p.offer.map(o => ({ ...o, identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount) })), consideration: p.consideration.map(c => ({ ...c, identifierOrCriteria: BigInt(c.identifierOrCriteria), startAmount: BigInt(c.startAmount), endAmount: BigInt(c.endAmount) })), startTime: BigInt(p.startTime), endTime: BigInt(p.endTime), salt: BigInt(p.salt), counter: BigInt(p.counter) });
  const orderHash = p => hashStruct({ data: message(p), primaryType: 'OrderComponents', types: TYPES });
  const domain = k => ({ name: 'Seaport', version: '1.6', chainId: chains[k].chainId, verifyingContract: SEAPORT });
  const slugsFor = async (env, k, contract) => {
    const out = CFG.collections.filter(c => c.deployments.some(d => d.chain === k && lc(d.address) === lc(contract))).map(c => c.slug);
    const idx = await env.COLLECTIONS.get('idx:' + k + ':' + lc(contract)); if (idx && !out.includes(idx)) out.push(idx); return out;
  };
  const royaltyFor = async (env, slug) => { const c = slug ? await getCollection(env, slug) : null; const r = c?.royalty; return r && ADDR.test(r.recipient || '') && r.bps > 0 ? { recipient: lc(r.recipient), bps: Math.min(1000, Math.floor(r.bps)) } : null; };

  // Shape + economics (no RPC). Returns normalized parameters.
  function clean(o, fee) {
    if (!o || typeof o !== 'object') bad('missing parameters');
    const now = Math.floor(Date.now() / 1000); const U = /^\d{1,78}$/;
    const num = v => { v = String(v ?? ''); if (!U.test(v)) bad('invalid number'); return v; };
    if (!ADDR.test(o.offerer || '')) bad('bad offerer');
    if (lc(o.zone) !== ZERO || Number(o.orderType) !== 0 || lc(o.zoneHash) !== ZERO32 || lc(o.conduitKey) !== ZERO32) bad('MultiSea listings use no zone (FULL_OPEN) and no conduit');
    if (!Array.isArray(o.offer) || o.offer.length !== 1) bad('exactly one offer item');
    const f = o.offer[0];
    if (Number(f.itemType) !== 2 || !ADDR.test(f.token || '') || !/^\d{1,30}$/.test(String(f.identifierOrCriteria)) || String(f.startAmount) !== '1' || String(f.endAmount) !== '1') bad('offer must be one ERC-721');
    if (!Array.isArray(o.consideration) || o.consideration.length < 2 || o.consideration.length > 4) bad('bad consideration');
    const cons = o.consideration.map(c => {
      if (Number(c.itemType) !== 0 || lc(c.token) !== ZERO || String(c.identifierOrCriteria) !== '0' || !ADDR.test(c.recipient || '')) bad('consideration must be native currency');
      const a = num(c.startAmount); if (String(c.endAmount) !== a || BigInt(a) === 0n) bad('fixed, non-zero amounts only');
      return { itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: a, endAmount: a, recipient: lc(c.recipient) };
    });
    if (cons[0].recipient !== lc(o.offerer)) bad('first consideration must pay the seller');
    const total = cons.reduce((s, c) => s + BigInt(c.startAmount), 0n);
    const feeGot = cons.slice(1).filter(c => c.recipient === lc(fee)).reduce((s, c) => s + BigInt(c.startAmount), 0n);
    if (feeGot * 10000n < total * BigInt(NATIVE_FEE_BPS)) bad('MultiSea fee (0.5%) missing or too low');
    const st = Number(num(o.startTime)), et = Number(num(o.endTime));
    if (st > now + 600 || et <= now + 60 || et > now + MAX_DAYS * 86400 + 600) bad('bad start/end time');
    if (Number(o.totalOriginalConsiderationItems ?? cons.length) !== cons.length) bad('bad consideration count');
    return { offerer: lc(o.offerer), zone: ZERO, offer: [{ itemType: 2, token: lc(f.token), identifierOrCriteria: String(f.identifierOrCriteria), startAmount: '1', endAmount: '1' }], consideration: cons, orderType: 0, startTime: String(st), endTime: String(et), zoneHash: ZERO32, salt: num(o.salt), conduitKey: ZERO32, totalOriginalConsiderationItems: cons.length, counter: num(o.counter), _total: total };
  }

  // On-chain liveness: status, owner, approval, counter, expiry.
  async function live(k, p, hash) {
    const c = client(k); const id = BigInt(p.offer[0].identifierOrCriteria); const tok = p.offer[0].token;
    const [st, owner, appr, ctr] = await Promise.all([
      c.readContract({ address: SEAPORT, abi: SEA, functionName: 'getOrderStatus', args: [hash] }),
      c.readContract({ address: tok, abi: NFT, functionName: 'ownerOf', args: [id] }).catch(() => null),
      c.readContract({ address: tok, abi: NFT, functionName: 'isApprovedForAll', args: [p.offerer, SEAPORT] }).catch(() => false),
      c.readContract({ address: SEAPORT, abi: SEA, functionName: 'getCounter', args: [p.offerer] }),
    ]);
    if (st[2] > 0n) return { ok: false, why: 'filled' };
    if (st[1]) return { ok: false, why: 'cancelled' };
    if (ctr.toString() !== String(p.counter)) return { ok: false, why: 'counter' };
    if (Number(p.endTime) <= Date.now() / 1000) return { ok: false, why: 'expired' };
    if (!owner || lc(owner) !== lc(p.offerer)) return { ok: false, why: 'transferred' };
    if (!appr) return { ok: false, why: 'not-approved' };
    return { ok: true };
  }
  const key = (k, p, hash) => `ord:${k}:${lc(p.offer[0].token)}:${p.offer[0].identifierOrCriteria}:${hash}`;
  async function drop(env, k, rec, why) {
    await env.COLLECTIONS.delete(key(k, rec.parameters, rec.hash));
    if (why === 'filled') {
      const feeWei = rec.parameters.consideration.filter(c => c.recipient === feeWallet(env)).reduce((s, c) => s + BigInt(c.startAmount), 0n);
      await env.COLLECTIONS.put(`nfill:${Date.now()}:${rec.hash.slice(2, 10)}`, JSON.stringify({ at: new Date().toISOString(), chain: k, hash: rec.hash, id: rec.parameters.offer[0].identifierOrCriteria, priceWei: rec.priceWei, feeWei: feeWei.toString(), seller: rec.parameters.offerer }));
    }
  }

  async function list(env, b) {
    const k = Object.keys(chains).find(x => x === b.chain); if (!k) bad('unknown chain');
    if (!/^0x[0-9a-fA-F]{128,4096}$/.test(b.signature || '')) bad('bad signature');
    const p = clean(b.parameters, feeWallet(env)); const total = p._total; delete p._total;
    const slugs = await slugsFor(env, k, p.offer[0].token); if (!slugs.length) bad('collection not listed on MultiSea');
    const roy = await royaltyFor(env, slugs[0]);
    if (roy) { const got = p.consideration.slice(1).filter(c => c.recipient === roy.recipient).reduce((s, c) => s + BigInt(c.startAmount), 0n); if (got * 10000n + 10000n < total * BigInt(roy.bps)) bad(`creator royalty (${roy.bps / 100}%) required by this collection`); }
    const hash = orderHash(p);
    const td = { domain: domain(k), types: TYPES, primaryType: 'OrderComponents', message: message(p) };
    let okSig = await verifyTypedData({ address: p.offerer, signature: b.signature, ...td }).catch(() => false);
    if (!okSig) okSig = await client(k).verifyTypedData({ address: p.offerer, signature: b.signature, ...td }).catch(() => false); // ERC-1271 smart wallets
    if (!okSig) bad('signature does not match offerer', 401);
    const l = await live(k, p, hash); if (!l.ok) bad(l.why === 'not-approved' ? 'approve Seaport for this collection first' : 'order not valid on-chain: ' + l.why);
    const rec = { chain: k, hash, parameters: p, signature: b.signature, priceWei: total.toString(), slug: slugs[0], createdAt: new Date().toISOString() };
    await env.COLLECTIONS.put(key(k, p, hash), JSON.stringify(rec), { metadata: { p: total.toString(), s: p.offerer, e: Number(p.endTime) }, expiration: Math.max(Number(p.endTime), Math.floor(Date.now() / 1000) + 120) });
    for (const s of slugs) await caches.default.delete(new Request('https://cache.multisea/n:' + s)).catch(() => {});
    return { ok: true, orderHash: hash };
  }

  async function records(env, col) {
    const out = [];
    for (const d of col.deployments || []) {
      let cursor; do { const l = await env.COLLECTIONS.list({ prefix: `ord:${d.chain}:${lc(d.address)}:`, cursor }); cursor = l.list_complete ? null : l.cursor; for (const kk of l.keys) out.push({ name: kk.name, chain: d.chain }); } while (cursor);
    }
    return out;
  }
  // Public listings for a collection; invalid orders are pruned on read (cached 60s).
  async function listings(env, slug) {
    const col = await getCollection(env, slug); if (!col) bad('not found', 404);
    return cached(`n:${slug}`, 60, async () => {
      const recs = await records(env, col); const out = [];
      await Promise.all(recs.map(async r => {
        const rec = await env.COLLECTIONS.get(r.name, 'json'); if (!rec) return;
        const l = await live(r.chain, rec.parameters, rec.hash).catch(() => ({ ok: true })); // RPC hiccup: keep
        if (!l.ok) { await drop(env, r.chain, rec, l.why); return; }
        out.push({ source: 'multisea', chain: r.chain, id: Number(rec.parameters.offer[0].identifierOrCriteria), price: Number(rec.priceWei) / 1e18, currency: chains[r.chain].native, orderHash: rec.hash, protocolAddress: lc(SEAPORT), seller: rec.parameters.offerer, endTime: Number(rec.parameters.endTime) });
      }));
      return out;
    });
  }
  async function getOrder(env, k, hash) {
    const l = await env.COLLECTIONS.list({ prefix: `ord:${k}:` });
    const name = l.keys.find(x => x.name.endsWith(':' + lc(hash)))?.name; if (!name) bad('order not found', 404);
    const rec = await env.COLLECTIONS.get(name, 'json'); if (!rec) bad('order not found', 404);
    const lv = await live(k, rec.parameters, rec.hash); if (!lv.ok) { await drop(env, k, rec, lv.why); bad('listing no longer valid: ' + lv.why, 409); }
    return { chain: k, orderHash: rec.hash, parameters: rec.parameters, signature: rec.signature, priceWei: rec.priceWei, protocolAddress: lc(SEAPORT) };
  }
  async function remove(env, k, hash, address) {
    const l = await env.COLLECTIONS.list({ prefix: `ord:${k}:` }); const name = l.keys.find(x => x.name.endsWith(':' + lc(hash)))?.name; if (!name) bad('order not found', 404);
    const rec = await env.COLLECTIONS.get(name, 'json'); if (lc(rec.parameters.offerer) !== lc(address)) bad('only the seller can remove this listing', 403);
    await env.COLLECTIONS.delete(name); if (rec.slug) await caches.default.delete(new Request('https://cache.multisea/n:' + rec.slug)).catch(() => {});
    return { ok: true, note: 'Removed from MultiSea. The signed order stays valid on-chain until it expires; cancel on-chain or call Seaport incrementCounter() to invalidate all your open orders.' };
  }
  // Cron: re-validate every stored order.
  async function sweep(env) {
    let cursor, n = 0, dropped = 0;
    do {
      const l = await env.COLLECTIONS.list({ prefix: 'ord:', cursor }); cursor = l.list_complete ? null : l.cursor;
      for (const kk of l.keys) { n++; const k = kk.name.split(':')[1]; const rec = await env.COLLECTIONS.get(kk.name, 'json'); if (!rec) continue; const lv = await live(k, rec.parameters, rec.hash).catch(() => ({ ok: true })); if (!lv.ok) { dropped++; await drop(env, k, rec, lv.why); } }
    } while (cursor);
    return { checked: n, dropped };
  }
  async function fills(env) {
    const l = await env.COLLECTIONS.list({ prefix: 'nfill:' }); return (await Promise.all(l.keys.slice(-100).map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(Boolean).reverse();
  }
  return { list, listings, getOrder, remove, sweep, fills, royaltyFor, orderHash, clean };
}
