// Direct listings (factory.list paid by a collection owner): verify -> queue -> refuel -> mirrors -> wire -> bcol, pauses, scan backstop.
import test from 'node:test'; import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbi, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeBridgeAuto } from '../src/bridgeauto.js';
import { makeLinkBridge } from '../src/bridgelink.js';

const FAC = parseAbi(['event Listed(uint256 indexed id, address indexed nft, address indexed owner, address escrow, uint32[] eids, uint256 fee)', 'event MirrorDeployed(uint256 indexed listingId, address mirror, address escrow)']);
const ZERO = '0x' + '0'.repeat(40); const lc = s => String(s || '').toLowerCase();
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const CH = { robinhood: { eid: 30416, f: addr(0xf1), r: addr(0xa1) }, ethereum: { eid: 30101, f: addr(0xf2), r: addr(0xa2) }, base: { eid: 30184, f: addr(0xf3), r: addr(0xa3) } };
const ETH = 10n ** 18n;
const bcfg = { network: 'mainnet', setupGas: 1_000_000, chains: Object.fromEntries(Object.entries(CH).map(([k, v], i) => [k, { name: k, chainId: i + 1, eid: v.eid, native: 'ETH', rpc: 'x', factory: v.f, refuel: v.r }])) };
const mkKV = () => { const m = new Map(); return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); }, list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) }; };
const listedLog = (chain, { id, nft, owner, escrow, eids, fee = 5n }) => ({ address: CH[chain].f, topics: encodeEventTopics({ abi: FAC, eventName: 'Listed', args: { id, nft, owner } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint32[]' }, { type: 'uint256' }], [escrow, eids, fee]), blockNumber: 100n, transactionHash: '0x' + 'ab'.repeat(32) });

// A tiny chain world: balances, NFT contracts, factories, receipts. Nothing leaves the process.
function world(opts = {}) {
  const pk = generatePrivateKey(); const op = privateKeyToAccount(pk).address;
  const W = { pk, op, sent: [], bal: { robinhood: 5n * ETH, ethereum: 0n, base: 0n }, gp: 1n, dropOnRefuel: true, receipts: {}, logs: {}, escrowOf: {}, txFrom: {}, nfts: {}, head: { robinhood: 1000, ethereum: 1000, base: 1000 }, n: 0 };
  W.nfts[addr(0xdd97)] = { name: 'Claymons', symbol: 'CLAYMON', totalSupply: 5225n, baseURI: 'ipfs://Qm/', ids: new Set([...Array(5225).keys()].map(i => i + 1)), ...(opts.nft || {}) };
  const chainOf = a => Object.keys(CH).find(k => lc(CH[k].f) === lc(a) || lc(CH[k].r) === lc(a));
  const mk = (c, k, key) => ({
    pub: {
      readContract: async ({ address, functionName: fn, args = [] }) => {
        const nft = W.nfts[lc(address)];
        if (nft) { if (fn === 'name') return nft.name; if (fn === 'symbol') return nft.symbol; if (fn === 'totalSupply') { if (nft.totalSupply == null) throw new Error('revert'); return nft.totalSupply; } if (fn === 'baseURI') { if (!nft.baseURI) throw new Error('revert'); return nft.baseURI; }
          if (fn === 'tokenURI') { if (!nft.ids.has(Number(args[0]))) throw new Error('revert'); return (nft.baseURI || 'ipfs://x/') + args[0]; } if (fn === 'ownerOf') { if (!nft.ids.has(Number(args[0]))) throw new Error('revert'); return addr(0x77); } throw new Error('revert ' + fn); }
        if (fn === 'escrowOf') return W.escrowOf[k + ':' + lc(args[0])] || ZERO;
        if (fn === 'quote') return 1000n;
        if (fn === 'operators') return lc(args[0]) === lc(W.op);
        if (fn === 'gasWallet') return W.op;
        if (fn === 'getPrepaid') return { payer: ZERO, eids: [] };
        throw new Error('unmocked read ' + fn);
      },
      getBalance: async ({ address }) => (lc(address) === lc(W.op) ? W.bal[k] : 0n), getGasPrice: async () => W.gp, getBlockNumber: async () => BigInt(W.head[k]),
      getTransactionReceipt: async ({ hash }) => W.receipts[hash] || null, waitForTransactionReceipt: async ({ hash }) => W.receipts[hash],
      getLogs: async ({ fromBlock, toBlock }) => (W.logs[k] || []).filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      getTransaction: async ({ hash }) => ({ from: W.txFrom[hash] || addr(0x01) }),
    },
    wal: key ? { writeContract: async ({ address, functionName: fn, args, value }) => {
      const ck = chainOf(address); W.sent.push({ chain: ck || k, fn, args, address });
      if (fn !== 'refuel' && W.bal[k] < 1n) throw new Error('insufficient funds for gas');
      const hash = keccak256(toHex('tx' + (++W.n))); let logs = [];
      if (fn === 'deployMirror') { const m = addr(0x9000 + W.n), e = addr(0x8000 + W.n); logs = [{ address: address, topics: encodeEventTopics({ abi: FAC, eventName: 'MirrorDeployed', args: { listingId: args[0] } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [m, e]) }]; }
      if (fn === 'refuel' && W.dropOnRefuel) { const [dsts, amts] = args; dsts.forEach((d, i) => { const kk = Object.keys(CH).find(x => CH[x].eid === d); W.bal[kk] += amts[i]; }); W.bal[k] -= (value || 0n); }
      W.receipts[hash] = { status: 'success', logs, blockNumber: 200n + BigInt(W.n), gasUsed: 1n }; return hash; } } : null,
  });
  return W.mk = mk, W;
}
const listing = (W, over = {}) => { const nft = addr(0xdd97), escrow = addr(0xe5c), eids = over.eids || [CH.robinhood.eid, CH.ethereum.eid, CH.base.eid];
  W.escrowOf['robinhood:' + lc(nft)] = escrow; const hash = '0x' + 'cd'.repeat(32); W.receipts[hash] = { status: 'success', blockNumber: 100n, logs: [listedLog('robinhood', { id: 1n, nft, owner: addr(0x76ad), escrow, eids })] }; return { hash, nft, escrow }; };
const setup = (W, extra = {}) => { const K = mkKV(); const published = []; const ba = makeBridgeAuto({ fetchImpl: async () => ({ json: async () => bcfg }), clients: W.mk, onPublish: async (env, job, col) => published.push({ job, col }), ...extra }); return { K, ba, env: { COLLECTIONS: K, BRIDGE_OPERATOR_PK: W.pk }, published }; };
const runAll = async (ba, env, n = 8) => { const out = []; for (let i = 0; i < n; i++) out.push(await ba.run(env)); return out; };

test('direct listing: verified on-chain, queued at refuel, mirrors + wiring + bcol, idempotent', async () => {
  const W = world(); const { K, ba, env, published } = setup(W); const { hash, nft, escrow } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash });
  assert.equal(st.known, true); assert.equal(st.state, 'queued'); assert.equal(st.chains, 3);
  const job = await K.get('bjob:' + st.slug, 'json');
  assert.equal(job.step, 'refuel'); assert.equal(job.name, 'Claymons'); assert.equal(job.symbol, 'CLAYMON'); assert.equal(job.supply, 5225); assert.equal(job.firstId, 1); assert.equal(job.baseURI, 'ipfs://Qm/');
  assert.equal(job.escrows.robinhood, escrow); assert.equal(job.listingId, 1); assert.ok(!job.hold);
  assert.match(st.slug, /^claymons-/);
  const again = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }); assert.equal(again.slug, st.slug);
  assert.equal([...K.m.keys()].filter(k => k.startsWith('bjob:')).length, 1, 'one job per nft');
  await runAll(ba, env);
  const done = await K.get('bjob:' + st.slug, 'json'); assert.equal(done.step, 'done');
  const dm = W.sent.filter(s => s.fn === 'deployMirror'); assert.equal(dm.length, 2); assert.deepEqual(dm.map(s => s.chain).sort(), ['base', 'ethereum']);
  for (const s of dm) { assert.equal(s.args[1], 'Claymons'); assert.equal(s.args[3], 'ipfs://Qm/'); assert.equal(s.args[4], 1n); assert.equal(s.args[5], 5225n); assert.equal(s.args[0], 1n); }
  const wires = W.sent.filter(s => s.fn === 'wire'); assert.deepEqual(wires.map(s => s.chain).sort(), ['base', 'ethereum', 'robinhood']);
  assert.ok(wires.every(s => s.args[1].length === 2 && s.args[2].length === 2));
  const col = await K.get('bcol:' + st.slug, 'json'); assert.equal(Object.keys(col.contracts).length, 3); assert.equal(col.contracts.robinhood, nft); assert.equal(Object.keys(col.escrows).length, 3);
  assert.equal(published.length, 1);
  assert.equal((await ba.directStatus(env, 'robinhood', nft)).state, 'live');
  assert.equal(W.sent.filter(s => s.fn === 'refuel').length, 1, 'gas moved to Ethereum with the existing refuel step');
});

test('direct listing: rejects anything that is not a real Listed event from the configured factory', async () => {
  const W = world(); const { ba, env } = setup(W); const { hash } = listing(W);
  await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: '0x' + '11'.repeat(32) }), /not found/);
  await assert.rejects(ba.enqueueDirect(env, { chain: 'nope', tx: hash }), /unsupported chain/);
  await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: 'zz' }), /bad tx hash/);
  W.receipts[hash].logs[0].address = addr(0xbad); await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }), /no MultiSea Listed event/);
  W.receipts[hash].logs[0].address = CH.robinhood.f; W.escrowOf['robinhood:' + addr(0xdd97)] = addr(0x1234); await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }), /escrow does not match/);
  W.escrowOf['robinhood:' + addr(0xdd97)] = addr(0xe5c); W.receipts[hash].status = 'reverted'; await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }), /reverted/);
  W.receipts[hash].status = 'success'; W.receipts[hash].logs = [listedLog('robinhood', { id: 1n, nft: addr(0xdd97), owner: addr(0x76ad), escrow: addr(0xe5c), eids: [CH.robinhood.eid, 99999] })];
  await assert.rejects(ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }), /not all supported/);
});

