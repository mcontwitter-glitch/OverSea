// CORS for browser calls from MultiSea origins (and localhost). solana-client is the extra header
// @solana/web3.js always sets on Connection requests; without it the /rpc/solana preflight fails.
export const CORS_ALLOW_HEADERS = 'content-type,authorization,solana-client,accept';

export function corsHeaders(req, env) {
  const o = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok ? {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': '86400',
    vary: 'origin',
  } : null;
}
