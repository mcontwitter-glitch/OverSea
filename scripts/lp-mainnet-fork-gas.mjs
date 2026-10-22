// READ-ONLY w.r.t. mainnet: runs the FULL launchpad mainnet setup on LOCAL anvil forks of each mainnet (real LayerZero
// endpoints, ULN libs, DVN configs, price feeds) with a throwaway random deployer, and records gas per step.
// Nothing is broadcast to any real network. Usage: node scripts/lp-mainnet-fork-gas.mjs [chain...]  -> /tmp/est/fork-<chain>.json
import fs from 'node:fs'; import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, parseAbi, decodeAbiParameters, encodeAbiParameters, keccak256, toHex, decodeEventLog, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MAIN } from './lp-mainnet-lz-check.mjs';
const art = n => { const j = JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const TL = art('MultiSeaTimelock'), DR = art('MultiSeaDrop'), OD = art('MultiSeaOmniDrop'), ES = art('MultiSeaOmniEscrow'), FA = art('MultiSeaLaunchpadFactory');
const ADMIN = '0xca89ae48a5c61d13e78236daa4ac29ee588ea475', FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0', DELAY = 172800n;
const EP = parseAbi(['function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)']);
const MOVEFEE = { base: 10n ** 14n, ethereum: 10n ** 14n, robinhood: 10n ** 14n, bnb: 5n * 10n ** 14n, apechain: 3n * 10n ** 17n }; // ≈ $0.30
// Pinned DVN set (2-of-2 required): LayerZero Labs + Horizen — the only providers with all 20 directed pathways live.
export const DVNS = { base: ['0x9e059a54699a285714207b43b055483e78faac25', '0xa7b5189bca84cd304d8553977c7c614329750d99'], ethereum: ['0x589dedbd617e0cbcb916a9223f4d1300c294236b', '0x380275805876ff19055ea900cdb2b46a94ecf20d'],
  apechain: ['0x6788f52439aca6bff597d3eec2dc9a44b8fee842', '0xdd7b5e1db4aafd5c8ec3b764efb8ed265aa5445b'], bnb: ['0xfd6865c841c2d64565562fcc7e05e619a30615f0', '0x247624e2143504730aec22912ed41f092498bef2'],
  robinhood: ['0xd01ae6905d48315f7be10c7330aecf8360ef5b12', '0x1258a278519c7f4bd997a9c3bfd4aa802a028d89'] };
export const CONF = { base: 10n, ethereum: 15n, apechain: 20n, bnb: 20n, robinhood: 5n }; // = LZ default send confirmations of each source chain
const ULN_T = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const uln = (chain, conf) => encodeAbiParameters(ULN_T, [{ confirmations: conf, requiredDVNCount: 2, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: [...DVNS[chain]].map(a => getAddress(a)).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1), optionalDVNs: [] }]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fork(k, port) { const p = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ['--fork-url', MAIN[k].rpc, '--port', String(port), '--silent', '--no-rate-limit', '--chain-id', String(MAIN[k].chainId)], { stdio: 'ignore' });
  const pub = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { timeout: 120_000 }) }); for (let i = 0; i < 60; i++) { try { await pub.getBlockNumber(); return { p, pub }; } catch { await sleep(1000); } } throw new Error('anvil did not start'); }
