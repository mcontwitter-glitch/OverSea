// Shared helpers for the MultiSea bridge deployer. Private keys are read from .secrets/ (gitignored) and never printed.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, decodeEventLog, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/testnet.json'), 'utf8'));
export const MODE = process.env.MODE || 'fork'; // 'fork' (local anvil forks) or 'live' (public testnets)
export const art = n => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
export const deployer = () => privateKeyToAccount(fs.readFileSync(path.join(ROOT, '.secrets/deployer.key'), 'utf8').trim());
const depFile = path.join(ROOT, `deployments/${MODE === 'live' ? 'testnet' : 'fork'}.json`);
export const loadDep = () => (fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : { chains: {}, listings: {} });
export const saveDep = d => fs.writeFileSync(depFile, JSON.stringify(d, null, 1) + '\n');
export function clients(key, account) {
  const c = CFG.chains[key]; const rpc = MODE === 'live' ? c.rpc : c.forkRpc;
  const chain = defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wal = account ? createWalletClient({ chain, transport: http(rpc), account }) : null;
  return { c, pub, wal, chain, rpc };
}
export async function deploy({ pub, wal }, name, args) {
  const { abi, bytecode } = art(name);
  const { encodeDeployData } = await import('viem');
  const est = await pub.estimateGas({ account: wal.account, data: encodeDeployData({ abi, bytecode, args }) });
  const hash = await wal.deployContract({ abi, bytecode, args, gas: est * 13n / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${name} deploy failed`);
  return getAddress(r.contractAddress);
}
export async function send({ pub, wal }, address, abi, functionName, args, value) {
  const { request, result } = await pub.simulateContract({ account: wal.account, address, abi, functionName, args, value });
  const hash = await wal.writeContract({ ...request, gas: request.gas ? request.gas * 13n / 10n : undefined });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} failed`);
  return { r, result, hash };
}
export const b32 = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const eventsOf = (r, abi, name) => r.logs.map(l => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).filter(e => e && e.eventName === name);
export const PACKET_ABI = parseAbi(['event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)']);
