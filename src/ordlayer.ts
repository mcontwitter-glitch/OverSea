// Bitcoin Ordinals as one more chain in the unified collection page (/c/<slug>).
// Turned on per collection by `ordinals` in config/collections.json (or the Worker collection override, set by an admin or
// a Bitcoin Ordinals launchpad drop): { enabled: true, collection: "<ord collection slug>" } and/or inscriptions: ["<id>i0", ...].
// `demo` lets a collection show MOCKED signet Ordinals with ?demo=1 (clearly labelled DEMO); it never marks real inscriptions.
import * as D from './btc/data';
import { demoOn, demoListings, demoHoldings } from './btc/demo';
export type OrdCfg = { enabled?: boolean; collection?: string; inscriptions?: string[]; demo?: { collection: string } };
export type OrdItem = { iid: string; num: number | null; name: string; attrs: [string, string][]; owner: string; priceSats: number | null; txid?: string; createdAt?: number };
export type OrdLayer = { demo: boolean; net: D.Net; collection: string; items: OrdItem[]; btcUsd: number | null };
const NET = (): D.Net => (D.getNet() === 'mainnet' && !D.mainnetOn() ? 'signet' : D.getNet());
const attrsOf = (a: any[] = []): [string, string][] => a.filter(x => x?.trait_type).map(x => [String(x.trait_type), String(x.value)]);
async function meta(id: string) { try { const i = await D.inscription(id); return { num: i.num ?? null, name: i.name, attrs: attrsOf(i.attributes), owner: i.address || '' }; } catch { return null; } }
export const ordEnabled = (c?: OrdCfg | null) => !!(c && (c.enabled && (c.collection || c.inscriptions?.length)));
export const ordDemo = (c?: OrdCfg | null) => !!(c?.demo && demoOn(NET()));
export async function loadOrdLayer(c: OrdCfg): Promise<OrdLayer | null> {
  const demo = !ordEnabled(c) && ordDemo(c); if (!ordEnabled(c) && !demo) return null;
  const net = demo ? NET() : D.getNet(); const btcUsd = await D.btcUsd().catch(() => null);
  if (demo) {
    const ls = demoListings(net); const held = (await demoHoldings('demo')).items;
    const base: OrdItem[] = [...ls.map(l => ({ iid: l.inscriptionId, num: null, name: l.name || '', attrs: [], owner: l.seller, priceSats: l.priceSats, txid: l.txid, createdAt: l.createdAt })),
      ...held.map(h => ({ iid: h.id, num: h.num, name: h.name, attrs: [], owner: 'tb1p-demo-holder', priceSats: null }))];
    await Promise.all(base.map(async b => { const m = await meta(b.iid); if (m) { b.attrs = m.attrs; b.num ??= m.num; } }));
    return { demo, net, collection: c.demo!.collection, items: base, btcUsd };
  }
  const ids = new Set(c.inscriptions || []); const items: OrdItem[] = [];
  if (c.collection) { const all = await D.collItems(c.collection).catch(() => []); for (const x of all.slice(0, 500)) { ids.delete(x.id); items.push({ iid: x.id, num: x.num ?? null, name: x.meta?.name || `#${x.num}`, attrs: attrsOf(x.meta?.attributes), owner: x.address || '', priceSats: null }); } }
  for (const id of ids) { const m = await meta(id); items.push({ iid: id, num: m?.num ?? null, name: m?.name || id.slice(0, 8), attrs: m?.attrs || [], owner: m?.owner || '', priceSats: null }); }
  const ls = await D.listings(net, c.collection ? { collection: c.collection } : {}).catch(() => [] as D.Listing[]);
  for (const l of ls) { const it = items.find(i => i.iid === l.inscriptionId); if (it && (it.priceSats == null || l.priceSats < it.priceSats)) Object.assign(it, { priceSats: l.priceSats, txid: l.txid, createdAt: l.createdAt, owner: l.seller }); }
  return { demo, net, collection: c.collection || '', items, btcUsd };
}
export const ordThumb = (iid: string, alt: string) => `<img class="ordimg" src="${D.contentUrl(iid)}" alt="${alt}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${D.previewUrl(iid)}'">`;
export { D };
