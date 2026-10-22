// Renders /tmp/est/estimate.json (from lp-mainnet-estimate.mjs) as markdown tables -> /tmp/est/estimate.md
import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync('/tmp/est/estimate.json', 'utf8')); const C = e.chains; const K = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
const NM = { base: 'Base (hub)', ethereum: 'Ethereum', apechain: 'ApeChain', bnb: 'BNB Chain', robinhood: 'Robinhood' };
const u = (k, n) => n * e.usd[C[k].native]; const $ = x => x < 0.01 ? '<$0.01' : x < 10 ? '$' + x.toFixed(2) : '$' + x.toFixed(0);
const nat = (k, n) => { const d = C[k].native === 'APE' ? 3 : n < 0.0001 ? 7 : n < 0.01 ? 5 : 4; return n.toFixed(d) + ' ' + C[k].native; };
const M = x => (x / 1e6).toFixed(2) + 'M';
const L = [];
L.push(`Prices ${e.ts}: ETH $${e.usd.ETH}, APE $${e.usd.APE}, BNB $${e.usd.BNB} (CoinGecko). Live gas (eth_gasPrice): ` + K.map(k => `${NM[k]} ${+C[k].gasPriceGwei.toPrecision(3)} gwei`).join(', ') + '. Busy: Ethereum 3 gwei, BNB 1 gwei, Base/ApeChain/Robinhood 5× live (Base L1 data fee ×3).', '');
L.push('| Chain | (a) platform gas | (a) cost | (b) multichain gas | (b) cost | (a)+(b) today | (a)+(b) busy |', '|---|---|---|---|---|---|---|');
let tot = 0, totB = 0;
for (const k of K) { const c = C[k]; const n = c.a.native + c.b.native, b = c.a.busy + c.b.busy; tot += u(k, n); totB += u(k, b);
  L.push(`| ${NM[k]} | ${M(c.a.gas)} | ${nat(k, c.a.native)} (${$(u(k, c.a.native))}) | ${M(c.b.gas)} | ${nat(k, c.b.native)} (${$(u(k, c.b.native))}) | ${nat(k, n)} (${$(u(k, n))}) | ${nat(k, b)} (${$(u(k, b))}) |`); }
L.push(`| **All 5** | | | | | **${$(tot)}** | **${$(totB)}** |`, '');
e.totals = { today: tot, busy: totB };
L.push('| Chain | Deployer wallet (+50%) | Admin wallet 0xca89… (+50%) | Busy-ready deployer (busy +50%) |', '|---|---|---|---|');
for (const k of K) { const c = C[k]; const d = (c.a.native + c.b.native - c.adminOnly.native) * 1.5, a = c.adminOnly.native * 1.5, db = (c.a.busy + c.b.busy - c.adminOnly.busy) * 1.5;
  L.push(`| ${NM[k]} | ${nat(k, d)} (${$(u(k, d))}) | ${nat(k, a)} (${$(u(k, a))}) | ${nat(k, db)} (${$(u(k, db))}) |`); }
L.push('');
L.push('| Chain | (c) single-chain createDrop (0.43M gas) | (c) createOmniDrop on this chain (0.68M gas) | busy single / omni |', '|---|---|---|---|');
let o5 = 0, o5b = 0; for (const k of K) { const c = C[k]; o5 += u(k, c.c5.native); o5b += u(k, c.c5.busy);
  L.push(`| ${NM[k]} | ${nat(k, c.c1.native)} (${$(u(k, c.c1.native))}) | ${nat(k, c.c5.native)} (${$(u(k, c.c5.native))}) | ${$(u(k, c.c1.busy))} / ${$(u(k, c.c5.busy))} |`); }
L.push(`| **Multichain drop on all 5** | | **${$(o5)}** (3.41M gas) | **${$(o5b)}** |`, '');
const f = C.base.flush; const lz49 = f.lzWei49 / 1e18, sh50 = f.batchShare50Wei / 1e18;
L.push(`(d) Ongoing, per batch (Base hub, K=50, 4 destination chains): flush gas ${M(f.gas)} (measured: 49 ids in 4 ranges → 4 chains) = ${nat('base', f.native)} (${$(u('base', f.native))}), busy ${$(u('base', f.busy))}. LayerZero fee per batch ${lz49.toFixed(5)} ETH (${$(u('base', lz49))}, 4 messages, 2 DVNs each), paid from the drop's pool, not the bot; the full K=50 quote with the 1.2× margin = ${sh50.toFixed(5)} ETH (${$(u('base', sh50))}) ≈ ${$(u('base', sh50 / 50))} per NFT, which the minter prepays. The flush tip (pool minus fees) went back to the caller, so the bot is reimbursed. A Base hub mint pays ${(f.hubShare1Wei / 1e18).toFixed(6)} ETH (${$(u('base', f.hubShare1Wei / 1e18))}) share per NFT. Hub reply (hubValue, 1 NFT) for non-Base mints: ` + Object.entries(f.hubValue).map(([k, v]) => `${NM[k]} ${$(u('base', v[1] / 1e18))}`).join(', ') + '.');
fs.writeFileSync('/tmp/est/estimate.md', L.join('\n') + '\n'); fs.writeFileSync('/tmp/est/estimate.json', JSON.stringify(e, null, 1)); console.log(L.join('\n'));
