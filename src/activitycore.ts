// On-chain activity core, shared by the API worker (worker/src/activity.js) and the collection page (src/collection.ts).
// Raw Transfer rows -> Activity rows: mint, sent (wallet to wallet), sale (Seaport OrderFulfilled in the same tx; price and
// currency from the order) and bridge (escrow/vault lock or mirror burn on one chain paired with the release or mirror mint
// of the same id on another chain). Escrow copies minted straight into escrow are not user events and are dropped.
export type Raw = { chain: string; contract: string; id: number; from: string; to: string; tx: string; log: number; block: number; ts: number; sale?: { price: number; currency: string } | null };
export type Row = { type: 'mint' | 'sent' | 'sale' | 'bridge'; chain: string; chain2?: string; dir?: 'in' | 'out'; id: number; from: string; to: string; tx: string; ts: number; price?: number; currency?: string };
export type Kv = { get(k: string): Promise<any>; put(k: string, v: any): Promise<void> };
type ChainCfg = { chainId: number; rpc: string; rpcs?: string[]; native?: string; name?: string };

export const ZERO = '0x0000000000000000000000000000000000000000';
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_FULFILLED = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31'; // Seaport OrderFulfilled (any Seaport version or router)
export const PER_CHAIN = 200;
const BRIDGE_WINDOW = 3 * 86400;
const lc = (s: any) => String(s || '').toLowerCase();
export const escrowSet = (col: { escrow?: { chain: string; address: string }[] }) => new Set((col.escrow || []).map(e => `${e.chain}:${lc(e.address)}`));
export const isEscrowCopy = (r: Raw, esc: Set<string>) => r.from === ZERO && esc.has(`${r.chain}:${r.to}`);
const isTransfer = (r: Raw, esc: Set<string>) => r.from !== ZERO && r.to !== ZERO && !esc.has(`${r.chain}:${r.to}`) && !esc.has(`${r.chain}:${r.from}`);

// ---- JSON-RPC with fallback across the chain's RPCs (single or batch) ----
export function makeRpc(chains: Record<string, ChainCfg>) {
  async function rpc(k: string, payload: any): Promise<any> {
    const c = chains[k]; const urls = c.rpcs?.length ? c.rpcs : [c.rpc]; let last = '';
    for (const u of urls) for (let n = 0; n < 2; n++) {
      try {
        if (n) await new Promise(r => setTimeout(r, 800));
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
        if (!r.ok) { last = 'HTTP ' + r.status; if (r.status === 429 || r.status >= 500) continue; break; }
        const out = await r.json();
        if (Array.isArray(payload)) { if (!Array.isArray(out) || out.some((x: any) => x?.error)) { last = 'batch error'; break; } return payload.map((p: any) => out.find((x: any) => x.id === p.id)?.result ?? null); }
        if (out.error) { last = out.error.message || 'rpc error'; break; }
        return out.result;
      } catch (e: any) { last = e?.message || String(e); }
    }
    throw new Error(`${k} rpc failed: ${last}`.slice(0, 200));
  }
  async function batch(k: string, calls: [string, any[]][], size = 20): Promise<any[]> { // up to 4 batches in flight
    const parts: any[][] = []; for (let i = 0; i < calls.length; i += size) parts.push(calls.slice(i, i + size).map(([method, params], j) => ({ jsonrpc: '2.0', id: j + 1, method, params })));
    const res: any[][] = new Array(parts.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, parts.length) }, async () => {
      while (next < parts.length) { const i = next++; const part = parts[i]; res[i] = await rpc(k, part).catch(() => Promise.all(part.map(p => rpc(k, p).catch(() => null)))); }
    }));
    return res.flat();
  }
  return { rpc, batch };
}
export type RpcApi = ReturnType<typeof makeRpc>;

