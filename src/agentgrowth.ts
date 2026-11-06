// ERC-463N7 AgentGrowth: append-only trait art/unlocks and permanent agent XP.
// All writes are signed directly by the connected creator/holder wallet; no relayer or smart account.
import { parseAbi, type Address } from 'viem';
import { readClient } from './wallet';
import { pinImage } from './lpmedia';
import { agentAddValue, agentClaim } from './agentdrop';

export const GROWTH = parseAbi([
  'function types(address engine) view returns (uint8)',
  'function typeName(address engine, uint8 typeId) view returns (string)',
  'function values(address engine, uint8 typeId) view returns ((string value,string art,uint16 chanceBps,uint16 minParentLevel,uint32 claimLevel,uint8 reqType,uint8 reqValue)[])',
  'function xpOf(address engine, uint256 id) view returns (uint256)',
  'function levelOf(address engine, uint256 id) view returns (uint32)',
  'function inheritedRow(address engine, uint256 id) view returns (bytes)',
  'function claimable(address engine, uint256 id, uint8 typeId, uint8 valueId) view returns (bool)',
]);
export type GrowthValue = { value: string; art: string; chanceBps: number; minParentLevel: number; claimLevel: number; reqType: number; reqValue: number };
export type GrowthType = { id: number; name: string; values: GrowthValue[] };
export type GrowthToken = { xp: bigint; level: number; row: number[]; types: GrowthType[]; thresholds: number[]; claimable: { typeId: number; valueId: number; value: GrowthValue }[] };

export async function growthTypes(k: string, engine: Address, growth: Address): Promise<GrowthType[]> {
  const pub = readClient(k); const n = Number(await pub.readContract({ address: growth, abi: GROWTH, functionName: 'types', args: [engine] }));
  return Promise.all(Array.from({ length: n }, async (_, id) => {
    const [name, values] = await Promise.all([
      pub.readContract({ address: growth, abi: GROWTH, functionName: 'typeName', args: [engine, id] }),
      pub.readContract({ address: growth, abi: GROWTH, functionName: 'values', args: [engine, id] }),
    ]);
    return { id, name: name as string, values: (values as any[]).map(v => ({ ...v, chanceBps: Number(v.chanceBps), minParentLevel: Number(v.minParentLevel), claimLevel: Number(v.claimLevel), reqType: Number(v.reqType), reqValue: Number(v.reqValue) })) };
  }));
}

export async function loadGrowthToken(k: string, engine: Address, growth: Address, id: number, thresholds = [0, 100, 300, 600, 1000]): Promise<GrowthToken> {
  const pub = readClient(k); const I = BigInt(id);
  const [xp, level, raw, types] = await Promise.all([
    pub.readContract({ address: growth, abi: GROWTH, functionName: 'xpOf', args: [engine, I] }),
    pub.readContract({ address: growth, abi: GROWTH, functionName: 'levelOf', args: [engine, I] }),
    pub.readContract({ address: growth, abi: GROWTH, functionName: 'inheritedRow', args: [engine, I] }),
    growthTypes(k, engine, growth),
  ]);
  const row = Array.from((raw as string).replace(/^0x/, '').match(/../g) || [], x => parseInt(x, 16));
  const checks = await Promise.all(types.flatMap(t => t.values.map((v, i) =>
    pub.readContract({ address: growth, abi: GROWTH, functionName: 'claimable', args: [engine, I, t.id, i + 1] }).then((ok: boolean) => ({ typeId: t.id, valueId: i + 1, value: v, ok })).catch(() => ({ typeId: t.id, valueId: i + 1, value: v, ok: false })))));
  return { xp: xp as bigint, level: Number(level), row, types, thresholds, claimable: checks.filter(x => x.ok).map(({ ok: _, ...x }) => x) };
}

export function inheritedAttribution(row: number[], mom: number[], dad: number[]) {
  return row.map((v, i) => ({ value: v, parent: v && v === mom[i] && v !== dad[i] ? 'Mother' : v && v === dad[i] && v !== mom[i] ? 'Father' : v ? 'Shared / rolled' : 'None' }));
}

