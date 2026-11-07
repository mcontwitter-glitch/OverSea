// Fork rehearsal of the automatic bridge listing (NET=mainnet MODE=fork, 5 anvil forks). New factories with the LZ route and a
// server operator; a creator prepays at review; the Worker's bridgeauto job (real module, in-memory KV) lists, deploys mirrors and
// wires every chain; then a test NFT bridges Base -> ApeChain -> Base (relay simulated as the destination endpoint).
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, CFG, MODE, NET, art, deployer, loadDep, clients, deploy, send, eventsOf, PACKET_ABI } from './lib.mjs';
import { factories, setGasCosts, refuels } from './deploy-bridge.mjs';
import { makeBridgeAuto } from '../../worker/src/bridgeauto.js';
import { parseEther, formatEther, slice, createWalletClient, http, keccak256, toBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
if (NET !== 'mainnet' || MODE !== 'fork') throw new Error('run with NET=mainnet MODE=fork');
const E = art('MultiSeaEscrow'), F = art('MultiSeaFactory'), N = art('LilFootsTest');
const keys = Object.keys(CFG.chains); const acct = deployer();
const srvPk = generatePrivateKey(), srv = privateKeyToAccount(srvPk); const creator = privateKeyToAccount(generatePrivateKey());
const setBal = (k, a, eth) => clients(k).pub.request({ method: 'anvil_setBalance', params: [a, '0x' + parseEther(eth).toString(16)] });
for (const k of keys) { await setBal(k, acct.address, '5'); await setBal(k, srv.address, k === 'base' ? '5' : '0'); await setBal(k, creator.address, '5000'); }
fs.rmSync(path.join(ROOT, 'deployments/mainnet-fork.json'), { force: true });
process.env.SERVER_OPERATOR = srv.address;
await factories(); await refuels(); await setGasCosts();
const dep = loadDep(); const NAT = 'base'; const slug = 'auto-test-drop';
// creator: deploy collection, prepay at review
const cc = clients(NAT, creator);
const nft = await deploy(cc, 'LilFootsTest', [creator.address, 'ipfs://test/']); await send(cc, nft, N.abi, 'mint', [creator.address, 7n]);
const eids = [NAT, ...keys.filter(k => k !== NAT)].map(k => CFG.chains[k].eid);
const fee = await cc.pub.readContract({ address: dep.chains[NAT].factory, abi: F.abi, functionName: 'listingFee', args: [eids] });
const s0 = await cc.pub.getBalance({ address: srv.address });
await send(cc, dep.chains[NAT].factory, F.abi, 'prepay', [keccak256(toBytes(slug)), eids], fee * 103n / 100n);
const s1 = await cc.pub.getBalance({ address: srv.address });
// Worker job with fork RPCs
const kv = new Map(); const K = { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v), list: async ({ prefix }) => ({ keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) };
const bcfg = { network: 'mainnet', setupGas: 3793754, chains: Object.fromEntries(keys.map(k => [k, { name: CFG.chains[k].name, chainId: CFG.chains[k].chainId, eid: CFG.chains[k].eid, native: CFG.chains[k].native, rpc: CFG.chains[k].forkRpc, factory: dep.chains[k].factory, refuel: dep.chains[k].refuel }])) };
const env = { COLLECTIONS: K, BRIDGE_OPERATOR_PK: srvPk };
const before = {}; for (const k of keys) before[k] = await clients(k).pub.getBalance({ address: srv.address });
const ba = makeBridgeAuto({ fetchImpl: async () => ({ json: async () => bcfg }) });
const drop = { slug, name: 'Auto Test', symbol: 'AUTO', maxSupply: 100, baseURI: 'ipfs://test/', bridgePrepay: { chain: NAT, dropId: keccak256(toBytes(slug)), eids, tx: '0x' + '1'.repeat(64) } };
await ba.enqueue(env, drop, NAT, nft);
let runs = 0, job; do { const r = await ba.run(env); runs++; job = await K.get('bjob:' + slug, 'json'); console.log('run', runs, JSON.stringify(r));
  if (r[0]?.waiting) { const ps = []; for (const k of keys) if (k !== NAT) ps.push(setBal(k, srv.address, '5')); await Promise.all(ps); console.log('simulated LayerZero gas drops arriving'); } } while (job.step !== 'done' && job.step !== 'failed' && runs < 10);
const spent = {}; for (const k of keys) spent[k] = formatEther(before[k] - await clients(k).pub.getBalance({ address: srv.address }));
const col = await K.get('bcol:' + slug, 'json');
// bridge round trip with the auto-listed collection
async function relay(dstKey, receipt, dstEscrow) {
  const p = eventsOf(receipt, PACKET_ABI, 'PacketSent')[0].args.encodedPayload;
  const nonce = BigInt(slice(p, 1, 9)), srcEid = Number(BigInt(slice(p, 9, 13))), sender = slice(p, 13, 45), guid = slice(p, 81, 113), message = slice(p, 113);
  const d = clients(dstKey); const ep = CFG.chains[dstKey].endpoint;
  await d.pub.request({ method: 'anvil_impersonateAccount', params: [ep] }); await setBal(dstKey, ep, '1');
  const w = createWalletClient({ chain: d.chain, transport: http(d.rpc), account: ep });
  const h = await w.writeContract({ address: dstEscrow, abi: E.abi, functionName: 'lzReceive', args: [{ srcEid, sender, nonce }, guid, message, ep, '0x'], gas: 600000n });
  if ((await d.pub.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error('lzReceive failed');
}
const OPTS = '0x0003' + '01' + '0011' + '01' + (300000).toString(16).padStart(32, '0');
const ha = clients('apechain', creator);
const [pf, lz] = await cc.pub.readContract({ address: col.escrows[NAT], abi: E.abi, functionName: 'quote', args: [CFG.chains.apechain.eid, creator.address, 7n, OPTS] });
await send(cc, nft, N.abi, 'approve', [col.escrows[NAT], 7n]);
const { r: br } = await send(cc, col.escrows[NAT], E.abi, 'bridge', [CFG.chains.apechain.eid, creator.address, 7n, OPTS], pf + lz);
await relay('apechain', br, col.escrows.apechain);
const own1 = await ha.pub.readContract({ address: col.contracts.apechain, abi: N.abi, functionName: 'ownerOf', args: [7n] });
const [pf2, lz2] = await ha.pub.readContract({ address: col.escrows.apechain, abi: E.abi, functionName: 'quote', args: [CFG.chains.base.eid, creator.address, 7n, OPTS] });
await send(ha, col.contracts.apechain, N.abi, 'approve', [col.escrows.apechain, 7n]);
const { r: br2 } = await send(ha, col.escrows.apechain, E.abi, 'bridge', [CFG.chains.base.eid, creator.address, 7n, OPTS], pf2 + lz2);
await relay(NAT, br2, col.escrows[NAT]);
const own2 = await cc.pub.readContract({ address: nft, abi: N.abi, functionName: 'ownerOf', args: [7n] });
const wire = Math.max(...Object.entries(job.gas || {}).filter(([t]) => t.startsWith('wire:')).map(([, g]) => g));
const units = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/gas-units.json'), 'utf8')); units.wire = wire;
fs.writeFileSync(path.join(ROOT, 'deployments/gas-units.json'), JSON.stringify(units, null, 1) + '\n');
console.log(JSON.stringify({ step: job.step, err: job.err, runs, txs: Object.keys(job.gas || {}).length, gas: job.gas, prepaidToServer: formatEther(s1 - s0), fee: formatEther(fee), serverSpent: spent,
  roundTrip: { baseToApe: own1.toLowerCase() === creator.address.toLowerCase(), apeToBase: own2.toLowerCase() === creator.address.toLowerCase() } }, null, 1));
