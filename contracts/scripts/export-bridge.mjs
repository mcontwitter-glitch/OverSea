// Write public/bridge.json for the site from deployments/<net>.json. Mainnet: NET=mainnet MODE=live.
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, CFG, MODE, NET, loadDep } from './lib.mjs';
const dep = loadDep(); const out = path.join(ROOT, '..', 'public', 'bridge.json');
const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const chains = Object.fromEntries(Object.entries(CFG.chains).map(([k, c]) => [k, { name: c.name, chainId: c.chainId, eid: c.eid, native: c.native || 'ETH', logo: c.logo || k,
  rpc: c.rpc, explorer: c.explorer, factory: dep.chains[k]?.factory || null }]));
const j = { network: NET, mode: MODE, feeWallet: CFG.feeWallet, supportedChains: CFG.supportedChains, lzGas: 300000, chains, collections: prev.network === NET ? prev.collections || [] : [] };
fs.writeFileSync(out, JSON.stringify(j, null, 1) + '\n'); console.log('wrote', out, Object.values(chains).filter(c => c.factory).length, 'factories,', j.collections.length, 'collections');
