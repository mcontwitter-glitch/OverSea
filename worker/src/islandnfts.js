// GET /islands/wallet-nfts: how many NFTs each Island's ERC-6551 wallets hold, summed over the 5 chains (each chain has its
// own wallet address: Tokenbound V3 proxy, salt 0, bound to that chain's drop contract). The Island itself is not counted.
// Base / Ethereum / ApeChain / BNB: thirdweb Insight owned NFTs (any collection), 20 wallets per request (Insight's cap).
// Robinhood is not on Insight and its RPCs refuse wide eth_getLogs, so there we read balanceOf of the static ERC-721
// collections deployed on Robinhood (one multicall). Also the USD value of the coins + tokens in each Island's 5 wallets
// (Multicall3 getEthBalance + ERC-20 balanceOf per chain; token list = src/islandkit.ts ISLAND_TOKENS, keep in sync;
// prices from CoinGecko like the site). Kept in KV for 10 min (1 min if a chain failed), edge-cached 60 s in front.
import { concat, encodeAbiParameters, getContractAddress, encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
const INSIGHT = 'https://insight.thirdweb.com';
const INSIGHT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb'];
const REG = '0x000000006551c19487814612e58FE06813775758', PROXY = '0x55266d75D1a14E4572138116aF39863Ed6596E7F', Z = '0x' + '0'.repeat(64);
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function getEthBalance(address) view returns (uint256)']);
// [address, decimals, price key]; native coin price key per chain in NATIVE_PX.
const TOKENS = {
  base: [['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6, 'USD'], ['0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', 6, 'USD'], ['0x4200000000000000000000000000000000000006', 18, 'ETH']],
  ethereum: [['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, 'USD'], ['0xdac17f958d2ee523a2206206994597c13d831ec7', 6, 'USD'], ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18, 'ETH'], ['0x4d224452801aced8b2f0aebe155379bb5d594381', 18, 'APE'], ['0xB8c77482e45F1F44dE1745F52C74426C631bDD52', 18, 'BNB']],
  apechain: [['0x48b62137EdfA95a428D35C09E44256a739F6B557', 18, 'APE'], ['0xA2235d059F80e176D931Ef76b6C51953Eb3fBEf4', 18, 'USD'], ['0xcF800F4948D16F23333508191B1B1591daF70438', 18, 'ETH'], ['0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949', 18, 'ETH']],
  bnb: [['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18, 'USD'], ['0x55d398326f99059ff775485246999027b3197955', 18, 'USD'], ['0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18, 'ETH'], ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18, 'BNB']],
  robinhood: [['0x5fc5360d0400a0fd4f2af552add042d716f1d168', 6, 'USD']],
};
const NATIVE_PX = { base: 'ETH', ethereum: 'ETH', apechain: 'APE', bnb: 'BNB', robinhood: 'ETH' };
const units = (v, d) => Number(v) / 10 ** d;
const AGG = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const tba = (chainId, drop, id) => getContractAddress({ opcode: 'CREATE2', from: REG, salt: Z, bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', PROXY, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [Z, BigInt(chainId), drop, BigInt(id)])]) }).toLowerCase();

export function makeIslandNfts({ CFG, chains, lc, rpcFanout, cached }) {
  const col = CFG.collections.find(c => c.slug === 'multi-islands');
  const start = Number(col.idStart ?? 1), end = Number(col.idEnd);
  const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const deps = col.deployments.filter(d => chains[d.chain]);
  async function insight(env, k, drop, addrs) {
    const out = [];
    await Promise.all(Array.from({ length: Math.ceil(addrs.length / 20) }, (_, b) => b * 20).map(async s => {
      for (let page = 0; page < 5; page++) {
        const u = new URL(`${INSIGHT}/v1/nfts`);
        u.searchParams.set('chain_id', String(chains[k].chainId)); u.searchParams.set('limit', '1000'); u.searchParams.set('page', String(page)); u.searchParams.set('metadata', 'false');
        addrs.slice(s, s + 20).forEach(a => u.searchParams.append('owner_address', a));
        const r = await fetch(u, { headers: { 'x-client-id': env.THIRDWEB_CLIENT_ID || 'db9c090161e29abd52e311fef0d97aea', origin: 'https://multisea.io' }, signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error(`insight ${k} ${r.status}`);
        const d = (await r.json())?.data || [];
        out.push(...d.map(x => ({ contract: lc(x.contract_address), id: String(x.token_id), owners: (x.owner_addresses || []).map(lc), bal: Number(x.balance || 1) || 1 })));
        if (d.length < 1000) break;
      }
    }));
    return out;
  }
  async function onchainCounts(k, addrs) {
    const toks = CFG.collections.filter(c => !/1155/i.test(c.standard || '')).flatMap(c => c.deployments.filter(d => d.chain === k).map(d => ({ address: lc(d.address), islands: c.slug === 'multi-islands' })));
    const calls = toks.flatMap(t => addrs.map(a => ({ target: t.address, allowFailure: false, callData: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [a] }) })));
    const drop = toks.find(t => t.islands);
    if (drop) ids.forEach(i => calls.push({ target: drop.address, allowFailure: true, callData: encodeFunctionData({ abi: ABI, functionName: 'ownerOf', args: [BigInt(i)] }) }));
    const j = await rpcFanout(chains[k], { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MC, data: encodeFunctionData({ abi: AGG, functionName: 'aggregate3', args: [calls] }) }, 'latest'] });
    if (j.error || !j.result || j.result === '0x') throw new Error(j.error?.message || 'empty result');
    const res = decodeFunctionResult({ abi: AGG, functionName: 'aggregate3', data: j.result });
    const n = addrs.map(() => 0);
    toks.forEach((t, ti) => addrs.forEach((_, ai) => { n[ai] += Number(BigInt(res[ti * addrs.length + ai].returnData)); }));
    if (drop) ids.forEach((_, ai) => { const r = res[toks.length * addrs.length + ai]; if (r.success && ('0x' + r.returnData.slice(-40)).toLowerCase() === addrs[ai]) n[ai] -= 1; }); // the Island itself
    return n;
  }
  async function aggregate(k, calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 300) {
      const j = await rpcFanout(chains[k], { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MC, data: encodeFunctionData({ abi: AGG, functionName: 'aggregate3', args: [calls.slice(i, i + 300)] }) }, 'latest'] });
      if (j.error || !j.result || j.result === '0x') throw new Error(j.error?.message || 'empty result');
      out.push(...decodeFunctionResult({ abi: AGG, functionName: 'aggregate3', data: j.result }));
    }
    return out;
  }
  // CoinGecko (same as the site) first; it often refuses Cloudflare Worker IPs, so Coinbase spot prices are the fallback.
  async function rates() {
    const ok = r => r.ETH && r.APE && r.BNB;
    try {
      const j = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,apecoin,binancecoin&vs_currencies=usd', { headers: { accept: 'application/json', 'user-agent': 'multisea-api' }, signal: AbortSignal.timeout(8000) }).then(r => r.json());
      const r = { USD: 1, ETH: j?.ethereum?.usd, APE: j?.apecoin?.usd, BNB: j?.binancecoin?.usd }; if (ok(r)) return r;
    } catch {}
    const cb = async s => +(await fetch(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, { headers: { 'user-agent': 'multisea-api' }, signal: AbortSignal.timeout(8000) }).then(r => r.json()))?.data?.amount || null;
    const [ETH, APE, BNB] = await Promise.all(['ETH', 'APE', 'BNB'].map(s => cb(s).catch(() => null)));
    const r = { USD: 1, ETH, APE, BNB }; if (!ok(r)) throw new Error('rates'); return r;
  }
  /** USD of native + listed ERC-20s in each wallet on chain k (array aligned with addrs). */
  async function usdOn(k, addrs, px) {
    const toks = TOKENS[k] || [];
    const calls = addrs.flatMap(a => [{ target: MC, allowFailure: false, callData: encodeFunctionData({ abi: ABI, functionName: 'getEthBalance', args: [a] }) }, ...toks.map(t => ({ target: t[0], allowFailure: true, callData: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [a] }) }))]);
    const res = await aggregate(k, calls); const n = 1 + toks.length;
    return addrs.map((_, i) => { const r = res.slice(i * n, i * n + n); let v = units(BigInt(r[0].returnData), 18) * px[NATIVE_PX[k]]; toks.forEach((t, j) => { const x = r[j + 1]; if (x.success && x.returnData.length >= 66) v += units(BigInt(x.returnData.slice(0, 66)), t[1]) * px[t[2]]; }); return v; });
  }
  async function build(env) {
    const counts = Object.fromEntries(ids.map(i => [i, 0])); const usd = Object.fromEntries(ids.map(i => [i, 0])); const failed = [];
    const px = await rates().catch(e => { failed.push('prices'); console.warn('island usd rates', e?.message); return null; });
    await Promise.all(deps.map(async d => {
      const k = d.chain, drop = lc(d.address); const addrs = ids.map(i => tba(chains[k].chainId, drop, i));
      try {
        if (INSIGHT_CHAINS.includes(k)) {
          const byAddr = new Map(addrs.map((a, i) => [a, ids[i]]));
          for (const x of await insight(env, k, drop, addrs)) for (const o of x.owners) {
            const id = byAddr.get(o); if (id == null) continue;
            if (x.contract === drop && x.id === String(id)) continue; // the Island itself
            counts[id] += x.bal;
          }
        } else (await onchainCounts(k, addrs)).forEach((v, i) => { counts[ids[i]] += Math.max(0, v); });
      } catch (e) { failed.push(k); console.warn('island nfts', k, e?.message); }
      if (px) try { (await usdOn(k, addrs, px)).forEach((v, i) => { usd[ids[i]] += v; }); } catch (e) { if (!failed.includes(k)) failed.push(k); console.warn('island usd', k, e?.message); }
    }));
    return { counts: Object.fromEntries(Object.entries(counts).filter(([, v]) => v > 0)), usd: px ? Object.fromEntries(Object.entries(usd).filter(([, v]) => v >= 0.005).map(([i, v]) => [i, Math.round(v * 100) / 100])) : {}, failed, at: Math.floor(Date.now() / 1000) };
  }
  return async function handle(req, env, url, p, M) {
    if (!(M === 'GET' && p[0] === 'islands' && p[1] === 'wallet-nfts' && p.length === 2)) return undefined;
    const key = new Request('https://cache.multisea/island-wallet-nfts:v3');
    const hit = await caches.default.match(key); if (hit) return hit.json();
    const KV = env.COLLECTIONS, kk = 'cache:island-wallets:v3'; const now = Math.floor(Date.now() / 1000);
    let v = KV ? await KV.get(kk, 'json').catch(() => null) : null;
    if (!v || now - v.at > (v.failed?.length ? 60 : 600)) { v = await build(env); if (KV) await KV.put(kk, JSON.stringify(v), { expirationTtl: 3600 }).catch(() => {}); }
    await caches.default.put(key, new Response(JSON.stringify(v), { headers: { 'cache-control': 'public, max-age=60' } }));
    return v;
  };
}