test('pauses visibly (not fails) when the operator lacks gas, resumes when it arrives', async () => {
  const W = world(); W.dropOnRefuel = false; W.gp = 1n; const { K, ba, env } = setup(W); const { hash } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash });
  const r1 = await ba.run(env); assert.match(r1[0].waiting, /waiting for gas on ethereum/);
  let job = await K.get('bjob:' + st.slug, 'json'); assert.equal(job.step, 'mirrors'); assert.match(job.waiting, /operator has 0/); assert.ok(job.waitingSince); assert.equal(job.tries || 0, 0);
  assert.equal((await ba.directStatus(env, 'robinhood', addr(0xdd97))).state, 'waiting-gas');
  const adm = await ba.status(env); assert.equal(adm.jobs[0].state, 'waiting-gas'); assert.match(adm.jobs[0].waiting, /ethereum/); assert.equal(adm.operatorIsGasWallet, true);
  W.bal.ethereum = ETH; W.bal.base = ETH; await runAll(ba, env, 4);
  job = await K.get('bjob:' + st.slug, 'json'); assert.equal(job.step, 'done'); assert.equal(job.waiting, undefined);
});

test('refuel: operator without enough native gas to fund the other chains waits, no tx sent, then proceeds', async () => {
  const W = world(); W.bal.robinhood = 1n; W.gp = 10n ** 9n; const { K, ba, env } = setup(W); const { hash } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash });
  const r = await ba.run(env); assert.match(r[0].waiting, /needs ~.*to send gas to the other chains/); assert.equal(W.sent.length, 0);
  assert.equal((await K.get('bjob:' + st.slug, 'json')).step, 'refuel');
  W.bal.robinhood = 5n * ETH; await runAll(ba, env); assert.equal((await K.get('bjob:' + st.slug, 'json')).step, 'done');
});

