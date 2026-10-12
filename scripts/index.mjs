// LIL FOOTS multichain data pipeline -> public/data/<slug>/*.json
// Usage: node scripts/index.mjs [slug] [--skip-meta] [--skip-chain]
import fs from 'node:fs/promises';
import path from 'node:path';
import { Interface, getAddress, id as keccakId } from 'ethers';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'config/collections.json'), 'utf8'));
const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--')) || CFG.default;
const COL = CFG.collections.find(c => c.slug === slug);
if (!COL) throw new Error('unknown collection ' + slug);
const OUT = path.join(ROOT, 'public/data', slug);
const CACHE = path.join(ROOT, '.cache', slug);
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(CACHE, 'meta'), { recursive: true });
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const TRANSFER = keccakId('Transfer(address,address,uint256)');
const ORDER_FULFILLED = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';
const seaportIface = new Interface(['event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer, (uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ids = []; for (let i = COL.idStart; i <= COL.idEnd; i++) ids.push(i);

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function fetchT(url, opts = {}, ms = 20000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

// ---------- 1+2) metadata & traits ----------
const ipfsPath = u => u.replace('ipfs://', '');
async function fetchMeta(tokenId) {
  const f = path.join(CACHE, 'meta', tokenId + '.json');
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch {}
  const p = ipfsPath(COL.metadataBase) + tokenId;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const g of COL.ipfsGateways) {
      try {
        const r = await fetchT(g + p, {}, 15000);
        if (!r.ok) continue;
        const j = JSON.parse(await r.text());
        await fs.writeFile(f, JSON.stringify(j));
        return j;
      } catch {}
    }
    await sleep(1000 * (attempt + 1));
  }
  return null;
}
async function buildMetadata() {
  log('metadata: fetching', ids.length);
  let done = 0;
  const metas = await pool(ids, 24, async tid => { const m = await fetchMeta(tid); if (++done % 500 === 0) log('  meta', done); return m; });
  const missing = ids.filter((_, k) => !metas[k]);
  const counts = {};
  metas.forEach(m => (m?.attributes || []).forEach(a => {
    counts[a.trait_type] ??= {}; counts[a.trait_type][a.value] = (counts[a.trait_type][a.value] || 0) + 1;
  }));
  const total = ids.length - missing.length;
  const traits = {};
  for (const [t, vals] of Object.entries(counts)) {
    traits[t] = Object.entries(vals).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, pct: +(100 * count / total).toFixed(2) }));
  }
  // rarity score: sum of 1/frequency over traits (statistical rarity)
  const items = ids.map((tid, k) => {
    const m = metas[k];
    const attrs = (m?.attributes || []).map(a => [a.trait_type, String(a.value)]);
    const score = attrs.reduce((s, [t, v]) => s + total / counts[t][v], 0);
    return { id: tid, name: m?.name || `${COL.name} #${tid}`, image: ipfsPath(m?.image || COL.imageBase + tid), attrs, score };
  });
  [...items].sort((a, b) => b.score - a.score).forEach((it, r) => { it.rank = r + 1; });
  items.forEach(it => { it.score = +it.score.toFixed(2); });
  await fs.writeFile(path.join(OUT, 'items.json'), JSON.stringify(items));
  await fs.writeFile(path.join(OUT, 'traits.json'), JSON.stringify({ total, traits, missing }));
  log('metadata done; missing', missing.length);
}

// ---------- RPC ----------
function rpcFor(chainKey) {
  const c = CFG.chains[chainKey]; const urls = [c.rpc, ...(c.rpcFallback || [])];
  let n = 0;
  async function call(method, params, tries = 6) {
    let lastErr;
    for (let a = 0; a < tries; a++) {
      const url = urls[(n + a) % urls.length];
      try {
        const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) }, 30000);
        const txt = await r.text(); let j;
        try { j = JSON.parse(txt); } catch { throw new Error(`HTTP ${r.status} ${txt.slice(0, 120)}`); }
        if (j.error) { const e = new Error(j.error.message || JSON.stringify(j.error)); e.rpc = j.error; throw e; }
        return j.result;
      } catch (e) {
        lastErr = e;
        if (e.rpc && /revert|invalid token|nonexistent|ERC721/i.test(e.message)) throw e; // deterministic
        if (e.rpc && /range|too many|limit exceeded|max.*block|10000|response size|query returned more/i.test(e.message) && method === 'eth_getLogs') throw e;
        await sleep(400 * (a + 1) * (a + 1));
      }
    }
    throw lastErr;
  }
  return { call };
}

