// ERC-463N7 agent drops: CSV traits stored onchain by AgentDropKit so OpenSea shows them next to the live traits
// (tokenURI is one onchain JSON). Encoding: packed dictionary (u8 nTypes; per type u8 len|name|u8 nValues; per value
// u8 len|value, UTF-8) + fixed-width rows,
// 1 byte per trait type (value index, 0 = none) for gen-0 tokens 1..N, uploaded as SSTORE2 chunks (<= 24,575 B each)
// by the creator after deploy, before mint opens (kit.uploadTraits ... seal, or kit.skipTraits).
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { readClient } from './wallet';
import { usdRates, esc } from './shell';

/** Names the onchain renderer already emits (AgentDropKit._reserved): a CSV column with one of these is prefixed. */
export const RESERVED = ['Status', 'Generation', 'Score', 'Tier', 'Rank', 'Wallet', 'Sex', 'Fertility', 'Mutation', 'Mutated', 'Infect', 'Infections', 'Repo', 'Queen', 'Zombie', 'Death skill', 'Strike', 'Latest child'];
export const PREFIX = 'Art ';
export const MAX_TYPES = 32, MAX_VALUES = 255, CHUNK_MAX = 24_575, CHUNKS_PER_TX = 2;
export type TraitEnc = { types: string[]; renamed: [string, string][]; values: string[][]; width: number; rows: number; dict: Hex; chunks: Hex[] };
type RowIn = { tokenID: string; attrs: { trait_type: string; value: string }[] };

const hex = (b: Uint8Array): Hex => ('0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')) as Hex;

/** Build the onchain encoding from CSV rows (tokenID 1..N). Returns an error string for limits it cannot fit. */
export function encodeTraits(rows: RowIn[]): TraitEnc | string | null {
  const sorted = [...rows].sort((a, b) => +a.tokenID - +b.tokenID);
  const order: string[] = [];
  for (const r of sorted) for (const a of r.attrs) if (a.value && !order.includes(a.trait_type)) order.push(a.trait_type);
  if (!order.length) return null; // no trait columns: nothing to store
  if (order.length > MAX_TYPES) return `Onchain CSV traits: at most ${MAX_TYPES} trait columns (found ${order.length}).`;
  const res = new Set(RESERVED.map(x => x.toLowerCase())); const used = new Set<string>(); const renamed: [string, string][] = [];
  const types = order.map(t => { let n = t; if (res.has(t.toLowerCase())) n = PREFIX + t; let k = 2; const base = n; while (used.has(n.toLowerCase())) n = `${base} ${k++}`; used.add(n.toLowerCase()); if (n !== t) renamed.push([t, n]); return n; });
  const values: string[][] = order.map(() => []);
  const w = order.length; const buf = new Uint8Array(sorted.length * w);
  for (let i = 0; i < sorted.length; i++) for (const a of sorted[i].attrs) {
    if (!a.value) continue; const k = order.indexOf(a.trait_type); let x = values[k].indexOf(a.value);
    if (x < 0) { values[k].push(a.value); x = values[k].length - 1; }
    if (values[k].length > MAX_VALUES) return `Onchain CSV traits: "${order[k]}" has more than ${MAX_VALUES} different values.`;
    buf[i * w + k] = x + 1;
  }
  const te = new TextEncoder(); const out: number[] = [types.length];
  const put = (x: string, what: string) => { const b = te.encode(x); if (b.length > 255) return `Onchain CSV traits: ${what} "${x.slice(0, 40)}…" is over 255 bytes.`; out.push(b.length, ...b); return ''; };
  for (let k = 0; k < w; k++) { const e1 = put(types[k], 'trait name'); if (e1) return e1; out.push(values[k].length); for (const v of values[k]) { const e2 = put(v, 'value'); if (e2) return e2; } }
  const dict = hex(Uint8Array.from(out));
  if ((dict.length - 2) / 2 > CHUNK_MAX) return 'Onchain CSV traits: the trait dictionary is over 24 KB (shorten trait names / values).';
  const per = Math.floor(CHUNK_MAX / w) * w; const chunks: Hex[] = [];
  for (let o = 0; o < buf.length; o += per) chunks.push(hex(buf.subarray(o, o + per)));
  return { types, renamed, values, width: w, rows: sorted.length, dict, chunks };
}

