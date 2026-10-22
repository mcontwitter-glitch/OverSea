// Estimate the extra LayerZero cost a multichain (escrow) mint adds, per NFT, for the BATCHED (default) and AT_MINT copy
// modes, from config/launchpad.json (Oct 17 2026 LayerZero fork quotes, 2 DVNs). ESTIMATES ONLY: real fees come from
// MultiSeaOmniEscrow.quoteBatchShare / quoteHubValue / quoteRequest. Usage: node scripts/launchpad-batch-costs.mjs [K]
import { readFileSync } from 'node:fs';
const LP = JSON.parse(readFileSync(new URL('../config/launchpad.json', import.meta.url)));
const LZ = LP.lzEstUsd, HUB = LP.hubChain, CH = LP.chains, B = LP.batch;
const K = Number(process.argv[2] || B.defaultK), BUF = 1 + B.shareBufferBps / 10_000;
const MIX = { base: 0.42, ethereum: 0.07, apechain: 0.19, bnb: 0.17, robinhood: 0.15 }; // LIL FOOTS demo origin mix
// origin-chain gas for the mint tx beyond a plain mint (today / busy), from §7.4 of the spec
const ORIGIN_GAS = { today: { base: 0.001, ethereum: 0.06, apechain: 0.005, bnb: 0.01, robinhood: 0.02 }, busy: { base: 0.01, ethereum: 2.61, apechain: 0.01, bnb: 0.02, robinhood: 0.05 } };
const ETH_BUSY_MSG = 1.06, ETH_BUSY_ID = 0.22; // Ethereum at 3 gwei: executor gas per message / per extra id
const lz = (s, d, busy) => (LZ[s]?.[d] ?? 0.27) + (busy && d === 'ethereum' ? ETH_BUSY_MSG : 0);
const perId = (d, busy) => d === 'ethereum' ? (busy ? ETH_BUSY_ID : LP.perIdLzUsd.ethereum) : LP.perIdLzUsd.other;
const dests = CH.filter(k => k !== HUB);
/** BATCHED: pool share per NFT (what the minter pays; ~1/(1+buffer) of it is spent, the rest returns to the creator). */
const share = busy => dests.reduce((a, d) => a + lz(HUB, d, busy) / K + ((K - 1) / K) * perId(d, busy), 0) * BUF;
function batched(origin, qty, busy) {
  let tx = share(busy) * qty;
  if (origin !== HUB) tx += lz(origin, HUB, busy) + LZ.requestExtraBatched + lz(HUB, origin, busy) + (qty - 1) * perId(origin, busy);
  return (tx + ORIGIN_GAS[busy ? 'busy' : 'today'][origin]) / qty;
}
function atMint(origin, qty, busy) {
  let tx = 0;
  for (const d of dests) if (d !== origin) tx += lz(HUB, d, busy) + (qty - 1) * perId(d, busy);
  if (origin !== HUB) tx += lz(origin, HUB, busy) + LZ.requestExtra + lz(HUB, origin, busy) + (qty - 1) * perId(origin, busy);
  return (tx + ORIGIN_GAS[busy ? 'busy' : 'today'][origin] * (origin === HUB ? 20 : 1)) / qty;
}
const mix = (f, qty, busy) => Object.entries(MIX).reduce((a, [o, w]) => a + w * f(o, qty, busy), 0);
const $ = v => '$' + v.toFixed(2), N = 4404;
console.log(`K = ${K}, buffer ${B.shareBufferBps / 100}%. Pool share per NFT: today ${$(share(false))}, busy ${$(share(true))} (spent ≈ ${$(share(false) / BUF)})`);
console.log('\nPer NFT by origin (qty 1 | qty 3), today / busy:');
for (const o of CH) console.log(`  ${o.padEnd(10)} batched ${$(batched(o, 1, false))} / ${$(batched(o, 1, true))} | qty3 ${$(batched(o, 3, false))} / ${$(batched(o, 3, true))}    at-mint ${$(atMint(o, 1, false))}`);
for (const q of [1, 2, 3, 5]) console.log(`  demo mix qty ${q}: batched ${$(mix(batched, q, false))}/NFT → ${N} drop ≈ $${Math.round(mix(batched, q, false) * N)} (busy ≈ $${Math.round(mix(batched, q, true) * N)}) · at-mint ${$(mix(atMint, q, false))} → ≈ $${Math.round(mix(atMint, q, false) * N)}`);
console.log(`  all on Base, any qty: ${$(batched('base', 3, false))}/NFT → ≈ $${Math.round(batched('base', 3, false) * N)} (busy ≈ $${Math.round(batched('base', 3, true) * N)})`);
for (const k of [10, 25, 50, 100, 200]) { const s = dests.reduce((a, d) => a + lz(HUB, d) / k + ((k - 1) / k) * perId(d), 0) * BUF; console.log(`  K=${k}: share ${$(s)}`); }
