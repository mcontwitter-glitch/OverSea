// Unlocks and art are read from AgentGrowth; only a connected user's wallet writes.
import { parseAbi, type Address } from 'viem';
import { readClient } from './wallet';
import { esc } from './shell';
import { pinImage } from './lpmedia';
import { WORLD_ID, mediaURL, gatewaySvg, contractLayeredSvg } from './growthart';
import { agentAddValue, agentClaim } from './agentdrop';
import { keysFor, decodeRecord, recordsHtml, type Records } from './records8048';

export const GROWTH = parseAbi([
 'function types(address e) view returns (uint8)', 'function typeName(address e,uint8 k) view returns (string)',
 'function values(address e,uint8 k) view returns ((string value,string art,uint16 chanceBps,uint16 minParentLevel,uint32 claimLevel,uint8 reqType,uint8 reqValue)[])',
 'function config(address e) view returns ((uint16 mutationBps,uint16[6] xp,uint32[] levels))', 'function xpOf(address e,uint256 id) view returns (uint256)', 'function levelOf(address e,uint256 id) view returns (uint32)',
 'function inheritedRow(address e,uint256 id) view returns (bytes)', 'function claimable(address e,uint256 id,uint8 k,uint8 v) view returns (bool)',
 'function agentOf(uint256 id) view returns ((uint64 birth,uint64 lastFed,uint32 generation,bool dead,bool frozen,int256 score,uint256 latestChild,uint256 parentA,uint256 parentB))',
 'function originalRow(address e,uint256 n) view returns (bytes)', 'function idPrefix() view returns (uint128)',
 'function originalValues(address e,uint8 k) view returns (uint8)', 'function originalName(address e,uint8 k) view returns (string)',
 'function originalValue(address e,uint8 k,uint8 v) view returns (string)', 'function widthOf(address e) view returns (uint8)', 'function tokenURI(uint256) view returns (string)',
]);
export type GrowthValue = { value: string; art: string; chanceBps: number; minParentLevel: number; claimLevel: number; reqType: number; reqValue: number; id: number };
export type GrowthType = { id: number; name: string; values: GrowthValue[] };
export type GrowthToken = { records?: Records; xp: bigint; level: number; row: number[]; types: GrowthType[]; parents: bigint[]; source: string[]; claimable: { k: number; v: GrowthValue }[]; kit: Address; thresholds: number[]; image?: string };
const bytes = (s: string) => Array.from(s.slice(2).match(/../g) || [], x => parseInt(x, 16));

