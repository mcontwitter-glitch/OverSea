// Mainnet dry run on local anvil forks of all 5 chains (NET=mainnet MODE=fork). Real endpoints, feeds and gas prices;
// nothing is broadcast to a real chain. Deploys factories (+ pushed feeds), sets gas-only listing costs, lists a test
// collection on Base across all 5 chains, deploys/wires mirrors, bridges Base -> ApeChain -> Base, and reports what each
// step cost the owner wallet per chain.
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, CFG, MODE, NET, art, deployer, loadDep, saveDep, clients, deploy, send, eventsOf, PACKET_ABI } from './lib.mjs';
import { factories, setGasCosts, processListing } from './deploy-bridge.mjs';
import { parseEther, formatEther, slice, createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
if (NET !== 'mainnet' || MODE !== 'fork') throw new Error('run with NET=mainnet MODE=fork');
const E = art('MultiSeaEscrow'), F = art('MultiSeaFactory'), N = art('LilFootsTest');
const keys = Object.keys(CFG.chains); const acct = deployer(); const holder = privateKeyToAccount(generatePrivateKey());
const OPTS = '0x0003' + '01' + '0011' + '01' + (300000).toString(16).padStart(32, '0');
const real = {}; for (const k of keys) real[k] = await clients(k).pub.getBalance({ address: acct.address });
const bal = async k => clients(k).pub.getBalance({ address: acct.address });
const setBal = async (k, a, eth) => clients(k).pub.request({ method: 'anvil_setBalance', params: [a, '0x' + parseEther(eth).toString(16)] });
for (const k of keys) { await setBal(k, acct.address, '100'); await setBal(k, holder.address, '100'); }
// gas used by the owner wallet per chain (fork gas prices are not real, so cost = gas used x live gas price)
const { createPublicClient } = await import('viem');
const liveGp = {}; for (const k of keys) liveGp[k] = await createPublicClient({ transport: http(CFG.chains[k].rpc) }).getGasPrice();
const last = {}; for (const k of keys) last[k] = await clients(k).pub.getBlockNumber();
async function gasSince(k) { const cl = clients(k); const top = await cl.pub.getBlockNumber(); let g = 0n;
  for (let b = last[k] + 1n; b <= top; b++) { const B = await cl.pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const t of B.transactions) if (t.from.toLowerCase() === acct.address.toLowerCase()) g += (await cl.pub.getTransactionReceipt({ hash: t.hash })).gasUsed; }
  last[k] = top; return g; }
const snap = async () => { const o = {}; for (const k of keys) o[k] = (await gasSince(k)) * liveGp[k]; return o; };
const diff = (a, b) => b;
const cost = {};
let s0 = await snap(); await factories(); let s1 = await snap(); cost.factories = diff(s0, s1);
await setGasCosts(); let s2 = await snap(); cost.gascosts = diff(s1, s2);
const NAT = 'base'; const cn = clients(NAT, acct); const dep = loadDep();
const nft = await deploy(cn, 'LilFootsTest', [acct.address, 'https://multisea.io/data/lil-foots/meta/']);
await send(cn, nft, N.abi, 'mint', [holder.address, 7n]);
const eids = [NAT, ...keys.filter(k => k !== NAT)].map(k => CFG.chains[k].eid);
const fee = await cn.pub.readContract({ address: dep.chains[NAT].factory, abi: F.abi, functionName: 'listingFee', args: [eids] });
let s3 = await snap();
const { r: lr } = await send(cn, dep.chains[NAT].factory, F.abi, 'list', [nft, eids], fee);
const lid = eventsOf(lr, F.abi, 'Listed')[0].args.id;
let s4 = await snap(); cost.list = s4;
const rec = await processListing(NAT, lid); let s5 = await snap(); cost.process = diff(s4, s5);
// gas units for the listing fee model
const units = { list: Number(lr.gasUsed) };
{ const cl = clients('apechain'); const blk = await cl.pub.getBlockNumber(); const txs = [];
  for (let b = blk; b > blk - 20n; b--) { const B = await cl.pub.getBlock({ blockNumber: b, includeTransactions: true }); for (const t of B.transactions) if (t.from.toLowerCase() === acct.address.toLowerCase()) txs.push(t); }
  const rs = await Promise.all(txs.map(t => cl.pub.getTransactionReceipt({ hash: t.hash })));
  const big = rs.map(r => Number(r.gasUsed)).sort((a, b) => b - a); units.deployMirror = big[0]; units.setPeer = big[big.length - 1]; }
