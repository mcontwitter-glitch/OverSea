import assert from 'node:assert/strict';
import { parseAbi, decodeFunctionData, encodeFunctionResult, encodeAbiParameters } from 'viem';
import { makeWalletNfts } from '../src/walletnfts.js';
const address = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222';
const AGG = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const cache = new Map(); globalThis.caches = { default: { match: async r => cache.get(r.url)?.clone(), put: async (r, v) => { cache.set(r.url, v.clone()); } } };
const CFG = { chains: Object.fromEntries(['base', 'ethereum', 'apechain', 'bnb', 'robinhood'].map(k => [k, { name: k, openseaSlug: k === 'bnb' ? null : k }])), collections: [{ name: 'Test', slug: 'test', standard: 'ERC721', idStart: 1, idEnd: 3, deployments: [{ chain: 'robinhood', address: token }] }] };
let broken = false;
const rpcFanout = async (_c, j) => {
  if (broken) throw Error('RPC unavailable');
  const d = j.params[0].data;
  if (d.startsWith('0x70a08231')) return { result: encodeAbiParameters([{ type: 'uint256' }], [1n]) };
  const { args } = decodeFunctionData({ abi: AGG, data: d });
  return { result: encodeFunctionResult({ abi: AGG, functionName: 'aggregate3', result: args[0].map(x => {
    // Enumerable deliberately reverts; only token #2 belongs to our test address.
    if (!x.callData.startsWith('0x6352211e')) return { success: false, returnData: '0x' };
    const id = BigInt('0x' + x.callData.slice(10));
    return { success: true, returnData: encodeAbiParameters([{ type: 'address' }], [id === 2n ? address : token]) };
  }) }) };
};
const handle = makeWalletNfts({ CFG, rpcFanout, accountNfts: async (_env, _a, k) => ({ nfts: k === 'base' ? [{ chain: k, contract: token, id: '7', standard: 'erc1155' }] : [], next: k === 'base' ? 'cursor2' : null }), bad: m => { throw Error(m); }, ADDR: /^0x[0-9a-f]{40}$/i });
const req = new Request('https://api.multisea.io/wallet/' + address + '/nfts');
const run = query => handle(req, { OPENSEA_API_KEY: 'test' }, new URL(req.url + query), ['wallet', address, 'nfts'], 'GET');
const result = await run('');
assert.equal(result.nfts.find(n => n.chain === 'robinhood').id, '2');
assert.equal(result.nfts.find(n => n.chain === 'base').standard, 'erc1155');
assert.deepEqual(result.unsupported, ['bnb']); assert.deepEqual(result.failed, []); assert.equal(result.cursors.base, 'cursor2');
assert.equal((await run('')).cached, true);
cache.clear(); broken = true; assert.ok((await run('')).failed.includes('robinhood'));
await assert.rejects(() => run('?chain=invalid'), /unsupported chain/);
console.log('PASS public NFT endpoint: Robinhood balance/ownerOf fallback, chain isolation, cursors, cache, validation');