// ---- Transfer logs straight from a chain RPC (chains without an indexer, e.g. Robinhood) ----
// 10M-block windows back from head; the newest logs are kept in kv so later reads only scan the blocks since then.
export async function rpcTransfers(R: RpcApi, kv: Kv, k: string, contract: string, fromBlock = 0): Promise<Raw[]> {
  const toRow = (g: any): Raw => ({ chain: k, contract: lc(contract), id: Number(BigInt(g.topics[3])), from: '0x' + g.topics[1].slice(26), to: '0x' + g.topics[2].slice(26), tx: lc(g.transactionHash), log: parseInt(g.logIndex, 16), block: parseInt(g.blockNumber, 16), ts: parseInt(g.blockTimestamp || '0x0', 16) });
  const getLogs = (from: number, to: number) => R.rpc(k, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: contract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [T_TRANSFER] }] })
    .then((l: any[]) => (l || []).filter(g => g.topics.length === 4).map(toRow));
  const head = parseInt(await R.rpc(k, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), 16);
  const ck = `rl:${k}:${lc(contract)}`; const prev = await kv.get(ck); let rows: Raw[];
  if (prev && head - prev.upto < 9_000_000) {
    const add = await getLogs(Math.max(fromBlock, prev.upto - 50), head); const seen = new Set<string>();
    rows = [...add, ...prev.rows].filter(r => { const x = r.tx + ':' + r.log; if (seen.has(x)) return false; seen.add(x); return true; });
  } else {
    rows = [];
    for (let to = head; to >= fromBlock && rows.length < PER_CHAIN; to -= 10_000_000) rows.push(...await getLogs(Math.max(fromBlock, to - 9_999_999), to));
  }
  rows.sort((a, b) => b.block - a.block || b.log - a.log); rows = rows.slice(0, PER_CHAIN);
  const need = [...new Set(rows.filter(r => !r.ts).map(r => r.block))]; const bt: Record<number, number> = {};
  await Promise.all(need.map(async b => { const v = await kv.get(`bt:${k}:${b}`); if (v) bt[b] = v; }));
  const miss = need.filter(b => !bt[b]);
  const got = await R.batch(k, miss.map(b => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]] as [string, any[]]), 25);
  await Promise.all(miss.map((b, i) => { const t = got[i] ? parseInt(got[i].timestamp, 16) : 0; if (t) { bt[b] = t; return kv.put(`bt:${k}:${b}`, t); } }));
  rows.forEach(r => { if (!r.ts) r.ts = bt[r.block] || 0; });
  if (rows.every(r => r.ts)) await kv.put(ck, { upto: head, rows });
  return rows;
}

// ---- sales: Seaport OrderFulfilled in the transfer's tx ----
function decodeFulfilled(data: string) { // (bytes32 orderHash, address recipient, SpentItem[] offer, ReceivedItem[] consideration)
  const h = data.slice(2); const w = (i: number) => h.slice(i * 64, i * 64 + 64); const n = (i: number) => Number(BigInt('0x' + w(i)));
  const items = (off: number, words: number) => { const at = off / 32, len = n(at); const out: { type: number; token: string; id: bigint; amount: bigint }[] = [];
    for (let i = 0; i < len; i++) { const b = at + 1 + i * words; out.push({ type: n(b), token: '0x' + w(b + 1).slice(24), id: BigInt('0x' + w(b + 2)), amount: BigInt('0x' + w(b + 3)) }); } return out; };
  return { offer: items(n(2), 4), consideration: items(n(3), 5) };
}
function salesFromReceipt(rc: any) {
  const sales: { token: string; id: string; cur: string; wei: string }[] = [];
  for (const g of rc.logs || []) {
    if (g.topics?.[0] !== T_FULFILLED) continue;
    let o; try { o = decodeFulfilled(g.data); } catch { continue; }
    const nft = (a: any[]) => a.filter(x => x.type >= 2), pay = (a: any[]) => a.filter(x => x.type <= 1);
    const listing = nft(o.offer).length > 0; const nfts = listing ? nft(o.offer) : nft(o.consideration); const money = listing ? pay(o.consideration) : pay(o.offer);
    if (!nfts.length || !money.length) continue;
    const cur = money[0].type === 0 ? '' : lc(money[0].token);
    const total = money.filter(m => (m.type === 0 ? '' : lc(m.token)) === cur).reduce((s, m) => s + m.amount, 0n);
    for (const x of nfts) sales.push({ token: lc(x.token), id: x.id.toString(), cur, wei: (total / BigInt(nfts.length)).toString() }); // multi-NFT order: even split
  }
  return sales;
}
async function tokenInfo(R: RpcApi, kv: Kv, k: string, token: string): Promise<{ symbol: string; decimals: number }> {
  const key = `tk:${k}:${token}`; const c = await kv.get(key); if (c) return c;
  const [s, d] = await R.batch(k, [['eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']], ['eth_call', [{ to: token, data: '0x313ce567' }, 'latest']]]);
  let sym = ''; try { const h = String(s || '').slice(2); const len = parseInt(h.slice(64, 128), 16); sym = new TextDecoder().decode(new Uint8Array((h.slice(128, 128 + len * 2).match(/../g) || []).map(x => parseInt(x, 16)))).replace(/[^\x20-\x7e]/g, ''); } catch {}
  const v = { symbol: sym || token, decimals: d && d !== '0x' ? parseInt(d, 16) : 18 }; if (s) await kv.put(key, v); return v;
}
/** Sets r.sale (price + currency, or null) on every wallet-to-wallet transfer of one chain. Receipts are cached in kv. */
export async function annotateSales(R: RpcApi, kv: Kv, chains: Record<string, ChainCfg>, k: string, rows: Raw[], esc: Set<string>) {
  const cand = rows.filter(r => r.chain === k && isTransfer(r, esc)); const txs = [...new Set(cand.map(r => r.tx))];
  const sales: Record<string, any[]> = {}; const miss: string[] = [];
  await Promise.all(txs.map(async t => { const v = await kv.get(`rc2:${k}:${t}`); if (v) sales[t] = v; else miss.push(t); }));
  const rcs = await R.batch(k, miss.map(t => ['eth_getTransactionReceipt', [t]] as [string, any[]]), 20);
  await Promise.all(miss.map(async (t, i) => { if (!rcs[i]) return; sales[t] = salesFromReceipt(rcs[i]); await kv.put(`rc2:${k}:${t}`, sales[t]); }));
  for (const r of cand) {
    const s = sales[r.tx]?.find(x => x.token === r.contract && x.id === String(r.id)); if (!s) { r.sale = null; continue; }
    const t = s.cur ? await tokenInfo(R, kv, k, s.cur).catch(() => ({ symbol: s.cur, decimals: 18 })) : { symbol: chains[k].native || 'ETH', decimals: 18 };
    r.sale = { price: Number(BigInt(s.wei)) / 10 ** t.decimals, currency: t.symbol };
  }
}

