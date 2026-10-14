// Writes ../src/bridge.json for the site from deployments/<mode>.json. RPCs: PREVIEW=1 -> same-origin /rpc/<chain> proxy.
import fs from 'node:fs'; import path from 'node:path';
import { CFG, MODE, ROOT, loadDep } from './lib.mjs';
const dep = loadDep(); const preview = process.env.PREVIEW === '1';
const out = { network: 'testnet', mode: MODE, feeWallet: CFG.feeWallet, admin: CFG.admin, supportedChains: CFG.supportedChains,
  tiers: [{ min: 2, max: 2, eth: '0.08' }, { min: 3, max: 4, eth: '0.095' }, { min: 5, max: 99, eth: '0.12', label: 'All chains' }],
  lzGas: 300000, chains: {}, collections: [] };
for (const [k, c] of Object.entries(CFG.chains)) out.chains[k] = { name: c.name, chainId: c.chainId, eid: c.eid, rpc: preview ? `/rpc/${k}` : c.rpc, explorer: c.explorer, factory: dep.chains[k]?.factory || null, logo: k.startsWith('base') ? 'base' : 'ethereum' };
for (const [id, l] of Object.entries(dep.listings || {})) {
  const contracts = { [l.native]: l.nft, ...l.mirrors };
  out.collections.push({ id, slug: 'lil-foots-test', mirrorsSlug: 'lil-foots', name: id.endsWith(':1') ? 'LIL FOOTS test' : 'LIL FOOTS test ' + id.split(':')[1], native: l.native, contracts, escrows: l.escrows, img: '/img/lil-foots/s/', fromBlock: dep.fromBlock || {} });
}
fs.mkdirSync(path.join(ROOT, '../public'), { recursive: true }); fs.writeFileSync(path.join(ROOT, process.env.OUT || '../public/bridge.json'), JSON.stringify(out, null, 1) + '\n'); console.log('wrote bridge.json', out.collections.length, 'collections');
