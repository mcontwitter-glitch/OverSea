// GET /wallet/<solana>/nfts: MultiSea Solana copies (Metaplex Core PDAs) held by that wallet.
// The profile used to scan every PDA from the browser through POST /rpc/solana (10-account chunks).
// That burst hit publicnode 429s and the official RPC's 403 from Cloudflare, so the Solana tab was empty
// even when the copy was on-chain. This reads the small MultiSea collections once, caches the owner map,
// and returns the same shape as the EVM /wallet/<addr>/nfts gallery.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { solFanout } from './solrpc.js';
import { findPda, storePdaOf, b58 } from './solswitch.js';
import { SOL_ADDR } from './solanalink.js';
const MAINNET_PID = 'ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH';
const ENUM_MAX = 400;
const CID_ABI = parseAbi(['function collectionId() view returns (bytes32)']);
const S = s => new TextEncoder().encode(s);
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const hex32 = h => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g) || [], x => parseInt(x, 16));
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const coreOwner = d => (d && d[0] === 1 && d.length >= 33 ? b58(d.slice(1, 33)) : null);
const assetPda = (pid, cid, id) => findPda([S('Asset'), hex32(cid), le32(id)], pid);
const collectionPda = (pid, cid) => findPda([S('Collection'), hex32(cid)], pid);
const COLS = (CFG) => (CFG.collections || []).filter(c => (c.deployments || []).length > 1 && c.escrow && Number(c.supply || 0) > 0 && Number(c.supply) <= ENUM_MAX);

async function programIdOf(env) {
  const rec = await env.COLLECTIONS?.get('lp:solana', 'json').catch(() => null);
  if (rec?.programId) return rec.programId;
  return env.LP_NETWORK === 'testnet' ? null : MAINNET_PID;
}

export function makeSolWalletNfts({ CFG, rpcFanout, bad, solRpc = solFanout }) {
  const mem = new Map(); // slug -> { t, v }
  async function rpcMany(pubkeys) {
    const parts = []; for (let i = 0; i < pubkeys.length; i += 10) parts.push(pubkeys.slice(i, i + 10));
    const rs = new Array(parts.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(2, parts.length) }, async () => {
      while (i < parts.length) {
        const n = i++;
        const j = await solRpc({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [parts[n], { encoding: 'base64', commitment: 'confirmed' }] });
        const vals = j?.result?.value;
        if (!Array.isArray(vals) || vals.length !== parts[n].length) throw new Error('bad getMultipleAccounts');
        rs[n] = vals;
      }
    }));
    return rs.flat();
  }
  async function cidOf(c) {
    const orig = (c.deployments || []).find(d => d.original) || (c.deployments || [])[0];
    const chain = CFG.chains[orig?.chain];
    if (!orig?.address || !chain) throw new Error('no home chain');
    const data = encodeFunctionData({ abi: CID_ABI, functionName: 'collectionId' });
    const j = await rpcFanout(chain, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: orig.address, data }, 'latest'] });
    const raw = j?.result; if (!raw || raw === '0x') throw new Error('empty collectionId');
    return decodeFunctionResult({ abi: CID_ABI, functionName: 'collectionId', data: raw });
  }
  function decode(acc) {
    const raw = acc?.data?.[0]; if (!raw) return null;
    try { return coreOwner(raw instanceof Uint8Array ? raw : b64(typeof raw === 'string' ? raw : '')); } catch { return null; }
  }
  async function buildMap(env, c, pid) {
    const cid = await cidOf(c);
    const start = Number(c.idStart ?? 1), n = Number(c.supply || 0);
    const ids = Array.from({ length: n }, (_, i) => start + i);
    const col = collectionPda(pid, cid);
    const [colAcc] = await rpcMany([col]);
    if (!colAcc) return { slug: c.slug, cid, collection: col, items: [], missing: true, at: Date.now() };
    const keys = ids.map(id => assetPda(pid, cid, id));
    const accs = await rpcMany(keys);
    if (accs.length !== ids.length) throw new Error('incomplete Solana owner scan');
    const store = storePdaOf(pid);
    const items = ids.map((id, i) => {
      const owner = decode(accs[i]);
      return { id, mint: keys[i], owner: owner && owner !== store ? owner : (owner === store ? 'locked' : null) };
    });
    return { slug: c.slug, cid, collection: col, items, missing: false, at: Date.now() };
  }
  async function mapOf(env, c, pid, fresh) {
    const k = 'solowners:' + c.slug, now = Date.now();
    if (!fresh) {
      const m = mem.get(k); if (m && now - m.t < 300_000) return m.v;
      const edge = await caches.default.match(new Request('https://cache.multisea/' + k)).catch(() => null);
      if (edge) { const v = await edge.json(); mem.set(k, { t: now, v }); return v; }
      const kv = env.COLLECTIONS ? await env.COLLECTIONS.get(k, 'json').catch(() => null) : null;
      if (kv && now - (kv.at || 0) < 600_000) { mem.set(k, { t: now, v: kv }); return kv; }
    }
    const v = await buildMap(env, c, pid);
    mem.set(k, { t: Date.now(), v });
    const body = JSON.stringify(v);
    await caches.default.put(new Request('https://cache.multisea/' + k), new Response(body, { headers: { 'cache-control': 'public, max-age=60' } })).catch(() => {});
    if (env.COLLECTIONS) await env.COLLECTIONS.put(k, body, { expirationTtl: 3600 }).catch(() => {});
    return v;
  }
  return async (req, env, url, p, M) => {
    if (M !== 'GET' || p[0] !== 'wallet' || p[2] !== 'nfts' || p.length !== 3) return undefined;
    if (!SOL_ADDR.test(p[1])) return undefined;
    const address = p[1], want = url.searchParams.get('chain') || '', next = url.searchParams.get('next') || '';
    if (want && want !== 'solana') bad('unsupported chain');
    if (next) bad('bad cursor');
    const cache = caches.default, cacheReq = new Request('https://cache.multisea/wallet-sol-nfts/' + address + (url.searchParams.get('fresh') === '1' ? '?fresh=1' : ''));
    const hit = await cache.match(cacheReq);
    if (hit && url.searchParams.get('fresh') !== '1') { const j = await hit.json(); return { ...j, cached: true }; }
    const pid = await programIdOf(env);
    if (!pid) return { address, nfts: [], failed: [], notes: ['Solana is not on.'], at: Date.now() };
    const nfts = [], errors = [];
    const fresh = url.searchParams.get('fresh') === '1';
    for (const c of COLS(CFG)) {
      try {
        const m = await mapOf(env, c, pid, fresh);
        if (m.missing) continue;
        for (const it of m.items) {
          if (it.owner !== address) continue;
          nfts.push({
            chain: 'solana', contract: it.mint, id: String(it.id), name: `${c.name} #${it.id}`,
            collection: c.slug, image: `/img/${c.slug}/s/${it.id}.webp`, standard: 'mpl-core',
            msSlug: c.slug, href: `/c/${c.slug}?item=${it.id}`,
          });
        }
      } catch (e) { errors.push(`${c.name} on Solana: ${String(e.message || e).slice(0, 100)}`); }
    }
    const result = { address, nfts, failed: errors.length ? ['solana'] : [], notes: errors, at: Date.now() };
    await cache.put(cacheReq, new Response(JSON.stringify(result), { headers: { 'cache-control': `public, max-age=${errors.length ? 10 : 30}` } })).catch(() => {});
    return result;
  };
}
