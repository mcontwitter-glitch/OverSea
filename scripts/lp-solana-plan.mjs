// UNSIGNED mainnet plan for the EVM side of Solana drops (5 chains). Holds NO key, signs nothing, broadcasts nothing.
// Read-only RPC calls only (nonce, default LZ libraries, executor config, factory owner). Output: ordered transactions
// { step, chain, from, to, value, data, note } per chain that MC signs and sends in order (/deploy-solana runs them from his wallet).
// Usage (explicit flag required):
//   node scripts/lp-solana-plan.mjs --i-will-sign-myself --deployer 0xMC --solana-program <program id> [--existing-cid 0xcid,0xcid...] [--timelock-exit ownership|delay0|keep] [--nonce-<chain> N] [--out /tmp/lp-solana-plan.json] [chain...]
// Per chain: deploy MultiSeaOmniEscrowV2 + MultiSeaOmniDropV2 impl, escrow.setFactory(existing factory), peers to the other V2 escrows
// and to the Solana Store PDA, LayerZero send/receive config (2-of-2 DVNs = the chain's requiredDVNs, LZ Labs + Horizen) for every
// remote incl. Solana, escrow.setSolana(30168); ownership + LayerZero delegate of the NEW contracts stay with the deployer (MC's wallet),
// then factory.setOmni(V2 impl, V2 escrow). LIVE drops keep their V1 escrow; only drops created afterwards use V2.
// EXISTING collections (Option A): per chain a MultiSeaSolanaMover (moves a token into the chain's EXISTING V1 escrow and sends the
// LayerZero release to Solana; never holds tokens), its Solana peer + send config, setCollection for each --existing-cid (owner = MC,
// direct calls), and on the existing V1 escrow (owned by the timelock): V1escrow.setPeer(30168, Store) + its receive config from Solana.
// EXISTING timelock (owner + LZ delegate of the live factory and V1 escrow; 48 h minDelay, MC = proposer/executor/canceller, the timelock
// is its own admin): --timelock-exit picks how the plan deals with it. Each costs ONE 48 h wait, scheduled as step 1 of the chain:
//   ownership (default): timelock.scheduleBatch(factory.transferOwnership(MC), V1escrow.setDelegate(MC), V1escrow.transferOwnership(MC)),
//              executeBatch after 48 h, MC calls factory.acceptOwnership() (Ownable2Step); after that every call is a direct MC call.
//   delay0:    timelock.scheduleBatch(updateDelay(0)), executeBatch after 48 h; the timelock stays owner, later calls are
//              scheduleBatch(delay 0) + executeBatch back-to-back (two txs, no wait).
//   keep:      no change: the existing-contract steps are scheduled with the 48 h delay.
import fs from 'node:fs';
import { createPublicClient, http, encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbi, getAddress, getContractAddress, keccak256, toHex, isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import LP from '../config/launchpad.json' with { type: 'json' };
import { MAIN } from './lp-mainnet-lz-check.mjs';
const argv = process.argv.slice(2); const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (!argv.includes('--i-will-sign-myself')) { console.error('Refusing: pass --i-will-sign-myself. This script only prints unsigned transactions; nothing is sent.'); process.exit(2); }
const deployer = opt('--deployer'); if (!deployer || !isAddress(deployer, { strict: false })) { console.error('--deployer 0x... (the EOA that signs) is required'); process.exit(2); }
let program; try { program = new PublicKey(opt('--solana-program')); } catch { console.error('--solana-program <the mainnet MultiSea program id> is required'); process.exit(2); }
const store = PublicKey.findProgramAddressSync([Buffer.from('Store')], program)[0]; const store32 = '0x' + Buffer.from(store.toBytes()).toString('hex');
const SOL_EID = LP.solana.eid, SOL_CONF = 32; // Solana finalized-ish confirmations for packets coming from Solana
const M = LP.mainnet; const FEE = getAddress(M.feeWallet), DELAY = BigInt(M.timelockDelaySec);
const art = n => { const j = JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const MV = art('MultiSeaSolanaMover'), V1 = art('MultiSeaOmniEscrow'), ES = art('MultiSeaOmniEscrowV2'), OD = art('MultiSeaOmniDropV2'), FA = art('MultiSeaLaunchpadFactory'), TL = art('MultiSeaTimelock');
const EP = parseAbi(['function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)']);
const OWN = parseAbi(['function owner() view returns (address)', 'function delegates(address) view returns (address)', 'function dropOf(bytes32) view returns (address)']);
const EXIT = opt('--timelock-exit') || 'ownership';
if (!['ownership', 'delay0', 'keep'].includes(EXIT)) { console.error('--timelock-exit ownership|delay0|keep'); process.exit(2); }
const EXISTING = (opt('--existing-cid') || '').split(',').filter(Boolean);
for (const x of EXISTING) if (!/^0x[0-9a-fA-F]{64}$/.test(x)) { console.error(`--existing-cid: ${x} is not a bytes32`); process.exit(2); }
const ULN_T = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const uln = (k, conf) => encodeAbiParameters(ULN_T, [{ confirmations: BigInt(conf), requiredDVNCount: 2, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: M.chains[k].requiredDVNs.map(a => getAddress(a)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), optionalDVNs: [] }]);
const Z32 = '0x' + '0'.repeat(64);
const chains = argv.filter(a => MAIN[a]).length ? argv.filter(a => MAIN[a]) : Object.keys(M.chains);
const pred = {};
for (const k of Object.keys(M.chains)) {
  const c = M.chains[k]; const pub = createPublicClient({ transport: http(MAIN[k].rpc, { retryCount: 3 }) });
  if (await pub.getChainId() !== c.chainId) throw new Error(`${k}: RPC chainId mismatch`);
  const n0 = opt('--nonce-' + k) != null ? BigInt(opt('--nonce-' + k)) : BigInt(await pub.getTransactionCount({ address: deployer }));
  const tl = getAddress(c.timelock); const rd = (address, functionName, args = []) => pub.readContract({ address, abi: OWN, functionName, args }).then(getAddress);
  const fOwner = await rd(c.factory, 'owner'), vOwner = await rd(c.omniEscrow, 'owner'), vDel = await rd(c.endpoint, 'delegates', [c.omniEscrow]);
  const exit = EXIT !== 'keep' && (fOwner === tl || vOwner === tl || vDel === tl); // the exit batch is step 1 (from the proposer)
  const shift = exit && getAddress(M.timelockProposer) === getAddress(deployer) ? 1n : 0n; // it uses one deployer nonce before the deploys
  const at = i => getContractAddress({ from: deployer, nonce: n0 + shift + BigInt(i) });
  pred[k] = { pub, n0: n0 + shift, nTx0: n0, escrow: at(0), dropImpl: at(1), mover: at(2), tl, fOwner, vOwner, vDel, exit };
}
const out = { timelockExit: EXIT, generated: new Date().toISOString(), deployer, solanaProgram: program.toBase58(), solanaStore: store.toBase58(), solanaEid: SOL_EID, unsigned: true, chains: {} };
for (const k of chains) {
  const c = M.chains[k], P = pred[k], pub = P.pub; const txs = []; const add = (from, to, data, note, value = 0n) => txs.push({ step: txs.length + 1, chainId: c.chainId, from, to, value: value.toString(), data, note });
  const D = (a, args, note) => add(deployer, null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }), note);
  const C = (to, abi, fn, args, note, from = deployer) => add(from, to, encodeFunctionData({ abi, functionName: fn, args }), note);
  const PROP = getAddress(M.timelockProposer), EXEC = getAddress(M.timelockExecutor), MC = getAddress(M.timelockProposer);
  const exitOps = [];
  if (P.exit && EXIT === 'ownership') {
    if (P.fOwner === P.tl) exitOps.push([c.factory, encodeFunctionData({ abi: FA.abi, functionName: 'transferOwnership', args: [MC] }), `factory.transferOwnership(${MC})`]);
    if (P.vDel === P.tl) exitOps.push([c.omniEscrow, encodeFunctionData({ abi: V1.abi, functionName: 'setDelegate', args: [MC] }), `V1escrow.setDelegate(${MC})`]);
    if (P.vOwner === P.tl) exitOps.push([c.omniEscrow, encodeFunctionData({ abi: V1.abi, functionName: 'transferOwnership', args: [MC] }), `V1escrow.transferOwnership(${MC})`]);
  } else if (P.exit) exitOps.push([P.tl, encodeFunctionData({ abi: TL.abi, functionName: 'updateDelay', args: [0n] }), 'timelock.updateDelay(0)']);
  const batch = (ops) => [ops.map(o => getAddress(o[0])), ops.map(() => 0n), ops.map(o => o[1])];
  const exitSalt = keccak256(toHex(`timelock-exit-${EXIT}-${k}`));
  if (exitOps.length) C(P.tl, TL.abi, 'scheduleBatch', [...batch(exitOps), Z32, exitSalt, DELAY], `[PROPOSER ${PROP}] TIMELOCK EXIT (${EXIT}): timelock.scheduleBatch(${exitOps.map(o => o[2]).join(' + ')}), 48 h delay starts now, salt ${exitSalt}`, PROP);
  // a call on an EXISTING contract owned by the timelock, after the exit (or, with keep, through a 48 h schedule)
  let afterExit = false;
  const ownerCalls = (owner, ops, tag) => {
    if (owner !== P.tl) { for (const o of ops) add(owner, o[0], o[1], `[OWNER ${owner}] ${o[2]}`); return; }
    if (exitOps.length && !afterExit) { afterExit = true;
      C(P.tl, TL.abi, 'executeBatch', [...batch(exitOps), Z32, exitSalt], `[EXECUTOR ${EXEC}] TIMELOCK EXIT: timelock.executeBatch: ONLY 48 h after step 1`, EXEC);
      if (EXIT === 'ownership' && P.fOwner === P.tl) add(MC, c.factory, encodeFunctionData({ abi: FA.abi, functionName: 'acceptOwnership', args: [] }), `factory.acceptOwnership() (Ownable2Step): MC now owns the factory`);
    }
    if (EXIT === 'ownership') { for (const o of ops) add(MC, o[0], o[1], `[MC, owner after the exit] ${o[2]}`); return; }
    const d = EXIT === 'delay0' ? 0n : DELAY; const salt = keccak256(toHex(`solana-${tag}-${k}`));
    C(P.tl, TL.abi, 'scheduleBatch', [...batch(ops), Z32, salt, d], `[PROPOSER ${PROP}] timelock.scheduleBatch(${ops.map(o => o[2]).join(' + ')}), delay ${d}s, salt ${salt}`, PROP);
    C(P.tl, TL.abi, 'executeBatch', [...batch(ops), Z32, salt], `[EXECUTOR ${EXEC}] timelock.executeBatch${d ? ': ONLY after 48 h' : ' (right after the schedule, delay 0)'}`, EXEC);
  };
  D(ES, [c.endpoint, deployer, FEE, BigInt(c.moveFeeWei)], `deploy MultiSeaOmniEscrowV2 (endpoint ${c.endpoint}, fee ${FEE}, move fee ${c.moveFeeWei} wei) -> ${P.escrow} (nonce ${P.n0})`);
  D(OD, [], `deploy MultiSeaOmniDropV2 impl -> ${P.dropImpl}`);
  const v1 = getAddress(c.omniEscrow);
  D(MV, [c.endpoint, deployer, v1, SOL_EID], `deploy MultiSeaSolanaMover (existing V1 escrow ${v1}, Solana eid ${SOL_EID}) -> ${P.mover}`);
  C(P.escrow, ES.abi, 'setFactory', [getAddress(c.factory)], `escrowV2.setFactory(${c.factory}) (the existing factory)`);
  const remotes = [...Object.keys(M.chains).filter(x => x !== k).map(x => ({ k: x, eid: M.chains[x].eid, peer: '0x' + pred[x].escrow.slice(2).toLowerCase().padStart(64, '0'), conf: M.chains[x].confirmations })), { k: 'solana', eid: SOL_EID, peer: store32, conf: SOL_CONF }];
  for (const r of remotes) {
    C(P.escrow, ES.abi, 'setPeer', [r.eid, r.peer], `escrowV2.setPeer(${r.k} eid ${r.eid} -> ${r.k === 'solana' ? store.toBase58() + ' (Store PDA)' : '0x' + r.peer.slice(26)})`);
    const sl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultSendLibrary', args: [r.eid] }); const rl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultReceiveLibrary', args: [r.eid] });
    const exe = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'getConfig', args: ['0x0000000000000000000000000000000000000000', sl, r.eid, 1] });
    C(c.endpoint, EP, 'setConfig', [P.escrow, sl, [{ eid: r.eid, configType: 1, config: exe }, { eid: r.eid, configType: 2, config: uln(k, c.confirmations) }]], `endpoint.setConfig send ${sl} -> ${r.k}: executor + ULN 2-of-2, ${c.confirmations} confs`);
    C(c.endpoint, EP, 'setConfig', [P.escrow, rl, [{ eid: r.eid, configType: 2, config: uln(k, r.conf) }]], `endpoint.setConfig receive ${rl} <- ${r.k}: ULN 2-of-2, ${r.conf} confs`);
  }
  C(P.escrow, ES.abi, 'setSolana', [SOL_EID, true], `escrowV2.setSolana(${SOL_EID}, true)`);
  // existing collections: mover -> Solana (send only), then the existing V1 escrow learns the Solana Store as its 30168 peer
  {
    C(P.mover, MV.abi, 'setPeer', [SOL_EID, store32], `mover.setPeer(solana ${SOL_EID} -> ${store.toBase58()} (Store PDA))`);
    const sl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultSendLibrary', args: [SOL_EID] }), rl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultReceiveLibrary', args: [SOL_EID] });
    const exe = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'getConfig', args: ['0x0000000000000000000000000000000000000000', sl, SOL_EID, 1] });
    C(c.endpoint, EP, 'setConfig', [P.mover, sl, [{ eid: SOL_EID, configType: 1, config: exe }, { eid: SOL_EID, configType: 2, config: uln(k, c.confirmations) }]], `endpoint.setConfig send ${sl} mover -> solana: executor + ULN 2-of-2, ${c.confirmations} confs`);
    for (const cid of EXISTING) {
      const d = await pub.readContract({ address: v1, abi: OWN, functionName: 'dropOf', args: [cid] });
      if (/^0x0{40}$/i.test(d)) { console.error(`${k}: ${cid} is not a drop of the V1 escrow ${v1}; skipped`); continue; }
      C(P.mover, MV.abi, 'setCollection', [cid, true], `mover.setCollection(${cid} = drop ${d}, true)`);
    }
    const sp = encodeFunctionData({ abi: V1.abi, functionName: 'setPeer', args: [SOL_EID, store32] });
    const rc = encodeFunctionData({ abi: EP, functionName: 'setConfig', args: [v1, rl, [{ eid: SOL_EID, configType: 2, config: uln(k, SOL_CONF) }]] });
    // after an ownership exit MC is also the V1 escrow's delegate, so its receive config goes with the peer
    const sameAuth = P.vDel === P.vOwner || EXIT === 'ownership';
    const ops = [[v1, sp, `V1escrow.setPeer(${SOL_EID}, Store)`]]; if (sameAuth) ops.push([c.endpoint, rc, `endpoint.setConfig receive ${rl} V1escrow <- solana: ULN 2-of-2, ${SOL_CONF} confs`]);
    ownerCalls(P.vOwner, ops, 'existing');
    if (!sameAuth) add(P.vDel, c.endpoint, rc, `[V1 ESCROW DELEGATE ${P.vDel}] endpoint.setConfig receive ${rl} V1escrow <- solana: ULN 2-of-2, ${SOL_CONF} confs`);
  }
  const owner = P.fOwner;
  ownerCalls(owner, [[c.factory, encodeFunctionData({ abi: FA.abi, functionName: 'setOmni', args: [P.dropImpl, P.escrow] }), 'factory.setOmni(V2 impl, V2 escrow). From here new multichain drops use V2']], 'setOmni');
  out.chains[k] = { chainId: c.chainId, eid: c.eid, deployerNonce: P.nTx0.toString(), timelock: P.tl, timelockExit: exitOps.length ? EXIT : 'none', factoryOwner: owner, v1EscrowOwner: P.vOwner, predicted: { omniEscrowV2: P.escrow, omniDropImplV2: P.dropImpl, solanaMover: P.mover, v1Escrow: getAddress(c.omniEscrow) }, existingCids: EXISTING, txs };
}
const file = opt('--out') || '/tmp/lp-solana-plan.json'; fs.writeFileSync(file, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out.chains)) { console.log(`\n${k} (chainId ${v.chainId}, deployer nonce ${v.deployerNonce}, factory owner ${v.factoryOwner})`); for (const t of v.txs) console.log(`  ${t.step}. ${t.from.toLowerCase() === deployer.toLowerCase() ? 'deployer' : t.from} ${t.to ?? '(create)'}  ${t.note}`); }
console.log(`\nUnsigned plan written to ${file} (Solana Store PDA ${store.toBase58()}). Nothing was signed or sent. Load it in /deploy-solana.`);
