// CollectionOffers CREATE2 helper — prints calldata and gas estimates. NEVER sends a transaction and NEVER reads a private key.
// MC signs the deploy himself from 0xb19F00e095B1387061d73751C772bbA848D196b1 (or uses https://multisea.io/deploy-offers).
import { createPublicClient, http, keccak256, toBytes, encodeDeployData, getContractAddress, formatEther, formatGwei } from 'viem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = JSON.parse(readFileSync(join(root, 'config/collection-offers-artifact.json'), 'utf8'));
const CFG = JSON.parse(readFileSync(join(root, 'config/collections.json'), 'utf8'));

const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const OWNER = '0xb19F00e095B1387061d73751C772bbA848D196b1';
const FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0';
const SALT = keccak256(toBytes('MultiSea.CollectionOffers.v1'));
const CHAINS = ['ethereum', 'base', 'apechain', 'bnb', 'robinhood'];

const init = encodeDeployData({ abi: ART.abi, bytecode: ART.bytecode, args: [OWNER, FEE] });
const address = getContractAddress({ opcode: 'CREATE2', from: FACTORY, salt: SALT, bytecode: init });
const calldata = SALT + init.slice(2);

console.log('CollectionOffers CREATE2 deploy (read-only — no key, no tx)');
console.log('Factory :', FACTORY);
console.log('Salt    :', SALT, '(keccak256("MultiSea.CollectionOffers.v1"))');
console.log('Owner   :', OWNER);
console.log('Fee     :', FEE);
console.log('Address :', address, '(same on every chain once deployed)');
console.log('Calldata: salt || initcode  (' + (calldata.length - 2) / 2 + ' bytes)');
console.log('');

const rows = [];
for (const k of CHAINS) {
  const c = CFG.chains[k];
  const pub = createPublicClient({ transport: http(c.rpc, { timeout: 15_000 }) });
  try {
    const [factoryCode, code, gasPrice, block] = await Promise.all([
      pub.getCode({ address: FACTORY }),
      pub.getCode({ address }),
      pub.getGasPrice(),
      pub.getBlock({ blockTag: 'latest' }),
    ]);
    const factoryOk = !!(factoryCode && factoryCode !== '0x');
    const deployed = !!(code && code !== '0x');
    let gas = null, err = null;
    if (factoryOk && !deployed) {
      try { gas = await pub.estimateGas({ account: OWNER, to: FACTORY, data: calldata, value: 0n }); }
      catch (e) { err = e.shortMessage || e.message; }
    }
    const fee = gas != null ? gas * (gasPrice * 12n / 10n) : null;
    rows.push({ chain: k, name: c.name, factoryOk, deployed, gas: gas?.toString() || null, gasPriceGwei: formatGwei(gasPrice), est: fee != null ? formatEther(fee) + ' ' + c.native : (deployed ? 'already deployed' : err || (factoryOk ? '-' : 'factory missing')) });
  } catch (e) {
    rows.push({ chain: k, name: c.name, factoryOk: false, deployed: false, gas: null, gasPriceGwei: null, est: e.shortMessage || e.message });
  }
}
console.table(rows);
console.log('\nWhat to sign on each chain (from the owner wallet, in a wallet UI or on https://multisea.io/deploy-offers):');
console.log('  to    =', FACTORY);
console.log('  value = 0');
console.log('  data  = (calldata printed above; the page fills this for you)');
console.log('\nAfter a chain confirms, add the address to config/collections.json:');
console.log('  "collectionOffers": { "ethereum": "' + address + '", "base": "' + address + '", "apechain": "' + address + '", "bnb": "' + address + '", "robinhood": "' + address + '" }');
console.log('  (only the chains that actually have code; leave others out until they do)');
console.log('\nThis script does not and will not broadcast a transaction.');
