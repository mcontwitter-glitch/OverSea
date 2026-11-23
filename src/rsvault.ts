// On-chain revenue-share vaults (contracts/src/revshare): shared reads + holder claim + the collection-page card.
// One RevShareVault per collection per chain. Deposits split equally across tokenIds; holders claim straight from the vault.
// This module never sends anything except the holder's own claim() (simulated first, then signed in their wallet).
import { createWalletClient, custom, formatEther, type Hex, type Address } from 'viem';
import CFG from '../config/collections.json';
import ART from '../config/revshare-artifact.json';
import { wallet, readClient, ensureChain, vchain, friendly } from './wallet';

export const FACTORIES: Record<string, string> = ((CFG as any).revshareVaults?.factories || {}) as Record<string, string>;
export const hasFactories = () => Object.keys(FACTORIES).length > 0;
export const VAULT_ABI = (ART as any).vaultAbi;
export const FACTORY_ABI = (ART as any).factoryAbi;
const chains = CFG.chains as Record<string, { name: string; chainId: number; native: string; explorer: string }>;
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const OWNER_OF = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] }] as const;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const fe = (v: bigint, max = 6) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: max });
export const rejected = (e: any) => e?.code === 4001 || e?.cause?.code === 4001 || /user rejected|user denied|rejected in wallet|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));
export const errText = (e: any, k?: string) => rejected(e) ? 'Rejected in wallet.' : (friendly(e, k) || e?.shortMessage || e?.message || String(e));

export type VaultStats = { chain: string; vault: Address; balance: bigint; deposited: bigint; claimed: bigint; owed: bigint; dust: bigint; supply: number; firstId: number; owner: string; claimsPaused: boolean; depositsPaused: boolean; collection: string };
export async function readVault(k: string, vault: string): Promise<VaultStats> {
  const pc = readClient(k); const address = vault as Address;
  const rd = (functionName: string) => pc.readContract({ address, abi: VAULT_ABI, functionName } as any) as Promise<any>;
  const [balance, deposited, claimed, owed, dust, supply, firstId, owner, cp, dp, collection] = await Promise.all([pc.getBalance({ address }), rd('totalDeposited'), rd('totalClaimed'), rd('totalPending'), rd('dust'), rd('totalSupply'), rd('firstId'), rd('owner'), rd('claimsPaused'), rd('depositsPaused'), rd('collection')]);
  return { chain: k, vault: address, balance, deposited, claimed, owed, dust, supply: Number(supply), firstId: Number(firstId), owner: String(owner).toLowerCase(), claimsPaused: !!cp, depositsPaused: !!dp, collection: String(collection).toLowerCase() };
}

/** Token ids in [firstId, firstId+supply) that `me` currently owns on this chain (multicall of ownerOf; ids that don't exist here are skipped). */
export async function holderTokens(k: string, collection: string, firstId: number, supply: number, me: string): Promise<number[]> {
  const pc = readClient(k); const out: number[] = []; const lo = me.toLowerCase();
  const ids = Array.from({ length: Math.min(supply, 20000) }, (_, i) => firstId + i);
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const res = await pc.multicall({ multicallAddress: MC3, allowFailure: true, contracts: part.map(id => ({ address: collection as Address, abi: OWNER_OF, functionName: 'ownerOf', args: [BigInt(id)] })) } as any).catch(() => null) as any[] | null;
    if (res) res.forEach((r, j) => { if (r.status === 'success' && String(r.result).toLowerCase() === lo) out.push(part[j]); });
    else for (const id of part) { const o = await pc.readContract({ address: collection as Address, abi: OWNER_OF, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null); if (o && String(o).toLowerCase() === lo) out.push(id); }
  }
  return out;
}
export async function pendingFor(k: string, vault: string, ids: number[]): Promise<bigint> {
  if (!ids.length) return 0n;
  return await readClient(k).readContract({ address: vault as Address, abi: VAULT_ABI, functionName: 'pending', args: [ids.map(BigInt)] } as any) as bigint;
}

/** Claim for the connected holder: simulated on-chain first (the wallet is not prompted if it would fail), then signed. */
export async function claimVault(k: string, vault: string, ids: number[]): Promise<{ hash: Hex }> {
  const me = wallet.address as Address | null; if (!me || !wallet.provider) throw new Error('Connect your wallet first.');
  await ensureChain(k);
  const pc = readClient(k); const req = { address: vault as Address, abi: VAULT_ABI, functionName: 'claim', args: [ids.map(BigInt)], account: me } as any;
  try { await pc.simulateContract(req); } catch (e: any) { throw new Error(`This claim would fail (${String(friendly(e, k) || e?.shortMessage || e?.message || '').split('\n')[0].slice(0, 160)}). Nothing was sent.`); }
  const est = await pc.estimateContractGas(req).catch(() => 250_000n);
  const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
  const hash = await wc.writeContract({ ...req, chain: vchain(k), gas: est * 13n / 10n + 20_000n });
  const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('Claim reverted.');
  return { hash };
}

