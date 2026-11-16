// /deploy-solana, EVM side: the ordered steps MC signs on each chain, each with an on-chain "done" check, so the page
// always knows the next step (no saved plan, works from any device). Pure module (viem only): also used by the tests.
// New contracts are deployed with CREATE2 through the deterministic deployment proxy, so their addresses are fixed
// (config/launchpad.json solana.v2, from scripts/gen-sol-artifacts.mjs) and never depend on the wallet's nonce.
// Ownership: the NEW contracts stay with MC's wallet. The LIVE factory + V1 escrow belong to the chain's 48 h timelock:
// step 1 schedules handing them back to MC ("ownership" exit), and the finishing steps run once that wait is over.
import { encodeDeployData, encodeFunctionData, encodeAbiParameters, parseAbi, getAddress, keccak256, toHex, concat, type Address, type Hex, type PublicClient } from 'viem';
import ART from './solartifacts.json';

export const ABI = {
  escrow: parseAbi(['constructor(address _endpoint, address _owner, address _feeWallet, uint256 _moveFee)', 'function setFactory(address)', 'function factory() view returns (address)', 'function setPeer(uint32,bytes32)', 'function peers(uint32) view returns (bytes32)', 'function setSolana(uint32,bool)', 'function isSolana(uint32) view returns (bool)', 'function owner() view returns (address)', 'function setDelegate(address)', 'function transferOwnership(address)', 'function dropOf(bytes32) view returns (address)']),
  mover: parseAbi(['constructor(address _endpoint, address _owner, address _escrow, uint32 _solanaEid)', 'function setPeer(uint32,bytes32)', 'function peers(uint32) view returns (bytes32)', 'function setCollection(bytes32,bool)', 'function enabled(bytes32) view returns (bool)']),
  factory: parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function transferOwnership(address)', 'function acceptOwnership()', 'function setOmni(address,address)', 'function omniImplementation() view returns (address)', 'function omniEscrow() view returns (address)']),
  timelock: parseAbi(['function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)', 'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable', 'function getTimestamp(bytes32) view returns (uint256)', 'function getMinDelay() view returns (uint256)']),
  endpoint: parseAbi(['function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)', 'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)', 'function delegates(address) view returns (address)']),
  uln: parseAbi(['function getAppUlnConfig(address,uint32) view returns ((uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs))', 'function executorConfigs(address,uint32) view returns (uint32 maxMessageSize, address executor)']),
};
const ULN_T = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }] as const;
const EXE_T = [{ type: 'tuple', components: [{ name: 'maxMessageSize', type: 'uint32' }, { name: 'executor', type: 'address' }] }] as const;
const Z32 = ('0x' + '0'.repeat(64)) as Hex;
export const SOL_CONF = 32; // confirmations required for packets coming from Solana

// Measured gas per step kind (Base mainnet fork, scripts/test/solplan-fork.ts); the page multiplies by the live gas price.
export const GAS: Record<string, bigint> = { schedule: 72_300n, deployEscrow: 5_416_700n, deployImpl: 4_864_200n, deployMover: 1_817_000n, setFactory: 46_400n, setPeer: 47_900n, sendConfig: 166_900n, recvConfig: 138_900n, setSolana: 47_600n, setCollection: 53_500n, execute: 102_800n, accept: 28_400n, setOmni: 36_000n };

export type Step = { id: string; kind: string; title: string; detail: string; from: Address; to: Address; data: Hex; done: boolean; readyAt?: number; blocked?: string };
export type ChainPlan = { key: string; steps: Step[]; next: number; firstOpen: number; doneCount: number; remainingGas: bigint; addrs: { escrow: Address; dropImpl: Address; mover: Address; v1: Address; factory: Address; timelock: Address }; opId: Hex };

const pad32 = (a: string) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex;
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sortAddr = (xs: string[]) => xs.map(a => getAddress(a)).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
export const opIdOf = (targets: Address[], payloads: Hex[], salt: Hex) => keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }, { type: 'bytes[]' }, { type: 'bytes32' }, { type: 'bytes32' }], [targets, targets.map(() => 0n), payloads, Z32, salt]));
export const exitSaltOf = (k: string) => keccak256(toHex('timelock-exit-ownership-' + k));