// ---------- 3) per chain ownership + history ----------
async function ownersViaOwnerOf(rpc, address) {
  const owners = {}; let todo = ids, done = 0;
  for (let round = 0; round < 5 && todo.length; round++) {
    const failed = [];
    await pool(todo, round === 0 ? 12 : 3, async tid => {
      const data = '0x6352211e' + tid.toString(16).padStart(64, '0');
      try {
        const res = await rpc.call('eth_call', [{ to: address, data }, 'latest'], 4);
        if (res && res.length >= 66) { const o = '0x' + res.slice(-40); if (o !== ZERO) owners[tid] = getAddress(o); }
      } catch (e) { if (!e.rpc || !/revert|nonexist|invalid token|ERC721/i.test(e.message)) failed.push(tid); }
      if (++done % 1000 === 0) log('   ownerOf', done);
    });
    if (failed.length) { log('   ownerOf retry round', round + 1, failed.length); await sleep(5000); }
    todo = failed;
  }
  return { owners, errs: todo.length };
}
async function findCreationBlock(rpc, address, latest) {
  const code = b => rpc.call('eth_getCode', [address, '0x' + b.toString(16)]);
  try {
    if ((await code(latest)) === '0x') return null;
    let lo = 0, hi = latest;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const c = await code(mid); if (c && c !== '0x') hi = mid; else lo = mid + 1; }
    return lo;
  } catch (e) { log('   getCode binary search failed:', e.message.slice(0, 100)); return null; }
}
async function scanLogs(rpc, filterBase, from, to, budgetMs) {
  const t0 = Date.now(); let chunk = 50000, cur = from; const logs = [];
  while (cur <= to) {
    if (Date.now() - t0 > budgetMs) return { logs, complete: false, scannedTo: cur - 1 };
    const end = Math.min(to, cur + chunk - 1);
    try {
      const res = await rpc.call('eth_getLogs', [{ ...filterBase, fromBlock: '0x' + cur.toString(16), toBlock: '0x' + end.toString(16) }], 3);
      logs.push(...res); cur = end + 1;
      if (res.length < 2000 && chunk < 2_000_000) chunk = Math.floor(chunk * 2);
    } catch (e) {
      const m = /\[0x([0-9a-f]+), 0x([0-9a-f]+)\]/i.exec(e.message);
      if (m) chunk = Math.max(1, parseInt(m[2], 16) - parseInt(m[1], 16) + 1);
      else chunk = Math.max(1, Math.floor(chunk / 4));
      if (chunk === 1 && !e.rpc) throw e;
    }
  }
  return { logs, complete: true, scannedTo: to };
}
const blockTsCache = new Map();
async function blockTs(rpc, chainKey, bn) {
  const k = chainKey + bn; if (blockTsCache.has(k)) return blockTsCache.get(k);
  const b = await rpc.call('eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
  const ts = parseInt(b.timestamp, 16); blockTsCache.set(k, ts); return ts;
}

async function processChain(dep) {
  const chainKey = dep.chain, c = CFG.chains[chainKey], rpc = rpcFor(chainKey);
  const address = getAddress(dep.address);
  const res = { chain: chainKey, address, ok: false, error: null };
  try {
    const latest = parseInt(await rpc.call('eth_blockNumber', []), 16);
    const code = await rpc.call('eth_getCode', [address, 'latest']);
    res.latestBlock = latest;
    if (code === '0x') { res.error = 'no contract code at address'; return res; }
    log(chainKey, 'latest', latest);
    // ownership (authoritative): ownerOf over all ids
    const { owners, errs } = await ownersViaOwnerOf(rpc, address);
    res.owners = owners; res.ownerOfErrors = errs;
    log(chainKey, 'minted/owned ids', Object.keys(owners).length, 'errors', errs);
    // history: Transfer logs from creation block
    const created = await findCreationBlock(rpc, address, latest);
    res.creationBlock = created;
    const startBlock = created ?? Math.max(0, latest - 500000);
    const budget = chainKey === 'abstract' ? 6 * 60e3 : 4 * 60e3;
    const scan = await scanLogs(rpc, { address, topics: [TRANSFER] }, startBlock, latest, budget);
    res.historyComplete = scan.complete && created != null; res.scannedFrom = startBlock; res.scannedTo = scan.scannedTo;
    log(chainKey, 'transfer logs', scan.logs.length, 'complete', res.historyComplete);
    const transfers = scan.logs.filter(l => l.topics.length === 4).map(l => ({
      block: parseInt(l.blockNumber, 16), tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16),
      from: getAddress('0x' + l.topics[1].slice(26)), to: getAddress('0x' + l.topics[2].slice(26)), id: Number(BigInt(l.topics[3])),
    }));
    res.mintedEver = new Set(transfers.filter(t => t.from === ZERO).map(t => t.id)).size;
    // sales: Seaport OrderFulfilled in txs that moved our tokens (non-mint)
    const txs = [...new Set(transfers.filter(t => t.from !== ZERO).map(t => t.tx))];
    const sales = [];
    await pool(txs, 6, async tx => {
      try {
        const rc = await rpc.call('eth_getTransactionReceipt', [tx]);
        for (const l of rc.logs) {
          if (l.topics[0] !== ORDER_FULFILLED || l.address.toLowerCase() !== CFG.seaport.toLowerCase()) continue;
          const ev = seaportIface.parseLog(l);
          const items = [...ev.args.offer, ...ev.args.consideration];
          const nfts = items.filter(i => (Number(i.itemType) === 2 || Number(i.itemType) === 4) && i.token.toLowerCase() === address.toLowerCase());
          if (!nfts.length) continue;
          const pay = items.filter(i => Number(i.itemType) <= 1);
          const byCur = {};
          pay.forEach(p => { const cur = Number(p.itemType) === 0 ? c.native : p.token; byCur[cur] = (byCur[cur] || 0n) + BigInt(p.amount); });
          const [currency, amt] = Object.entries(byCur).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] || [];
          if (!currency) continue;
          const isNative = currency === c.native;
          sales.push({ chain: chainKey, tx, block: parseInt(l.blockNumber, 16), ids: nfts.map(n => Number(n.identifier)),
            currency: isNative ? c.native : (currency.toLowerCase().includes('4200000000000000000000000000000000000006') || currency.toLowerCase() === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' ? 'WETH' : currency),
            amount: Number(amt) / 1e18, from: ev.args.offerer, to: ev.args.recipient });
        }
      } catch (e) { /* skip */ }
    });
    log(chainKey, 'seaport sales', sales.length);
    // activity: latest 150 transfers + all sales, timestamps
    const recent = transfers.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, 150);
    const blocks = [...new Set([...recent.map(t => t.block), ...sales.map(s => s.block)])];
    await pool(blocks, 6, async b => { try { await blockTs(rpc, chainKey, b); } catch {} });
    const saleTx = new Set(sales.map(s => s.tx));
    res.activity = recent.map(t => ({ type: t.from === ZERO ? 'mint' : saleTx.has(t.tx) ? 'sale-transfer' : 'transfer', chain: chainKey, id: t.id, from: t.from, to: t.to, tx: t.tx, block: t.block, ts: blockTsCache.get(chainKey + t.block) || null }));
    res.sales = sales.map(s => ({ ...s, ts: blockTsCache.get(chainKey + s.block) || null }));
    res.transferCount = transfers.length;
    res.ok = true;
  } catch (e) { res.error = e.message.slice(0, 300); log(chainKey, 'ERROR', res.error); }
  return res;
}

