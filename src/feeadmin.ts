// Admin "Listing fees": shows each factory's current 5-chain listing fee against the recommended one (src/feeplan.ts) and lets MC (factory owner)
// sign setGasCosts on a chain. The tx is simulated first; nothing is sent until you confirm in your own wallet.
import { createWalletClient, custom, formatEther, parseAbi, type Address } from 'viem';
import { wallet, readClient, ensureChain, vchain, friendly } from './wallet';
import { bridgeCfg } from './bridgekit';
import { planNative, DEFAULT_MARKUPS, type Plan, type Units } from './feeplan';

const ABI = parseAbi(['function listingFee(uint32[]) view returns (uint256)', 'function owner() view returns (address)', 'function gasWallet() view returns (address)',
  'function operators(address) view returns (bool)', 'function setGasCosts(uint32[] eids, uint256[] costs)']);
const REF = parseAbi(['function quote(uint32[] dsts, uint128[] amounts, address to) view returns (uint256)']);
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const f = (w: bigint) => { const [a, b = ''] = formatEther(w).split('.'); return a + (b ? '.' + b.slice(0, 6).replace(/0+$/, '') : ''); };
type Row = { k: string; name: string; native: string; old: bigint; plan: Plan; owner: string; busy: boolean; msg: string };
let rows: Row[] | null = null; let err = '';
const UNITS: Units = { list: 1904036, deployMirror: 5271945, wire: 960409 };

async function planFor(cfg: any, keys: string[], k: string, gp: Record<string, bigint>): Promise<{ plan: Plan; gw: Address }> {
  const c = cfg.chains[k]; const pc = readClient(k); const gw = await pc.readContract({ address: c.factory, abi: ABI, functionName: 'gasWallet' }) as Address;
  const plan = await planNative({ native: k, keys, eid: Object.fromEntries(keys.map(x => [x, cfg.chains[x].eid])), gasPrice: gp, units: cfg.gasUnits || UNITS, markups: cfg.feePlan || DEFAULT_MARKUPS,
    quote: (d, a) => pc.readContract({ address: c.refuel, abi: REF, functionName: 'quote', args: [d, a, gw] }) as Promise<bigint> });
  return { plan, gw };
}
const gasPrices = async (keys: string[]) => Object.fromEntries(await Promise.all(keys.map(async k => [k, await readClient(k).getGasPrice()])));
export async function loadFeeAdmin(rerender: () => void) {
  try {
    const cfg: any = await bridgeCfg(); if (!cfg) { rows = []; return rerender(); }
    const keys = Object.keys(cfg.chains).filter(k => cfg.chains[k].factory && cfg.chains[k].refuel); const gp = await gasPrices(keys); const out: Row[] = [];
    for (const k of keys) { const c = cfg.chains[k]; const pc = readClient(k);
      const { plan } = await planFor(cfg, keys, k, gp);
      const all = [c.eid, ...keys.filter(x => x !== k).map(x => cfg.chains[x].eid)];
      out.push({ k, name: c.name, native: c.native || 'ETH', old: await pc.readContract({ address: c.factory, abi: ABI, functionName: 'listingFee', args: [all] }) as bigint, plan,
        owner: String(await pc.readContract({ address: c.factory, abi: ABI, functionName: 'owner' })), busy: false, msg: rows?.find(r => r.k === k)?.msg || '' }); }
    rows = out; err = '';
  } catch (e: any) { err = e.message || String(e); rows = rows || []; }
  rerender();
}
// True when the connected wallet is the owner() of any bridge factory. No SIWE needed: setGasCosts is onlyOwner/onlyOperator on-chain, which is the real check.
export const feeOwner = () => !!wallet.address && !!rows?.some(r => r.owner.toLowerCase() === wallet.address!.toLowerCase());
export function feeAdminHtml(isAdmin = false): string {
  if (!isAdmin && !feeOwner()) return '';
  if (!rows && !err) return '';
  return `<div class="fees"><div class="fh"><h2>Listing fees (bridge factories)</h2></div>
    <p class="mut small">What an owner pays for a ${rows?.length || 5}-chain listing. It must cover, from the fee alone, the deployer's gas on every chain including the LayerZero gas drop + fee that funds Ethereum. Gas prices move, so the fee is recomputed from live prices with a safety buffer (2x on gas, 1.3x on LayerZero) and stored on each factory with <span class="mono">setGasCosts</span> (factory owner, signed in your wallet; simulated first). Update when "recommended" drifts above "current".</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    ${(rows || []).map(r => { const me = wallet.address?.toLowerCase(); const can = !!me && me === r.owner.toLowerCase(); const low = r.plan.total > r.old * 11n / 10n;
      return `<div class="fcard"><b>${esc(r.name)}</b> <span class="mut small">as the native chain, all-chain listing</span><br>
        <span class="mut small">current</span> <b>${f(r.old)} ${esc(r.native)}</b> · <span class="mut small">recommended</span> <b>${f(r.plan.total)} ${esc(r.native)}</b> ${low ? '<span class="small warn">current fee is too low: the deployer would subsidize</span>' : '<span class="small ok">current fee is fine</span>'}
        <div class="mut small">base ${f(r.plan.base)} + ${Object.entries(r.plan.remote).map(([k, x]) => `${esc(k)} ${f(x.cost)}`).join(' + ')}</div>
        <button class="bbtn sm" data-feeset="${esc(r.k)}" ${can && !r.busy ? '' : 'disabled'}>${r.busy ? 'Working…' : `Update fees on ${esc(r.name)}`}</button>
        ${!can ? `<span class="small warn">${me ? 'Connect the factory owner wallet' : 'Connect the factory owner wallet'} (${esc(r.owner.slice(0, 6))}…${esc(r.owner.slice(-4))})</span>` : ''}${r.msg ? `<div class="small">${r.msg}</div>` : ''}</div>`; }).join('')}</div>`;
}
export async function doFeeSet(k: string, rerender: () => void) {
  const r = rows?.find(x => x.k === k); if (!r || r.busy) return; r.busy = true; r.msg = ''; rerender();
  try {
    if (!wallet.address || !wallet.provider) throw new Error('Connect the factory owner wallet first.');
    const cfg: any = await bridgeCfg(); const keys = Object.keys(cfg.chains).filter(x => cfg.chains[x].factory && cfg.chains[x].refuel); const c = cfg.chains[k];
    await ensureChain(k); const pc = readClient(k); const me = wallet.address as Address;
    const { plan } = await planFor(cfg, keys, k, await gasPrices(keys)); // fresh numbers at signing time
    try { await pc.simulateContract({ account: me, address: c.factory, abi: ABI, functionName: 'setGasCosts', args: [plan.eids, plan.costs] }); }
    catch (e: any) { throw new Error(`The update would fail (${String(friendly(e, k) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 160)}). Nothing was sent.`); }
    const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
    const hash = await wc.writeContract({ account: me, chain: vchain(k), address: c.factory, abi: ABI, functionName: 'setGasCosts', args: [plan.eids, plan.costs] });
    r.msg = 'Waiting for confirmation…'; rerender();
    const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('The update reverted.');
    r.msg = `<span class="ok">✓ Fees updated on ${esc(c.name)}. <a href="${esc(c.explorer)}/tx/${hash}" target="_blank" rel="noopener">Tx ↗</a></span>`;
  } catch (e: any) { r.msg = `<span class="err">${esc(e?.code === 4001 ? 'Rejected in wallet.' : e.message || e)}</span>`; }
  r.busy = false; await loadFeeAdmin(rerender);
}
