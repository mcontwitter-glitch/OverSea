// GET /activity/lz?txs=<chain>:<tx>,... : the other side of escrow locks/releases that the Activity page could not pair
// with a transfer on another EVM chain (above all Solana: no ERC-721 Transfer there). For each EVM tx, LayerZero Scan
// gives the message it sent (lock -> destination) or delivered (release <- source). A Solana leg is confirmed with the
// Solana RPCs (fallback list from solswitch.js) for its block time. Resolved legs are immutable: cached 30 days.
import { solRpcList } from './solswitch.js';
const SCAN = 'https://scan.layerzero-api.com/v1';
const IMMUTABLE = 30 * 86400;

export function makeLzLegs({ LP, chains }) {
  const SOL_EID = Number(LP.solana?.eid || 30168);
  const eidChain = new Map(Object.entries(LP.eids || {}).map(([k, e]) => [Number(e), k])); eidChain.set(SOL_EID, 'solana');
  const ck = tx => new Request('https://cache.multisea/lzleg1:' + tx);
  async function solTime(sig) {
    for (const u of solRpcList(LP)) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[sig], { searchTransactionHistory: true }] }), signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue; const j = await r.json(); const st = j?.result?.value?.[0];
        if (j?.error || st === undefined) continue;
        if (!st) continue; // this RPC doesn't know it (no history): try the next one
        if (st.err) return null; // failed transaction
        const b = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [st.slot] }), signal: AbortSignal.timeout(8000) }).then(x => x.json()).catch(() => null);
        return { ts: Number(b?.result) || 0, slot: st.slot };
      } catch {}
    }
    return undefined; // no RPC answered
  }
  async function one(chain, tx) {
    const hit = await caches.default.match(ck(tx)).catch(() => null); if (hit) return hit.json();
    const r = await fetch(`${SCAN}/messages/tx/${tx}`, { headers: { accept: 'application/json', 'user-agent': 'multisea-api' }, signal: AbortSignal.timeout(10000) }).catch(e => ({ ok: false, status: e?.message }));
    if (!r.ok && r.status !== 404) throw new Error('LayerZero Scan ' + r.status); // not cached: retried next time
    const j = r.ok ? await r.json().catch(() => null) : null;
    const myEid = Number(LP.eids?.[chain]);
    let v = null;
    for (const m of j?.data || []) {
      const s = Number(m?.pathway?.srcEid), d = Number(m?.pathway?.dstEid);
      const out = lc(m?.source?.tx?.txHash) === lc(tx) && s === myEid, inn = lc(m?.destination?.tx?.txHash) === lc(tx) && d === myEid;
      if (!out && !inn) continue;
      const peer = eidChain.get(out ? d : s); if (!peer) continue;
      const peerTx = out ? m?.destination?.tx?.txHash || '' : m?.source?.tx?.txHash || '';
      v = { dir: out ? 'out' : 'in', peer, peerTx, status: m?.status?.name || '', ts: 0 };
      if (peer === 'solana' && peerTx) { const t = await solTime(peerTx); if (t === null) v = null; else if (t) v.ts = t.ts; }
      break;
    }
    const done = v && v.peerTx && (v.peer !== 'solana' || v.ts);
    await caches.default.put(ck(tx), new Response(JSON.stringify(v), { headers: { 'cache-control': `public, max-age=${done ? IMMUTABLE : 120}` } })).catch(() => {});
    return v;
  }
  return async function handle(req, env, url, p, M) {
    if (!(M === 'GET' && p[0] === 'activity' && p[1] === 'lz' && p.length === 2)) return undefined;
    const items = String(url.searchParams.get('txs') || '').split(',').map(s => s.trim().split(':')).filter(([c, t]) => chains[c] && /^0x[0-9a-fA-F]{64}$/.test(t || '')).slice(0, 40);
    const out = {}, errors = {};
    await Promise.all(items.map(async ([c, t]) => { out[lc(t)] = await one(c, lc(t)).catch(e => { errors[lc(t)] = String(e?.message || e).slice(0, 120); return null; }); }));
    return { legs: out, errors };
  };
}
const lc = s => String(s || '').toLowerCase();
