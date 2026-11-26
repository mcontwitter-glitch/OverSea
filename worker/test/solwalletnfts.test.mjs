import assert from 'node:assert/strict';
import { encodeFunctionResult, parseAbi } from 'viem';
import { makeSolWalletNfts } from '../src/solwalletnfts.js';
import { findPda, storePdaOf, b58 } from '../src/solswitch.js';
import { b58decode } from '../src/solanalink.js';
import { SOL_RPCS } from '../src/solrpc.js';

const PID = 'ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH';
const CID = '0x03e2138e8ea4a2e7059bf4e43fe5f888fe6fd944fd42921f300efe55fac9852d';
const HOLDER = 'FMNGFgvGQ2RczDdopo5Z6KURRqEkJqwfyiefouMw5zjo';
const OTHER = '625MJ4WFA3y3AsikRsgnwGQvvPhPD2bw38UjzRKcTQiu';
const S = s => new TextEncoder().encode(s);
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const hex32 = h => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map(x => parseInt(x, 16)));
const asset = id => findPda([S('Asset'), hex32(CID), le32(id)], PID);
const colPda = findPda([S('Collection'), hex32(CID)], PID);

assert.equal(asset(80), 'GDXDedY2bRzs71B4QikPwP9Pzugv1ZrcLo1iveAtUmUX');
assert.ok(SOL_RPCS.includes('https://solana.api.pocket.network'));
assert.ok(SOL_RPCS.includes('https://api.tatum.io/v3/blockchain/node/solana-mainnet'));
assert.ok(SOL_RPCS.includes('https://solana-rpc.publicnode.com'));

function acc(owner) {
  const d = new Uint8Array(40); d[0] = 1; d.set(b58decode(owner), 1);
  return { data: [Buffer.from(d).toString('base64'), 'base64'] };
}
const store = storePdaOf(PID);
const byKey = new Map([
  [colPda, acc(store)],
  [asset(11), acc(OTHER)],
  [asset(80), acc(HOLDER)],
  [asset(50), acc(store)],
]);
for (let id = 1; id <= 100; id++) if (!byKey.has(asset(id))) byKey.set(asset(id), acc(store));

const cache = new Map();
globalThis.caches = { default: { match: async r => cache.get(r.url)?.clone(), put: async (r, v) => { cache.set(r.url, v.clone()); } } };
const ABI = parseAbi(['function collectionId() view returns (bytes32)']);
let rpcCalls = 0;
const solRpc = async payload => {
  rpcCalls++;
  assert.equal(payload.method, 'getMultipleAccounts');
  const keys = payload.params[0];
  return { result: { value: keys.map(k => byKey.get(k) || null) } };
};
const rpcFanout = async () => ({ result: encodeFunctionResult({ abi: ABI, functionName: 'collectionId', result: CID }) });
const CFG = {
  chains: { base: { name: 'Base', rpc: 'https://example.invalid' } },
  collections: [{
    slug: 'multi-islands', name: "Island's", standard: 'ERC721', supply: 100, idStart: 1, idEnd: 100,
    escrow: [{ chain: 'base', address: '0x6CB09C1Fca57540607f08273c9cD6335287374Ad' }],
    deployments: [{ chain: 'base', address: '0x5a54e10a40320d6285bdfa323e44b7abecfe87ef', original: true }, { chain: 'ethereum', address: '0x510b1be747304dd83b296279ccf18ca3a3fbfe88' }],
  }],
};
const handle = makeSolWalletNfts({ CFG, rpcFanout, bad: m => { throw Error(m); }, solRpc });
const env = { COLLECTIONS: { get: async () => ({ programId: PID }), put: async () => {} } };
const run = (addr, query = '') => {
  const req = new Request('https://api.multisea.io/wallet/' + addr + '/nfts' + query);
  return handle(req, env, new URL(req.url), ['wallet', addr, 'nfts'], 'GET');
};

const r = await run(HOLDER);
const ids = r.nfts.map(n => n.id).sort((a, b) => +a - +b);
assert.deepEqual(ids, ['80']);
const n = r.nfts[0];
assert.equal(n.chain, 'solana');
assert.equal(n.contract, asset(80));
assert.equal(n.name, "Island's #80");
assert.equal(n.collection, 'multi-islands');
assert.equal(n.standard, 'mpl-core');
assert.equal(n.href, '/c/multi-islands?item=80');
assert.deepEqual(r.failed, []);
assert.equal(r.address, HOLDER);

const other = await run(OTHER);
assert.deepEqual(other.nfts.map(n => n.id), ['11']);

const empty = await run('11111111111111111111111111111111');
assert.deepEqual(empty.nfts, []);

const cachedCalls = rpcCalls;
const cached = await run(HOLDER);
assert.equal(cached.cached, true);
assert.equal(rpcCalls, cachedCalls, 'cache hit must not scan again');
assert.equal(cached.nfts[0].id, '80');

const fresh = await run(HOLDER, '?fresh=1');
assert.equal(fresh.cached, undefined);
assert.ok(rpcCalls > cachedCalls, 'fresh=1 rescans');
assert.equal(fresh.nfts[0].id, '80');

await assert.rejects(() => run(HOLDER, '?chain=base'), /unsupported chain/);
assert.equal(await handle(new Request('https://x'), env, new URL('https://x/'), ['wallet', '0x1111111111111111111111111111111111111111', 'nfts'], 'GET'), undefined, 'EVM addresses are left to the EVM gallery');

console.log('PASS Solana wallet NFTs: Island #80 for its holder, locked copies omitted, cache, fresh=1, validation');