// ---------- 5) OpenSea (optional) ----------
async function opensea(results) {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) return { available: false, reason: 'needs OpenSea API key (set OPENSEA_API_KEY)' };
  const H = { 'x-api-key': key, accept: 'application/json' };
  const out = { available: true, listings: [], stats: {}, events: [] };
  const deps = COL.deployments.filter(d => CFG.chains[d.chain].openseaSlug);
  for (const d of deps) {
    const ch = CFG.chains[d.chain].openseaSlug;
    try {
      const r = await fetchT(`https://api.opensea.io/api/v2/chain/${ch}/contract/${d.address}`, { headers: H });
      const j = await r.json(); const cs = j.collection; if (!cs) continue;
      const st = await (await fetchT(`https://api.opensea.io/api/v2/collections/${cs}/stats`, { headers: H })).json();
      out.stats[d.chain] = { slug: cs, ...st.total };
      let next = '';
      for (let p = 0; p < 20; p++) {
        const lj = await (await fetchT(`https://api.opensea.io/api/v2/listings/collection/${cs}/all?limit=100${next ? '&next=' + next : ''}`, { headers: H })).json();
        for (const l of lj.listings || []) {
          const offer = l.protocol_data?.parameters?.offer?.[0];
          const price = l.price?.current; if (!offer || !price) continue;
          out.listings.push({ chain: d.chain, id: Number(offer.identifierOrCriteria), price: Number(price.value) / 10 ** price.decimals, currency: price.currency, orderHash: l.order_hash });
        }
        if (!lj.next) break; next = lj.next;
      }
      const ej = await (await fetchT(`https://api.opensea.io/api/v2/events/collection/${cs}?event_type=sale&limit=50`, { headers: H })).json();
      for (const e of ej.asset_events || []) {
        const pay = e.payment; if (!pay || !e.nft) continue;
        out.events.push({ type: 'sale', chain: d.chain, id: Number(e.nft.identifier), price: Number(pay.quantity) / 10 ** pay.decimals, currency: pay.symbol, from: e.seller, to: e.buyer, tx: e.transaction, ts: e.event_timestamp, src: 'opensea' });
      }
    } catch (e) { log('opensea', d.chain, e.message); }
  }
  return out;
}