export async function growthTypes(k: string, engine: Address, growth: Address, kit: Address) {
 const pub = readClient(k); let n = Number(await pub.readContract({ address: growth, abi: GROWTH, functionName: 'types', args: [engine] })); if (!n) n = Number(await pub.readContract({address:growth,abi:GROWTH,functionName:'widthOf',args:[engine]}));
 return Array.from({ length: n }, async (_, i) => {
  const [name, values] = await Promise.all([pub.readContract({ address: growth, abi: GROWTH, functionName: 'typeName', args: [engine, i] }).catch(() => ""), pub.readContract({ address: growth, abi: GROWTH, functionName: 'values', args: [engine, i] })]);
  return { id: i, name: name || await pub.readContract({address:growth,abi:GROWTH,functionName:'originalName',args:[engine,i]}), values: (values as GrowthValue[]).map(v => ({ ...v, chanceBps: Number(v.chanceBps), minParentLevel: Number(v.minParentLevel), claimLevel: Number(v.claimLevel), reqType: Number(v.reqType), reqValue: Number(v.reqValue), id: i })) };
 });
}
export async function rowOf(k: string, e: Address, growth: Address, kit: Address, id: bigint) {
 const raw = await readClient(k).readContract({ address: growth, abi: GROWTH, functionName: 'inheritedRow', args: [e, id] });
 const n = bytes(raw as string); if (n.length) return n;
 const ord = await readClient(k).readContract({ address: growth, abi: GROWTH, functionName: 'originalRow', args: [e, id] });
 return bytes(ord as string);
}
async function loadFullToken(k: string, e: Address, growth: Address, id: bigint, kit: Address, thresholds = [0,100,300,600,1000]): Promise<GrowthToken> {
 const pub = readClient(k); const typeCount = Math.max(Number(await pub.readContract({address:growth,abi:GROWTH,functionName:'types',args:[e]})),Number(await pub.readContract({address:growth,abi:GROWTH,functionName:'widthOf',args:[e]}))); const [x,l,row,child,types] = await Promise.all([
  pub.readContract({address:growth,abi:GROWTH,functionName:'xpOf',args:[e,id]}),pub.readContract({address:growth,abi:GROWTH,functionName:'levelOf',args:[e,id]}),rowOf(k,e,growth,kit,id),pub.readContract({address:e,abi:GROWTH,functionName:'agentOf',args:[id]}),
  Promise.all(Array.from({length:typeCount},async(_,i)=>{
   const [name,vs,base]=await Promise.all([pub.readContract({address:growth,abi:GROWTH,functionName:'typeName',args:[e,i]}).catch(()=>pub.readContract({address:growth,abi:GROWTH,functionName:'originalName',args:[e,i]})),pub.readContract({address:growth,abi:GROWTH,functionName:'values',args:[e,i]}),pub.readContract({address:growth,abi:GROWTH,functionName:'originalValues',args:[e,i]})]);
   const vals: GrowthValue[]=(vs as any[]).map((v,n)=>({...v,chanceBps:Number(v.chanceBps),minParentLevel:Number(v.minParentLevel),claimLevel:Number(v.claimLevel),reqType:Number(v.reqType),reqValue:Number(v.reqValue),id:Number(base)+n+1}));
   for(let j=1;j<=Number(base);++j) vals.unshift({value:await pub.readContract({address:growth,abi:GROWTH,functionName:'originalValue',args:[e,i,j]}).catch(()=> ''),art:'',chanceBps:0,minParentLevel:0,claimLevel:0,reqType:0,reqValue:0,id:j});
   return{id:i,name:name as string,values:vals};
  }))]);
 thresholds = ((await pub.readContract({address:growth,abi:GROWTH,functionName:'config',args:[e]})) as any).levels.map(Number);
 const claimable = (await Promise.all(types.flatMap(t=>t.values.filter(v=>v.claimLevel).map(async v=>({k:t.id,v,ok:await pub.readContract({address:growth,abi:GROWTH,functionName:'claimable',args:[e,id,t.id,v.id]}).catch(()=>false)}))))).filter(x=>x.ok).map(({k,v})=>({k,v}));
 const a=String((child as any).parentA),b=String((child as any).parentB); const parents=(a==='0'||b==='0')?[]:[BigInt(a),BigInt(b)]; const source: string[]= [];
 if(parents.length){const [ma,mb]=await Promise.all([rowOf(k,e,growth,kit,parents[0]),rowOf(k,e,growth,kit,parents[1])]); row.forEach((v,i)=>source[i]=v===ma[i]&&v!==mb[i]?'Mother':v===mb[i]&&v!==ma[i]?'Father':'Shared / rolled');}
 return{xp:x as bigint,level:Number(l),row,types,parents,source,claimable,kit,thresholds};
}
export function createGrowthValue(k:string,e:Address,g:Address,type:number,name:string,value:string,file:File,r:{kind:'breeding'|'level';chanceBps:number;parent:number;level:number;reqType:number;reqValue:number},onTx:(h:string)=>void){
 const v={value:'',art:'',chanceBps:r.kind==='breeding'?r.chanceBps:0,minParentLevel:r.kind==='breeding'?r.parent:0,claimLevel:r.kind==='level'?r.level:0,reqType:r.reqType,reqValue:r.reqValue};
 if (r.chanceBps < 0 || r.chanceBps > 10000 || r.level < 1 || r.parent < 0 || r.reqType < 0 || r.reqType > 255 || r.reqValue < 0 || r.reqValue > 255) return Promise.reject(new Error('Unlock rule is outside the contract range.'));
 return pinImage(file).then(art=>agentAddValue(k,e,g,type,name,value,{...v,art},onTx));
}
export const claimGrowthValue=(k:string,e:Address,g:Address,id:bigint,kidx:number,v:number,onTx:(h:string)=>void)=>agentClaim(k,e,g,id,kidx,v,onTx);
/** Display copy of the exact contract image: same SVG as AgentGrowthArt.compose, ipfs:// hrefs via gateway. */
export function layerPreview(base:string,arts:string[]){const uri=contractLayeredSvg(base,arts);return uri.startsWith('data:image/svg+xml')?gatewaySvg(uri):mediaURL(uri);}
export async function loadGrowthToken(k:string,e:Address,g:Address,id:number,kit:Address,thresholds=[0,100,300,600,1000]) {const pre=await readClient(k).readContract({address:e,abi:GROWTH,functionName:'idPrefix'});return loadFullToken(k,e,g,((pre as bigint) << 128n) | BigInt(id),kit,thresholds);}
export function growthHtml(g: GrowthToken) {
 const next = g.thresholds[g.level + 1], prev = g.thresholds[g.level] || 0;
 return `<i hidden data-agready></i>${g.parents.length ? `<div class="mut small">Child of #${WORLD_ID(g.parents[0])} × #${WORLD_ID(g.parents[1])}</div>` : ''}<div class="ag-xphead"><b>Level ${g.level} · ${g.xp} XP</b><span class="mut">${next == null ? 'Max level' : 'Next at ' + next}</span></div><div class="ag-xpbar"><i style="width:${next == null ? 100 : Math.max(0, Math.min(100, (Number(g.xp) - prev) * 100 / (next - prev)))}%"></i></div><div class="ag-traitgrid">${g.row.map((id, i) => `<div class="ag-trait"><span>${esc(g.types[i]?.name || 'Trait ' + i)}${g.source.length ? ' · ' + esc(g.source[i]) : ''}</span><b>${esc(g.types[i]?.values.find(v => v.id === id)?.value || '–')}</b></div>`).join('')}</div>${g.image ? `<details open><summary>Layered NFT image</summary><img src="${g.image}" alt="Layered agent" width="350" height="350" style="display:block;width:100%;height:auto;aspect-ratio:1;object-fit:contain"></details>` : ''}${g.records ? recordsHtml(g.records) : ''}${g.claimable.length ? `<button class="bbtn sm" data-agclaim>Claim ${g.claimable.length} unlocked traits</button>` : '<span class="mut small">No new claimable traits</span>'}<details><summary>${g.types.reduce((n, t) => n + t.values.length, 0)} trait values</summary>${g.types.flatMap(t => t.values.filter(v => v.claimLevel || v.chanceBps).map(v => `<div class="ag-unlock"><b>${esc(t.name)}: ${esc(v.value)}</b><span class="mut">${v.claimLevel ? 'Level ' + v.claimLevel : 'Breeding ' + v.chanceBps / 100 + '%'}${g.row[t.id] === v.id ? ' · owned' : ''}</span></div>`)).join('')}</details>`;
}
export function creatorGrowthHtml(types: GrowthType[]) {
 return `<details class="ag-growth"><summary>Creator · new traits</summary><p class="mut small">Pin art to IPFS, then append it with your creator wallet. Layers follow trait type order; death art overrides.</p><div class="lffrow"><label>Type<select data-gtype><option value="-1">New type</option>${types.map(t => `<option value="${t.id}">${esc(t.name)} (${t.values.length})</option>`).join('')}</select></label><label>New type name<input data-gtypename></label></div><label>Value name<input data-gname></label><label>Artist layer<input type="file" accept="image/*" data-gart></label><label>Unlock by<select data-grule><option value="level">Level</option><option value="breeding">Breeding</option></select></label><div class="lffrow"><label>Level<input type="number" min="1" value="2" data-glevel></label><label>Chance %<input type="number" min="0" max="100" value="5" data-gchance></label><label>Min parent level<input type="number" min="0" value="0" data-gparent></label></div><label>Required parent trait<select data-greq><option value="255:0">None</option>${types.flatMap(t => t.values.map(v => `<option value="${t.id}:${v.id}">${esc(t.name)}: ${esc(v.value)}</option>`)).join('')}</select></label><button class="bbtn sm" data-agadd>Pin &amp; add trait</button></details>`;
}

