// Pre-mint every id that does not exist yet on <chain> into that chain's MultiSeaCopyEscrow (escrow.preMint).
// Usage: node scripts/premint.mjs <ethereum|apechain|bnb|robinhood|base> [--escrow 0x..] [--batch 100]  (dry-run unless EXECUTE=1 KEY_FILE=...)
import { parseAbi } from 'viem';
import fs from 'fs';
import { CHAINS, SUPPLY, EXECUTE, snapshot, pub, wallet, chunks } from './mainnet-common.mjs';
const k = process.argv[2]; if (!CHAINS[k] || k === 'abstract') throw new Error('chain: ethereum|apechain|bnb|robinhood|base');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BATCH = +arg('--batch', 100), ESCROW = arg('--escrow');
const have = await snapshot(k);
const missing = Array.from({ length: SUPPLY }, (_, i) => i + 1).filter(id => !have[id]);
const batches = chunks(missing, BATCH);
const gp = await pub(k).getGasPrice();
const plan = { chain: k, mode: EXECUTE ? 'EXECUTE' : 'dry-run', existing: Object.keys(have).length, mints: missing.length, batches: batches.length, estGas: missing.length * 97750 + batches.length * 21000, gasPriceWei: gp.toString() };
console.log(JSON.stringify(plan, null, 1));
fs.mkdirSync('plans', { recursive: true }); fs.writeFileSync(`plans/premint-${k}.json`, JSON.stringify({ plan, missing }));
if (!EXECUTE) process.exit(0);
if (!ESCROW) throw new Error('--escrow required');
const w = wallet(k), abi = parseAbi(['function preMint(uint256[])']);
for (const [i, b] of batches.entries()) {
  const h = await w.writeContract({ address: ESCROW, abi, functionName: 'preMint', args: [b.map(BigInt)] });
  await pub(k).waitForTransactionReceipt({ hash: h }); console.log(`batch ${i + 1}/${batches.length} ${h}`);
}
