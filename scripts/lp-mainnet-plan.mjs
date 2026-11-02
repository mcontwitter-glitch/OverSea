// UNSIGNED mainnet deploy PLAN for the MultiSea launchpad (5 chains). Holds NO key, signs nothing, broadcasts nothing.
// Only read-only RPC calls (nonce, default LZ libraries, executor config). Output: an ordered list of transactions
// { step, chain, from, to, value, data, note } per chain that YOU sign and send in order (wallet / hardware / Safe).
// Usage (explicit flag required):
//   node scripts/lp-mainnet-plan.mjs --i-will-sign-myself --deployer 0xYourDeployer [--nonce N] [--out /tmp/lp-mainnet-plan.json] [chain...]
// Contract addresses are predicted from (deployer, nonce): send each chain's txs in order from the same deployer with
// no other txs in between, or the predicted escrow peers will be wrong. Requires `forge build` (contracts/out).
import fs from 'node:fs';
import { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbi, getAddress, getContractAddress, keccak256, toHex, isAddress } from 'viem';
import LP from '../config/launchpad.json' with { type: 'json' };
import { MAIN } from './lp-mainnet-lz-check.mjs';
const argv = process.argv.slice(2); const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!argv.includes('--i-will-sign-myself')) { console.error('Refusing: pass --i-will-sign-myself. This script only prints unsigned transactions; nothing is sent.'); process.exit(2); }
const deployer = opt('--deployer'); if (!deployer || !isAddress(deployer, { strict: false })) { console.error('--deployer 0x... (the EOA that will sign the deploy txs) is required'); process.exit(2); }
const M = LP.mainnet; const ADMIN = getAddress(M.approver), FEE = getAddress(M.feeWallet), DELAY = BigInt(M.timelockDelaySec);
const art = n => { const j = JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const TL = art('MultiSeaTimelock'), DR = art('MultiSeaDrop'), OD = art('MultiSeaOmniDrop'), ES = art('MultiSeaOmniEscrow'), FA = art('MultiSeaLaunchpadFactory');
const EP = parseAbi(['function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)']);
const ULN_T = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const uln = (k, conf) => encodeAbiParameters(ULN_T, [{ confirmations: BigInt(conf), requiredDVNCount: 2, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: M.chains[k].requiredDVNs.map(a => getAddress(a)).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1), optionalDVNs: [] }]);
const Z32 = '0x' + '0'.repeat(64);
const chains = argv.filter(a => MAIN[a]).length ? argv.filter(a => MAIN[a]) : Object.keys(M.chains);
// 1) predict addresses on every chain (peers need all of them)
const pred = {};
for (const k of Object.keys(M.chains)) {
  const c = M.chains[k]; if (MAIN[k].eid !== c.eid || MAIN[k].endpoint.toLowerCase() !== c.endpoint.toLowerCase()) throw new Error(`${k}: config/launchpad.json mainnet EID/endpoint disagree with lp-mainnet-lz-check.mjs`);
  const pub = createPublicClient({ transport: http(MAIN[k].rpc, { retryCount: 3 }) });
  if (await pub.getChainId() !== c.chainId) throw new Error(`${k}: RPC chainId mismatch`);
  const n0 = opt('--nonce') != null ? BigInt(opt('--nonce')) : BigInt(await pub.getTransactionCount({ address: deployer }));
  const at = i => getContractAddress({ from: deployer, nonce: n0 + BigInt(i) });
  pred[k] = { pub, n0, timelock: at(0), dropImpl: at(1), omniDropImpl: at(2), omniEscrow: at(3), factory: at(4) };
}
const out = { generated: new Date().toISOString(), deployer, admin: ADMIN, approver: ADMIN, feeWallet: FEE, platformFeeBps: M.platformFeeBps, unsigned: true, chains: {} };
for (const k of chains) {
  const c = M.chains[k], P = pred[k], pub = P.pub; const txs = []; const add = (from, to, data, note, value = 0n) => txs.push({ step: txs.length + 1, chainId: c.chainId, from, to, value: value.toString(), data, note });
  const D = (abi, args, note) => add(deployer, null, encodeDeployData({ abi: abi.abi, bytecode: abi.bytecode, args }), note);
  const C = (to, abi, fn, args, note, from = deployer) => add(from, to, encodeFunctionData({ abi, functionName: fn, args }), note);
  D(TL, [DELAY, [ADMIN], [ADMIN]], `deploy MultiSeaTimelock (48h, proposer+executor ${ADMIN}) -> ${P.timelock} (nonce ${P.n0})`);
  D(DR, [], `deploy MultiSeaDrop impl -> ${P.dropImpl}`); D(OD, [], `deploy MultiSeaOmniDrop impl -> ${P.omniDropImpl}`);
  D(ES, [c.endpoint, deployer, FEE, BigInt(c.moveFeeWei)], `deploy MultiSeaOmniEscrow (endpoint ${c.endpoint}, fee ${FEE}, move fee ${c.moveFeeWei} wei ${c.native}) -> ${P.omniEscrow}`);
  D(FA, [deployer, P.dropImpl, FEE, ADMIN, M.platformFeeBps], `deploy MultiSeaLaunchpadFactory (approver ${ADMIN}, fee ${M.platformFeeBps} bps -> ${FEE}) -> ${P.factory}`);
  C(P.factory, FA.abi, 'setOmni', [P.omniDropImpl, P.omniEscrow], 'factory.setOmni(omniImpl, escrow)'); C(P.omniEscrow, ES.abi, 'setFactory', [P.factory], 'escrow.setFactory(factory)');
  for (const k2 of Object.keys(M.chains)) { if (k2 === k) continue; const c2 = M.chains[k2];
    C(P.omniEscrow, ES.abi, 'setPeer', [c2.eid, '0x' + pred[k2].omniEscrow.slice(2).toLowerCase().padStart(64, '0')], `escrow.setPeer(${k2} eid ${c2.eid} -> ${pred[k2].omniEscrow})`);
    const sl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultSendLibrary', args: [c2.eid] }); const rl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultReceiveLibrary', args: [c2.eid] });
    const exe = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'getConfig', args: ['0x0000000000000000000000000000000000000000', sl, c2.eid, 1] }); // default executor config, pinned
    C(c.endpoint, EP, 'setConfig', [P.omniEscrow, sl, [{ eid: c2.eid, configType: 1, config: exe }, { eid: c2.eid, configType: 2, config: uln(k, c.confirmations) }]], `endpoint.setConfig send lib ${sl} -> ${k2}: executor + ULN 2-of-2 DVNs, ${c.confirmations} confs`);
    C(c.endpoint, EP, 'setConfig', [P.omniEscrow, rl, [{ eid: c2.eid, configType: 2, config: uln(k, c2.confirmations) }]], `endpoint.setConfig receive lib ${rl} <- ${k2}: ULN 2-of-2 DVNs, ${c2.confirmations} confs`); }
  C(P.omniEscrow, ES.abi, 'setDelegate', [P.timelock], 'escrow.setDelegate(timelock)'); C(P.omniEscrow, ES.abi, 'transferOwnership', [P.timelock], 'escrow.transferOwnership(timelock)');
  C(P.factory, FA.abi, 'transferOwnership', [P.timelock], 'factory.transferOwnership(timelock) (Ownable2Step: pending until accepted)');
  const acc = encodeFunctionData({ abi: FA.abi, functionName: 'acceptOwnership' }); const salt = keccak256(toHex('accept-' + k));
  C(P.timelock, TL.abi, 'schedule', [P.factory, 0n, acc, Z32, salt, DELAY], `[ADMIN ${ADMIN}] timelock.schedule(factory.acceptOwnership), salt ${salt}`, ADMIN);
  C(P.timelock, TL.abi, 'execute', [P.factory, 0n, acc, Z32, salt], `[ADMIN ${ADMIN}] timelock.execute(factory.acceptOwnership): ONLY after 48h`, ADMIN);
  out.chains[k] = { chainId: c.chainId, eid: c.eid, endpoint: c.endpoint, native: c.native, deployerNonce: P.n0.toString(), predicted: { timelock: P.timelock, dropImpl: P.dropImpl, omniDropImpl: P.omniDropImpl, omniEscrow: P.omniEscrow, factory: P.factory }, txs };
}
const file = opt('--out') || '/tmp/lp-mainnet-plan.json'; fs.writeFileSync(file, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out.chains)) { console.log(`\n${k} (chainId ${v.chainId}, eid ${v.eid}, deployer nonce ${v.deployerNonce})`); for (const t of v.txs) console.log(`  ${t.step}. ${t.from === deployer ? 'deployer' : 'ADMIN'} ${t.to ?? '(create)'}  ${t.note}`); }
console.log(`\nUnsigned plan written to ${file}. Nothing was signed or sent. After deploy, fill config/launchpad.json mainnet.chains.*, factories.* and omniEscrows.*.`);
