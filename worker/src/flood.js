// Flood protection for api.multisea.io: Workers Rate Limiting binding (FLOOD, 2000 req / 10s per CF-Connecting-IP).
// WAF zone rules are not available on the current token/plan; this runs first in fetch().
export const FLOOD_PERIOD_SEC = 10;
export const FLOOD_LIMIT = 2000; // ~200 req/s; abuse ceiling, not a normal-page budget

// Public GET freshness. `fresh=1` is a revalidate hint for the fetch wrapper (it still
// falls back to the last good copy); it does not disable caching of the path itself.
export function edgeTtl(url, req) {
  if (req?.method && req.method !== 'GET') return 0;
  const p = url.pathname;
  if (p.startsWith('/auth/') || p.startsWith('/admin/') || p === '/profile/nfts' || p.startsWith('/profile/link') || p.startsWith('/launchpad/mine') || p.startsWith('/launchpad/reveal-uri') || p.startsWith('/rpc/')) return 0;
  if (p.startsWith('/activity/')) return 30;
  if (p === '/islands/wallet-nfts') return 30;
  if (p === '/health') return 30;
  if (/^\/owners\/[a-z0-9-]+$/.test(p)) return 60;
  if (/^\/btc\/ord\/mainnet\/r\/inscription\/[0-9a-f]{64}i\d+$/.test(p)) return 60;
  if (/^\/os\/[^/]+\/stats$/.test(p)) return 60;
  if (/^\/os\/[^/]+\/(listings|items)$/.test(p)) return 30;
  if (p === '/collections' || /^\/collections\/[^/]+$/.test(p)) return 30;
  if (p === '/profiles' || p.startsWith('/profiles/')) return 30;
  if (p === '/wallets/nfts' || /^\/wallet\/[^/]+\/nfts$/.test(p)) return 30;
  if (/^\/foot\/\d+\/nfts$/.test(p)) return 30;
  if (p === '/launchpad/drops' || /^\/launchpad\/drops\/[^/]+$/.test(p) || p === '/launchpad/holder-collections' || p === '/launchpad/solana') return 30;
  if (/^\/profile\/0x[0-9a-fA-F]{40}$/.test(p)) return 30;
  if (/^\/profile\/wallets\/[^/]+$/.test(p)) return 30;
  if (/^\/quests\/0x[0-9a-fA-F]{40}$/.test(p)) return 30;
  if (p === '/bridge/collections') return 30;
  if (p.endsWith('/listings') || p.endsWith('/best')) return 30;
  return 0;
}

// Strip `fresh=1` so a refresh writes the same cache entry everyone else reads.
export function edgeCacheKey(url) {
  const u = new URL(url, 'https://cache.multisea');
  u.searchParams.delete('fresh');
  return new Request('https://cache.multisea/edge:' + u.pathname + u.search);
}

/** Returns a 429 Response when the IP is over the flood cap; null when the request may proceed. CORS headers (H) are attached so browsers on allowed origins still read the body. */
export async function floodBlock(env, req, H = {}) {
  if (!env?.FLOOD?.limit) return null;
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const { success } = await env.FLOOD.limit({ key: ip });
  if (success) return null;
  return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(FLOOD_PERIOD_SEC), ...H } });
}