/** The steps for chain `k`, with every step's done flag read from the chain. `store32` = the Solana Store PDA (null before the program exists). */
export async function chainPlan(o: { k: string; pub: PublicClient; LP: any; names: Record<string, string>; store32: Hex | null; existingCids?: Hex[]; now?: number }): Promise<ChainPlan> {
  const { k, pub, LP } = o; const M = LP.mainnet; const c = M.chains[k]; const V2 = LP.solana.v2; const SOL = LP.solana.eid as number;
  const MC = getAddress(V2.owner); const FEE = getAddress(M.feeWallet); const ep = getAddress(c.endpoint);
  const A = { escrow: getAddress(V2.escrows[k]), dropImpl: getAddress(V2.dropImpls[k]), mover: getAddress(V2.movers[k]), v1: getAddress(c.omniEscrow), factory: getAddress(c.factory), timelock: getAddress(c.timelock) };
  const rd = (address: Address, abi: any, functionName: string, args: any[] = []) => pub.readContract({ address, abi, functionName, args } as any).catch(() => undefined) as Promise<any>;
  const uln = (conf: number) => encodeAbiParameters(ULN_T, [{ confirmations: BigInt(conf), requiredDVNCount: 2, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: sortAddr(c.requiredDVNs), optionalDVNs: [] }]);
  const ulnOk = (got: any, conf: number) => !!got && Number(got.confirmations) === conf && Number(got.requiredDVNCount) === 2 && got.requiredDVNs.length === 2 && sortAddr(got.requiredDVNs).every((a: string, i: number) => same(a, sortAddr(c.requiredDVNs)[i]));
  const remotes = [...Object.keys(M.chains).filter(x => x !== k).map(x => ({ key: x, name: o.names[x] || x, eid: M.chains[x].eid as number, peer: pad32(V2.escrows[x]), conf: M.chains[x].confirmations as number })),
    { key: 'solana', name: 'Solana', eid: SOL, peer: o.store32, conf: SOL_CONF }];
  // the endpoint's default libraries always exist for these routes: retry a failed read (busy public RPC), then fail clearly
  const must = async (fn: string, eid: number) => { for (let i = 0; i < 4; i++) { const v = await rd(ep, ABI.endpoint, fn, [eid]); if (v) return v; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
    throw new Error(`could not read the LayerZero ${fn} for eid ${eid} on ${k} (RPC busy?)`); };
  const libs = await Promise.all(remotes.map(async r => { const [sl, rl] = await Promise.all([must('defaultSendLibrary', r.eid), must('defaultReceiveLibrary', r.eid)]);
    const exe = sl ? await rd(ep, ABI.endpoint, 'getConfig', ['0x0000000000000000000000000000000000000000', sl, r.eid, 1]) : undefined; return { sl: sl as Address, rl: rl as Address, exe: exe as Hex }; }));
  const [solSl, solRl] = [libs[libs.length - 1].sl, libs[libs.length - 1].rl]; const solExe = libs[libs.length - 1].exe;
  // the timelock exit (static, so its operation id never changes): factory + V1 escrow (and its LayerZero delegate) back to MC
  const exitT = [A.factory, A.v1, A.v1];
  const exitP = [encodeFunctionData({ abi: ABI.factory, functionName: 'transferOwnership', args: [MC] }), encodeFunctionData({ abi: ABI.escrow, functionName: 'setDelegate', args: [MC] }), encodeFunctionData({ abi: ABI.escrow, functionName: 'transferOwnership', args: [MC] })];
  const salt = exitSaltOf(k); const opId = opIdOf(exitT, exitP, salt);
  const delay = BigInt(M.timelockDelaySec);
  // ---- reads for the done checks (all in parallel)
  const R = await Promise.all([
    pub.getCode({ address: A.escrow }).catch(() => undefined), pub.getCode({ address: A.dropImpl }).catch(() => undefined), pub.getCode({ address: A.mover }).catch(() => undefined),
    rd(A.timelock, ABI.timelock, 'getTimestamp', [opId]), rd(A.factory, ABI.factory, 'owner'), rd(A.factory, ABI.factory, 'pendingOwner'), rd(A.v1, ABI.escrow, 'owner'), rd(ep, ABI.endpoint, 'delegates', [A.v1]),
    rd(A.escrow, ABI.escrow, 'factory'), rd(A.escrow, ABI.escrow, 'isSolana', [SOL]), rd(A.mover, ABI.mover, 'peers', [SOL]), rd(A.v1, ABI.escrow, 'peers', [SOL]),
    rd(A.factory, ABI.factory, 'omniImplementation'), rd(A.factory, ABI.factory, 'omniEscrow'),
    solSl ? rd(solSl, ABI.uln, 'executorConfigs', [A.mover, SOL]) : undefined, solSl ? rd(solSl, ABI.uln, 'getAppUlnConfig', [A.mover, SOL]) : undefined, solRl ? rd(solRl, ABI.uln, 'getAppUlnConfig', [A.v1, SOL]) : undefined,
  ]);
  const [codeE, codeI, codeM, ts, fOwner, fPending, vOwner, vDel, escFactory, isSol, moverPeer, v1Peer, oImpl, oEsc, mvExe, mvUln, v1Uln] = R;
  const perRemote = await Promise.all(remotes.map((r, i) => Promise.all([rd(A.escrow, ABI.escrow, 'peers', [r.eid]), libs[i].sl ? rd(libs[i].sl, ABI.uln, 'executorConfigs', [A.escrow, r.eid]) : undefined,
    libs[i].sl ? rd(libs[i].sl, ABI.uln, 'getAppUlnConfig', [A.escrow, r.eid]) : undefined, libs[i].rl ? rd(libs[i].rl, ABI.uln, 'getAppUlnConfig', [A.escrow, r.eid]) : undefined])));
  const cids = (o.existingCids || []); const cidOn = await Promise.all(cids.map(async cid => ({ cid, drop: await rd(A.v1, ABI.escrow, 'dropOf', [cid]), on: await rd(A.mover, ABI.mover, 'enabled', [cid]) })));
  const has = (code: unknown) => typeof code === 'string' && code.length > 2;
  const handedBack = same(fOwner, MC) && same(vOwner, MC);
  const scheduled = (ts !== undefined && BigInt(ts) > 0n) || handedBack || same(fPending, MC);
  const executed = (ts !== undefined && BigInt(ts) === 1n) || same(fPending, MC) || same(fOwner, MC);
  const readyAt = ts !== undefined && BigInt(ts) > 1n ? Number(ts) : undefined;
  const noStore = o.store32 ? undefined : 'Deploy the Solana program first (step 2)';
  // ---- steps
  const S: Step[] = []; const add = (s: Omit<Step, 'from'> & { from?: Address }) => S.push({ from: MC, ...s } as Step);
  const call = (to: Address, abi: any, fn: string, args: any[]) => ({ to, data: encodeFunctionData({ abi, functionName: fn, args } as any) as Hex });
  const SALTV2 = V2.salt as Hex; const dep = (init: Hex) => ({ to: getAddress(V2.deployer), data: concat([SALTV2, init]) });
  add({ id: 'exit-schedule', kind: 'schedule', title: 'Start the 48-hour safety wait', detail: `timelock ${A.timelock}.scheduleBatch(factory.transferOwnership(MC), V1escrow.setDelegate(MC), V1escrow.transferOwnership(MC)), delay ${delay}s, salt ${salt}, operation ${opId}`,
    ...call(A.timelock, ABI.timelock, 'scheduleBatch', [exitT, [0n, 0n, 0n], exitP, Z32, salt, delay]), done: scheduled });
  add({ id: 'deploy-escrow', kind: 'deployEscrow', title: 'Create the new escrow', detail: `CREATE2 MultiSeaOmniEscrowV2(endpoint ${ep}, owner ${MC}, fee ${FEE}, move fee ${c.moveFeeWei} wei) -> ${A.escrow}`,
    ...dep(encodeDeployData({ abi: ABI.escrow, bytecode: ART.escrowV2 as Hex, args: [ep, MC, FEE, BigInt(c.moveFeeWei)] })), done: has(codeE) });
  add({ id: 'deploy-impl', kind: 'deployImpl', title: 'Create the new drop template', detail: `CREATE2 MultiSeaOmniDropV2 implementation -> ${A.dropImpl}`, ...dep(ART.dropV2 as Hex), done: has(codeI) });
  add({ id: 'deploy-mover', kind: 'deployMover', title: 'Create the mover for existing collections', detail: `CREATE2 MultiSeaSolanaMover(endpoint ${ep}, owner ${MC}, V1 escrow ${A.v1}, Solana eid ${SOL}) -> ${A.mover}`,
    ...dep(encodeDeployData({ abi: ABI.mover, bytecode: ART.mover as Hex, args: [ep, MC, A.v1, SOL] })), done: has(codeM) });
  add({ id: 'set-factory', kind: 'setFactory', title: 'Connect the escrow to the launchpad', detail: `escrowV2.setFactory(${A.factory})`, ...call(A.escrow, ABI.escrow, 'setFactory', [A.factory]), done: same(escFactory, A.factory) });
  remotes.forEach((r, i) => {
    const [peer, exe, su, ru] = perRemote[i]; const b = r.key === 'solana' ? noStore : undefined;
    add({ id: 'peer-' + r.key, kind: 'setPeer', title: `Link to ${r.name}`, detail: `escrowV2.setPeer(${r.eid}, ${r.peer ?? '(Store PDA, after step 2)'})`, ...call(A.escrow, ABI.escrow, 'setPeer', [r.eid, r.peer ?? Z32]), done: !!r.peer && same(peer, r.peer), blocked: b });
    add({ id: 'send-' + r.key, kind: 'sendConfig', title: `Delivery settings to ${r.name}`, detail: `endpoint.setConfig(escrowV2, send lib ${libs[i].sl}, eid ${r.eid}: executor + ULN 2-of-2 [${sortAddr(c.requiredDVNs).join(', ')}], ${c.confirmations} confirmations)`,
      ...call(ep, ABI.endpoint, 'setConfig', [A.escrow, libs[i].sl, [{ eid: r.eid, configType: 1, config: libs[i].exe }, { eid: r.eid, configType: 2, config: uln(c.confirmations) }]]), done: !!exe && !same(exe.executor ?? exe[1], '0x0000000000000000000000000000000000000000') && ulnOk(su, c.confirmations) });
    add({ id: 'recv-' + r.key, kind: 'recvConfig', title: `Receiving settings from ${r.name}`, detail: `endpoint.setConfig(escrowV2, receive lib ${libs[i].rl}, eid ${r.eid}: ULN 2-of-2, ${r.conf} confirmations)`,
      ...call(ep, ABI.endpoint, 'setConfig', [A.escrow, libs[i].rl, [{ eid: r.eid, configType: 2, config: uln(r.conf) }]]), done: ulnOk(ru, r.conf) });
  });
  add({ id: 'set-solana', kind: 'setSolana', title: 'Switch on Solana in the escrow', detail: `escrowV2.setSolana(${SOL}, true)`, ...call(A.escrow, ABI.escrow, 'setSolana', [SOL, true]), done: isSol === true });
  add({ id: 'mover-peer', kind: 'setPeer', title: 'Link the mover to Solana', detail: `mover.setPeer(${SOL}, ${o.store32 ?? '(Store PDA)'})`, ...call(A.mover, ABI.mover, 'setPeer', [SOL, o.store32 ?? Z32]), done: !!o.store32 && same(moverPeer, o.store32), blocked: noStore });
  add({ id: 'mover-send', kind: 'sendConfig', title: 'Mover delivery settings to Solana', detail: `endpoint.setConfig(mover, send lib ${solSl}, eid ${SOL}: executor + ULN 2-of-2, ${c.confirmations} confirmations)`,
    ...call(ep, ABI.endpoint, 'setConfig', [A.mover, solSl, [{ eid: SOL, configType: 1, config: solExe }, { eid: SOL, configType: 2, config: uln(c.confirmations) }]]), done: !!mvExe && !same(mvExe.executor ?? mvExe[1], '0x0000000000000000000000000000000000000000') && ulnOk(mvUln, c.confirmations) });
  for (const x of cidOn) if (x.drop && !same(x.drop, '0x0000000000000000000000000000000000000000'))
    add({ id: 'collection-' + x.cid.slice(0, 10), kind: 'setCollection', title: 'Allow an existing collection to move to Solana', detail: `mover.setCollection(${x.cid} = drop ${x.drop}, true)`, ...call(A.mover, ABI.mover, 'setCollection', [x.cid, true]), done: x.on === true });
  add({ id: 'exit-execute', kind: 'execute', title: 'Finish the 48-hour handover', detail: `timelock.executeBatch(... same batch ...), operation ${opId}${readyAt ? `, ready ${new Date(readyAt * 1000).toISOString()}` : ''}`,
    ...call(A.timelock, ABI.timelock, 'executeBatch', [exitT, [0n, 0n, 0n], exitP, Z32, salt]), done: executed, readyAt, blocked: scheduled ? undefined : 'Sign step 1 first' });
  add({ id: 'accept', kind: 'accept', title: 'Accept the launchpad ownership', detail: `factory.acceptOwnership() (Ownable2Step)`, ...call(A.factory, ABI.factory, 'acceptOwnership', []), done: same(fOwner, MC) });
  add({ id: 'v1-peer', kind: 'setPeer', title: 'Let the existing escrow talk to Solana', detail: `V1escrow.setPeer(${SOL}, ${o.store32 ?? '(Store PDA)'})`, ...call(A.v1, ABI.escrow, 'setPeer', [SOL, o.store32 ?? Z32]), done: !!o.store32 && same(v1Peer, o.store32), blocked: noStore });
  add({ id: 'v1-recv', kind: 'recvConfig', title: 'Existing escrow receiving settings from Solana', detail: `endpoint.setConfig(V1escrow, receive lib ${solRl}, eid ${SOL}: ULN 2-of-2, ${SOL_CONF} confirmations)`,
    ...call(ep, ABI.endpoint, 'setConfig', [A.v1, solRl, [{ eid: SOL, configType: 2, config: uln(SOL_CONF) }]]), done: ulnOk(v1Uln, SOL_CONF) });
  add({ id: 'set-omni', kind: 'setOmni', title: 'Use the new escrow for new drops', detail: `factory.setOmni(${A.dropImpl}, ${A.escrow})`, ...call(A.factory, ABI.factory, 'setOmni', [A.dropImpl, A.escrow]), done: same(oImpl, A.dropImpl) && same(oEsc, A.escrow) });
  // steps that need MC as owner/delegate of the live contracts wait for the handover
  for (const s of S) if (['accept', 'v1-peer', 'v1-recv', 'set-omni'].includes(s.id) && !s.done && !s.blocked) {
    if (s.id === 'accept' ? !executed : s.id === 'set-omni' ? !same(fOwner, MC) : !(same(vOwner, MC) && (s.id !== 'v1-recv' || same(vDel, MC)))) s.blocked = 'After the 48-hour handover';
  }
  // next = the first step that can be signed now (blocked / still-waiting steps are skipped); firstOpen = the first not-done one
  const now = o.now ?? Number((await pub.getBlock().catch(() => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }))).timestamp); // the chain's clock decides readiness
  const next = S.findIndex(s => !s.done && !s.blocked && !(s.readyAt && s.readyAt > now));
  const firstOpen = S.findIndex(s => !s.done);
  const remainingGas = S.filter(s => !s.done).reduce((a, s) => a + (GAS[s.kind] || 100_000n), 0n);
  return { key: k, steps: S, next, firstOpen, doneCount: S.filter(s => s.done).length, remainingGas, addrs: A, opId };
}
