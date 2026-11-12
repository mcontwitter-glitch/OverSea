// Admin: send a multichain drop's queued escrow copies from the Base hub (MultiSeaOmniEscrow.flush, permissionless).
// One flush sends one LayerZero message per destination chain, paid from the drop's copy pool; the connected wallet
// only tops the pool up if the quoted fees exceed it, and is reimbursed its gas from the pool.
import { createWalletClient, custom, formatEther, parseAbi, type Hex } from 'viem';
import { wallet, readClient, ensureChain, vchain, friendly } from './wallet';
import { bridgeCfg } from './bridgekit';
import { esc } from './shell';
const ESC = parseAbi(['function queueOf(bytes32) view returns (uint64 oldest, uint32 ids, uint32 head, uint32 tail)', 'function rangeAt(bytes32,uint256) view returns (uint256)', 'function flushReady(bytes32) view returns (bool)',
  'function quoteFlush(bytes32) view returns (uint256 ids, uint256 fees)', 'function poolOf(bytes32) view returns (uint256)', 'function flush(bytes32) payable']);
const EIDS: Record<number, string> = { 30184: 'Base', 30101: 'Ethereum', 30312: 'ApeChain', 30102: 'BNB Chain', 30416: 'Robinhood' };
type Row = { name: string; slug: string; cid: Hex; escrow: Hex; ids: number; ready: boolean; fees: bigint; pool: bigint; ranges: string[]; msg: string; busy: boolean };
let rows: Row[] | null = null; let redraw = () => {};
const fe = (v: bigint) => Number(formatEther(v)).toFixed(6);
export async function loadFlush(onChange: () => void) {
  redraw = onChange;
  const cfg = await bridgeCfg(); const cols = (cfg?.collections || []).filter((c: any) => c.kind === 'omni' && c.cid && c.escrows?.base);
  const pc = readClient('base');
  rows = await Promise.all(cols.map(async (c: any): Promise<Row> => {
    const cid = c.cid as Hex, escrow = c.escrows.base as Hex; const r = (functionName: any, args: any[]) => pc.readContract({ address: escrow, abi: ESC, functionName, args }) as Promise<any>;
    try {
      const [q, ready, qf, pool] = await Promise.all([r('queueOf', [cid]), r('flushReady', [cid]), r('quoteFlush', [cid]).catch(() => [0n, 0n]), r('poolOf', [cid])]);
      const ranges: string[] = [];
      for (let i = Number(q[2]); i < Number(q[3]) && ranges.length < 20; i++) { const v = BigInt(await r('rangeAt', [cid, BigInt(i)])); const s = Number((v >> 32n) & 0xffffffffn), n = Number(v & 0xffffffffn); ranges.push(`#${s}${n > 1 ? '–' + (s + n - 1) : ''} (minted on ${EIDS[Number(v >> 104n)] || Number(v >> 104n)})`); }
      return { name: c.name, slug: c.slug, cid, escrow, ids: Number(q[1]), ready, fees: qf[1], pool, ranges, msg: '', busy: false };
    } catch (e) { return { name: c.name, slug: c.slug, cid, escrow, ids: 0, ready: false, fees: 0n, pool: 0n, ranges: [], msg: 'Could not read the hub escrow: ' + friendly(e), busy: false }; }
  }));
  redraw();
}
function cardHtml(r: Row, i: number) {
  return `<div class="qcard"><b>${esc(r.name)}</b><div class="small">${r.ids ? `${r.ids} pending: ${esc(r.ranges.join(', '))}` : 'Nothing pending: every copy has been sent.'}</div>
    ${r.ids ? `<div class="mut small">LayerZero fees ${fe(r.fees)} ETH · copy pool ${fe(r.pool)} ETH · ${r.pool >= r.fees ? 'pool covers it (you pay gas only)' : `you add ${fe((r.fees - r.pool) * 12n / 10n)} ETH`}${r.ready ? '' : ' · not ready yet'}</div>
    <div class="qa"><button class="bbtn sm" data-flush="${i}" ${r.busy || !r.ready ? 'disabled' : ''}>${r.busy ? 'Sending…' : 'Send pending copies'}</button></div>` : ''}${r.msg ? `<p class="small">${r.msg}</p>` : ''}</div>`;
}
const blurb = "Queued copies wait on the Base hub until a flush sends them to every other chain (one LayerZero message per chain). Anyone may flush; the fees come from the drop's copy pool and your gas is reimbursed from it.";
export function flushHtml() {
  if (!rows) return '';
  return `<div class="gh pad">Multichain escrow copies</div><p class="mut small">${blurb}</p>
  ${rows.map((r, i) => cardHtml(r, i)).join('') || '<p class="mut">No multichain drops.</p>'}`;
}
/** Founder panel: the same pending-copies card, only for this drop, and only while something is queued (or a flush result is showing). */
export function founderFlushHtml(slug?: string) {
  if (!rows || !slug) return '';
  const i = rows.findIndex(r => r.slug === slug); if (i < 0) return '';
  const r = rows[i]; if (!r.ids && !r.msg) return '';
  return `<div class="fndsec"><h4>Send pending copies</h4><p class="mut small">${blurb}</p>${cardHtml(r, i)}</div>`;
}
export async function doFlush(i: number) {
  const r = rows?.[i]; if (!r || r.busy || !wallet.address || !wallet.provider) return;
  r.busy = true; r.msg = ''; redraw();
  try {
    await ensureChain('base');
    const pc = readClient('base');
    const [, fees] = await pc.readContract({ address: r.escrow, abi: ESC, functionName: 'quoteFlush', args: [r.cid] }) as [bigint, bigint];
    const pool = await pc.readContract({ address: r.escrow, abi: ESC, functionName: 'poolOf', args: [r.cid] }) as bigint;
    const value = pool >= fees ? 0n : (fees - pool) * 12n / 10n;
    const account = wallet.address as Hex;
    const flush = { address: r.escrow, abi: ESC, functionName: 'flush' as const, args: [r.cid] as const, account, value };
    await pc.simulateContract(flush);
    const est = await pc.estimateContractGas(flush);
    const gas = est * 16n / 10n > 2_000_000n ? est * 16n / 10n : 2_000_000n; // wallet estimate alone was 946k and both live flushes ran out of gas
    const hash = await createWalletClient({ chain: vchain('base'), transport: custom(wallet.provider) }).writeContract({ ...flush, account, chain: vchain('base'), gas });
    r.msg = `Sent. <a href="https://basescan.org/tx/${hash}" target="_blank" rel="noopener">Base tx ↗</a> · LayerZero delivers to each chain in a few minutes (<a href="https://layerzeroscan.com/tx/${hash}" target="_blank" rel="noopener">LayerZero Scan ↗</a>).`;
    redraw(); await pc.waitForTransactionReceipt({ hash }); r.busy = false; const keep = r.msg; await loadFlush(redraw); const n = rows?.find(x => x.cid === r.cid); if (n) n.msg = keep; redraw();
  } catch (e: any) { r.busy = false; r.msg = `<span class="err">${esc(e?.code === 4001 ? 'Rejected in wallet.' : friendly(e))}</span>`; redraw(); }
}
