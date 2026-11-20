// Create-flow helper: snapshot collection holders into an allowlist (Worker POST /launchpad/holder-allowlist).
import { API } from './wallet';

export type HolderSrc = { slug?: string; chain?: string; address?: string; min: number };
export type HolderCol = { slug: string; name: string; standard?: string; supply?: number; chains: string[]; static?: boolean };
export type HolderSnap = {
  addresses: string[]; count: number; evm: number; solana: number; skippedSolana: number; excludedEscrow: number;
  truncated: boolean; warning?: string; sources: { slug?: string; name?: string; chain?: string; address?: string; min: number; tokens: number }[];
  notes: string[]; at: string; includeLinked?: boolean; includeSolana?: boolean;
};

let cols: HolderCol[] | null = null;
let colsP: Promise<HolderCol[]> | null = null;
export function holderCollections(): Promise<HolderCol[]> {
  if (cols) return Promise.resolve(cols);
  return colsP ||= fetch(`${API}/launchpad/holder-collections`).then(r => r.json()).then(j => (cols = j.collections || [])).catch(() => (cols = []));
}

export async function snapshotHolders(body: { sources: HolderSrc[]; includeLinked: boolean; includeSolana: boolean }): Promise<HolderSnap> {
  const r = await fetch(`${API}/launchpad/holder-allowlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || 'Holder snapshot failed');
  return j as HolderSnap;
}

export const srcLabel = (s: HolderSrc, list: HolderCol[] = cols || []) => {
  if (s.slug) { const c = list.find(x => x.slug === s.slug); return `${c?.name || s.slug} · min ${s.min}`; }
  if (s.chain === 'solana') return `Solana ${s.address?.slice(0, 4)}…${s.address?.slice(-4)} · min ${s.min}`;
  return `${s.chain} ${s.address?.slice(0, 6)}…${s.address?.slice(-4)} · min ${s.min}`;
};

export function snapNote(s: HolderSnap) {
  const bits = [`${s.count.toLocaleString()} wallets`];
  if (s.solana) bits.push(`${s.evm} EVM + ${s.solana} Solana`);
  if (s.skippedSolana) bits.push(`${s.skippedSolana} Solana-only skipped (no linked EVM wallet)`);
  if (s.excludedEscrow) bits.push(`${s.excludedEscrow} escrow/contract excluded`);
  const t = s.at ? new Date(s.at) : null;
  const when = t && !isNaN(+t) ? t.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '';
  return bits.join(' · ') + (when ? ' · ' + when : '');
}
