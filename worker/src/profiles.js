const MEDIA = /^\/media\/[0-9a-f]{64}\.(webp|png|jpg|gif)$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;
const ID = /^\d{1,78}$/;
const cleanText = (s, n) => String(s || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

export function makeProfiles({ CFG, lc, bad, ADDR, requireSession, rpcFanout }) {
  const key = a => 'profile:' + lc(a);
  async function one(env, address) {
    const r = await env.COLLECTIONS.get(key(address), 'json');
    return r ? { address: lc(address), name: cleanText(r.name, 24), avatar: typeof r.avatar === 'string' ? r.avatar : '', nft: r.nft || null, updatedAt: r.updatedAt } : { address: lc(address), name: '', avatar: '', nft: null };
  }
  async function owned(chain, token, id, address) {
    const c = CFG.chains[chain]; if (!c || !ADDR.test(token) || !ID.test(String(id))) bad('invalid NFT');
    const out = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: '0x6352211e' + BigInt(id).toString(16).padStart(64, '0') }, 'latest'] });
    const result = Array.isArray(out) ? out[0]?.result : out?.result;
    if (!result || result.length < 66 || lc('0x' + result.slice(-40)) !== lc(address)) bad('connected wallet does not own this NFT', 403);
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
        await owned(b.nft.chain, b.nft.contract, b.nft.id, s.address);
        avatar = String(b.nft.image || ''); if (!/^https:\/\//.test(avatar) && !MEDIA.test(avatar)) bad('NFT image must be a verified media or HTTPS URL');
        nft = { chain: String(b.nft.chain), contract: lc(b.nft.contract), id: String(b.nft.id) };
      } else if (b.avatar) { avatar = String(b.avatar); if (!MEDIA.test(avatar)) bad('invalid profile image'); }
      const rec = { address: lc(s.address), name, avatar, nft, updatedAt: Date.now() };
      await env.COLLECTIONS.put(key(s.address), JSON.stringify(rec));
      if (old.name && old.name.toLowerCase() !== name.toLowerCase()) await env.COLLECTIONS.delete('profile:name:' + old.name.toLowerCase() + ':' + lc(s.address));
      if (name) await env.COLLECTIONS.put('profile:name:' + name.toLowerCase() + ':' + lc(s.address), '1');
      return { ok: true, profile: rec };
    }
  };
}
