// Pure step builder for /deploy-bridge-v3 (viem only, so scripts/check-bridgev3.mjs can replay the exact same calldata on forks).
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex, type Address } from 'viem';
import ART from '../config/bridgev3-artifact.json';
export const A = ART as any;
export const ADMIN = A.admin as Address;
export const FAC = parseAbi([
  'function owner() view returns (address)', 'function endpoint() view returns (address)', 'function escrowDeployer() view returns (address)', 'function mirrorDeployer() view returns (address)',
  'function gasWallet() view returns (address)', 'function operators(address) view returns (bool)', 'function priceFeed() view returns (address)', 'function maxPriceAge() view returns (uint256)',
  'function supportedChains() view returns (uint256)', 'function baseGasCost() view returns (uint256)', 'function chainGasCost(uint32) view returns (uint256)', 'function feeWallet() view returns (address)',
  'function lzRoute() view returns (address sendLib, address receiveLib, address executor, address dvn, uint64 confirmations)', 'function remoteConfirmations(uint32) view returns (uint64)',
  'function setEscrowDeployer(address)', 'function setMirrorDeployer(address)',
  'function setLzRoute((address sendLib, address receiveLib, address executor, address dvn, uint64 confirmations) r, uint32[] eids, uint64[] confs)',
  'function setGasCosts(uint32[] eids, uint256[] costs)']);
export const DEP = parseAbi(['function factory() view returns (address)']);
export type Live = { feed: Address; age: bigint; operator: Address; base: bigint; costs: bigint[] };
export type State = { factory?: Address; escrowDeployer?: Address; mirrorDeployer?: Address };
export type Step = { id: number; label: string; kind: 'deploy' | 'call'; to?: Address; data: Hex; key?: keyof State; need?: keyof State[] | string[] };
const ctor = (types: string[], args: any[]) => encodeAbiParameters(types.map(type => ({ type })), args).slice(2);

/** Old-factory values the V3 factory copies (price feed, max age, gas costs). */
export const OLD = parseAbi(['function baseGasCost() view returns (uint256)', 'function chainGasCost(uint32) view returns (uint256)', 'function gasWallet() view returns (address)', 'function priceFeed() view returns (address)', 'function maxPriceAge() view returns (uint256)']);

