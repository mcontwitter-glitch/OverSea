// Read-only CLI view of the EVM side of "Turn on Solana": the exact steps /deploy-solana signs per chain (src/solplan.ts,
// CREATE2 addresses from config/launchpad.json solana.v2), each with its on-chain done state. Nothing is signed or sent.
//   npx tsx scripts/lp-solana-plan.ts [--solana-program <id>] [--chain base,bnb] [--existing-cid 0xcid,...] [--out plan.json]
import { createPublicClient, http, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import { chainPlan } from '../src/solplan.ts';
import { storePda, hexOf } from '../src/solanaomni.ts';
const LP = JSON.parse(fs.readFileSync(new URL('../config/launchpad.json', import.meta.url), 'utf8'));
const CFG = JSON.parse(fs.readFileSync(new URL('../config/collections.json', import.meta.url), 'utf8'));
const opt = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const prog = opt('--solana-program'); const store32 = prog ? (hexOf(storePda(new PublicKey(prog)).toBytes()) as Hex) : null;
const keys = (opt('--chain') || Object.keys(LP.solana.v2.escrows).join(',')).split(',');
const cids = (opt('--existing-cid') || '').split(',').filter(Boolean) as Hex[];
const names = Object.fromEntries(Object.entries(CFG.chains).map(([k, c]: any) => [k, c.name]));
const out: any = { generated: new Date().toISOString(), solanaProgram: prog || null, store32, chains: {} };
for (const k of keys) {
  const pub = createPublicClient({ transport: http(CFG.chains[k].rpc) });
  const now = Number((await pub.getBlock()).timestamp);
  const p = await chainPlan({ k, pub: pub as any, LP, names, store32, existingCids: cids, now });
  out.chains[k] = { done: p.doneCount, of: p.steps.length, next: p.next + 1, remainingGas: String(p.remainingGas), addrs: p.addrs,
    steps: p.steps.map((s, i) => ({ step: i + 1, id: s.id, title: s.title, detail: s.detail, from: s.from, to: s.to, data: s.data, done: s.done, blocked: s.blocked, readyAt: s.readyAt })) };
  console.log(`\n${names[k] || k}: ${p.doneCount}/${p.steps.length} done${p.next >= 0 ? `, next step ${p.next + 1}` : ''}`);
  p.steps.forEach((s, i) => console.log(`  ${s.done ? '✓' : ' '} ${String(i + 1).padStart(2)} ${s.title}${!s.done && s.blocked ? ` (${s.blocked})` : ''}`));
}
const file = opt('--out'); if (file) { fs.writeFileSync(file, JSON.stringify(out, null, 1)); console.log(`\nwritten to ${file}`); }