export async function tokenId(k: string, e: Address, id: number) { const p = await readClient(k).readContract({ address: e, abi: GROWTH, functionName: 'idPrefix' }); return ((p as bigint) << 128n) | BigInt(id); }
export function demoGrowth(claimed = false): GrowthToken {
 const base = [
  { value: 'Background', orig: ['Night', 'Peach'], extra: 'Aurora', art: 'layer-aurora.svg' },
  { value: 'Hat', orig: ['Cap', 'Crown'], extra: 'Halo', art: 'layer-halo.svg' },
 ];
 const types: GrowthType[] = base.map((t,id) => ({ id, name: t.value, values: [...t.orig.map((value,j) => ({value,art:'',chanceBps:0,minParentLevel:0,claimLevel:0,reqType:0,reqValue:0,id:j+1})), {value:t.extra,art:t.art,chanceBps:0,minParentLevel:0,claimLevel:1,reqType:0,reqValue:0,id:3}] }));
 return { xp: 50n, level: 0, row: [claimed?3:1,1], types, parents: [], source: [], claimable: claimed?[]:[{k:0,v:types[0].values[2]}], kit: '0x0000000000000000000000000000000000000001', thresholds: [0,100,300,600,1000] };
}

export async function loadComposite(k: string, e: Address, id: bigint) { const uri = await readClient(k).readContract({ address: e, abi: GROWTH, functionName: 'tokenURI', args: [id] }); return gatewaySvg(uri as string); }

const RECORDS = parseAbi(['function metadata(uint256 id,string key) view returns (bytes)', 'function recordsOf(address e) view returns (address)']);
/** ERC-8048 records for one agent: tokenURI's metadata_contract (else growth.recordsOf), every key via metadata(). */
export async function loadRecords(k: string, e: Address, growth: Address, id: bigint, traitTypes: string[]): Promise<Records | null> {
 const pub = readClient(k);
 let contract: string | undefined;
 try { const uri = await pub.readContract({ address: e, abi: GROWTH, functionName: 'tokenURI', args: [id] }) as string; contract = JSON.parse(atob(uri.split(',')[1])).metadata_contract; } catch {}
 if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) contract = await pub.readContract({ address: growth, abi: RECORDS, functionName: 'recordsOf', args: [e] }).catch(() => undefined) as string | undefined;
 if (!contract || !(await pub.getCode({ address: contract as Address }).catch(() => undefined))) return null;
 const chainId = await pub.getChainId(); const keys = keysFor(chainId, traitTypes); const values: Records['values'] = {};
 await Promise.all(keys.map(async key => { values[key] = decodeRecord(key, await pub.readContract({ address: contract as Address, abi: RECORDS, functionName: 'metadata', args: [id, key] }).catch(() => '0x') as string); }));
 return { contract, chainId, values };
}
