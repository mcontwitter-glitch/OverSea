// Writes deployed testnet addresses (deployments/launchpad-testnet.json) into config/launchpad.testnet.json for the
// staging Worker + staging UI. Public addresses only.
import fs from 'node:fs';
import { load } from './lp-testnet.mjs';
const P = new URL('../../config/launchpad.testnet.json', import.meta.url);
const T = JSON.parse(fs.readFileSync(P, 'utf8')); const s = load();
const live = Object.keys(T.chains).filter(k => s.chains[k]?.factory);
for (const k of Object.keys(T.chains)) { const d = s.chains[k]; const c = T.chains[k];
  if (!d?.factory) { c.status = c.status?.startsWith('blocked') ? c.status : 'not deployed'; delete c.contracts; continue; }
  c.status = 'deployed'; c.contracts = { timelock: d.timelock, dropImplementation: d.dropImpl, omniImplementation: d.omniImpl, omniEscrow: d.escrow, factory: d.factory };
  c.lzPeers = Object.keys(d.peers || {}); c.lzNoPathway = d.unsupported || []; c.dvn = d.dvn; }
T.deployer = s.deployer; T.approver = s.approver;
T.worker = { chains: live, hubChain: T.hubChain, factories: Object.fromEntries(live.map(k => [k, s.chains[k].factory])), eids: Object.fromEntries(live.map(k => [k, T.chains[k].eid])), omniEscrows: Object.fromEntries(live.map(k => [k, s.chains[k].escrow])) };
if (s.smoke?.cid) T.drops = [{ slug: s.smoke.slug, name: 'MultiSea Smoke', symbol: 'MSMOKE', collectionId: s.smoke.cid, maxSupply: 20, batchK: 10, batchTMin: 5, priceWei: '10000000000000', chains: ['baseSepolia', 'sepolia', 'robinhoodTestnet'],
  addresses: Object.fromEntries(['baseSepolia', 'sepolia', 'robinhoodTestnet'].map(k => [k, s.chains[k].drops[s.smoke.cid]])) }];
fs.writeFileSync(P, JSON.stringify(T, null, 1) + '\n'); console.log('exported', live.join(','));
