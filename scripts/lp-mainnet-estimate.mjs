// READ-ONLY mainnet cost estimate for the launchpad (no transactions). Inputs: /tmp/est/fork-<chain>.json from
// lp-mainnet-fork-gas.mjs (actual gasUsed on local mainnet forks; equals the testnet receipts), live eth_gasPrice on
// each mainnet, L1 data components (Base GasPriceOracle.getL1Fee, Arbitrum-orbit NodeInterface.gasEstimateL1Component
// for ApeChain/Robinhood), CoinGecko prices. Output: /tmp/est/estimate.json + /tmp/est/estimate.md
import fs from 'node:fs'; import { createPublicClient, http, parseAbi } from 'viem'; import { MAIN } from './lp-mainnet-lz-check.mjs';
const BUSY = { ethereum: 3e9, base: null, bnb: 1e9, apechain: null, robinhood: null }; // null = 5x live; Base busy also 3x L1 fee
const fx = (n, d = 6) => Number(n).toFixed(d);
const cg = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,apecoin,binancecoin&vs_currencies=usd')).json();
const usd = { ETH: cg.ethereum.usd, APE: cg.apecoin.usd, BNB: cg.binancecoin.usd };
const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
const GPO = parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
const NI = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
const steps = {
  a: ['deploy timelock', 'deploy MultiSeaDrop impl', 'deploy factory', 'factory transferOwnership(timelock)', 'timelock schedule(acceptOwnership) [admin]', 'timelock execute(acceptOwnership) [admin]'],
  b: ['deploy MultiSeaOmniDrop impl', 'deploy MultiSeaOmniEscrow', 'factory config (setOmni)', 'escrow config (setFactory)', 'setPeer ×4', 'setConfig send (ULN DVNs + executor) ×4', 'setConfig receive (ULN DVNs) ×4', 'escrow setDelegate(timelock)', 'escrow transferOwnership(timelock)'],
  c1: ['createDrop (single-chain clone + init)'], c5: ['createOmniDrop (multichain clone + init + register), per chain'],
};
const out = { ts, usd, chains: {} };
for (const [k, c] of Object.entries(MAIN)) {
  const pub = createPublicClient({ transport: http(c.rpc, { retryCount: 3 }) }); const f = JSON.parse(fs.readFileSync(`/tmp/est/fork-${k}.json`, 'utf8'));
  const gp = Number(await pub.getGasPrice()); const dd = f.extra.deployData; const calls = f.extra.calls;
  // L1 data cost per step, in wei (deploys: real bytecode; calls: ~200 B of calldata each)
  const small = '0x' + 'ab'.repeat(200); const l1 = {};
  for (const s of Object.keys(f.gas)) { const data = dd[s] ?? small; const n = dd[s] ? 1 : (calls[s] || 1);
    if (k === 'base') l1[s] = Number(await pub.readContract({ address: '0x420000000000000000000000000000000000000F', abi: GPO, functionName: 'getL1Fee', args: [data] })) * n;
    else if (k === 'apechain' || k === 'robinhood') { const { result } = await pub.simulateContract({ address: '0x00000000000000000000000000000000000000C8', abi: NI, functionName: 'gasEstimateL1Component', args: [MAIN.base.endpoint, !!dd[s], data] }); l1[s] = Number(result[0]) * gp * n; }
    else l1[s] = 0; }
  const busyGp = BUSY[k] ?? gp * 5; const busyL1 = k === 'base' ? 3 : busyGp / gp;
  const cost = (list, g = gp, m = 1) => list.reduce((t, s) => t + (f.gas[s] || 0) * g + (l1[s] || 0) * m, 0) / 1e18;
  const gasOf = list => list.reduce((t, s) => t + (f.gas[s] || 0), 0);
  const r = { native: c.native, gasPriceGwei: gp / 1e9, busyGwei: busyGp / 1e9, gas: f.gas, l1Wei: l1 };
  for (const [g, list] of Object.entries(steps)) r[g] = { gas: gasOf(list), native: cost(list), busy: cost(list, busyGp, busyL1) };
  if (k === 'base') { const fl = ['flush (49 ids, 4 ranges -> 4 chains, permissionless)']; r.flush = { gas: gasOf(fl), native: cost(fl), busy: cost(fl, busyGp, busyL1), lzWei49: f.extra.flushLzWei, batchShare50Wei: f.extra.batchShare50Wei, hubShare1Wei: f.extra.hubShare[1], hubValue: f.extra.hubValue, moveLzWei: f.extra.moveLzWei }; }
  r.adminOnly = { native: cost(['timelock schedule(acceptOwnership) [admin]', 'timelock execute(acceptOwnership) [admin]']), busy: cost(['timelock schedule(acceptOwnership) [admin]', 'timelock execute(acceptOwnership) [admin]'], busyGp, busyL1) };
  out.chains[k] = r; console.log(k, 'gas', fx(gp / 1e9, 4), 'gwei; a', fx(r.a.native), 'b', fx(r.b.native), 'c1', fx(r.c1.native, 8), 'c5', fx(r.c5.native, 8), c.native);
}
fs.writeFileSync('/tmp/est/estimate.json', JSON.stringify(out, null, 1)); console.log(ts, usd);