async function run(k, port) {
  const { p, pub } = await fork(k, port); const R = `http://127.0.0.1:${port}`; const c = MAIN[k]; const gas = {}; const extra = {};
  const dep = privateKeyToAccount(generatePrivateKey()); const appr = privateKeyToAccount(generatePrivateKey());
  for (const a of [dep.address, ADMIN]) await pub.request({ method: 'anvil_setBalance', params: [a, '0x3635C9ADC5DEA00000'] });
  await pub.request({ method: 'anvil_impersonateAccount', params: [ADMIN] });
  const W = createWalletClient({ transport: http(R), account: dep, chain: { id: c.chainId, name: k, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [R] } } } });
  const WA = createWalletClient({ transport: http(R), account: ADMIN, chain: W.chain });
  const rc = async h => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('reverted ' + h); return r; };
  const D = async (label, a, args) => { const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }); const r = await rc(await W.sendTransaction({ data, gas: 30_000_000n })); gas[label] = Number(r.gasUsed); (extra.deployData ??= {})[label] = data; return getAddress(r.contractAddress); };
  const S = async (label, w, to, abi, fn, args, value) => { const r = await rc(await w.writeContract({ address: to, abi, functionName: fn, args, value, gas: 15_000_000n })); gas[label] = (gas[label] || 0) + Number(r.gasUsed); (extra.calls ??= {})[label] = (extra.calls[label] || 0) + 1; return r; };
  // (a) platform setup
  const tl = await D('deploy timelock', TL, [DELAY, [ADMIN], [ADMIN]]); const di = await D('deploy MultiSeaDrop impl', DR, []); const oi = await D('deploy MultiSeaOmniDrop impl', OD, []);
  const es = await D('deploy MultiSeaOmniEscrow', ES, [c.endpoint, dep.address, FEE, MOVEFEE[k]]); const fa = await D('deploy factory', FA, [dep.address, di, FEE, appr.address, 50]);
  await S('factory config (setOmni)', W, fa, FA.abi, 'setOmni', [oi, es]); await S('escrow config (setFactory)', W, es, ES.abi, 'setFactory', [fa]);
  // (b) LayerZero wiring to the 4 other chains: setPeer + pin ULN send/receive + executor config
  const Z = '0x0000000000000000000000000000000000000000';
  for (const [k2, c2] of Object.entries(MAIN)) { if (k2 === k) continue;
    await S('setPeer ×4', W, es, ES.abi, 'setPeer', [c2.eid, '0x' + keccak256(toHex(k2)).slice(26).padStart(64, '0')]);
    const sl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultSendLibrary', args: [c2.eid] }); const rl = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'defaultReceiveLibrary', args: [c2.eid] });
    const ulnS = uln(k, CONF[k]); const exe = await pub.readContract({ address: c.endpoint, abi: EP, functionName: 'getConfig', args: [es, sl, c2.eid, 1] });
    const ulnR = uln(k, CONF[k2]);
    await S('setConfig send (ULN DVNs + executor) ×4', W, c.endpoint, EP, 'setConfig', [es, sl, [{ eid: c2.eid, configType: 1, config: exe }, { eid: c2.eid, configType: 2, config: ulnS }]]);
    await S('setConfig receive (ULN DVNs) ×4', W, c.endpoint, EP, 'setConfig', [es, rl, [{ eid: c2.eid, configType: 2, config: ulnR }]]); }
  // handoff to the timelock (48 h) + admin schedules and executes factory.acceptOwnership()
  await S('escrow setDelegate(timelock)', W, es, ES.abi, 'setDelegate', [tl]); await S('escrow transferOwnership(timelock)', W, es, ES.abi, 'transferOwnership', [tl]); await S('factory transferOwnership(timelock)', W, fa, FA.abi, 'transferOwnership', [tl]);
  const acc = encodeFunctionData({ abi: FA.abi, functionName: 'acceptOwnership' }); const salt = keccak256(toHex('accept-' + k)); const pred = '0x' + '0'.repeat(64);
  await S('timelock schedule(acceptOwnership) [admin]', WA, tl, TL.abi, 'schedule', [fa, 0n, acc, pred, salt, DELAY]);
  await pub.request({ method: 'evm_increaseTime', params: [Number(DELAY) + 1] }); await pub.request({ method: 'evm_mine', params: [] });
  await S('timelock execute(acceptOwnership) [admin]', WA, tl, TL.abi, 'execute', [fa, 0n, acc, pred, salt]);
  if ((await pub.readContract({ address: fa, abi: FA.abi, functionName: 'owner' })).toLowerCase() !== tl.toLowerCase()) throw new Error('handoff failed');
  // (c) per-drop creator deploys (creator = deployer here; approver signs the factory digest)
  const now = BigInt((await pub.getBlock()).timestamp); const ph = [{ start: now - 60n, end: 0n, price: 10n ** 15n, maxPerWallet: 0, merkleRoot: pred }];
  const sp = { name: 'Estimate Drop', symbol: 'EST', owner: dep.address, payout: dep.address, feeWallet: Z, platformFeeBps: 0, maxSupply: 4404, creatorReserve: 0, royaltyReceiver: dep.address, royaltyBps: 500n, baseURI: 'ipfs://bafy/', preRevealURI: '', phases: ph };
  const dl = now + 86400n; const salt1 = keccak256(toHex('drop-' + k));
  const dg = await pub.readContract({ address: fa, abi: FA.abi, functionName: 'approvalDigest', args: [dep.address, await pub.readContract({ address: fa, abi: FA.abi, functionName: 'configHash', args: [sp] }), salt1, dl] });
  await S('createDrop (single-chain clone + init)', W, fa, FA.abi, 'createDrop', [sp, salt1, dl, await appr.sign({ hash: dg })]);
  const eids = Object.values(MAIN).map(x => x.eid);
  const op = { name: 'Estimate Omni', symbol: 'OMNI', owner: dep.address, payout: dep.address, feeWallet: Z, platformFeeBps: 0, maxSupply: 4404, royaltyReceiver: dep.address, royaltyBps: 500n, baseURI: 'ipfs://bafy/', preRevealURI: '', phases: ph, eids, hubEid: MAIN.base.eid, prices: eids.map(() => 10n ** 15n), copyMode: 0, batchK: 50, batchT: 1800 };
  const cid = keccak256(toHex('omni-est')); const og = await pub.readContract({ address: fa, abi: FA.abi, functionName: 'omniDigest', args: [dep.address, await pub.readContract({ address: fa, abi: FA.abi, functionName: 'omniConfigHash', args: [op] }), cid, dl] });
  const r = await S('createOmniDrop (multichain clone + init + register), per chain', W, fa, FA.abi, 'createOmniDrop', [op, cid, dl, await appr.sign({ hash: og })]);
  const drop = getAddress('0x' + r.logs.find(l => l.address.toLowerCase() === fa.toLowerCase()).topics[1].slice(26));
  // mints (+ flush on the hub). Escrow is now timelock-owned; the destination gas defaults are the mainnet ones.
  const qm = async q => pub.readContract({ address: drop, abi: OD.abi, functionName: 'quoteMint', args: [0n, BigInt(q), dep.address, 0n] });
  if (k === 'base') {
    for (const q of [1, 20, 20, 8]) { const [pr, lz] = await qm(q); (extra.hubShare ??= {})[q] = lz.toString(); await S(`hub mint x${q}`, W, drop, OD.abi, 'mint', [dep.address, 0n, BigInt(q), [], 0n], pr + lz); }
    const [ids, fees] = await pub.readContract({ address: es, abi: ES.abi, functionName: 'quoteFlush', args: [cid] }); extra.flushIds = Number(ids); extra.flushLzWei = fees.toString();
    extra.poolWei = (await pub.readContract({ address: es, abi: ES.abi, functionName: 'poolOf', args: [cid] })).toString();
    await pub.request({ method: 'evm_increaseTime', params: [1801] }); await pub.request({ method: 'evm_mine', params: [] });
    const fr = await S('flush (49 ids, 4 ranges -> 4 chains, permissionless)', W, es, ES.abi, 'flush', [cid], BigInt(fees) > BigInt(extra.poolWei) ? BigInt(fees) - BigInt(extra.poolWei) + 10n ** 12n : 0n);
    for (const l of fr.logs) { try { const e = decodeEventLog({ abi: ES.abi, data: l.data, topics: l.topics }); if (e.eventName === 'Flushed') { extra.flushPaidLzWei = e.args.lzFees.toString(); extra.flushTipWei = e.args.tip.toString(); } } catch {} }
    const [pl, lf] = await pub.readContract({ address: es, abi: ES.abi, functionName: 'quoteMove', args: [cid, MAIN.ethereum.eid, 1n, dep.address] }); extra.moveLzWei = lf.toString();
    await S('move token -> Ethereum', W, drop, OD.abi, 'moveTo', [MAIN.ethereum.eid, 1n, dep.address], pl + lf);
    extra.hubValue = {}; for (const [k2, c2] of Object.entries(MAIN)) if (k2 !== 'base') extra.hubValue[k2] = { 1: (await pub.readContract({ address: es, abi: ES.abi, functionName: 'quoteHubValue', args: [cid, c2.eid, 1n] })).toString(), 3: (await pub.readContract({ address: es, abi: ES.abi, functionName: 'quoteHubValue', args: [cid, c2.eid, 3n] })).toString() };
    // full K=50 batch quote (8 ranges) for the per-drop LZ table
    extra.batchShare50Wei = (await pub.readContract({ address: es, abi: ES.abi, functionName: 'quoteBatchShare', args: [cid, 50n] })).toString();
  } else {
    const hubValue = BigInt(process.env.HUBVALUE || '30000000000000'); // CONFIRM + share dropped on Base (from the Base run)
    for (const q of [1, 3]) { const [pr, lz] = await pub.readContract({ address: drop, abi: OD.abi, functionName: 'quoteMint', args: [0n, BigInt(q), dep.address, hubValue] }); (extra.remoteLz ??= {})[q] = lz.toString(); await S(`remote mint x${q} (REQUEST -> Base)`, W, drop, OD.abi, 'mint', [dep.address, 0n, BigInt(q), [], hubValue], pr + lz); }
  }
  p.kill(); fs.writeFileSync(`/tmp/est/fork-${k}.json`, JSON.stringify({ chain: k, gas, extra }, null, 1)); console.log(k, JSON.stringify(gas));
}
const list = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MAIN); let port = Number(process.env.PORT || 8710);
for (const k of list) { try { await run(k, port++); } catch (e) { console.log(k, 'FAILED', e.shortMessage || e.message); } }
process.exit(0);
