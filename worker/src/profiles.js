const MEDIA = /^\/media\/[0-9a-f]{64}\.(webp|png|jpg|gif)$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
const ID = /^\d{1,78}$/;
const cleanText = (s, n) => String(s || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
// MultiSea chains the profile gallery covers. OpenSea powers every one that has an openseaSlug;
// BNB has none, so it is reported under `unsupported` (client may fill via Insight).
const GALLERY_CHAINS = ['base', 'ethereum', 'bnb', 'apechain', 'robinhood'];

export function makeProfiles({ CFG, lc, bad, ADDR, requireSession, rpcFanout, osFetch }) {
  const key = a => 'profile:' + lc(a);
  const chains = CFG.chains;
  async function one(env, address) {
    const r = await env.COLLECTIONS.get(key(address), 'json');
    return r ? { address: lc(address), name: cleanText(r.name, 24), avatar: typeof r.avatar === 'string' ? r.avatar : '', nft: r.nft || null, updatedAt: r.updatedAt } : { address: lc(address), name: '', avatar: '', nft: null };
  }
  async function owned(chain, token, id, address, standard) {
    const c = CFG.chains[chain]; if (!c || !ADDR.test(token) || !ID.test(String(id))) bad('invalid NFT');
    const idHex = BigInt(id).toString(16).padStart(64, '0');
    const is1155 = /1155/i.test(String(standard || ''));
    if (is1155) {
      // balanceOf(address,uint256) — authoritative for ERC-1155 (ownerOf does not exist).
      const data = '0x00fdd58e' + lc(address).slice(2).padStart(64, '0') + idHex;
      const out = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] });
      const result = Array.isArray(out) ? out[0]?.result : out?.result;
      if (!result || BigInt(result) === 0n) bad('connected wallet does not own this NFT', 403);
      return;
    }
    const out = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: '0x6352211e' + idHex }, 'latest'] });
    const result = Array.isArray(out) ? out[0]?.result : out?.result;
    if (!result || result.length < 66 || lc('0x' + result.slice(-40)) !== lc(address)) bad('connected wallet does not own this NFT', 403);
  }
  async function accountNfts(env, address, chainKey, next) {
    const c = chains[chainKey]; if (!c?.openseaSlug) return { nfts: [], next: null, error: 'unsupported' };
    const qs = new URLSearchParams({ limit: '50' }); if (next) qs.set('next', next);
    for (let i = 0; i < 2; i++) {
      try {
        const r = await osFetch(env, `/chain/${c.openseaSlug}/account/${address}/nfts?${qs}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const j = await r.json();
          const nfts = (j.nfts || []).map(n => ({
            chain: chainKey, contract: lc(n.contract), id: String(n.identifier),
            name: n.name || null, collection: n.collection || n.collection_name || null,
            image: n.display_image_url || n.image_url || null,
            standard: (n.token_standard || '').toLowerCase() || null,
          }));
          return { nfts, next: j.next || null, error: null };
        }
        if (r.status !== 429 && r.status < 500) return { nfts: [], next: null, error: 'opensea ' + r.status };
        if (i) return { nfts: [], next: null, error: 'opensea ' + r.status };
      } catch (e) {
        if (i) return { nfts: [], next: null, error: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 60) };
      }
      await new Promise(r => setTimeout(r, 600));
    }
    return { nfts: [], next: null, error: 'unavailable' };
  }
  return {
    one,
    async handle(req, env, url, p, M, body) {
      if (p[0] === 'profiles' && M === 'GET') {
        const addresses = (url.searchParams.get('addresses') || '').split(',').filter(Boolean);
        if (!addresses.length || addresses.length > 100 || addresses.some(a => !ADDR.test(a))) bad('provide 1 to 100 valid addresses');
        const profiles = Object.fromEntries(await Promise.all([...new Set(addresses.map(lc))].map(async a => [a, await one(env, a)])));
        return { profiles };
      }
      // Session-scoped gallery of NFTs the signed-in wallet owns (OpenSea account endpoint, same source as /foot/<id>/nfts).
      if (p[0] === 'profile' && p[1] === 'nfts' && M === 'GET' && p.length === 2) {
        if (!env.OPENSEA_API_KEY || !osFetch) bad('server not configured', 503);
        const s = await requireSession(req, env);
        const want = url.searchParams.get('chain') || '';
        const next = url.searchParams.get('next') || '';
        if (next.length > 400) bad('bad cursor');
        const keys = want ? (GALLERY_CHAINS.includes(want) ? [want] : bad('unsupported chain')) : GALLERY_CHAINS;
        const unsupported = keys.filter(k => !chains[k]?.openseaSlug);
        const fetchKeys = keys.filter(k => chains[k]?.openseaSlug);
        // Single-chain + cursor: paginate that chain only. Multi-chain first page: fan out in parallel (no cursors).
        if (want && next && fetchKeys.length === 1) {
          const part = await accountNfts(env, s.address, want, next);
          return { address: s.address, nfts: part.nfts, next: part.next, failed: part.error ? [want] : [], unsupported, at: Date.now() };
        }
        const parts = await Promise.all(fetchKeys.map(k => accountNfts(env, s.address, k, null)));
        const nfts = parts.flatMap(x => x.nfts);
        const failed = fetchKeys.filter((k, i) => parts[i].error);
        const cursors = Object.fromEntries(fetchKeys.map((k, i) => [k, parts[i].next]).filter(([, n]) => n));
        return { address: s.address, nfts, next: null, cursors, failed, unsupported, at: Date.now() };
      }
      if (p[0] !== 'profile' || M !== 'POST' || p.length !== 1) return undefined;
      const s = await requireSession(req, env); const b = await body();
      const name = cleanText(b.name, 24); if (name && !NAME.test(name)) bad('display name must be 1-24 letters, numbers, spaces, dots, dashes or underscores');
      if (name) {
        const matches = await env.COLLECTIONS.list({ prefix: 'profile:name:' + name.toLowerCase() });
        if (matches.keys.some(k => k.name !== 'profile:name:' + name.toLowerCase() + ':' + lc(s.address))) bad('display name already in use', 409);
      }
      const old = await one(env, s.address);
      let avatar = '', nft = null;
      if (b.nft && typeof b.nft === 'object') {
        await owned(b.nft.chain, b.nft.contract, b.nft.id, s.address, b.nft.standard);
        avatar = String(b.nft.image || ''); if (!MEDIA.test(avatar)) bad('NFT image must use the MultiSea media path');
        nft = { chain: String(b.nft.chain), contract: lc(b.nft.contract), id: String(b.nft.id), ...(b.nft.standard ? { standard: String(b.nft.standard).toLowerCase() } : {}) };
      } else if (b.avatar) { avatar = String(b.avatar); if (!MEDIA.test(avatar)) bad('invalid profile image'); }
      const rec = { address: lc(s.address), name, avatar, nft, updatedAt: Date.now() };
      await env.COLLECTIONS.put(key(s.address), JSON.stringify(rec));
      if (old.name && old.name.toLowerCase() !== name.toLowerCase()) await env.COLLECTIONS.delete('profile:name:' + old.name.toLowerCase() + ':' + lc(s.address));
      if (name) await env.COLLECTIONS.put('profile:name:' + name.toLowerCase() + ':' + lc(s.address), '1');
      return { ok: true, profile: rec };
    }
  };
}