fs.writeFileSync(path.join(ROOT, 'deployments/gas-units.json'), JSON.stringify(units, null, 1) + '\n');
// bridge Base -> ApeChain (relay simulated as the destination endpoint, as the LZ executor would)
async function relay(dstKey, receipt, dstEscrow) {
  const p = eventsOf(receipt, PACKET_ABI, 'PacketSent')[0].args.encodedPayload;
  const nonce = BigInt(slice(p, 1, 9)), srcEid = Number(BigInt(slice(p, 9, 13))), sender = slice(p, 13, 45), guid = slice(p, 81, 113), message = slice(p, 113);
  const d = clients(dstKey); const ep = CFG.chains[dstKey].endpoint;
  await d.pub.request({ method: 'anvil_impersonateAccount', params: [ep] }); await setBal(dstKey, ep, '1');
  const w = createWalletClient({ chain: d.chain, transport: http(d.rpc), account: ep });
  const h = await w.writeContract({ address: dstEscrow, abi: E.abi, functionName: 'lzReceive', args: [{ srcEid, sender, nonce }, guid, message, ep, '0x'], gas: 600000n });
  if ((await d.pub.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error('lzReceive failed');
}
const hb = clients(NAT, holder), ha = clients('apechain', holder); const M = rec.mirrors.apechain;
const [pf, lz] = await hb.pub.readContract({ address: rec.escrows[NAT], abi: E.abi, functionName: 'quote', args: [CFG.chains.apechain.eid, holder.address, 7n, OPTS] });
await send(hb, nft, N.abi, 'approve', [rec.escrows[NAT], 7n]);
const { r: br } = await send(hb, rec.escrows[NAT], E.abi, 'bridge', [CFG.chains.apechain.eid, holder.address, 7n, OPTS], pf + lz);
await relay('apechain', br, rec.escrows.apechain);
const own1 = await ha.pub.readContract({ address: M, abi: N.abi, functionName: 'ownerOf', args: [7n] });
const [pf2, lz2] = await ha.pub.readContract({ address: rec.escrows.apechain, abi: E.abi, functionName: 'quote', args: [CFG.chains.base.eid, holder.address, 7n, OPTS] });
await send(ha, M, N.abi, 'approve', [rec.escrows.apechain, 7n]);
const { r: br2 } = await send(ha, rec.escrows.apechain, E.abi, 'bridge', [CFG.chains.base.eid, holder.address, 7n, OPTS], pf2 + lz2);
await relay(NAT, br2, rec.escrows[NAT]);
const own2 = await hb.pub.readContract({ address: nft, abi: N.abi, functionName: 'ownerOf', args: [7n] });
const out = { units, listingFee: { chainsN: eids.length, wei: fee.toString(), eth: formatEther(fee) },
  roundTrip: { baseToApe: own1.toLowerCase() === holder.address.toLowerCase(), apeToBase: own2.toLowerCase() === holder.address.toLowerCase(),
    quoteBase: { platform: formatEther(pf), lz: formatEther(lz) }, quoteApe: { platform: formatEther(pf2), lz: formatEther(lz2) } },
  ownerCost: Object.fromEntries(keys.map(k => [k, { native: CFG.chains[k].native, factories: formatEther(cost.factories[k]), gascosts: formatEther(cost.gascosts[k]), listTx: formatEther(cost.list[k]), perCollection: formatEther(cost.process[k]), realBalance: formatEther(real[k]) }])) };
fs.writeFileSync(path.join(ROOT, 'deployments/mainnet-dryrun.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
