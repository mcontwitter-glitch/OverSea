// READ-ONLY: actual gasUsed of every launchpad testnet tx (contracts/deployments/launchpad-testnet.json) -> /tmp/est/receipts.json
import fs from 'node:fs'; import { createPublicClient, http } from 'viem';
const S = JSON.parse(fs.readFileSync('contracts/deployments/launchpad-testnet.json', 'utf8')); const T = JSON.parse(fs.readFileSync('config/launchpad.testnet.json', 'utf8'));
const all = [...S.txs.map(t => ({ ...t, kind: 'setup' })), ...(S.smoke?.txs || []).map(t => ({ ...t, kind: 'smoke' }))];
const out = [];
for (const t of all) { const c = T.chains[t.chain]; const pub = createPublicClient({ transport: http(c.rpc, { retryCount: 4 }) });
  const r = await pub.request({ method: 'eth_getTransactionReceipt', params: [t.hash] });
  out.push({ chain: t.chain, kind: t.kind, what: t.what, hash: t.hash, gasUsed: Number(BigInt(r.gasUsed)), gasUsedForL1: r.gasUsedForL1 ? Number(BigInt(r.gasUsedForL1)) : undefined, l1Fee: r.l1Fee ? Number(BigInt(r.l1Fee)) : undefined }); }
fs.mkdirSync('/tmp/est', { recursive: true }); fs.writeFileSync('/tmp/est/receipts.json', JSON.stringify(out, null, 1));
for (const o of out) console.log(o.chain.padEnd(17), String(o.gasUsed).padStart(9), o.gasUsedForL1 != null ? `(L1 part ${o.gasUsedForL1})` : '', o.what.slice(0, 70));