export const KIT_TRAITS = parseAbi([
  'function uploadTraits(address engine, bytes dict, bytes[] chunks, bool seal)', 'function skipTraits(address engine)',
  'function traitsReady(address engine) view returns (bool)',
  'function traits(address engine) view returns (uint32 expectedRows, uint32 rows, uint8 width, bool done, address dict)',
]);

/** Upload batches: the first tx carries the dictionary; each tx up to CHUNKS_PER_TX row chunks; the last tx seals.
 * `fromChunk` / `withDict` resume a partly uploaded table (rows already onchain = whole chunks). */
export function traitTxs(e: TraitEnc, engine: Address = '0x0000000000000000000000000000000000000000', fromChunk = 0, withDict = true): { dict: Hex; chunks: Hex[]; seal: boolean; data: Hex }[] {
  const out: { dict: Hex; chunks: Hex[]; seal: boolean; data: Hex }[] = [];
  for (let i = fromChunk; i < Math.max(fromChunk + 1, e.chunks.length); i += CHUNKS_PER_TX) {
    const dict = i === fromChunk && withDict ? e.dict : '0x'; const chunks = e.chunks.slice(i, i + CHUNKS_PER_TX); const seal = i + CHUNKS_PER_TX >= e.chunks.length;
    out.push({ dict, chunks, seal, data: encodeFunctionData({ abi: KIT_TRAITS, functionName: 'uploadTraits', args: [engine, dict, chunks, seal] }) });
  }
  return out;
}
export const rowsPerChunk = (e: TraitEnc) => Math.floor(CHUNK_MAX / e.width);

const cdGas = (d: Hex) => { let g = 0; for (let i = 2; i < d.length; i += 2) g += d.slice(i, i + 2) === '00' ? 4 : 16; return g; };
// Execution model fitted to forge (ERC-463N7 test/AgentDropTraits.t.sol, 6 types x 20 values, 1k/5k/10k tokens):
// ~219 gas per stored byte (SSTORE2 code deposit 200/B + copy/memory), ~64k per row chunk (CREATE + _chunks slot),
// ~48k fixed per tx, dictionary ~33k + ~530 per name/value checked.
const G = { tx: 21_000, fixed: 48_000, perByte: 219, chunk: 64_000, dict: 33_000, perVal: 530 };
/** Estimated total gas (and per tx) for the whole upload. */
export function traitGas(e: TraitEnc): { txs: number; perTx: number[]; total: number; bytes: number } {
  const txs = traitTxs(e); const nVals = e.values.reduce((a, v) => a + v.length, 0) + e.types.length;
  const perTx = txs.map(t => {
    const bytes = t.chunks.reduce((a, c) => a + (c.length - 2) / 2, 0) + (t.dict.length - 2) / 2;
    return G.tx + cdGas(t.data) + G.fixed + (t.dict.length > 2 ? G.dict + nVals * G.perVal : 0) + t.chunks.length * G.chunk + bytes * G.perByte;
  });
  return { txs: txs.length, perTx, total: perTx.reduce((a, b) => a + b, 0), bytes: (e.dict.length - 2) / 2 + e.chunks.reduce((a, c) => a + (c.length - 2) / 2, 0) };
}

// Kept in this browser between submit (CSV in memory) and the post-deploy upload; also pinned to IPFS (traitsURI).
const LKEY = (slug: string) => 'multisea-agent-traits:' + slug;
export function saveTraits(slug: string, e: TraitEnc) { try { localStorage.setItem(LKEY(slug), JSON.stringify(e)); } catch {} }
export function loadTraits(slug: string): TraitEnc | null { try { return JSON.parse(localStorage.getItem(LKEY(slug)) || 'null'); } catch { return null; } }
export async function fetchTraits(uri: string): Promise<TraitEnc | null> {
  if (!/^ipfs:\/\/\w+\/[\w.-]+$/.test(uri)) return null;
  try { const j = await fetch('https://ipfs.io/ipfs/' + uri.slice(7)).then(r => r.json()); return j && Array.isArray(j.chunks) && typeof j.dict === 'string' ? j : null; } catch { return null; }
}