// ---------- main ----------
if (!args.includes('--skip-meta')) await buildMetadata();
let chainResults;
const chainCache = path.join(CACHE, 'chains.json');
if (args.includes('--skip-chain')) chainResults = JSON.parse(await fs.readFile(chainCache, 'utf8'));
else {
  const only = args.find(a => a.startsWith('--chains='))?.slice(9).split(',');
  let prev = []; try { prev = JSON.parse(await fs.readFile(chainCache, 'utf8')); } catch {}
  chainResults = await Promise.all(COL.deployments.map(d => only && !only.includes(d.chain) && prev.find(p => p.chain === d.chain) ? prev.find(p => p.chain === d.chain) : processChain(d)));
  await fs.writeFile(chainCache, JSON.stringify(chainResults));
}

const escrow = new Set([ZERO, DEAD, ...COL.escrow.map(e => e.address.toLowerCase())]);
const isEscrow = a => escrow.has(a.toLowerCase());
const location = {}; // id -> {chain, owner}
const perChain = {};
const holdersAll = new Set();
for (const r of chainResults) {
  const ow = r.owners || {};
  const hs = new Set(); let inEscrow = 0;
  for (const [tid, o] of Object.entries(ow)) {
    if (isEscrow(o)) { inEscrow++; continue; }
    hs.add(o.toLowerCase()); holdersAll.add(o.toLowerCase());
    if (!location[tid] || r.chain === 'abstract' && false) location[tid] = { chain: r.chain, owner: o };
    else (location[tid].also ??= []).push({ chain: r.chain, owner: o });
  }
  const vol = {};
  (r.sales || []).forEach(s => { vol[s.currency] = (vol[s.currency] || 0) + s.amount; });
  perChain[r.chain] = { ok: r.ok, error: r.error, address: r.address, latestBlock: r.latestBlock, creationBlock: r.creationBlock,
    minted: Object.keys(ow).length, inEscrow, live: Object.keys(ow).length - inEscrow, holders: hs.size,
    mintedEver: r.mintedEver ?? null, transfers: r.transferCount ?? null, historyComplete: !!r.historyComplete,
    scannedFrom: r.scannedFrom, scannedTo: r.scannedTo, sales: (r.sales || []).length, volume: vol, ownerOfErrors: r.ownerOfErrors };
}
const os = await opensea(chainResults);
const listings = os.available ? os.listings : [];
// Floor compares like with like: only ETH-denominated listings (ETH/WETH) are compared across chains; APE/BNB floors are kept per chain.
// Convert non-ETH listings to ETH: live CoinGecko rate at build time, fallback to user-provided rate (160 APE = 0.01 ETH).
const FALLBACK_RATES = { APE: { eth: 0.0000625, source: 'user-provided (160 APE = 0.01 ETH)' } };
const rates = { ETH: { eth: 1, source: 'unit' }, WETH: { eth: 1, source: 'unit' } };
try {
  const r = await (await fetchT('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,apecoin,binancecoin&vs_currencies=usd', {}, 15000)).json();
  const e = r.ethereum?.usd; const at = new Date().toISOString();
  if (e && r.apecoin?.usd) rates.APE = { eth: r.apecoin.usd / e, usd: r.apecoin.usd, ethUsd: e, source: 'coingecko', at };
  if (e && r.binancecoin?.usd) rates.BNB = { eth: r.binancecoin.usd / e, usd: r.binancecoin.usd, ethUsd: e, source: 'coingecko', at };
} catch (e) { log('coingecko failed', e.message); }
for (const [k, v] of Object.entries(FALLBACK_RATES)) rates[k] ??= v;
listings.forEach(l => { const r = rates[l.currency]; l.priceEth = r ? +(l.price * r.eth).toPrecision(6) : null; });
const ethL = listings.filter(l => l.priceEth != null);
const floor = ethL.length ? ethL.reduce((a, b) => (a.priceEth <= b.priceEth ? a : b)) : null;
const floorByChain = {}; listings.forEach(l => { if (!floorByChain[l.chain] || l.price < floorByChain[l.chain].price) floorByChain[l.chain] = l; });
const volTotal = {};
if (os.available && Object.keys(os.stats).length) {
  for (const [ch, st] of Object.entries(os.stats)) { perChain[ch].onchainVolume = perChain[ch].volume; perChain[ch].volume = st.volume ? { [st.volume_symbol]: st.volume } : {}; perChain[ch].osSales = st.sales; perChain[ch].osOwners = st.num_owners; perChain[ch].osFloor = st.floor_price; }
  for (const ch of Object.keys(perChain)) if (!os.stats[ch]) { perChain[ch].onchainVolume = perChain[ch].volume; }
}
Object.values(perChain).forEach(p => Object.entries(p.volume).forEach(([k, v]) => { volTotal[k] = (volTotal[k] || 0) + v; }));
const activity = [
  ...chainResults.flatMap(r => r.activity || []).filter(a => a.type !== 'sale-transfer'),
  ...(os.events || []),
  ...chainResults.flatMap(r => r.sales || []).filter(s => !(os.events || []).some(e => e.tx?.toLowerCase() === s.tx.toLowerCase())).map(s => ({ type: 'sale', chain: s.chain, id: s.ids[0], ids: s.ids, price: s.amount, currency: s.currency, from: s.from, to: s.to, tx: s.tx, block: s.block, ts: s.ts })),
].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 400);

const summary = {
  slug, generatedAt: new Date().toISOString(), items: COL.supply,
  owners: holdersAll.size, perChain, volume: volTotal,
  volumeSource: os.available ? 'opensea' : 'onchain-seaport-1.6',
  listingsAvailable: os.available, listingsReason: os.available ? null : os.reason,
  listedCount: os.available ? new Set(listings.map(l => l.id)).size : null,
  floor, floorByChain, rates, openseaStats: os.stats || null,
  livePlaced: Object.keys(location).length,
};
await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
await fs.writeFile(path.join(OUT, 'owners.json'), JSON.stringify(location));
await fs.writeFile(path.join(OUT, 'listings.json'), JSON.stringify(listings));
await fs.writeFile(path.join(OUT, 'activity.json'), JSON.stringify(activity));
log('DONE owners', summary.owners, JSON.stringify(Object.fromEntries(Object.entries(perChain).map(([k, v]) => [k, { minted: v.minted, holders: v.holders, esc: v.inEscrow, sales: v.sales, err: v.error }]))));