/** Raw transfers (any chains, any order) -> activity rows, newest first. */
export function assemble(raw: Raw[], esc: Set<string>): Row[] {
  const seen = new Set<string>(); const ev: (Raw & { kind: string })[] = [];
  for (const r of raw) {
    const key = `${r.chain}:${r.tx}:${r.id}:${r.log}`; if (seen.has(key) || !r.ts || isEscrowCopy(r, esc)) continue; seen.add(key);
    const toEsc = esc.has(`${r.chain}:${r.to}`), fromEsc = esc.has(`${r.chain}:${r.from}`);
    ev.push({ ...r, kind: r.from === ZERO ? 'mint' : toEsc ? 'lock' : fromEsc ? 'unlock' : r.to === ZERO ? 'burn' : 'transfer' });
  }
  ev.sort((a, b) => a.ts - b.ts || a.block - b.block || a.log - b.log);
  const open = new Map<number, (Raw & { kind: string })[]>(); const out: Row[] = [];
  for (const r of ev) {
    if (r.kind === 'lock' || r.kind === 'burn') { if (!open.has(r.id)) open.set(r.id, []); open.get(r.id)!.push(r); continue; }
    if (r.kind === 'unlock' || r.kind === 'mint') {
      const q = open.get(r.id) || []; let i = -1;
      for (let j = q.length - 1; j >= 0; j--) if (q[j].chain !== r.chain && r.ts - q[j].ts <= BRIDGE_WINDOW && r.ts - q[j].ts >= -600) { i = j; break; }
      if (i >= 0) { const d = q.splice(i, 1)[0]; out.push({ type: 'bridge', chain: d.chain, chain2: r.chain, id: r.id, from: d.from, to: r.to, tx: d.tx, ts: d.ts }); continue; }
      if (r.kind === 'unlock') out.push({ type: 'bridge', chain: r.chain, chain2: r.chain, dir: 'in', id: r.id, from: '', to: r.to, tx: r.tx, ts: r.ts });
      else out.push({ type: 'mint', chain: r.chain, id: r.id, from: ZERO, to: r.to, tx: r.tx, ts: r.ts });
      continue;
    }
    out.push(r.sale ? { type: 'sale', chain: r.chain, id: r.id, from: r.from, to: r.to, tx: r.tx, ts: r.ts, price: r.sale.price, currency: r.sale.currency } : { type: 'sent', chain: r.chain, id: r.id, from: r.from, to: r.to, tx: r.tx, ts: r.ts });
  }
  for (const q of open.values()) for (const d of q) out.push(d.kind === 'lock' ? { type: 'bridge', chain: d.chain, chain2: d.chain, dir: 'out', id: d.id, from: d.from, to: '', tx: d.tx, ts: d.ts } : { type: 'sent', chain: d.chain, id: d.id, from: d.from, to: d.to, tx: d.tx, ts: d.ts });
  return out.sort((a, b) => b.ts - a.ts);
}