test('an out-of-gas send error is a pause, not a failure', async () => {
  const W = world(); W.bal = { robinhood: 5n * ETH, ethereum: 0n, base: 0n }; W.gp = 0n; const { K, ba, env } = setup(W); const { hash } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash });
  W.dropOnRefuel = false; W.bal.ethereum = 0n; W.bal.base = 0n; const r = await runAll(ba, env, 2);
  // gas price 0 => threshold 0, so the send is attempted and the node says insufficient funds
  assert.ok(r.flat().some(x => /out of gas on/.test(x.waiting || '')), JSON.stringify(r)); const job = await K.get('bjob:' + st.slug, 'json'); assert.equal(job.step, 'mirrors'); assert.ok(!job.err); assert.ok(job.waiting);
});

test('unclear token range holds the job for an admin; retry with an override resumes', async () => {
  const W = world({ nft: { totalSupply: 100n, ids: new Set([...Array(120).keys()].map(i => i + 1)) } }); const { K, ba, env } = setup(W); const { hash } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }); assert.equal(st.state, 'held');
  const r = await ba.run(env); assert.match(r[0].hold, /beyond totalSupply/); assert.equal(W.sent.length, 0);
  assert.match((await ba.status(env)).jobs[0].hold, /beyond totalSupply/);
  const j = await ba.retry(env, st.slug, { supply: 120 }); assert.equal(j.supply, 120); assert.equal(j.hold, undefined);
  await runAll(ba, env); assert.equal((await K.get('bjob:' + st.slug, 'json')).step, 'done');
  assert.equal(W.sent.find(s => s.fn === 'deployMirror').args[5], 120n);
});

