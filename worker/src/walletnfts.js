// Public profile gallery. MultiSea collections (LIL FOOTS, Island's) are read authoritatively on-chain
// on every gallery chain so a just-sent or just-received token shows up without waiting on OpenSea.
import { parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)', 'function balanceOf(address,uint256) view returns (uint256)']);
const AGG = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
export function makeWalletNfts({ CFG, rpcFanout, accountNfts, bad, ADDR }) {
  const keys = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
  async function onchain(address, selected) {
    const nfts = [], errors = [], scanned = new Set(), failedChains = new Set();
    const call = async (chain, to, data) => {
      const j = await rpcFanout(CFG.chains[chain], { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
      if (j.error || !j.result || j.result === '0x') throw Error(j.error?.message || 'Empty RPC result');
      return j.result;
    };
    const multi = async (chain, token, fn, args) => {
      const result = await call(chain, MC, encodeFunctionData({ abi: AGG, functionName: 'aggregate3', args: [args.map(a => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: ABI, functionName: fn, args: a }) }))] }));
      return decodeFunctionResult({ abi: AGG, functionName: 'aggregate3', data: result });
    };
    for (const col of CFG.collections) for (const dep of col.deployments.filter(d => selected.includes(d.chain))) {
      const chain = dep.chain, token = dep.address;
      try {
        const is1155 = /1155/i.test(col.standard);
        const add = (id, quantity = 1n) => nfts.push({ chain, contract: token.toLowerCase(), id: String(id), name: col.slug === 'lil-foots' ? `LIL FOOT #${id}` : `${col.name} #${id}`, collection: col.slug, image: col.slug === 'lil-foots' ? `/img/lil-foots/s/${id}.webp` : col.imageBase ? col.imageBase + id : null, standard: is1155 ? 'erc1155' : 'erc721', quantity: String(quantity) });
        const start = Number(col.idStart ?? 0), end = Number(col.idEnd ?? (start + col.supply - 1));
        if (!Number.isSafeInteger(end) || end - start > 20000) throw Error('Collection ID range unavailable');
        let balance = null;
        if (!is1155) {
          balance = BigInt(await call(chain, token, '0x70a08231' + address.slice(2).padStart(64, '0')));
          scanned.add(chain + ':' + token.toLowerCase());
          if (!balance) continue;
          if (balance > 20000n) throw Error('Collection balance exceeds scan limit');
          // ERC721Enumerable, when implemented, avoids a full ID sweep.
          const first = await multi(chain, token, 'tokenOfOwnerByIndex', [[address, 0n]]);
          if (first[0].success) {
            add(BigInt(first[0].returnData));
            for (let i = 1; i < Number(balance); i += 300) {
              const out = await multi(chain, token, 'tokenOfOwnerByIndex', Array.from({ length: Math.min(300, Number(balance) - i) }, (_, n) => [address, BigInt(i + n)]));
              if (out.some(x => !x.success)) throw Error('Incomplete owner enumeration');
              out.forEach(x => add(BigInt(x.returnData)));
            }
            continue;
          }
        }
        let found = 0;
        for (let i = start; i <= end && (is1155 || found < Number(balance)); i += 300) {
          const ids = Array.from({ length: Math.min(300, end - i + 1) }, (_, n) => i + n);
          const out = await multi(chain, token, is1155 ? 'balanceOf' : 'ownerOf', ids.map(id => is1155 ? [address, BigInt(id)] : [BigInt(id)]));
          out.forEach((x, n) => { if (!x.success) return; if (is1155) { const v = BigInt(x.returnData); if (v) add(ids[n], v); } else if (('0x' + x.returnData.slice(-40)).toLowerCase() === address) { add(ids[n]); found++; } });
        }
        if (is1155) scanned.add(chain + ':' + token.toLowerCase());
        else if (found !== Number(balance)) throw Error('Incomplete ID range or RPC read');
      } catch (e) { scanned.delete(chain + ':' + token.toLowerCase()); failedChains.add(chain); errors.push(`${col.name} on ${CFG.chains[chain]?.name || chain}: ${String(e.message).slice(0, 100)}`); }
    }
    return { nfts, errors, scanned, failedChains };
  }
  return async (req, env, url, p, M) => {
    if (M !== 'GET' || p[0] !== 'wallet' || p[2] !== 'nfts' || p.length !== 3) return undefined;
    if (!ADDR.test(p[1])) bad('invalid address');
    const address = p[1].toLowerCase(), want = url.searchParams.get('chain') || '', next = url.searchParams.get('next') || '';
    if (want && !keys.includes(want)) bad('unsupported chain');
    if (next.length > 400 || (next && !want)) bad('bad cursor');
    const selected = want ? [want] : keys;
    const cache = caches.default, cacheReq = new Request('https://cache.multisea/wallet-nfts/' + address + '?' + new URLSearchParams({ chain: want, next }));
    const hit = await cache.match(cacheReq);
    // fresh=1 always re-reads (used after Send and Refresh) so a just-moved MultiSea NFT is not served from cache.
    if (hit && url.searchParams.get('fresh') !== '1') { const j = await hit.json(); return { ...j, cached: true }; }
    const parts = await Promise.all(selected.map(async k => {
      if (!CFG.chains[k]?.openseaSlug) return { nfts: [], error: null, unsupported: true };
      if (!env.OPENSEA_API_KEY) return { nfts: [], error: 'OpenSea unavailable' };
      return accountNfts(env, address, k, next);
    }));
    const owned = !next ? await onchain(address, selected) : { nfts: [], errors: [], scanned: new Set(), failedChains: new Set() };
    const fromIndex = parts.flatMap(x => x.nfts).filter(n => !owned.scanned.has(n.chain + ':' + String(n.contract).toLowerCase()));
    const dedup = new Map([...fromIndex, ...owned.nfts].map(n => [n.chain + ':' + n.contract.toLowerCase() + ':' + n.id, n]));
    const failed = selected.filter((k, i) => parts[i].error || owned.failedChains.has(k));
    const result = { address, nfts: [...dedup.values()], failed, unsupported: selected.filter((k, i) => parts[i].unsupported), cursors: Object.fromEntries(selected.map((k, i) => [k, parts[i].next]).filter(([, n]) => n)), notes: !next ? ['MultiSea collections (LIL FOOTS, Island\'s) are read on-chain; other collections depend on OpenSea indexing.', ...owned.errors] : [], at: Date.now() };
    await cache.put(cacheReq, new Response(JSON.stringify(result), { headers: { 'cache-control': `public, max-age=${failed.length ? 10 : 30}` } }));
    return result;
  };
}
