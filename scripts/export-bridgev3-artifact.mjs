// Writes config/bridgev3-artifact.json (bytecode + ABI-free constants) for /deploy-bridge-v3 from forge output.
// Run on branch escrow-v2 (sources: contracts/src/MultiSeaFactoryV3.sol, EscrowDeployer.sol, MultiSeaEscrowV2.sol) after `forge build`.
import fs from 'node:fs'; import cp from 'node:child_process';
const out = n => JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')).bytecode.object;
const CFG = JSON.parse(fs.readFileSync('contracts/config/mainnet.json', 'utf8'));
const DEP = JSON.parse(fs.readFileSync('contracts/deployments/mainnet.json', 'utf8'));
const chains = {};
for (const [k, c] of Object.entries(CFG.chains)) { const others = Object.keys(CFG.chains).filter(x => x !== k);
  chains[k] = { eid: c.eid, oldFactory: DEP.chains[k].factory, endpoint: c.endpoint, route: { sendLib: c.sendLib, receiveLib: c.receiveLib, executor: c.executor, dvn: c.dvn, confirmations: c.confirmations },
    remoteEids: others.map(x => CFG.chains[x].eid), remoteConfirmations: others.map(x => CFG.chains[x].confirmations) }; }
const j = { note: 'MultiSeaFactoryV3 + EscrowDeployer + MultiSeaMirrorDeployer. Deployed by the admin wallet from /deploy-bridge-v3 (no server key).',
  source: cp.execSync('git rev-parse escrow-v2', { encoding: 'utf8' }).trim(), admin: CFG.admin, feeWallet: CFG.feeWallet, supportedChains: CFG.supportedChains,
  operator: process.env.SERVER_OPERATOR || '0x9af3dD330923a0d5d8567a85456C773cD6C98faa',
  factory: out('MultiSeaFactoryV3'), escrowDeployer: out('EscrowDeployer'), mirrorDeployer: out('MultiSeaMirrorDeployer'), chains };
fs.writeFileSync('config/bridgev3-artifact.json', JSON.stringify(j, null, 1) + '\n'); console.log('wrote config/bridgev3-artifact.json', j.source.slice(0, 8));
