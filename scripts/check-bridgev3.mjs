// Replays the /deploy-bridge-v3 steps (same src/bridgev3steps.ts calldata) on LOCAL anvil forks of every chain, impersonating the admin
// on the fork only. Reports gas per step, current gas price and the admin's balance. Sends nothing to any real network.
//   npx esbuild src/bridgev3steps.ts --bundle --format=esm --platform=node --outfile=/tmp/bv3steps.mjs --external:viem && node scripts/check-bridgev3.mjs
import fs from 'node:fs'; import cp from 'node:child_process';
import { createPublicClient, createWalletClient, http, formatEther, formatGwei } from 'viem';
import { A, ADMIN, stepsFor, readLive, doneSteps, verifyChain } from '/tmp/bv3steps.mjs';
const CFG = JSON.parse(fs.readFileSync('contracts/config/mainnet.json', 'utf8')); const BR = JSON.parse(fs.readFileSync('public/bridge.json', 'utf8'));
const res = {}; let port = Number(process.env.P0 || 8661); const procs = [];
for (const k of (process.env.ONLY ? process.env.ONLY.split(',') : Object.keys(A.chains))) {
  const p = port++; const proc = cp.spawn(process.env.HOME + '/.foundry/bin/anvil', ['--fork-url', CFG.chains[k].rpc, '--port', String(p), '--silent', '--auto-impersonate', ...(k === 'apechain' ? ['--hardfork', 'shanghai'] : [])], { stdio: 'ignore' }); procs.push(proc);
  await new Promise(r => setTimeout(r, 5000));
  const url = `http://127.0.0.1:${p}`; const pub = createPublicClient({ transport: http(url) }); const real = createPublicClient({ transport: http(CFG.chains[k].rpc) });
  const w = createWalletClient({ account: ADMIN, transport: http(url) });
  const live = await readLive(k, BR.chains[k].factory, pub); const st = {}; const gas = {};
  const bal = await real.getBalance({ address: ADMIN }); const gp = await real.getGasPrice();
  for (let i = 1; i <= 7; i++) {
    const s = stepsFor(k, live, st).find(x => x.id === i);
    const est = await pub.estimateGas({ account: ADMIN, to: s.to, data: s.data });
    const h = await w.sendTransaction({ chain: null, to: s.to, data: s.data, gas: est * 12n / 10n }); const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`${k} step ${i} reverted`); gas[i] = Number(r.gasUsed);
    if (s.kind === 'deploy') st[s.key] = r.contractAddress;
  }
  const done = await doneSteps(k, live, st, pub); const bad = await verifyChain(k, live, st, pub);
  const total = Object.values(gas).reduce((a, b) => a + b, 0);
  res[k] = { gas, total, gasPriceGwei: formatGwei(gp), needEth: formatEther(BigInt(total) * gp * 13n / 10n), balance: formatEther(bal), enough: bal >= BigInt(total) * gp * 13n / 10n, allDone: Object.values(done).every(Boolean), problems: bad };
  console.log(k, JSON.stringify(res[k]));
}
procs.forEach(p => p.kill()); fs.writeFileSync('/tmp/bridgev3-check.json', JSON.stringify(res, null, 1));
