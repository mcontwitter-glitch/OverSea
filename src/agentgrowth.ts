// Unlocks and art are read from AgentGrowth; only a connected user's wallet writes.
import { parseAbi, type Address } from 'viem';
import { readClient } from './wallet';
import { esc } from './shell';
import { pinImage } from './lpmedia';
import { agentAddValue, agentClaim } from './agentdrop';

export const GROWTH = parseAbi([
 'function types(address e) view returns (uint8)', 'function typeName(address e,uint8 k) view returns (string)',
 'function values(address e,uint8 k) view returns ((string value,string art,uint16 chanceBps,uint16 minParentLevel,uint32 claimLevel,uint8 reqType,uint8 reqValue)[])',
 'function xpOf(address e,uint256 id) view returns (uint256)', 'function levelOf(address e,uint256 id) view returns (uint32)',
 'function inheritedRow(address e,uint256 id) view returns (bytes)', 'function claimable(address e,uint256 id,uint8 k,uint8 v) view returns (bool)',
 'function agentOf(uint256 id) view returns ((uint64 birth,uint64 lastFed,uint32 generation,bool dead,bool frozen,int256 score,uint256 latestChild,uint256 parentA,uint256 parentB))',
 'function originalRow(address e,uint256 n) view returns (bytes)', 'function idPrefix() view returns (uint128)', 'function art(address e) view returns ((string mediaBase,string mediaExt,string deathImage))', 'function ordinalOf(address e,uint256 id) view returns (uint256)', 'function ordinalOf(address e,uint256 id) view returns (uint256)',
 'function originalValues(address e,uint8 k) view returns (uint8)', 'function originalName(address e,uint8 k) view returns (string)',
 'function originalValue(address e,uint8 k,uint8 v) view returns (string)',
]);
export type GrowthValue = { value: string; art: string; chanceBps: number; minParentLevel: number; claimLevel: number; reqType: number; reqValue: number; id: number };
export type GrowthType = { id: number; name: string; values: GrowthValue[] };
export type GrowthToken = { xp: bigint; level: number; row: number[]; types: GrowthType[]; parents: bigint[]; source: string[]; claimable: { k: number; v: GrowthValue }[]; kit: Address; thresholds: number[] };
export const WORLD_ID = (id: bigint) => String(id & ((1n << 128n) - 1n));
export const mediaURL = (u: string) => u.replace(/^ipfs:\/\//, 'https://w3s.link/ipfs/');
const bytes = (s: string) => Array.from(s.slice(2).match(/../g) || [], x => parseInt(x, 16));

export async function growthTypes(k: string, engine: Address, growth: Address, kit: Address) {
 const pub = readClient(k); const n = Number(await pub.readContract({ address: growth, abi: GROWTH, functionName: 'types', args: [engine] }));
 return Array.from({ length: n }, async (_, i) => {
  const [name, values] = await Promise.all([pub.readContract({ address: growth, abi: GROWTH, functionName: 'typeName', args: [engine, i] }), pub.readContract({ address: growth, abi: GROWTH, functionName: 'values', args: [engine, i] })]);
  return { id: i, name: name as string, values: (values as GrowthValue[]).map(v => ({ ...v, chanceBps: Number(v.chanceBps), minParentLevel: Number(v.minParentLevel), claimLevel: Number(v.claimLevel), reqType: Number(v.reqType), reqValue: Number(v.reqValue), id: i })) };
 });
}
export async function rowOf(k: string, e: Address, growth: Address, kit: Address, id: bigint) {
 const raw = await readClient(k).readContract({ address: growth, abi: GROWTH, functionName: 'inheritedRow', args: [e, id] });
 const n = bytes(raw as string); if (n.length) return n;
 const ord = await readClient(k).readContract({ address: growth, abi: GROWTH, functionName: 'originalRow', args: [e, id] });
 return bytes(ord as string);
}
export async function loadGrowthTokenOld(k: string, e: Address, growth: Address, id: bigint, kit: Address, thresholds = [0,100,300,600,1000]): Promise<GrowthToken> {
 const pub = readClient(k); const [x,l,row,child,types] = await Promise.all([
  pub.readContract({address:growth,abi:GROWTH,functionName:'xpOf',args:[e,id]}),pub.readContract({address:growth,abi:GROWTH,functionName:'levelOf',args:[e,id]}),rowOf(k,e,growth,kit,id),pub.readContract({address:e,abi:GROWTH,functionName:'agentOf',args:[id]}),
  Promise.all(Array.from({length:Number(await pub.readContract({address:growth,abi:GROWTH,functionName:'types',args:[e]}))},async(_,i)=>{
   const [name,vs,base]=await Promise.all([pub.readContract({address:growth,abi:GROWTH,functionName:'typeName',args:[e,i]}),pub.readContract({address:growth,abi:GROWTH,functionName:'values',args:[e,i]}),pub.readContract({address:growth,abi:GROWTH,functionName:'originalValues',args:[e,i]})]);
   const vals: GrowthValue[]=(vs as any[]).map((v,n)=>({...v,chanceBps:Number(v.chanceBps),minParentLevel:Number(v.minParentLevel),claimLevel:Number(v.claimLevel),reqType:Number(v.reqType),reqValue:Number(v.reqValue),id:Number(base)+n+1}));
   for(let j=1;j<=Number(base);++j) vals.unshift({value:await pub.readContract({address:growth,abi:GROWTH,functionName:'originalValue',args:[e,i,j]}).catch(()=> ''),art:'',chanceBps:0,minParentLevel:0,claimLevel:0,reqType:0,reqValue:0,id:j});
   return{id:i,name:name as string,values:vals};
  }))]);
 const claimable = (await Promise.all(types.flatMap(t=>t.values.filter(v=>v.claimLevel).map(async v=>({k:t.id,v,ok:await pub.readContract({address:growth,abi:GROWTH,functionName:'claimable',args:[e,id,t.id,v.id]}).catch(()=>false)}))))).filter(x=>x.ok).map(({k,v})=>({k,v}));
 const a=String((child as any).parentA),b=String((child as any).parentB); const parents=(a==='0'||b==='0')?[]:[BigInt(a),BigInt(b)]; const source: string[]= [];
 if(parents.length){const [ma,mb]=await Promise.all([rowOf(k,e,growth,kit,parents[0]),rowOf(k,e,growth,kit,parents[1])]); row.forEach((v,i)=>source[i]=v===ma[i]&&v!==mb[i]?'Mother':v===mb[i]&&v!==ma[i]?'Father':'Shared / rolled');}
 return{xp:x as bigint,level:Number(l),row,types,parents,source,claimable,kit,thresholds};
}
export function createGrowthValue(k:string,e:Address,g:Address,type:number,name:string,value:string,file:File,r:{kind:'breeding'|'level';chanceBps:number;parent:number;level:number;reqType:number;reqValue:number},onTx:(h:string)=>void){
 const v={value:'',art:'',chanceBps:r.kind==='breeding'?r.chanceBps:0,minParentLevel:r.kind==='breeding'?r.parent:0,claimLevel:r.kind==='level'?r.level:0,reqType:r.reqType,reqValue:r.reqValue};
 return pinImage(file).then(art=>agentAddValue(k,e,g,type,name,value,{...v,art},onTx));
}
export const claimGrowthValue=(k:string,e:Address,g:Address,id:bigint,kidx:number,v:number,onTx:(h:string)=>void)=>agentClaim(k,e,g,id,kidx,v,onTx);
export function layerPreview(base:string,arts:string[]){const escXml=(u:string)=>mediaURL(u).replace(/&/g,'&amp;').replace(/"/g,'&quot;');return 'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 350"><image href="${escXml(base)}" width="350" height="350"/>${arts.filter(Boolean).map(u=>`<image href="${escXml(u)}" width="350" height="350"/>`).join('')}</svg>`);}
export async function loadGrowthToken(k:string,e:Address,g:Address,id:number,kit:Address,thresholds=[0,100,300,600,1000]) {const pre=await readClient(k).readContract({address:e,abi:GROWTH,functionName:'idPrefix'});return loadGrowthTokenOld(k,e,g,(pre as bigint)<<128n|BigInt(id),kit,thresholds);}
export function growthHtml(g:GrowthToken){const next=g.thresholds[g.level+1],prev=g.thresholds[g.level]||0;return `${g.parents.length?`<div class="mut small">Child of #${WORLD_ID(g.parents[0])} × #${WORLD_ID(g.parents[1])}</div>`:''}<div class="ag-xphead"><b>Level ${g.level} · ${g.xp} XP</b><span class="mut">${next==null?'Max level':'Next at '+next}</span></div><div class="ag-xpbar"><i style="width:${next==null?100:Math.max(0,Math.min(100,(Number(g.xp)-prev)*100/(next-prev)))}%"></i></div><div class="ag-traitgrid">${g.row.map((id,i)=>`<div class="ag-trait"><span>${esc(g.types[i]?.name||'Trait '+i)}${g.source.length?' · '+esc(g.source[i]):''}</span><b>${esc(g.types[i]?.values.find(v=>v.id===id)?.value||'–')}</b></div>`).join('')}</div><div data-preview></div>${g.claimable.length?`<button class="bbtn sm" data-agclaim>Claim ${g.claimable.length} unlocked trait${g.claimable.length===1?'':'s'}</button>`:'<span class="mut small">No new claimable traits</span>'}<details><summary>${g.types.reduce((n,t)=>n+t.values.length,0)} trait values</summary>${g.types.flatMap(t=>t.values.filter(v=>v.claimLevel||v.chanceBps).map(v=>`<div class="ag-unlock"><b>${esc(t.name)}: ${esc(v.value)}</b><span class="mut">${v.claimLevel?'Level '+v.claimLevel:'Breeding '+v.chanceBps/100%1+'%'}${g.row[t.id]===v.id?' · owned':''}</span></div>`)).join('')}</details>`}
export function creatorGrowthHtml(types:GrowthType[]){const opts=types.map(t=>`<option value="${t.id}">${esc(t.name)} (${t.values.length})</option>`).join('');return `<details class="ag-growth"><summary>Creator · new traits</summary><p class="mut small">Pin art to IPFS, then append it with your creator wallet. Unlocked values layer over the image in trait order; death art overrides.</p><div class="lffrow"><label>Trait type<select data-gtype><option value="-1">New type</option>${opts}</select></label><label>New type name<input data-gtypename placeholder="Accessories"></label></div><label>Value name<input data-gname placeholder="Crown"></label><label>Artist layer<input type="file" accept="image/*" data-gart></label><label>Unlock by<select data-grule><option value="level">Level</option><option value="breeding">Breeding</option></select></label><div class="lffrow"><label>Level<input type="number" min="1" value="2" data-glevel></label><label>Breed chance %<input type="number" min="0" max="100" value="5" data-gchance></label><label>Min parent level<input type="number" min="0" value="0" data-gparent></label></div><label>Required parent trait <input data-greq placeholder="type:value (optional)"></label><button class="bbtn sm" data-agadd>Pin &amp; add trait</button></details>`}
export async function tokenImage(k:string,e:Address){const uri=await readClient(k).readContract({address:e,abi:GROWTH,functionName:'tokenURI',args:[0n]});return uri as string;}
export async function loadComposite(k:string,e:Address,id:bigint){const uri=await readClient(k).readContract({address:e,abi:(await import('viem')).parseAbi(['function tokenURI(uint256) view returns (string)']),functionName:'tokenURI',args:[id]});return svgFromURI(uri as string);}
export function svgFromURI(uri:string){const data=uri.startsWith('data:application/json;base64,')?decodeURIComponent(escape(atob(uri.split(',')[1]))):uri;return (data.match(/"image":"([^"]+)/)||[])[1]||data;}
