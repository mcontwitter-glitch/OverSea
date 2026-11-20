// Live holder snapshots (network). Prints counts for the final report. Nothing is submitted.
// Run: node test/holderallow.live.mjs
import fs from 'node:fs';
import { makeHolderAllow } from '../src/holderallow.js';

const CFG = JSON.parse(fs.readFileSync(new URL('../../config/collections.json', import.meta.url)));
const LP0 = JSON.parse(fs.readFileSync(new URL('../../config/launchpad.json', import.meta.url)));
const LP = { ...LP0, solana: { ...(LP0.solana || {}), programId: process.env.SOLANA_OMNI_ID || LP0.solana?.programId || 'ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH' } };
const chains = CFG.chains;
const lc = s => String(s || '').toLowerCase();
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };

async function rpcFanout(c, payload) {
  const urls = c.rpcs?.length ? c.rpcs : [c.rpc]; let last = 'no rpc';
  for (let round = 0; round < 2; round++) for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      if (!r.ok) { last = u + ' HTTP ' + r.status; continue; }
      const out = await r.json(); const arr = Array.isArray(out) ? out : [out];
      if (arr.some(x => x?.error && (x.error.code === -32005 || x.error.code === -32603 || /rate|limit|capacity|timeout|unavailable/i.test(x.error.message || '')))) { last = u + ' ' + (arr.find(x => x.error).error.message || ''); continue; }
      return out;
    } catch (e) { last = u + ' ' + (e?.message || e); }
  }
  throw new Error('all RPCs failed for ' + c.name + ': ' + last.slice(0, 160));
}

const env = { COLLECTIONS: { async get() { return null; }, async list() { return { keys: [] }; } } };
const H = makeHolderAllow({ CFG, chains, lc, bad, ADDR, rpcFanout, LP, getCollection: async () => null, walletLink: null });

function show(label, r) {
  console.log('\n== ' + label + ' ==');
  console.log(JSON.stringify({ count: r.count, evm: r.evm, solana: r.solana, skippedSolana: r.skippedSolana, excludedEscrow: r.excludedEscrow, truncated: r.truncated, sources: r.sources, notes: r.notes, at: r.at, sample: r.addresses.slice(0, 3) }, null, 2));
}

const out = {};
try {
  const islands = await H.snapshot(env, { sources: [{ slug: 'multi-islands', min: 1 }], includeLinked: true, includeSolana: true });
  show("Island's (include Solana wallets)", islands);
  out.islands = islands;
  const evmOnly = await H.snapshot(env, { sources: [{ slug: 'multi-islands', min: 1 }], includeLinked: true, includeSolana: false });
  show("Island's (EVM-only mapping)", evmOnly);
  out.islandsEvm = evmOnly;
} catch (e) {
  console.error("Island's snapshot failed:", e.message || e);
  out.islandsError = String(e.message || e);
}

try {
  const g = await H.snapshot(env, { sources: [{ chain: 'ethereum', address: '0xd4e4078ca3495DE5B1d4dB434BEbc5a986197782', min: 1 }], includeLinked: false, includeSolana: false });
  show('Autoglyphs (Ethereum ERC-721)', g);
  out.autoglyphs = g;
} catch (e) {
  console.error('Autoglyphs snapshot failed:', e.message || e);
  out.autoglyphsError = String(e.message || e);
}

fs.writeFileSync('/tmp/holderallow-live.json', JSON.stringify(out, (k, v) => (k === 'addresses' ? { length: v.length, sample: v.slice(0, 8) } : v), 2));
console.log('\nWrote /tmp/holderallow-live.json');