// ---------------------------------------------------------------- holder card (collection page + /revenue-share)
export type ChainView = { k: string; vault: string; ids: number[]; pending: bigint; stats: VaultStats | null; err: string; busy: boolean; tx: string };
export type VaultView = { slug: string; rows: ChainView[]; loading: boolean; wallet: string | null };
export async function loadVaultView(slug: string, cfg: any, deployments: { chain: string; address: string }[], me: string | null): Promise<VaultView> {
  const rows: ChainView[] = [];
  const vs = (cfg?.vaults || {}) as Record<string, string>;
  await Promise.all(Object.entries(vs).map(async ([k, vault]) => {
    const row: ChainView = { k, vault, ids: [], pending: 0n, stats: null, err: '', busy: false, tx: '' };
    try {
      row.stats = await readVault(k, vault);
      if (me) { row.ids = await holderTokens(k, row.stats.collection, row.stats.firstId, row.stats.supply, me); row.pending = await pendingFor(k, vault, row.ids); }
    } catch (e: any) { row.err = errText(e, k); }
    rows.push(row);
  }));
  rows.sort((a, b) => a.k.localeCompare(b.k));
  return { slug, rows, loading: false, wallet: me };
}
export function vaultCardHtml(v: VaultView | null, cfg: any, connected: boolean): string {
  if (!cfg?.vaults || !Object.keys(cfg.vaults).length) return '';
  const head = `<div class="gh">💰 Revenue share · claim</div><p class="mut small">Paid from on-chain vaults, one per chain: the collection's creator royalty goes straight into the vault and MultiSea's fee share is added to it. Each deposit is split equally across all ${esc(cfg.supply)} tokens; the reward belongs to the token, so a buyer inherits anything unclaimed. Claims are paid by the contract, no MultiSea wallet involved.</p>`;
  if (!v || v.loading) return `<div class="fcard rsvcard">${head}<div class="spin"></div></div>`;
  const rows = v.rows.map(r => {
    const c = chains[r.k]; const logo = `<img class="cl" src="/logos/${r.k}.svg" alt="">`;
    if (r.err) return `<div class="fndr">${logo}<span>${esc(c?.name || r.k)}</span><span class="err small">${esc(r.err)}</span></div>`;
    const s = r.stats!; const can = connected && r.ids.length && r.pending > 0n && !r.busy && !s.claimsPaused;
    return `<div class="fndr">${logo}<div class="fndm"><b>${esc(c?.name || r.k)}</b>
      <div class="mut small">${connected ? (r.ids.length ? `Your ${r.ids.length} token${r.ids.length === 1 ? '' : 's'} on this chain: <b>${fe(r.pending, 8)} ${esc(c?.native)}</b> pending` : 'You hold no tokens on this chain') : 'Connect a wallet to see what your tokens earned'} · vault holds ${fe(s.balance, 6)} ${esc(c?.native)} · paid out so far ${fe(s.claimed, 6)}</div>
      ${s.claimsPaused ? '<div class="small err">Claims are paused by the vault owner.</div>' : ''}
      ${r.tx ? `<div class="small ok">✓ Claimed. <a href="${esc(c?.explorer)}/tx/${esc(r.tx)}" target="_blank" rel="noopener">Tx ↗</a></div>` : ''}</div>
      <button class="bbtn sm" data-act="vclaim" data-chain="${esc(r.k)}" ${can ? '' : 'disabled'}>${r.busy ? 'Claiming…' : 'Claim'}</button></div>`;
  }).join('');
  return `<div class="fcard rsvcard">${head}${rows || '<p class="mut">No vaults.</p>'}</div>`;
}
/** Run a holder's claim for one chain row and refresh it. */
export async function runVaultClaim(v: VaultView, k: string, redraw: () => void) {
  const r = v.rows.find(x => x.k === k); if (!r || r.busy) return; r.busy = true; r.err = ''; r.tx = ''; redraw();
  try { const { hash } = await claimVault(k, r.vault, r.ids); r.tx = hash; r.pending = await pendingFor(k, r.vault, r.ids); r.stats = await readVault(k, r.vault); }
  catch (e: any) { r.err = errText(e, k); }
  r.busy = false; redraw();
}
