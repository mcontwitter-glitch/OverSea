// MultiSea launchpad TESTNET deployer (spec §14 L2). Keys are read from .secrets/ (gitignored) and never printed.
// Refuses any chain id not in config/launchpad.testnet.json. State: deployments/launchpad-testnet.json (addresses + tx hashes).
//   node scripts/lp-testnet.mjs estimate|deploy|wire|status|handoff [nets...]
// handoff (run LAST, after every chain is wired): LayerZero delegate + escrow owner -> timelock (immediate), factory
// ownership -> timelock (Ownable2Step: pending until the admin wallet schedules + executes acceptOwnership via the timelock).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, encodeDeployData, encodeAbiParameters, parseAbi, getAddress, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const T = JSON.parse(fs.readFileSync(path.join(ROOT, '../config/launchpad.testnet.json'), 'utf8'));
const STATE = path.join(ROOT, 'deployments/launchpad-testnet.json');
export const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { chains: {}, txs: [] });
export const save = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n');
export const art = n => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object }; };
const key = f => fs.readFileSync(path.join(ROOT, '.secrets', f), 'utf8').trim();
export const deployer = () => privateKeyToAccount(key('deployer.key'));
export const approverAddr = () => getAddress(key('staging-approver.addr'));
export function net(k, account) {
  const c = T.chains[k]; if (!c) throw new Error('unknown testnet ' + k);
  const chain = defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(c.rpc, { retryCount: 5, retryDelay: 1500 }) });
  return { k, c, chain, pub, wal: account ? createWalletClient({ chain, transport: http(c.rpc), account }) : null };
}
export async function guard(n) { const id = await n.pub.getChainId(); if (id !== n.c.chainId) throw new Error(`refusing: ${n.k} rpc returned chain ${id}`); }
const fees = async n => { const b = await n.pub.getBlock(); const base = b.baseFeePerGas ?? (await n.pub.getGasPrice());
  const tip = n.k === 'sepolia' ? 1_500_000_000n : n.k === 'bscTestnet' ? 100_000_000n : base / 10n + 1n; return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip }; };
export async function deploy(n, name, args, s) {
  const { abi, bytecode } = art(name); const data = encodeDeployData({ abi, bytecode, args });
  const gas = (await n.pub.estimateGas({ account: n.wal.account, data })) * 12n / 10n;
  const hash = await n.wal.sendTransaction({ data, gas, ...(await fees(n)) });
  const r = await n.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== 'success') throw new Error(`${name} deploy failed ${hash}`);
  s.txs.push({ chain: n.k, what: `deploy ${name}`, hash }); save(s);
  console.log(`  ${n.k} ${name} ${r.contractAddress} gas=${r.gasUsed} tx=${hash}`);
  return getAddress(r.contractAddress);
}
export async function send(n, address, abi, functionName, args, s, value, label) {
  const { request } = await n.pub.simulateContract({ account: n.wal.account, address, abi, functionName, args, value });
  const gas = (await n.pub.estimateGas({ account: n.wal.account, to: address, data: (await import('viem')).encodeFunctionData({ abi, functionName, args }), value })) * 13n / 10n;
  const hash = await n.wal.writeContract({ ...request, gas, ...(await fees(n)) });
  const r = await n.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== 'success') throw new Error(`${functionName} failed ${hash}`);
  s.txs.push({ chain: n.k, what: label || functionName, hash }); save(s);
  return { r, hash };
}
const ENDPOINT = parseAbi(['function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)',
  'function defaultSendLibrary(uint32) view returns (address)', 'function defaultReceiveLibrary(uint32) view returns (address)', 'function isSupportedEid(uint32) view returns (bool)']);
