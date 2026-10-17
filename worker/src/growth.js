// MultiSea growth features (Worker side): sale ledger, referrals, revenue-sharing NFTs, chain quests + badge signatures,
// and Worker-coordinated bundles. All state lives in the COLLECTIONS KV namespace. On-chain reads are injectable (tests).
import { keccak256, toBytes, parseAbi, parseEventLogs, createPublicClient, createWalletClient, http, fallback, verifyTypedData, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const QUEST_CHAINS = ['ethereum', 'base', 'abstract', 'apechain', 'robinhood'];
export const QUEST_KINDS = ['buy', 'list', 'bridge', 'hold'];
export const DEFAULTS = { refBps: 2000, rsFeeCapBps: 5000 }; // referral = 20% of MultiSea's 0.5% fee; revshare can take up to 50% of it
const ZERO = '0x0000000000000000000000000000000000000000', ZERO32 = '0x' + '0'.repeat(64);
const SEA_EV = parseAbi(['event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)']);
const NFT = parseAbi(['function ownerOf(uint256) view returns (address)', 'function balanceOf(address) view returns (uint256)', 'function isApprovedForAll(address,address) view returns (bool)']);
const SEA = parseAbi(['function getCounter(address) view returns (uint256)', 'function getOrderStatus(bytes32) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)']);
const BIG = /^\d{1,78}$/;
const B = x => BigInt(x || 0);
export const refCode = addr => keccak256(toBytes(String(addr).toLowerCase())).slice(2, 10);
export const MINTPASS_TYPES = { MintPass: [{ name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }] };
export const BUNDLE_POLICY = 'Cross-chain bundles are filled one chain at a time (each chain\'s leg is a single Seaport order, so a leg is all-or-nothing). The buyer gets an exclusive 15-minute checkout lock and the signed orders are only revealed to that buyer. If a later leg fails or the lock expires after some legs were filled, the buyer keeps the filled legs at their listed per-leg prices and the bundle is marked "partially filled"; the remaining legs are withdrawn and the seller should cancel them on-chain.';

export function makeGrowth(d) {
  const { CFG, chains, lc, bad, ADDR, HASH, getCollection, feeWallet, admins, requireSession, canEdit, relayFetch } = d;
  const SEAPORT = lc(CFG.seaport);
  const kvj = (env, k) => env.COLLECTIONS.get(k, 'json');
  const put = (env, k, v, o) => env.COLLECTIONS.put(k, JSON.stringify(v), o);
  async function listAll(env, prefix, max = 2000) {
    const out = []; let cursor;
    do { const l = await env.COLLECTIONS.list({ prefix, cursor }); cursor = l.list_complete ? null : l.cursor; out.push(...l.keys); } while (cursor && out.length < max);
    return out;
  }
  // ---- on-chain (overridable) ----
  const clientCache = {};
  const client = k => (clientCache[k] ??= createPublicClient({ transport: fallback((chains[k].rpcs?.length ? chains[k].rpcs : [chains[k].rpc]).map(u => http(u, { timeout: 8000, retryCount: 1 }))) }));
  const chain = {
    ownerOf: (k, token, id) => client(k).readContract({ address: token, abi: NFT, functionName: 'ownerOf', args: [B(id)] }).then(lc).catch(() => null),
    balanceOf: (k, token, a) => client(k).readContract({ address: token, abi: NFT, functionName: 'balanceOf', args: [a] }).catch(() => 0n),
    approved: (k, token, a) => client(k).readContract({ address: token, abi: NFT, functionName: 'isApprovedForAll', args: [a, SEAPORT] }).catch(() => false),
    status: (k, hash) => client(k).readContract({ address: SEAPORT, abi: SEA, functionName: 'getOrderStatus', args: [hash] }),
    counter: (k, a) => client(k).readContract({ address: SEAPORT, abi: SEA, functionName: 'getCounter', args: [a] }),
    receipt: (k, h) => client(k).getTransactionReceipt({ hash: h }).catch(() => null),
    tx: (k, h) => client(k).getTransaction({ hash: h }).catch(() => null),
    verify: (k, args) => verifyTypedData(args).catch(() => false).then(ok => ok || client(k).verifyTypedData(args).catch(() => false)),
    relayStatus: async (env, id) => { const r = await relayFetch(env, `/intents/status/v3?requestId=${id}`); return r.ok ? r.json() : null; },
    ...(d.chain || {}),
  };
  const cfgOf = async env => ({ ...DEFAULTS, ...((await kvj(env, 'cfg:growth')) || {}) });
  const slugsFor = async (env, k, token) => {
    const out = CFG.collections.filter(c => c.deployments.some(x => x.chain === k && lc(x.address) === lc(token))).map(c => c.slug);
    const idx = await env.COLLECTIONS.get('idx:' + k + ':' + lc(token)); if (idx && !out.includes(idx)) out.push(idx); return out;
  };

  // ======================= sale ledger =======================
  // sale = { chain, orderHash, txHash?, buyer?, seller, priceWei, feeWei, royaltyWei, items:[{token,id,slug?}], source }
  async function recordSale(env, s) {
    if (!chains[s.chain] || !HASH.test(s.orderHash || '')) return { ok: false };
    const key = `sale:${s.chain}:${lc(s.orderHash)}`; const prev = await kvj(env, key);
    const rec = { ...(prev || {}), ...s, buyer: lc(prev?.buyer || s.buyer || '') || null, at: prev?.at || new Date().toISOString() };
    for (const it of rec.items || []) it.slug ??= (await slugsFor(env, s.chain, it.token))[0] || null;
    const out = { ok: true, new: !prev, revshare: null, referral: null };
    if (!prev) {
      // revenue share, split by item count per collection
      const per = {}; (rec.items || []).forEach(it => { if (it.slug) per[it.slug] = (per[it.slug] || 0) + 1; });
      const n = (rec.items || []).length || 1;
      out.revshare = [];
      for (const [slug, cnt] of Object.entries(per)) out.revshare.push(await accrueRevshare(env, slug, s.chain, B(s.feeWei) * BigInt(cnt) / BigInt(n), B(s.royaltyWei) * BigInt(cnt) / BigInt(n)));
      await put(env, `salelog:${String(Date.now()).padStart(15, '0')}:${lc(s.orderHash).slice(2, 10)}`, { chain: s.chain, orderHash: lc(s.orderHash), priceWei: String(s.priceWei || 0), feeWei: String(s.feeWei || 0), source: s.source || 'multisea' });
    }
    if (rec.buyer && !prev?.buyer) {
      out.referral = await accrueReferral(env, rec.buyer, s.chain, B(s.feeWei), lc(s.orderHash));
      await questEvent(env, rec.buyer, s.chain, 'buy', { tx: s.txHash || null, orderHash: lc(s.orderHash) });
    }
    await put(env, key, rec);
    return out;
  }
  // Parse Seaport OrderFulfilled events from a buyer-reported tx (on-chain truth, idempotent per orderHash).
  async function reportTx(env, k, txHash, native) {
    if (!chains[k] || !HASH.test(txHash || '')) bad('invalid input');
    let rc = null; for (let i = 0; i < 4 && !rc; i++) { rc = await chain.receipt(k, txHash); if (!rc && i < 3) await new Promise(r => setTimeout(r, 1500)); }
    if (!rc || rc.status !== 'success') bad('transaction not found or failed', 404);
    const evs = parseEventLogs({ abi: SEA_EV, logs: rc.logs.filter(g => lc(g.address) === SEAPORT), eventName: 'OrderFulfilled' });
    const fee = lc(feeWallet(env)); const results = [];
    for (const e of evs) {
      const a = e.args; const hash = lc(a.orderHash); const buyer = lc(a.recipient);
      const items = a.offer.filter(o => Number(o.itemType) === 2 || Number(o.itemType) === 4).map(o => ({ token: lc(o.token), id: String(o.identifier) }));
      if (!items.length) continue;
      const price = a.consideration.filter(c => Number(c.itemType) === 0).reduce((s, c) => s + c.amount, 0n);
      const feeWei = a.consideration.filter(c => lc(c.recipient) === fee).reduce((s, c) => s + c.amount, 0n);
      // royalty: consideration to the collection's configured royalty recipient(s)
      const slugs = [...new Set((await Promise.all(items.map(it => slugsFor(env, k, it.token)))).flat())];
      if (!slugs.length) continue; // not a MultiSea collection
      const royRecips = new Set((await Promise.all(slugs.map(sl => getCollection(env, sl)))).map(c => lc(c?.royalty?.recipient)).filter(Boolean));
      const royaltyWei = a.consideration.filter(c => royRecips.has(lc(c.recipient)) && lc(c.recipient) !== lc(a.offerer)).reduce((s, c) => s + c.amount, 0n);
      if (native) await native.dropByHash(env, k, hash).catch(() => {});
      const leg = await env.COLLECTIONS.get(`bleg:${k}:${hash}`);
      if (leg) await bundleLegFilled(env, leg, k, hash, buyer, txHash);
      const source = leg ? 'bundle' : feeWei > 0n ? 'multisea' : 'opensea';
      results.push({ orderHash: hash, buyer, source, ...(await recordSale(env, { chain: k, orderHash: hash, txHash, buyer, seller: lc(a.offerer), priceWei: price.toString(), feeWei: feeWei.toString(), royaltyWei: royaltyWei.toString(), items, source })) });
    }
    return { ok: true, matched: results.length, results };
  }

  // ======================= referrals =======================
  async function registerCode(env, addr) { const c = refCode(addr); if (!(await env.COLLECTIONS.get('refcode:' + c))) await env.COLLECTIONS.put('refcode:' + c, lc(addr)); return c; }
  async function bindReferral(env, buyer, code) {
    buyer = lc(buyer); code = String(code || '').toLowerCase(); if (!/^[0-9a-f]{8}$/.test(code)) bad('bad referral code');
    const ref = await env.COLLECTIONS.get('refcode:' + code); if (!ref) bad('unknown referral code', 404);
    if (ref === buyer) bad('you cannot refer yourself');
    const cur = await kvj(env, 'refby:' + buyer);
    if (cur) return { ok: true, bound: false, referrer: cur.referrer, note: 'already referred (first touch is permanent)' };
    const v = { referrer: ref, code, at: new Date().toISOString() };
    await put(env, 'refby:' + buyer, v); await put(env, `reffriend:${ref}:${buyer}`, { at: v.at });
    return { ok: true, bound: true, referrer: ref };
  }
  async function accrueReferral(env, buyer, k, feeWei, orderHash) {
    const by = await kvj(env, 'refby:' + lc(buyer)); if (!by || feeWei <= 0n) return null;
    const { refBps } = await cfgOf(env); const amt = feeWei * BigInt(refBps) / 10000n; if (amt <= 0n) return null;
    const ek = 'refearn:' + by.referrer; const e = (await kvj(env, ek)) || { perChain: {}, sales: 0 };
    e.perChain[k] = (B(e.perChain[k]) + amt).toString(); e.sales++; await put(env, ek, e);
    const fk = `reffriend:${by.referrer}:${lc(buyer)}`; const f = (await kvj(env, fk)) || {}; f.sales = (f.sales || 0) + 1; f.perChain = f.perChain || {}; f.perChain[k] = (B(f.perChain[k]) + amt).toString(); await put(env, fk, f);
    await put(env, `refsale:${String(Date.now()).padStart(15, '0')}:${orderHash.slice(2, 10)}`, { referrer: by.referrer, buyer: lc(buyer), chain: k, feeWei: feeWei.toString(), amount: amt.toString(), refBps });
    return { referrer: by.referrer, amount: amt.toString() };
  }
  async function refStats(env, addr) {
    addr = lc(addr); const code = await registerCode(env, addr);
    const fr = await listAll(env, `reffriend:${addr}:`, 500);
    const friends = await Promise.all(fr.map(async x => ({ address: x.name.split(':')[2], ...(await kvj(env, x.name)) })));
    return { code, path: '/r/' + code, referredBy: (await kvj(env, 'refby:' + addr))?.referrer || null, friends, earnings: (await kvj(env, 'refearn:' + addr)) || { perChain: {}, sales: 0 }, refBps: (await cfgOf(env)).refBps };
  }

  // ======================= revenue share =======================
  // Per-collection cumulative "amount per token" index per sale chain (pull-based, like the on-chain splitter):
  // claimable(token) = acc[chain] - claimed[token][chain]. Remainders carry to the next sale.
  async function accrueRevshare(env, slug, k, feeWei, royaltyWei) {
    const cfg = await kvj(env, 'rs:cfg:' + slug); if (!cfg?.enabled || !cfg.supply) return null;
    const pool = feeWei * BigInt(cfg.feeShareBps || 0) / 10000n + royaltyWei * BigInt(cfg.royaltyShareBps || 0) / 10000n;
    if (pool <= 0n) return null;
    const ak = 'rs:acc:' + slug; const a = (await kvj(env, ak)) || { perChain: {}, sales: 0 };
    const c = a.perChain[k] || { acc: '0', rem: '0', total: '0', fromFee: '0', fromRoyalty: '0' };
    const tot = pool + B(c.rem); const sup = BigInt(cfg.supply);
    c.acc = (B(c.acc) + tot / sup).toString(); c.rem = (tot % sup).toString(); c.total = (B(c.total) + pool).toString();
    c.fromFee = (B(c.fromFee) + feeWei * BigInt(cfg.feeShareBps || 0) / 10000n).toString(); c.fromRoyalty = (B(c.fromRoyalty) + royaltyWei * BigInt(cfg.royaltyShareBps || 0) / 10000n).toString();
    a.perChain[k] = c; a.sales++; await put(env, ak, a);
    return { slug, pool: pool.toString() };
  }
  async function claimable(env, slug, ids) {
    const a = (await kvj(env, 'rs:acc:' + slug)) || { perChain: {} }; const out = {}; const sum = {};
    for (const id of ids) {
      const cl = (await kvj(env, `rs:claimed:${slug}:${id}`)) || {}; out[id] = {};
      for (const [k, c] of Object.entries(a.perChain)) { const v = B(c.acc) - B(cl[k]); if (v > 0n) { out[id][k] = v.toString(); sum[k] = (B(sum[k]) + v).toString(); } }
    }
    return { perToken: out, total: sum };
  }
  const isMainnet = k => !/sepolia|testnet|holesky|curtis/i.test(k + ' ' + (chains[k]?.name || ''));
  const payoutState = (env, legs = []) => {
    if (env.REVSHARE_PAYOUTS !== 'on' || !env.PAYOUT_KEY) return { enabled: false, reason: 'Payouts are disabled until the payout wallet is funded and REVSHARE_PAYOUTS=on + PAYOUT_KEY are set.' };
    if (legs.some(l => isMainnet(l.chain)) && env.REVSHARE_MAINNET !== 'on') return { enabled: false, reason: 'Mainnet payouts are disabled until funded (set REVSHARE_MAINNET=on after funding).' };
    return { enabled: true };
  };
  async function quotePayout(env, from, to, leg, dest) {
    const sc = chains[leg.chain], dc = chains[dest.chain]; if (!sc || !dc) bad('unknown chain');
    const body = { user: from, recipient: to, refundTo: from, originChainId: sc.chainId, destinationChainId: dc.chainId, originCurrency: ZERO, destinationCurrency: dest.currency || ZERO, amount: leg.wei, tradeType: 'EXACT_INPUT' };
    const r = await relayFetch(env, '/quote/v2', { method: 'POST', body: JSON.stringify(body) }); const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.message || `relay ${r.status}`, leg };
    return { leg, quote: j, out: j.details?.currencyOut || null };
  }
  async function executePayout(env, legs, to, dest) {
    const acct = privateKeyToAccount(env.PAYOUT_KEY); const txs = [];
    for (const leg of legs) {
      const sc = chains[leg.chain]; const vc = defineChain({ id: sc.chainId, name: sc.name, nativeCurrency: { name: sc.native, symbol: sc.native, decimals: 18 }, rpcUrls: { default: { http: [sc.rpc] } } });
      const wc = createWalletClient({ account: acct, chain: vc, transport: http(sc.rpc) });
      if (leg.chain === dest.chain && lc(dest.currency || ZERO) === ZERO) { txs.push(await wc.sendTransaction({ to, value: B(leg.wei) })); continue; }
      const q = await quotePayout(env, acct.address, to, leg, dest); if (q.error) throw new Error('relay: ' + q.error);
      for (const st of q.quote.steps || []) for (const it of st.items || []) { if (st.kind !== 'transaction') throw new Error('unsupported relay step'); const x = it.data; if (Number(x.chainId) !== sc.chainId) throw new Error('unexpected chain'); txs.push(await wc.sendTransaction({ to: x.to, data: x.data, value: B(x.value) })); }
    }
    return txs;
  }
  async function revshareClaim(env, slug, who, b) {
    const cfg = await kvj(env, 'rs:cfg:' + slug); if (!cfg?.enabled) bad('revenue share is not enabled for this collection');
    const ids = [...new Set((Array.isArray(b.tokenIds) ? b.tokenIds : []).map(String))].filter(x => /^\d{1,9}$/.test(x)).slice(0, 50); if (!ids.length) bad('tokenIds required');
    const dest = { chain: b.chain, currency: b.currency || ZERO }; if (!chains[dest.chain] || !ADDR.test(dest.currency)) bad('choose a payout chain and token');
    const col = await getCollection(env, slug); if (!col) bad('not found', 404);
    for (const id of ids) {
      let ok = false; for (const dep of col.deployments || []) { if ((await chain.ownerOf(dep.chain, dep.address, id)) === lc(who)) { ok = true; break; } }
      if (!ok) bad(`you don't hold #${id}`, 403);
    }
    const c = await claimable(env, slug, ids); const legs = Object.entries(c.total).map(([chain, wei]) => ({ chain, wei }));
    if (!legs.length) bad('nothing to claim yet');
    const ps = payoutState(env, legs); const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!ps.enabled) {
      const quotes = env.PAYOUT_WALLET && ADDR.test(env.PAYOUT_WALLET) ? await Promise.all(legs.map(l => quotePayout(env, env.PAYOUT_WALLET, who, l, dest).then(q => ({ chain: l.chain, wei: l.wei, out: q.out, error: q.error })).catch(e => ({ chain: l.chain, error: String(e).slice(0, 120) })))) : legs.map(l => ({ ...l, error: 'payout wallet not configured' }));
      await put(env, `rs:req:${id}`, { id, slug, who: lc(who), ids, legs, dest, status: 'queued', reason: ps.reason, at: new Date().toISOString() });
      return { ok: true, executed: false, status: 'queued', reason: ps.reason, legs, quotes, requestId: id };
    }
    // lock tokens while paying so a double-submit can't pay twice
    const lockKey = `rs:lock:${slug}:${ids.join(',')}`; if (await env.COLLECTIONS.get(lockKey)) bad('a claim for these tokens is already in progress', 409);
    await env.COLLECTIONS.put(lockKey, '1', { expirationTtl: 300 });
    try {
      // mark claimed first (pessimistic), revert on failure
      const a = (await kvj(env, 'rs:acc:' + slug)) || { perChain: {} }; const prevs = {};
      for (const tid of ids) { const k = `rs:claimed:${slug}:${tid}`; prevs[k] = (await kvj(env, k)) || {}; const nv = { ...prevs[k] }; for (const [ch, x] of Object.entries(a.perChain)) nv[ch] = x.acc; await put(env, k, nv); }
      let txs; try { txs = await executePayout(env, legs, who, dest); } catch (e) { for (const [k, v] of Object.entries(prevs)) await put(env, k, v); throw e; }
      await put(env, `rs:req:${id}`, { id, slug, who: lc(who), ids, legs, dest, status: 'paid', txs, at: new Date().toISOString() });
      return { ok: true, executed: true, status: 'paid', txs, legs };
    } finally { await env.COLLECTIONS.delete(lockKey); }
  }

  // ======================= quests / badges =======================
  async function questEvent(env, addr, k, kind, proof = {}) {
    if (!QUEST_CHAINS.includes(k) || !QUEST_KINDS.includes(kind)) return;
    const key = `qe:${lc(addr)}:${k}`; const q = (await kvj(env, key)) || {};
    if (!q[kind]) { q[kind] = { at: new Date().toISOString(), ...proof }; await put(env, key, q); }
  }
  async function knownContracts(env, k) {
    const s = new Set(CFG.collections.flatMap(c => c.deployments.filter(x => x.chain === k).map(x => lc(x.address))));
    for (const x of await listAll(env, `idx:${k}:`, 300)) s.add(x.name.split(':')[2]);
    return [...s];
  }
  async function quests(env, addr, verify = false) {
    addr = lc(addr); const rows = [];
    for (const k of QUEST_CHAINS) {
      let q = (await kvj(env, `qe:${addr}:${k}`)) || {};
      if (verify && !Object.keys(q).length) {
        for (const t of await knownContracts(env, k)) { if ((await chain.balanceOf(k, t, addr)) > 0n) { await questEvent(env, addr, k, 'hold', { token: t }); q = (await kvj(env, `qe:${addr}:${k}`)) || {}; break; } }
      }
      rows.push({ chain: k, done: Object.fromEntries(QUEST_KINDS.map(x => [x, q[x]?.at || null])), badge: QUEST_KINDS.some(x => q[x]) });
    }
    const count = rows.filter(r => r.badge).length;
    return { address: addr, chains: rows, count, total: QUEST_CHAINS.length, eligible: count === QUEST_CHAINS.length };
  }
  async function bridgeQuest(env, requestId) {
    if (!HASH.test(requestId || '')) bad('requestId required');
    const st = await chain.relayStatus(env, requestId); if (!st || st.status !== 'success') bad('bridge not completed (yet)', 409);
    const originKey = Object.keys(chains).find(k => chains[k].chainId === Number(st.originChainId));
    const destKey = Object.keys(chains).find(k => chains[k].chainId === Number(st.destinationChainId));
    const inTx = (st.inTxHashes || [])[0]; if (!originKey || !destKey || !HASH.test(inTx || '')) bad('bridge is not between MultiSea chains');
    const tx = await chain.tx(originKey, inTx); if (!tx?.from) bad('origin transaction not found', 404);
    await questEvent(env, tx.from, destKey, 'bridge', { requestId }); await questEvent(env, tx.from, originKey, 'bridge', { requestId });
    return { ok: true, address: lc(tx.from), chains: [originKey, destKey] };
  }
  async function eligibility(env, addr) {
    const q = await quests(env, addr); if (!q.eligible) return { eligible: false, count: q.count, total: q.total };
    if (!env.BADGE_SIGNER_KEY || !ADDR.test(env.BADGE_CONTRACT || '') || !env.BADGE_CHAIN_ID) return { eligible: true, signature: null, setupNeeded: true, note: 'Badge mint not configured yet (BADGE_SIGNER_KEY, BADGE_CONTRACT, BADGE_CHAIN_ID).' };
    const acct = privateKeyToAccount(env.BADGE_SIGNER_KEY); const deadline = Math.floor(Date.now() / 1000) + 3 * 86400;
    const domain = { name: 'MultiSeaChainBadges', version: '1', chainId: Number(env.BADGE_CHAIN_ID), verifyingContract: env.BADGE_CONTRACT };
    const signature = await acct.signTypedData({ domain, types: MINTPASS_TYPES, primaryType: 'MintPass', message: { to: lc(addr), deadline: BigInt(deadline) } });
    return { eligible: true, signature, deadline, contract: env.BADGE_CONTRACT, chainId: Number(env.BADGE_CHAIN_ID), signer: lc(acct.address) };
  }

  // ======================= bundles =======================
  function cleanLeg(o, fee) {
    if (!o || typeof o !== 'object') bad('missing parameters');
    const now = Math.floor(Date.now() / 1000); const num = v => { v = String(v ?? ''); if (!BIG.test(v)) bad('invalid number'); return v; };
    if (!ADDR.test(o.offerer || '')) bad('bad offerer');
    if (lc(o.zone) !== ZERO || Number(o.orderType) !== 0 || lc(o.zoneHash) !== ZERO32 || lc(o.conduitKey) !== ZERO32) bad('bundle orders use no zone (FULL_OPEN) and no conduit');
    if (!Array.isArray(o.offer) || o.offer.length < 1 || o.offer.length > 30) bad('1-30 offer items per chain');
    const seen = new Set();
    const offer = o.offer.map(f => {
      if (Number(f.itemType) !== 2 || !ADDR.test(f.token || '') || !/^\d{1,30}$/.test(String(f.identifierOrCriteria)) || String(f.startAmount) !== '1' || String(f.endAmount) !== '1') bad('offer items must be ERC-721');
      const id = lc(f.token) + ':' + f.identifierOrCriteria; if (seen.has(id)) bad('duplicate item'); seen.add(id);
      return { itemType: 2, token: lc(f.token), identifierOrCriteria: String(f.identifierOrCriteria), startAmount: '1', endAmount: '1' };
    });
    if (!Array.isArray(o.consideration) || o.consideration.length < 2 || o.consideration.length > 12) bad('bad consideration');
    const cons = o.consideration.map(c => {
      if (Number(c.itemType) !== 0 || lc(c.token) !== ZERO || String(c.identifierOrCriteria) !== '0' || !ADDR.test(c.recipient || '')) bad('consideration must be native currency');
      const a = num(c.startAmount); if (String(c.endAmount) !== a || B(a) === 0n) bad('fixed, non-zero amounts only');
      return { itemType: 0, token: ZERO, identifierOrCriteria: '0', startAmount: a, endAmount: a, recipient: lc(c.recipient) };
    });
    if (cons[0].recipient !== lc(o.offerer)) bad('first consideration must pay the seller');
    const total = cons.reduce((s, c) => s + B(c.startAmount), 0n);
    const feeGot = cons.slice(1).filter(c => c.recipient === lc(fee)).reduce((s, c) => s + B(c.startAmount), 0n);
    if (feeGot * 10000n < total * 50n) bad('MultiSea fee (0.5%) missing or too low');
    const st = Number(num(o.startTime)), et = Number(num(o.endTime));
    if (st > now + 600 || et <= now + 60 || et > now + 180 * 86400 + 600) bad('bad start/end time');
    return { offerer: lc(o.offerer), zone: ZERO, offer, consideration: cons, orderType: 0, startTime: String(st), endTime: String(et), zoneHash: ZERO32, salt: num(o.salt), conduitKey: ZERO32, totalOriginalConsiderationItems: cons.length, counter: num(o.counter), _total: total };
  }
  async function legLive(k, p, hash) {
    const [st, ctr] = await Promise.all([chain.status(k, hash), chain.counter(k, p.offerer)]);
    if (st[2] > 0n) return { ok: false, why: 'filled' }; if (st[1]) return { ok: false, why: 'cancelled' };
    if (String(ctr) !== String(p.counter)) return { ok: false, why: 'counter' };
    if (Number(p.endTime) <= Date.now() / 1000) return { ok: false, why: 'expired' };
    for (const tok of [...new Set(p.offer.map(o => o.token))]) if (!(await chain.approved(k, tok, p.offerer))) return { ok: false, why: 'not-approved' };
    for (const o of p.offer) if ((await chain.ownerOf(k, o.token, o.identifierOrCriteria)) !== lc(p.offerer)) return { ok: false, why: 'transferred' };
    return { ok: true };
  }
  async function createBundle(env, b, native) {
    const legsIn = Array.isArray(b.legs) ? b.legs : []; if (!legsIn.length || legsIn.length > 6) bad('1-6 chain legs');
    const fee = feeWallet(env); const legs = []; let seller = null; const usedChains = new Set();
    for (const L of legsIn) {
      const k = L.chain; if (!chains[k] || usedChains.has(k)) bad('one leg per chain'); usedChains.add(k);
      if (!/^0x[0-9a-fA-F]{128,4096}$/.test(L.signature || '')) bad('bad signature');
      const p = cleanLeg(L.parameters, fee); const total = p._total; delete p._total;
      if (seller && seller !== p.offerer) bad('all legs must come from the same seller'); seller = p.offerer;
      // every item must belong to a MultiSea collection; royalties required pro-rata by item count
      const roys = {};
      for (const o of p.offer) { const sl = (await slugsFor(env, k, o.token))[0]; if (!sl) bad(`${o.token} is not a MultiSea collection`); const r = native ? await native.royaltyFor(env, sl) : null; if (r) roys[r.recipient] = Math.max(roys[r.recipient] || 0, 0) + r.bps / p.offer.length; }
      for (const [rcp, bps] of Object.entries(roys)) { const got = p.consideration.slice(1).filter(c => c.recipient === rcp).reduce((s, c) => s + B(c.startAmount), 0n); if (got * 10000n + 10000n < total * BigInt(Math.floor(bps))) bad('creator royalty missing for an item in this bundle'); }
      const hash = native.orderHash(p);
      const ok = await chain.verify(k, { address: p.offerer, signature: L.signature, ...native.typedData(k, p) }); if (!ok) bad('signature does not match seller', 401);
      const lv = await legLive(k, p, hash).catch(() => ({ ok: false, why: 'rpc' })); if (!lv.ok) bad(lv.why === 'not-approved' ? 'approve Seaport for every collection in the bundle first' : `${chains[k].name} leg not valid on-chain: ${lv.why}`);
      legs.push({ chain: k, hash, parameters: p, signature: L.signature, priceWei: total.toString(), status: 'open' });
    }
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { id, title: String(b.title || '').slice(0, 80) || `Bundle of ${legs.reduce((s, l) => s + l.parameters.offer.length, 0)}`, seller, kind: legs.length > 1 ? 'cross-chain' : 'same-chain', experimental: legs.length > 1, status: 'open', legs, createdAt: new Date().toISOString(), endTime: Math.min(...legs.map(l => Number(l.parameters.endTime))), policy: legs.length > 1 ? BUNDLE_POLICY : 'Single Seaport order with multiple offer items: all-or-nothing.' };
    await put(env, 'bundle:' + id, rec); for (const l of legs) await env.COLLECTIONS.put(`bleg:${l.chain}:${l.hash}`, id);
    return { ok: true, id, kind: rec.kind };
  }
  const pub = r => ({ ...r, legs: r.legs.map(l => ({ chain: l.chain, hash: l.hash, priceWei: l.priceWei, status: l.status, items: l.parameters.offer.map(o => ({ token: o.token, id: o.identifierOrCriteria })), filledBy: l.filledBy || null })) });
  async function bundles(env) { const ks = await listAll(env, 'bundle:', 300); return (await Promise.all(ks.map(k => kvj(env, k.name)))).filter(Boolean).filter(r => r.status !== 'cancelled').map(pub).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function checkout(env, id, buyer) {
    const r = await kvj(env, 'bundle:' + id); if (!r) bad('bundle not found', 404);
    if (r.status !== 'open' && r.status !== 'checkout') bad('bundle is ' + r.status, 409);
    const lockKey = 'block:' + id; const lock = await env.COLLECTIONS.get(lockKey);
    if (lock && lock !== lc(buyer)) bad('someone else is checking out this bundle; try again in a few minutes', 409);
    const open = r.legs.filter(l => l.status === 'open');
    for (const l of open) { const lv = await legLive(l.chain, l.parameters, l.hash).catch(() => ({ ok: true })); if (!lv.ok) { r.status = lv.why === 'filled' && r.legs.some(x => x.status === 'filled') ? 'partial' : 'unavailable'; r.reason = `${chains[l.chain].name} leg ${lv.why}`; await put(env, 'bundle:' + id, r); bad('bundle unavailable: ' + r.reason, 409); } }
    await env.COLLECTIONS.put(lockKey, lc(buyer), { expirationTtl: 900 });
    r.status = 'checkout'; r.lock = { buyer: lc(buyer), until: Date.now() + 900_000 }; await put(env, 'bundle:' + id, r);
    // highest-value leg first: if anything fails later, the most valuable part is already done
    return { ok: true, id, policy: r.policy, lockSeconds: 900, legs: open.sort((a, b) => (B(b.priceWei) > B(a.priceWei) ? 1 : -1)).map(l => ({ chain: l.chain, orderHash: l.hash, parameters: l.parameters, signature: l.signature, priceWei: l.priceWei, protocolAddress: SEAPORT })) };
  }
  async function bundleLegFilled(env, id, k, hash, buyer, txHash) {
    const r = await kvj(env, 'bundle:' + id); if (!r) return;
    const l = r.legs.find(x => x.chain === k && x.hash === hash); if (!l || l.status === 'filled') return;
    l.status = 'filled'; l.filledBy = buyer; l.tx = txHash;
    r.status = r.legs.every(x => x.status === 'filled') ? 'sold' : 'checkout';
    await put(env, 'bundle:' + id, r);
  }
  // Lock expired with only some legs filled -> partial (remaining legs withdrawn). Run from cron and on read.
  async function settleBundle(env, r) {
    if (r.status === 'checkout' && r.lock && Date.now() > r.lock.until) {
      const any = r.legs.some(x => x.status === 'filled');
      r.status = any ? 'partial' : 'open'; if (any) r.legs.forEach(x => { if (x.status === 'open') x.status = 'withdrawn'; }); delete r.lock; await put(env, 'bundle:' + r.id, r);
    }
    return r;
  }

  // ======================= router =======================
  async function handle(req, env, url, p, M, body, native) {
    const addrParam = x => { if (!ADDR.test(x || '')) bad('address required'); return lc(x); };
    // sale reports (buyer-submitted tx; verified on-chain)
    if (M === 'POST' && p[0] === 'native' && p[1] === 'filled' && p.length === 2) { const b = await body(); return reportTx(env, b.chain, b.txHash, native); }
    // referrals
    if (p[0] === 'ref') {
      if (M === 'GET' && p[1] === 'stats' && p.length === 3) return refStats(env, addrParam(p[2]));
      if (M === 'GET' && p[1] === 'code' && p.length === 3) { const c = String(p[2]).toLowerCase(); const a = /^[0-9a-f]{8}$/.test(c) ? await env.COLLECTIONS.get('refcode:' + c) : null; if (!a) bad('unknown code', 404); return { code: c, referrer: a }; }
      if (M === 'POST' && p[1] === 'bind' && p.length === 2) { const s = await requireSession(req, env); const b = await body(); return bindReferral(env, s.address, b.code); }
    }
    // revenue share
    if (p[0] === 'revshare') {
      if (M === 'GET' && p.length === 1) { const ks = await listAll(env, 'rs:cfg:', 300); const cfg = await cfgOf(env); return { capBps: cfg.rsFeeCapBps, payouts: payoutState(env, [{ chain: 'ethereum' }]), collections: (await Promise.all(ks.map(async k => { const c = await kvj(env, k.name); const slug = k.name.slice(7); const col = await getCollection(env, slug); return c && col ? { slug, name: col.name, logo: col.logo || null, ...c, acc: (await kvj(env, 'rs:acc:' + slug)) || { perChain: {}, sales: 0 } } : null; }))).filter(Boolean) }; }
      const slug = p[1]; if (!/^[a-z0-9-]{2,40}$/.test(slug || '')) bad('bad slug');
      if (M === 'GET' && p.length === 2) { const col = await getCollection(env, slug); if (!col) bad('not found', 404); const cfg = await cfgOf(env); return { slug, name: col.name, config: (await kvj(env, 'rs:cfg:' + slug)) || { enabled: false }, acc: (await kvj(env, 'rs:acc:' + slug)) || { perChain: {}, sales: 0 }, capBps: cfg.rsFeeCapBps, payouts: payoutState(env, [{ chain: col.deployments?.[0]?.chain || 'ethereum' }]), payoutWallet: env.PAYOUT_WALLET || null }; }
      if (M === 'GET' && p[2] === 'claimable') { const ids = (url.searchParams.get('ids') || '').split(',').filter(x => /^\d{1,9}$/.test(x)).slice(0, 200); return claimable(env, slug, ids); }
      if (M === 'POST' && p[2] === 'optin') {
        const s = await requireSession(req, env); const perm = await canEdit(env, slug, s.address); if (!perm.ok) bad('only the collection owner or an admin can opt in', 403);
        const b = await body(); const cfg = await cfgOf(env); const col = await getCollection(env, slug); if (!col) bad('not found', 404);
        const fee = Math.floor(+b.feeShareBps || 0), roy = Math.floor(+b.royaltyShareBps || 0);
        if (fee < 0 || fee > cfg.rsFeeCapBps || roy < 0 || roy > 10000) bad(`fee share 0-${cfg.rsFeeCapBps / 100}% of MultiSea's fee, royalty share 0-100%`);
        const supply = Math.floor(+(b.supply || col.supply || CFG.collections.find(c => c.slug === slug)?.supply || 0)); if (!(supply > 0 && supply <= 100000)) bad('collection supply (1-100000) required');
        const v = { enabled: !!b.enabled, feeShareBps: fee, royaltyShareBps: roy, supply, by: s.address, at: new Date().toISOString(), acceptedTerms: !!b.acceptedTerms };
        if (v.enabled && !v.acceptedTerms) bad('accept the revenue-share terms first');
        await put(env, 'rs:cfg:' + slug, v); return { ok: true, config: v };
      }
      if (M === 'POST' && p[2] === 'claim') { const s = await requireSession(req, env); return revshareClaim(env, slug, s.address, await body()); }
    }
    // quests
    if (p[0] === 'quests') {
      if (M === 'POST' && p[1] === 'bridge' && p.length === 2) { const b = await body(); return bridgeQuest(env, b.requestId); }
      if (M === 'GET' && p.length === 2) return quests(env, addrParam(p[1]));
      if (M === 'POST' && p[2] === 'verify') { const a = addrParam(p[1]); const rk = 'qv:' + a; if (await env.COLLECTIONS.get(rk)) return quests(env, a); await env.COLLECTIONS.put(rk, '1', { expirationTtl: 60 }); return quests(env, a, true); }
      if (M === 'GET' && p[2] === 'eligibility') return eligibility(env, addrParam(p[1]));
    }
    if (M === 'GET' && p[0] === 'profile' && p.length === 2) { const a = addrParam(p[1]); const [q, r, bs] = await Promise.all([quests(env, a), refStats(env, a), bundles(env)]); return { address: a, quests: q, referrals: { code: r.code, friends: r.friends.length, earnings: r.earnings }, bundles: bs.filter(x => x.seller === a) }; }
    // bundles
    if (p[0] === 'bundles') {
      if (M === 'GET' && p.length === 1) return { bundles: await Promise.all((await bundles(env)).map(async r => r)), policy: BUNDLE_POLICY };
      if (M === 'POST' && p.length === 1) return createBundle(env, await body(), native);
      const id = p[1]; if (!/^b[0-9a-z]{4,20}$/.test(id || '')) bad('bad bundle id');
      if (M === 'GET' && p.length === 2) { const r = await kvj(env, 'bundle:' + id); if (!r) bad('bundle not found', 404); return { bundle: pub(await settleBundle(env, r)) }; }
      if (M === 'POST' && p[2] === 'checkout') { const s = await requireSession(req, env); return checkout(env, id, s.address); }
      if (M === 'POST' && p[2] === 'cancel') { const s = await requireSession(req, env); const r = await kvj(env, 'bundle:' + id); if (!r) bad('not found', 404); if (r.seller !== s.address) bad('only the seller', 403); r.status = 'cancelled'; await put(env, 'bundle:' + id, r); return { ok: true, note: 'Removed from MultiSea. Cancel the signed orders on-chain (Seaport cancel or incrementCounter) to fully invalidate them.' }; }
    }
    // admin
    if (p[0] === 'admin' && p[1] === 'growth') {
      const s = await requireSession(req, env); if (!admins(env).includes(s.address)) bad('admin only', 403);
      if (M === 'GET' && p.length === 2) {
        const cfg = await cfgOf(env);
        const earn = await listAll(env, 'refearn:', 500); const top = (await Promise.all(earn.map(async k => ({ address: k.name.slice(8), ...(await kvj(env, k.name)) })))).sort((a, b) => b.sales - a.sales).slice(0, 50);
        const rsales = (await listAll(env, 'refsale:', 2000)).slice(-50); const recent = (await Promise.all(rsales.map(k => kvj(env, k.name)))).filter(Boolean).reverse();
        const reqs = (await listAll(env, 'rs:req:', 500)).slice(-50); const claims = (await Promise.all(reqs.map(k => kvj(env, k.name)))).filter(Boolean).reverse();
        return { config: cfg, referrers: top, refSales: recent, revshareClaims: claims, payouts: payoutState(env, [{ chain: 'ethereum' }]), badgeSigner: !!env.BADGE_SIGNER_KEY };
      }
      if (M === 'POST' && p[2] === 'config') { const b = await body(); const cur = await cfgOf(env); const refBps = b.refBps == null ? cur.refBps : Math.floor(+b.refBps); const rsFeeCapBps = b.rsFeeCapBps == null ? cur.rsFeeCapBps : Math.floor(+b.rsFeeCapBps); if (!(refBps >= 0 && refBps <= 5000) || !(rsFeeCapBps >= 0 && rsFeeCapBps <= 8000) || refBps + rsFeeCapBps > 10000) bad('referral 0-50%, revshare cap 0-80%, sum <= 100% of the fee'); const v = { refBps, rsFeeCapBps, by: s.address, at: new Date().toISOString() }; await put(env, 'cfg:growth', v); return { ok: true, config: v }; }
    }
    return undefined;
  }
  return { handle, recordSale, reportTx, bindReferral, registerCode, accrueReferral, refStats, accrueRevshare, claimable, revshareClaim, questEvent, quests, eligibility, bridgeQuest, cleanLeg, createBundle, checkout, bundleLegFilled, settleBundle, bundles, payoutState, cfgOf, chain };
}
