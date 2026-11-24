// Read-only: current vs recommended listing fees per factory chain (and the exact setGasCosts calldata for the owner to sign). Sends nothing.
// usage: node scripts/listing-fees.mjs [nativeKey]
import fs from 'node:fs'; import { createPublicClient, http, parseAbi, formatEther, encodeFunctionData } from 'viem';
import { planNative, DEFAULT_MARKUPS } from '../src/feeplan.ts';
const B = JSON.parse(fs.readFileSync(new URL('../public/bridge.json', import.meta.url), 'utf8'));
const FAC = parseAbi(['function listingFee(uint32[]) view returns (uint256)', 'function gasWallet() view returns (address)', 'function setGasCosts(uint32[] eids, uint256[] costs)']);
const REF = parseAbi(['function quote(uint32[] dsts, uint128[] amounts, address to) view returns (uint256)']);
const keys = Object.keys(B.chains).filter(k => B.chains[k].factory); const pc = Object.fromEntries(keys.map(k => [k, createPublicClient({ transport: http(B.chains[k].rpc) })]));
const gp = Object.fromEntries(await Promise.all(keys.map(async k => [k, await pc[k].getGasPrice()])));
const units = B.gasUnits || { list: 1904036, deployMirror: 5271945, wire: 960409 }; const markups = B.feePlan || DEFAULT_MARKUPS;
const only = process.argv[2];
for (const k of keys.filter(x => !only || x === only)) {
  const c = B.chains[k]; const gw = await pc[k].readContract({ address: c.factory, abi: FAC, functionName: 'gasWallet' });
  const plan = await planNative({ native: k, keys, eid: Object.fromEntries(keys.map(x => [x, B.chains[x].eid])), gasPrice: gp, units, markups, quote: (d, a) => pc[k].readContract({ address: c.refuel, abi: REF, functionName: 'quote', args: [d, a, gw] }) });
  const allEids = [B.chains[k].eid, ...keys.filter(x => x !== k).map(x => B.chains[x].eid)];
  const old = await pc[k].readContract({ address: c.factory, abi: FAC, functionName: 'listingFee', args: [allEids] });
  console.log(`${k.padEnd(10)} ${B.chains[k].native}  old ${formatEther(old)}  new ${formatEther(plan.total)}  (${(Number(plan.total) / Number(old)).toFixed(2)}x)  base ${formatEther(plan.base)}  ` + Object.entries(plan.remote).map(([d, r]) => `${d}:${formatEther(r.cost)}`).join(' '));
  if (only) console.log('calldata', encodeFunctionData({ abi: FAC, functionName: 'setGasCosts', args: [plan.eids, plan.costs] }));
}
console.log('gas price (gwei):', Object.fromEntries(keys.map(k => [k, Number(gp[k]) / 1e9])));