const ULN_T = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
const ZERO = '0x0000000000000000000000000000000000000000';
const nets = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(T.chains);
const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  const acct = deployer(); const s = load(); s.deployer = acct.address; s.approver = approverAddr();
  if (cmd === 'estimate') {
    for (const k of nets) { const n = net(k, acct); await guard(n); const bal = await n.pub.getBalance({ address: acct.address }); const gp = (await fees(n)).maxFeePerGas / 2n;
      let g = 0n; const est = async (name, args) => { const { abi, bytecode } = art(name); const x = await n.pub.estimateGas({ account: acct.address, data: encodeDeployData({ abi, bytecode, args }) }); g += x; return x; };
      await est('MultiSeaTimelock', [BigInt(T.timelockDelaySec), [T.admin], [T.admin]]); await est('MultiSeaDrop', []); await est('MultiSeaOmniDrop', []);
      await est('MultiSeaOmniEscrow', [n.c.endpoint, acct.address, T.feeWallet, BigInt(n.c.moveFee)]); await est('MultiSeaLaunchpadFactory', [acct.address, acct.address, T.feeWallet, s.approver, 50]);
      const wire = 4n * 120_000n + 8n * 90_000n + 200_000n; const need = (g + wire) * gp * 13n / 10n;
      console.log(`${k.padEnd(17)} bal=${formatEther(bal)} ${n.c.native}  deploy gas=${g} + wire≈${wire} @ ${Number(gp) / 1e9} gwei -> need≈${formatEther(need)} ${n.c.native} ${bal >= need ? 'OK' : 'SHORT by ' + formatEther(need - bal)}`); }
  }
  if (cmd === 'deploy') {
    for (const k of nets) { const n = net(k, acct); await guard(n); const d = (s.chains[k] ??= { chainId: n.c.chainId, eid: n.c.eid, endpoint: n.c.endpoint });
      console.log(`== deploy ${k}`);
      d.timelock ??= await deploy(n, 'MultiSeaTimelock', [BigInt(T.timelockDelaySec), [T.admin], [T.admin]], s); save(s);
      d.dropImpl ??= await deploy(n, 'MultiSeaDrop', [], s); save(s);
      d.omniImpl ??= await deploy(n, 'MultiSeaOmniDrop', [], s); save(s);
      d.escrow ??= await deploy(n, 'MultiSeaOmniEscrow', [n.c.endpoint, acct.address, T.feeWallet, BigInt(n.c.moveFee)], s); save(s);
      d.factory ??= await deploy(n, 'MultiSeaLaunchpadFactory', [acct.address, d.dropImpl, T.feeWallet, s.approver, T.platformFeeBps], s); save(s);
      const F = art('MultiSeaLaunchpadFactory').abi, E = art('MultiSeaOmniEscrow').abi;
      if ((await n.pub.readContract({ address: d.factory, abi: F, functionName: 'omniEscrow' })) === ZERO) await send(n, d.factory, F, 'setOmni', [d.omniImpl, d.escrow], s);
      if ((await n.pub.readContract({ address: d.escrow, abi: E, functionName: 'factory' })) === ZERO) await send(n, d.escrow, E, 'setFactory', [d.factory], s);
      console.log(`  ${k} wired factory<->escrow`); }
  }
  if (cmd === 'wire') {
    const E = art('MultiSeaOmniEscrow').abi; const all = Object.keys(s.chains).filter(k => s.chains[k].escrow);
    for (const k of nets) { const d = s.chains[k]; if (!d?.escrow) continue; const n = net(k, acct); await guard(n); d.peers ??= {}; d.unsupported ??= [];
      for (const k2 of all) { if (k2 === k) continue; const e2 = T.chains[k2].eid;
        if (!(await n.pub.readContract({ address: n.c.endpoint, abi: ENDPOINT, functionName: 'isSupportedEid', args: [e2] }))) { if (!d.unsupported.includes(k2)) d.unsupported.push(k2); console.log(`  ${k} -> ${k2}: no LayerZero pathway (skipped)`); save(s); continue; }
        const peer = '0x' + s.chains[k2].escrow.slice(2).toLowerCase().padStart(64, '0');
        if ((await n.pub.readContract({ address: d.escrow, abi: E, functionName: 'peers', args: [e2] })).toLowerCase() !== peer) await send(n, d.escrow, E, 'setPeer', [e2, peer], s, undefined, `setPeer ${k2}`);
        // Pin the DVN (ULN) config explicitly = today's LayerZero default for this pathway, so a default change can't alter it.
        for (const dir of ['send', 'receive']) {
          const lib = await n.pub.readContract({ address: n.c.endpoint, abi: ENDPOINT, functionName: dir === 'send' ? 'defaultSendLibrary' : 'defaultReceiveLibrary', args: [e2] });
          const cfgB = await n.pub.readContract({ address: n.c.endpoint, abi: ENDPOINT, functionName: 'getConfig', args: [d.escrow, lib, e2, 2] });
          const [u] = (await import('viem')).decodeAbiParameters(ULN_T, cfgB);
          const pin = (d.dvn ??= {})[`${dir}:${k2}`];
          if (!pin) { await send(n, n.c.endpoint, ENDPOINT, 'setConfig', [d.escrow, lib, [{ eid: e2, configType: 2, config: encodeAbiParameters(ULN_T, [u]) }]], s, undefined, `setConfig ULN ${dir} ${k2}`);
            d.dvn[`${dir}:${k2}`] = { lib, confirmations: Number(u.confirmations), requiredDVNs: u.requiredDVNs }; save(s); }
        }
        d.peers[k2] = s.chains[k2].escrow; save(s); console.log(`  ${k} -> ${k2}: peer + DVN pinned`);
      } }
  }
  if (cmd === 'handoff') {
    const E = art('MultiSeaOmniEscrow').abi, F = art('MultiSeaLaunchpadFactory').abi;
    for (const k of nets) { const d = s.chains[k]; if (!d?.timelock) continue; const n = net(k, acct); await guard(n);
      await send(n, d.escrow, E, 'setDelegate', [d.timelock], s, undefined, 'escrow.setDelegate(timelock)');
      await send(n, d.escrow, E, 'transferOwnership', [d.timelock], s, undefined, 'escrow.transferOwnership(timelock)');
      await send(n, d.factory, F, 'transferOwnership', [d.timelock], s, undefined, 'factory.transferOwnership(timelock) [pending accept]');
      d.handoff = new Date().toISOString(); save(s); console.log(`  ${k}: escrow owned by timelock; factory pending acceptOwnership`); }
  }
  if (cmd === 'status') for (const k of nets) { const n = net(k); console.log(k, formatEther(await n.pub.getBalance({ address: acct.address })), n.c.native, JSON.stringify(s.chains[k] || {}).slice(0, 200)); }
}
