// Solana NFTs for the profile grid. MultiSea's Solana NFTs are Metaplex Core assets (one account each, not SPL tokens),
// so getTokenAccountsByOwner does not see them, and the public RPCs refuse getProgramAccounts. Two routes:
//  1. MultiSea collections (Island's …): GET /wallet/<sol>/nfts on the Worker, which reads every PDA server-side and
//     caches the owner map. (A browser scan through POST /rpc/solana used to miss holdings when publicnode rate-limited
//     the Worker and the official RPC 403'd Cloudflare IPs.) If that API is down, the same PDA read is done here as a
//     fallback, 10 accounts per request.
//  2. Everything else (other Core collections, big MultiSea collections): the wallet's recent transactions are scanned for
//     Core accounts it still owns. Covers NFTs received or minted recently; very old holdings of other collections need an
//     indexer (DAS), which we don't use.
import { PublicKey } from '@solana/web3.js';
import { solConn } from './solwallet';
import { readClient, API } from './wallet';
import CFG from '../config/collections.json';
import LP from '../config/launchpad.json';

export type SolNft = { chain: 'solana'; contract: string; id: string; name: string; image: string | null; standard: 'mpl-core'; collection?: string; msSlug?: string; href?: string };
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const ENV = (import.meta as any).env || {};
const PROGRAM = new PublicKey(ENV.VITE_SOLANA_OMNI_ID || (LP as any).solana?.programId || (ENV.VITE_SOLANA_RPC ? 'Abu55rcZKUwUvuMDbpNrHy28RF9A8PBasZa5BGGNWiA7' : 'ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH'));
const ENUM_MAX = 400; // read every piece of MultiSea collections up to this size (≤ 40 requests)
const HISTORY = 40;
const te = new TextEncoder();
const hex32 = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map(x => parseInt(x, 16)));
const le32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds as any, PROGRAM)[0];
const COLS = (CFG as any).collections.filter((c: any) => (c.deployments || []).length > 1 && c.escrow);