export async function createGrowthValue(k: string, engine: Address, growth: Address, typeId: number, typeName: string, value: string, image: File, rule: { kind: 'breeding' | 'level'; chanceBps: number; minParentLevel: number; level: number; reqType: number; reqValue: number }, onTx: (h: string) => void) {
  const art = await pinImage(image);
  const v: GrowthValue = { value, art, chanceBps: rule.kind === 'breeding' ? rule.chanceBps : 0, minParentLevel: rule.kind === 'breeding' ? rule.minParentLevel : 0, claimLevel: rule.kind === 'level' ? rule.level : 0, reqType: rule.reqType, reqValue: rule.reqValue };
  return agentAddValue(k, engine, growth, typeId, typeName, value, v, onTx);
}
export const claimGrowthValue = (k: string, engine: Address, growth: Address, id: number, typeId: number, valueId: number, onTx: (h: string) => void) => agentClaim(k, engine, growth, id, typeId, valueId, onTx);

export function layerPreview(base: string, arts: string[]) {
  const images = [base, ...arts.filter(Boolean)].map(u => `<image href="${u.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" x="0" y="0" width="350" height="350"/>`).join('');
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 350">${images}</svg>`);
}

export const mediaURL = (u: string) => u.replace(/^ipfs:\/\//, 'https://w3s.link/ipfs/');
export function growthHtml(g: GrowthToken) {
  const next = g.thresholds[g.level + 1]; const prev = g.thresholds[g.level] || 0;
  const pct = next == null ? 100 : Math.max(0, Math.min(100, (Number(g.xp) - prev) * 100 / (next - prev)));
  return `<div class="ag-growth"><div class="ag-xphead"><b>Level ${g.level} · ${g.xp} XP</b><span class="mut">${next == null ? 'Max level' : 'Next at ' + next}</span></div><div class="ag-xpbar"><i style="width:${pct}%"></i></div><div class="ag-traitgrid">${g.row.map((id, i) => `<div class="ag-trait"><span>${g.types[i]?.name || 'Trait ' + i}</span><b>${g.types[i]?.values[id - 1]?.value || '–'}</b></div>`).join('')}</div>${g.claimable.length ? `<button class="bbtn sm" data-agclaim>Claim ${g.claimable.length} unlocked trait${g.claimable.length == 1 ? '' : 's'}</button>` : '<span class="mut small">No new claimable traits</span>'}<details><summary>Trait unlocks (${g.types.reduce((n, t) => n + t.values.length, 0)})</summary>${g.types.flatMap(t => t.values.map((v, i) => `<div class="ag-unlock"><b>${t.name}: ${v.value}</b><span class="mut">${v.claimLevel ? 'Claim at level ' + v.claimLevel : 'Breeding · ' + v.chanceBps / 100 + '%'}${g.row[t.id] > i ? ' · owned' : ''}</span></div>`)).join('')}</details></div>`;
}
export function creatorGrowthHtml(types: GrowthType[]) {
 const opts = types.map(t => `<option value="${t.id}">${t.name} (${t.values.length})</option>`).join('');
 return `<details class="ag-growth"><summary>Creator · new traits</summary><p class="mut small">Pin trait art to IPFS, then append it with your creator wallet. Unlocked values affect the child’s image; death art overrides.</p><div class="lffrow"><label>Trait type<select data-gtype><option value="-1">New type</option>${opts}</select></label><label>New type name<input data-gtypename placeholder="Accessories"></label></div><label>Value name<input data-gname placeholder="Crown"></label><label>Artist layer<input type="file" accept="image/*" data-gart></label><label>Unlock by<select data-grule><option value="level">Level</option><option value="breeding">Breeding</option></select></label><div class="lffrow"><label>Level<input type="number" min="0" value="2" data-glevel></label><label>Breed chance %<input type="number" min="0" max="100" value="5" data-gchance></label><label>Min parent level<input type="number" min="0" value="0" data-gparent></label></div><label>Required parent trait <input data-greq placeholder="type:value (optional)"></label><button class="bbtn sm" data-agadd>Pin &amp; add trait</button></details>`;
}