// ---- cost display (live gas price per chain + Base L1 data fee + USD) ----
const chainsC = CFG.chains as Record<string, { name: string; native: string }>;
const GPO = parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);
const OP_STACK = new Set(['base']);
export const cost: Record<string, { gp: bigint; l1: bigint } | undefined> = {}; let usd: Record<string, number | null> = {};
let primed = '';
/** Fetch gas price (and Base's L1 data fee for these exact txs) once per chain set; calls `done` when ready. */
export function primeCost(e: TraitEnc, keys: string[], done: () => void) {
  const sig = keys.join(',') + ':' + e.rows + ':' + e.width; if (primed === sig) return; primed = sig;
  const txs = traitTxs(e);
  Promise.all([usdRates().then(r => { usd = r as any; }), ...keys.map(async k => {
    const pub = readClient(k); const gp = (await Promise.race([pub.getGasPrice().catch(() => 0n), new Promise<bigint>(r => setTimeout(() => r(0n), 6000))])) as bigint;
    let l1 = 0n; if (OP_STACK.has(k)) for (const t of txs) l1 += ((await pub.readContract({ address: '0x420000000000000000000000000000000000000F', abi: GPO, functionName: 'getL1Fee', args: [t.data] }).catch(() => 0n)) as bigint);
    cost[k] = { gp, l1 };
  })]).then(done, done);
}
const fmtN = (w: bigint) => { const v = Number(w) / 1e18; return v === 0 ? '0' : v.toLocaleString(undefined, v < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 4 }); };
/** One line per chain: "Base: ≈ 0.0004 ETH (~$1.30) at 0.006 gwei (+L1 data)". */
export function costLines(e: TraitEnc, keys: string[]): string {
  const g = traitGas(e);
  return keys.map(k => { const c = cost[k]; const ch = chainsC[k] || { name: k, native: 'ETH' };
    if (!c || !c.gp) return `<li><b>${esc(ch.name)}</b>: ${g.total.toLocaleString()} gas <span class="mut">(gas price loading…)</span></li>`;
    const wei = BigInt(g.total) * c.gp + c.l1; const u = usd[ch.native]; const usdV = u ? Number(wei) / 1e18 * u : 0; const d = u ? (usdV < 0.01 ? ' (<$0.01)' : ` (~$${usdV.toLocaleString(undefined, { maximumFractionDigits: 2 })})`) : '';
    return `<li><b>${esc(ch.name)}</b>: ≈ ${fmtN(wei)} ${esc(ch.native)}${d} <span class="mut">at ${(Number(c.gp) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })} gwei${c.l1 ? ' incl. L1 data fee' : ''}</span></li>`; }).join('');
}
/** Creator-facing summary card of the onchain CSV traits (create form + drop page). */
export function traitsCard(e: TraitEnc, keys: string[], title = 'Onchain CSV traits'): string {
  const g = traitGas(e);
  return `<div class="fcard small lptraits"><div class="gh">${title}</div>
   <p class="mut small">OpenSea reads one onchain JSON per agent, so your CSV traits are stored onchain next to the live traits (Status, Sex, skills…). Children born later and ids past the CSV have none. Dead agents keep theirs.</p>
   <div class="kv"><span>Trait types</span><b>${e.types.map(esc).join(', ')}</b><span>Rows</span><b>${e.rows.toLocaleString()} (tokens 1–${e.rows.toLocaleString()})</b><span>Onchain bytes</span><b>${g.bytes.toLocaleString()} B (dictionary + ${e.width} B/token)</b><span>Setup</span><b>${g.txs} tx after deploy · ~${g.total.toLocaleString()} gas</b></div>
   ${e.renamed.length ? `<p class="small ldwarn">Renamed to avoid onchain trait names: ${e.renamed.map(([a, b]) => `<b>${esc(a)}</b> → <b>${esc(b)}</b>`).join(', ')}</p>` : ''}
   <ul class="small lptrcost">${costLines(e, keys)}</ul>
   <p class="mut small">Mint stays closed until you upload them (or skip) from the drop page. Estimate only; your wallet shows the exact fee per tx.</p></div>`;
}
