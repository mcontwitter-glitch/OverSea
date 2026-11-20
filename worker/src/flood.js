// Flood protection for api.multisea.io: Workers Rate Limiting binding (FLOOD, 2000 req / 10s per CF-Connecting-IP).
// WAF zone rules are not available on the current token/plan; this runs first in fetch().
export const FLOOD_PERIOD_SEC = 10;
export const FLOOD_LIMIT = 2000; // ~200 req/s; must stay far above normal page loads

export function edgeTtl(url, req) {
  if (req?.method && req.method !== 'GET') return 0;
  if (url.searchParams.get('fresh') === '1') return 0;
  const p = url.pathname;
  if (p.startsWith('/auth/') || p.startsWith('/admin/') || p === '/profile/nfts' || p.startsWith('/launchpad/mine') || p.startsWith('/launchpad/reveal-uri') || p.startsWith('/rpc/')) return 0;
  if (p.startsWith('/activity/')) return 30;
  if (p === '/islands/wallet-nfts') return 30;
  if (p === '/health') return 15;
  if (/^\/os\/[^/]+\/stats$/.test(p)) return 60;
  if (/^\/os\/[^/]+\/(listings|items)$/.test(p)) return 30;
  if (p === '/collections' || /^\/collections\/[^/]+$/.test(p)) return 30;
  if (p === '/profiles' || p.startsWith('/profiles/')) return 15;
  if (/^\/wallet\/[^/]+\/nfts$/.test(p)) return 15;
  if (/^\/foot\/\d+\/nfts$/.test(p)) return 30;
  if (p === '/launchpad/drops' || /^\/launchpad\/drops\/[^/]+$/.test(p) || p === '/launchpad/holder-collections' || p === '/launchpad/solana') return 15;
  if (p.endsWith('/listings') || p.endsWith('/best')) return 30;
  return 0;
}

export function edgeCacheKey(url) { return new Request('https://cache.multisea/edge:' + url.pathname + url.search); }

/** Returns a 429 Response when the IP is over the flood cap; null when the request may proceed. CORS headers (H) are attached so browsers on allowed origins still read the body. */
export async function floodBlock(env, req, H = {}) {
  if (!env?.FLOOD?.limit) return null;
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const { success } = await env.FLOOD.limit({ key: ip });
  if (success) return null;
  return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(FLOOD_PERIOD_SEC), ...H } });
}