/** AssetV1: key u8 (1) | owner 32 | update authority (u8 tag: 0 none, 1 address, 2 collection) [+32] | name | uri */
export function parseAsset(d: Uint8Array) {
  if (d[0] !== 1 || d.length < 38) return null;
  const owner = new PublicKey(d.slice(1, 33)); let o = 33; const tag = d[o++]; let collection: string | undefined;
  if (tag === 1 || tag === 2) { const k = new PublicKey(d.slice(o, o + 32)).toBase58(); if (tag === 2) collection = k; o += 32; }
  const str = () => { const n = d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); o += 4; const s = new TextDecoder().decode(d.slice(o, o + n)); o += n; return s; };
  try { const name = str(), uri = str(); return { owner, collection, name, uri }; } catch { return null; }
}
async function cidOf(c: any): Promise<string | null> {
  const k = 'msea-cid:' + c.slug; const hit = localStorage.getItem(k); if (hit) return hit;
  const orig = c.deployments.find((d: any) => d.original) || c.deployments[0];
  const ABI = [{ type: 'function', name: 'collectionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }] as const;
  const cid = await (readClient(orig.chain) as any).readContract({ address: orig.address, abi: ABI, functionName: 'collectionId' }).catch(() => null);
  if (cid) localStorage.setItem(k, cid); return cid;
}
const ipfs = (u: string) => (u.startsWith('ipfs://') ? 'https://ipfs.filebase.io/ipfs/' + u.slice(7) : u);

export async function solanaNfts(owner: string, fresh = false): Promise<{ nfts: SolNft[]; note: string }> {
  const ck = 'msea-solnfts:' + owner;
  if (!fresh) try { const c = JSON.parse(sessionStorage.getItem(ck) || 'null'); if (c && Date.now() - c.t < 300_000) return c.v; } catch {}
  const me = new PublicKey(owner); const out = new Map<string, SolNft>(); const notes: string[] = [];
  // 1. MultiSea collections registered on Solana (Worker first, local PDA read if the API is down)
  let fromApi = false;
  try {
    const r = await fetch(`${String(API).replace(/\/$/, '')}/wallet/${owner}/nfts${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (r.ok) {
      const j = await r.json();
      for (const n of j.nfts || []) {
        if (n.chain && n.chain !== 'solana') continue;
        const id = String(n.id), slug = n.collection || n.msSlug, addr = n.contract;
        out.set((slug && id) ? id + slug : addr, { chain: 'solana', contract: addr, id, name: n.name || (slug ? `${slug} #${id}` : id), image: n.image || (slug ? `/img/${slug}/s/${id}.webp` : null), standard: 'mpl-core', collection: slug, msSlug: slug, href: n.href || (slug ? `/c/${slug}?item=${id}` : `https://solscan.io/token/${addr}`) });
      }
      fromApi = true;
      if (Array.isArray(j.notes)) notes.push(...j.notes.filter(Boolean));
    }
  } catch { /* fall back to a direct PDA read */ }
  const ours = new Map<string, { c: any; cid: string }>(); // collection PDA -> config
  await Promise.all(COLS.map(async (c: any) => { const cid = await cidOf(c); if (cid) ours.set(pda([te.encode('Collection'), hex32(cid)]).toBase58(), { c, cid }); }));
  if (!fromApi) try {
    const live = [...ours.entries()]; const info = live.length ? await solConn.getMultipleAccountsInfo(live.map(([k]) => new PublicKey(k))) : [];
    for (const [i, [, { c, cid }]] of live.entries()) {
      if (!info[i]) continue; // not on Solana yet
      const n = Number(c.supply || 0), start = Number(c.idStart ?? 1);
      if (n > ENUM_MAX) continue; // big collections: history scan below
      const ids = Array.from({ length: n }, (_, j) => start + j);
      const accs = await solConn.getMultipleAccountsInfo(ids.map(id => pda([te.encode('Asset'), hex32(cid), le32(id)])));
      accs.forEach((a, j) => { if (!a) return; const p = parseAsset(a.data); if (!p?.owner.equals(me)) return; const id = ids[j];
        out.set(String(id) + c.slug, { chain: 'solana', contract: pda([te.encode('Asset'), hex32(cid), le32(id)]).toBase58(), id: String(id), name: p.name || `${c.name} #${id}`, image: `/img/${c.slug}/s/${id}.webp`, standard: 'mpl-core', collection: c.slug, msSlug: c.slug, href: `/c/${c.slug}?item=${id}` }); });
    }
  } catch { notes.push('Couldn’t load MultiSea Solana NFTs; refresh to retry.'); }
  // 2. Recent history: Core accounts touched by the wallet's last transactions that it still owns
  try {
    const sigs = await solConn.getSignaturesForAddress(me, { limit: HISTORY });
    const cand = new Set<string>();
    for (let i = 0; i < sigs.length; i += 5) {
      const txs = await Promise.all(sigs.slice(i, i + 5).filter(s => !s.err).map(s => solConn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)));
      for (const t of txs) { if (!t) continue; const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }).keySegments().flat();
        if (!keys.some(k => k.equals(CORE))) continue; keys.forEach(k => { if (!k.equals(me) && !k.equals(CORE)) cand.add(k.toBase58()); }); }
    }
    const list = [...cand].slice(0, 200).map(k => new PublicKey(k));
    const accs = list.length ? await solConn.getMultipleAccountsInfo(list) : [];
    const extra: SolNft[] = [];
    accs.forEach((a, j) => {
      if (!a || !a.owner.equals(CORE)) return; const p = parseAsset(a.data); if (!p?.owner.equals(me)) return;
      const addr = list[j].toBase58(); const m = p.collection ? ours.get(p.collection) : undefined; const id = (p.name.match(/#\s*(\d+)\s*$/) || [])[1];
      if (m && id) { const key = id + m.c.slug; if (!out.has(key)) out.set(key, { chain: 'solana', contract: addr, id, name: p.name, image: `/img/${m.c.slug}/s/${id}.webp`, standard: 'mpl-core', collection: m.c.slug, msSlug: m.c.slug, href: `/c/${m.c.slug}?item=${id}` }); return; }
      const n: SolNft = { chain: 'solana', contract: addr, id: id || addr.slice(0, 6), name: p.name, image: null, standard: 'mpl-core', collection: p.collection, href: `https://solscan.io/token/${addr}` };
      (n as any).uri = p.uri; extra.push(n); out.set(addr, n);
    });
    await Promise.all(extra.slice(0, 12).map(async n => { try { const u = (n as any).uri; if (!/^(https:|ipfs:)/.test(u)) return; const j = await fetch(ipfs(u), { signal: AbortSignal.timeout(6000) }).then(r => r.json()); if (typeof j.image === 'string') n.image = ipfs(j.image); } catch {} delete (n as any).uri; }));
    extra.forEach(n => delete (n as any).uri);
  } catch { notes.push('Couldn’t scan recent Solana activity; refresh to retry.'); }
  const v = { nfts: [...out.values()], note: notes.join(' ') };
  try { sessionStorage.setItem(ck, JSON.stringify({ t: Date.now(), v })); } catch {}
  return v;
}