export function stepsFor(k: string, live: Live, st: State): Step[] {
  const c = A.chains[k]; const s: Step[] = [];
  s.push({ id: 1, kind: 'deploy', key: 'factory', label: 'Deploy MultiSeaFactoryV3', data: (A.factory + ctor(['address', 'address', 'address', 'address', 'address', 'uint256', 'uint256'], [c.endpoint, ADMIN, live.operator, A.feeWallet, live.feed, live.age, BigInt(A.supportedChains)])) as Hex });
  s.push({ id: 2, kind: 'deploy', key: 'escrowDeployer', label: 'Deploy EscrowDeployer', data: (A.escrowDeployer + ctor(['address'], [st.factory ?? '0x0000000000000000000000000000000000000000'])) as Hex });
  s.push({ id: 3, kind: 'deploy', key: 'mirrorDeployer', label: 'Deploy MirrorDeployer', data: (A.mirrorDeployer + ctor(['address'], [st.factory ?? '0x0000000000000000000000000000000000000000'])) as Hex });
  const f = st.factory!;
  s.push({ id: 4, kind: 'call', to: f, label: 'Link the EscrowDeployer (one-time)', data: encodeFunctionData({ abi: FAC, functionName: 'setEscrowDeployer', args: [st.escrowDeployer ?? '0x0000000000000000000000000000000000000000'] }) });
  s.push({ id: 5, kind: 'call', to: f, label: 'Link the MirrorDeployer (one-time)', data: encodeFunctionData({ abi: FAC, functionName: 'setMirrorDeployer', args: [st.mirrorDeployer ?? '0x0000000000000000000000000000000000000000'] }) });
  s.push({ id: 6, kind: 'call', to: f, label: 'Set the LayerZero route', data: encodeFunctionData({ abi: FAC, functionName: 'setLzRoute', args: [{ sendLib: c.route.sendLib, receiveLib: c.route.receiveLib, executor: c.route.executor, dvn: c.route.dvn, confirmations: BigInt(c.route.confirmations) }, c.remoteEids, c.remoteConfirmations.map(BigInt)] }) });
  s.push({ id: 7, kind: 'call', to: f, label: 'Set the listing gas costs (copied from today\'s factory)', data: encodeFunctionData({ abi: FAC, functionName: 'setGasCosts', args: [[0, ...c.remoteEids], [live.base, ...live.costs]] }) });
  return s;
}
/** Which steps are already done on-chain (for resume). `read` = a viem-like readContract. */
export async function doneSteps(k: string, live: Live, st: State, pub: any): Promise<Record<number, boolean>> {
  const c = A.chains[k]; const d: Record<number, boolean> = {};
  const code = async (a?: Address) => { if (!a) return false; const b = await pub.getCode({ address: a }).catch(() => null); return !!b && b !== '0x'; };
  d[1] = await code(st.factory); d[2] = await code(st.escrowDeployer); d[3] = await code(st.mirrorDeployer);
  if (d[1]) {
    const rd = (functionName: string, args: any[] = []) => pub.readContract({ address: st.factory, abi: FAC, functionName, args }).catch(() => null);
    d[4] = !!st.escrowDeployer && String(await rd('escrowDeployer')).toLowerCase() === st.escrowDeployer.toLowerCase();
    d[5] = !!st.mirrorDeployer && String(await rd('mirrorDeployer')).toLowerCase() === st.mirrorDeployer.toLowerCase();
    const r: any = await rd('lzRoute'); d[6] = !!r && String(r[3]).toLowerCase() === c.route.dvn.toLowerCase();
    d[7] = ((await rd('baseGasCost')) as bigint) === live.base && (await Promise.all(c.remoteEids.map((e: number) => rd('chainGasCost', [e])))).every((v: any, i: number) => v === live.costs[i]);
  } else d[4] = d[5] = d[6] = d[7] = false;
  return d;
}
export async function readLive(k: string, oldFactory: Address, pub: any): Promise<Live> {
  const c = A.chains[k]; const rd = (functionName: string, args: any[] = []) => pub.readContract({ address: oldFactory, abi: OLD, functionName, args });
  const [feed, age, operator, base, costs] = await Promise.all([rd('priceFeed'), rd('maxPriceAge'), rd('gasWallet'), rd('baseGasCost'), Promise.all(c.remoteEids.map((e: number) => rd('chainGasCost', [e])))]);
  return { feed, age, operator, base, costs } as Live;
}
/** Final read-back that the finished chain is correct. Returns problems ([] = verified). */
export async function verifyChain(k: string, live: Live, st: State, pub: any): Promise<string[]> {
  const c = A.chains[k]; const bad: string[] = []; const f = st.factory!;
  const rd = (a: Address, abi: any, functionName: string, args: any[] = []) => pub.readContract({ address: a, abi, functionName, args }).catch(() => null);
  const eq = (x: any, y: any) => String(x).toLowerCase() === String(y).toLowerCase();
  if (!eq(await rd(f, FAC, 'owner'), ADMIN)) bad.push('factory owner is not the admin');
  if (!eq(await rd(f, FAC, 'endpoint'), c.endpoint)) bad.push('factory endpoint differs');
  if (!eq(await rd(f, FAC, 'feeWallet'), A.feeWallet)) bad.push('fee wallet differs');
  if (!eq(await rd(f, FAC, 'priceFeed'), live.feed)) bad.push('price feed differs');
  if (!eq(await rd(f, FAC, 'gasWallet'), live.operator)) bad.push('gas wallet differs');
  if (await rd(f, FAC, 'operators', [live.operator]) !== true) bad.push('server operator is not an operator');
  if (!eq(await rd(f, FAC, 'escrowDeployer'), st.escrowDeployer)) bad.push('escrow deployer not linked');
  if (!eq(await rd(f, FAC, 'mirrorDeployer'), st.mirrorDeployer)) bad.push('mirror deployer not linked');
  if (!eq(await rd(st.escrowDeployer!, DEP, 'factory'), f)) bad.push('escrow deployer points at another factory');
  if (!eq(await rd(st.mirrorDeployer!, DEP, 'factory'), f)) bad.push('mirror deployer points at another factory');
  const r: any = await rd(f, FAC, 'lzRoute'); if (!r || !eq(r[0], c.route.sendLib) || !eq(r[1], c.route.receiveLib) || !eq(r[2], c.route.executor) || !eq(r[3], c.route.dvn)) bad.push('LayerZero route differs');
  for (let i = 0; i < c.remoteEids.length; i++) { if (await rd(f, FAC, 'remoteConfirmations', [c.remoteEids[i]]) !== BigInt(c.remoteConfirmations[i])) bad.push('confirmations differ for eid ' + c.remoteEids[i]); if (await rd(f, FAC, 'chainGasCost', [c.remoteEids[i]]) !== live.costs[i]) bad.push('gas cost differs for eid ' + c.remoteEids[i]); }
  if (await rd(f, FAC, 'baseGasCost') !== live.base) bad.push('base gas cost differs');
  return bad;
}
