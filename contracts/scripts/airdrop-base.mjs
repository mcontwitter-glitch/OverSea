// Base airdrop plan: every Abstract LIL FOOTS holder gets their ids minted on Base via BatchMinter.mintBatch.
// Ids held by the old Abstract vault (already live on another chain) and ids that already exist on Base are skipped.
// Usage: node scripts/airdrop-base.mjs [--minter 0xBatchMinter] [--batch 100]   (dry-run unless EXECUTE=1 KEY_FILE=...)
// NOTE: see docs — airdropping while the Abstract originals stay free makes the same id free on two chains.
import { parseAbi } from 'viem';
import fs from 'fs';
import { CHAINS, OLD_VAULT, URI, EXECUTE, snapshot, pub, wallet, chunks } from './mainnet-common.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BATCH = +arg('--batch', 100), MINTER = arg('--minter');
const abs = await snapshot('abstract'), base = await snapshot('base');
const drops = Object.entries(abs).filter(([id, o]) => o !== OLD_VAULT.toLowerCase() && !base[id]).map(([id, o]) => [o, +id]);
const holders = new Set(drops.map(d => d[0]));
const batches = chunks(drops, BATCH);
const gp = await pub('base').getGasPrice();
const plan = { mode: EXECUTE ? 'EXECUTE' : 'dry-run', mints: drops.length, holders: holders.size, batches: batches.length, estGas: drops.length * 97750 + batches.length * 21000, gasPriceWei: gp.toString() };
console.log(JSON.stringify(plan, null, 1));
fs.mkdirSync('plans', { recursive: true }); fs.writeFileSync('plans/airdrop-base.json', JSON.stringify({ plan, drops }, null, 1));
if (!EXECUTE) process.exit(0);
if (!MINTER) throw new Error('--minter required');
const w = wallet('base'), abi = parseAbi(['function mintBatch(address,address[],uint256[],string)']);
for (const [i, b] of batches.entries()) {
  const h = await w.writeContract({ address: MINTER, abi, functionName: 'mintBatch', args: [CHAINS.base.nft, b.map(x => x[0]), b.map(x => BigInt(x[1])), URI] });
  await pub('base').waitForTransactionReceipt({ hash: h }); console.log(`batch ${i + 1}/${batches.length} ${h}`);
}
