// GET /islands/wallet-nfts: how many NFTs each Island's ERC-6551 wallets hold, summed over the 5 chains (each chain has its
// own wallet address: Tokenbound V3 proxy, salt 0, bound to that chain's drop contract). The Island itself is not counted.
// Base / Ethereum / ApeChain / BNB: thirdweb Insight owned NFTs (any collection), 20 wallets per request (Insight's cap).
// Robinhood is not on Insight and its RPCs refuse wide eth_getLogs, so there we read balanceOf of the static ERC-721
// collections deployed on Robinhood (one multicall). Cached 10 min (1 min if a chain failed).
import { concat, encodeAbiParameters, getContractAddress, encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
const INSIGHT = 'https://insight.thirdweb.com';
const INSIGHT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb'];
const REG = '0x000000006551c19487814612e58FE06813775758', PROXY = '0x55266d75D1a14E4572138116aF39863Ed6596E7F', Z = '0x' + '0'.repeat(64);
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)']);
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
  async function build(env) {
    const counts = Object.fromEntries(ids.map(i => [i, 0])); const failed = [];
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
    }));
    return { counts: Object.fromEntries(Object.entries(counts).filter(([, v]) => v > 0)), failed, at: Math.floor(Date.now() / 1000) };
  }
  return async function handle(req, env, url, p, M) {
    if (!(M === 'GET' && p[0] === 'islands' && p[1] === 'wallet-nfts' && p.length === 2)) return undefined;
    const key = new Request('https://cache.multisea/island-wallet-nfts:v1');
    const hit = await caches.default.match(key); if (hit) return hit.json();
    const v = await build(env);
    await caches.default.put(key, new Response(JSON.stringify(v), { headers: { 'cache-control': `public, max-age=${v.failed.length ? 60 : 600}` } }));
    return v;
  };
}
