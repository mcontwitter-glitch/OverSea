// Anvil fork test for src/solplan.ts: walks a real chain (Base mainnet fork) through every step as MC (impersonated on the
// LOCAL fork only, no key), checking that each step's on-chain "done" detection flips and the 48 h countdown works.
// Run: anvil --fork-url https://mainnet.base.org --port 8547 &  then  npx tsx scripts/test/solplan-fork.ts [chain] [rpc]
import { createPublicClient, createTestClient, http, getAddress, type Hex } from 'viem';
import LP from '../../config/launchpad.json' with { type: 'json' };
import { chainPlan, GAS } from '../../src/solplan.ts';
const K = process.argv[2] || 'base'; const RPC = process.argv[3] || 'http://127.0.0.1:8547';
const pub = createPublicClient({ transport: http(RPC) }); const t = createTestClient({ mode: 'anvil', transport: http(RPC) });
const MC = getAddress((LP as any).solana.v2.owner);
await t.impersonateAccount({ address: MC }); await t.setBalance({ address: MC, value: 10n ** 20n });
const store32 = (process.env.STORE32 || '0x' + 'ab'.repeat(32)) as Hex;
const names = { base: 'Base', ethereum: 'Ethereum', apechain: 'ApeChain', bnb: 'BNB Chain', robinhood: 'Robinhood' };
const cid = process.argv[4] as Hex | undefined;
const gas: Record<string, bigint[]> = {}; let sent = 0, fails = 0; const log: string[] = [];
const ok = (c: boolean, m: string) => { log.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
let p = await chainPlan({ k: K, pub: pub as any, LP, names, store32: null, existingCids: cid ? [cid] : [] });
ok(p.next === 0 && p.steps[0].id === 'exit-schedule', `fresh chain: ${p.steps.length} steps, next = step 1 (${p.steps[0].title})`);
ok(p.steps.some(s => s.blocked?.includes('Solana program')), 'without the program, Solana-linked steps are blocked');
for (let guard = 0; guard < 80; guard++) {
  const blob = guard > 2 ? store32 : null; // the program "appears" after the first steps
  p = await chainPlan({ k: K, pub: pub as any, LP, names, store32: blob, existingCids: cid ? [cid] : [] });
  if (p.firstOpen < 0) break;
  if (p.next < 0) {
    const w = p.steps[p.firstOpen];
    if (w.readyAt) { const now = Number((await pub.getBlock()).timestamp); ok(w.readyAt - now > 47 * 3600 && w.readyAt - now <= 48 * 3600 + 60, `countdown shown: ${((w.readyAt - now) / 3600).toFixed(2)} h left on "${w.title}"`);
      await t.increaseTime({ seconds: 48 * 3600 + 5 }); await t.mine({ blocks: 1 }); continue; }
    ok(false, `stuck at ${w.id}: ${w.blocked}`); break;
  }
  const s = p.steps[p.next];
  const h = await (t as any).request({ method: 'eth_sendTransaction', params: [{ from: MC, to: s.to, data: s.data, gas: '0x' + (12_000_000).toString(16) }] });
  await t.mine({ blocks: 1 }); const r = await pub.getTransactionReceipt({ hash: h }); sent++;
  (gas[s.kind] ||= []).push(r.gasUsed);
  if (r.status !== 'success') { ok(false, `step ${p.next + 1} ${s.id} reverted`); break; }
  const q = await chainPlan({ k: K, pub: pub as any, LP, names, store32: blob, existingCids: cid ? [cid] : [] });
  ok(q.steps[p.next].done, `step ${p.next + 1}/${p.steps.length} "${s.title}" sent (${r.gasUsed} gas) and detected as done`);
}
p = await chainPlan({ k: K, pub: pub as any, LP, names, store32, existingCids: cid ? [cid] : [] });
ok(p.firstOpen === -1 && p.doneCount === p.steps.length, `all ${p.steps.length} steps done on ${K} (${sent} transactions)`);
const f = (a: string) => pub.readContract({ address: p.addrs.factory, abi: [{ type: 'function', name: a, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: a } as any);
ok(getAddress(await f('owner') as string) === MC && getAddress(await f('omniEscrow') as string) === p.addrs.escrow, 'factory owned by MC and pointing at the new escrow');
console.log('gas by kind', JSON.stringify(Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, v.map(String)]))), 'table', JSON.stringify(Object.fromEntries(Object.entries(GAS).map(([k, v]) => [k, String(v)]))));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