test('slug: uses the pending/approved collection slug; mirrors merge into the approved record', async () => {
  const W = world(); const { K, ba, env } = setup(W); const { hash, nft } = listing(W);
  await K.put('pending:claymons', JSON.stringify({ slug: 'claymons', name: 'Claymons', deployments: [{ chain: 'robinhood', address: nft }], escrow: [] }));
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash }); assert.equal(st.slug, 'claymons');
  await runAll(ba, env); assert.equal((await K.get('bjob:claymons', 'json')).step, 'done');
  // approval after the job finished
  const col = { slug: 'claymons', name: 'Claymons', status: 'approved', deployments: [{ chain: 'robinhood', address: nft }], escrow: [{ chain: 'robinhood', address: '0xaaa', label: 'x' }] };
  await K.put('col:claymons', JSON.stringify(col));
  const save = async (e, slug, patch) => { const v = { ...(await K.get('col:' + slug, 'json')), ...patch }; await K.put('col:' + slug, JSON.stringify(v)); return v; };
  const link = makeLinkBridge({ chains: bcfg.chains, lc, saveCollectionPatch: save });
  const merged = await link(env, 'claymons', col);
  assert.deepEqual(merged.deployments.map(d => d.chain).sort(), ['base', 'ethereum', 'robinhood']); assert.equal(merged.deployments.filter(d => d.mirror).length, 2);
  assert.equal(merged.escrow.length, 4); assert.ok(merged.escrow.some(e => e.label === 'MultiSea bridge escrow'));
  for (const d of merged.deployments.filter(x => x.mirror)) assert.equal(await K.get('idx:' + d.chain + ':' + d.address), 'claymons');
  const again = await link(env, 'claymons', merged); assert.equal(again.deployments.length, 3, 'idempotent'); assert.equal(again.escrow.length, 4);
  assert.equal((await K.get('bcol:claymons', 'json')).mirrorsSlug, 'claymons');
});

test('backstop scan: enqueues direct listings, skips operator (launchpad) listings, remembers its block', async () => {
  const W = world(); const { K, ba, env } = setup(W); const { nft, escrow } = listing(W);
  const hash = '0x' + 'ee'.repeat(32); const lg = listedLog('robinhood', { id: 1n, nft, owner: addr(0x76ad), escrow, eids: [CH.robinhood.eid, CH.ethereum.eid, CH.base.eid] }); lg.transactionHash = hash; lg.blockNumber = 990n;
  const parsed = { ...lg, args: { id: 1n, nft, owner: addr(0x76ad), escrow, eids: [CH.robinhood.eid, CH.ethereum.eid, CH.base.eid], fee: 5n } };
  // viem getLogs returns decoded logs with args; the mock returns them directly
  W.logs.robinhood = [parsed]; W.txFrom[hash] = addr(0x76ad);
  const out = await ba.scan(env); assert.equal(out.robinhood.enqueued.length, 1); assert.equal(await K.get('bscan:robinhood'), '998');
  assert.equal((await ba.scan(env)).robinhood.enqueued.length, 0, 'no duplicates');
  assert.equal([...K.m.keys()].filter(k => k.startsWith('bjob:')).length, 1);
  // a launchpad listing (tx from the operator) is skipped; an existing job for the same nft without a marker is not duplicated
  const W2 = world(); const s2 = setup(W2); const l2 = listing(W2); const h2 = '0x' + 'ff'.repeat(32); const g2 = { ...parsed, transactionHash: h2 }; W2.logs.robinhood = [g2]; W2.txFrom[h2] = W2.op;
  assert.equal((await s2.ba.scan(s2.env)).robinhood.enqueued.length, 0);
  const W3 = world(); const s3 = setup(W3); listing(W3); const h3 = '0x' + '99'.repeat(32); W3.logs.robinhood = [{ ...parsed, transactionHash: h3 }]; W3.txFrom[h3] = addr(0x76ad);
  await s3.K.put('bjob:drop-1', JSON.stringify({ slug: 'drop-1', native: 'robinhood', nft, step: 'mirrors' }));
  assert.equal((await s3.ba.scan(s3.env)).robinhood.enqueued.length, 0); assert.equal(await s3.K.get('bnft:robinhood:' + nft), 'drop-1');
});

test('lease: a second run does not re-advance a job another run holds; operator-style retry clears it', async () => {
  const W = world(); let t = 1_000_000; const { K, ba, env } = setup(W, { now: () => t }); const { hash } = listing(W);
  const st = await ba.enqueueDirect(env, { chain: 'robinhood', tx: hash });
  const job = await K.get('bjob:' + st.slug, 'json'); job.lease = t + 60000; await K.put('bjob:' + st.slug, JSON.stringify(job));
  const r = await ba.run(env); assert.equal(r[0].busy, true); assert.equal(W.sent.length, 0);
  t += 61000; await runAll(ba, env); assert.equal((await K.get('bjob:' + st.slug, 'json')).step, 'done');
});
