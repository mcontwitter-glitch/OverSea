// Read-only Solana JSON-RPC proxy (POST /rpc/solana). Hedged across public RPCs so the collection page
// does not call solana-rpc.publicnode.com from the browser (CORS, rate limits, mixed content on previews).
// Cloudflare egress often cannot reach those RPCs in the default 3s window (getMultipleAccounts then
// surfaced as HTTP 500 and a Chrome "Failed to load resource" line). Heavy methods get a longer timeout;
// if every URL still fails the proxy returns a JSON-RPC error body with HTTP 200 so the page can fall
// back to publicnode from the browser without a console 500.
// Use the same fallback list as "Turn Solana on" (solswitch.js solRpcList): publicnode rate-limits
// Cloudflare IPs (HTTP 429) and api.mainnet-beta.solana.com often 403s them, which made the profile's
// Solana NFT scan (many getMultipleAccounts) return nothing.
import { rpcRace } from './rpcrace.js';
import { solRpcList } from './solswitch.js';

export const SOL_RPCS = solRpcList({ solana: { rpc: 'https://solana-rpc.publicnode.com' } });
export const SOL_HEAVY = new Set(['getMultipleAccounts', 'getProgramAccounts', 'getTransaction', 'getBlock', 'getBlocks']);
export const SOL_HEAVY_TIMEOUT_MS = 8000, SOL_HEAVY_HEDGE_MS = 600;
export const SOL_READ = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getBlockHeight', 'getLatestBlockhash',
  'getRecentBlockhash', 'getSlot', 'getEpochInfo', 'getVersion', 'getHealth', 'getTransaction',
  'getSignaturesForAddress', 'getSignatureStatuses', 'getTokenAccountsByOwner', 'getProgramAccounts',
  'getMinimumBalanceForRentExemption', 'getFeeForMessage', 'getRecentPrioritizationFees',
  'simulateTransaction', 'isBlockhashValid', 'getBlock', 'getBlocks', 'getFirstAvailableBlock',
  'getAddressLookupTable', 'getTokenAccountBalance', 'getTokenSupply', 'getInflationReward',
]);

export function solAllowed(calls) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 20) return 'bad batch';
  for (const x of calls) if (!SOL_READ.has(x?.method)) return 'method not allowed: ' + String(x?.method || '').slice(0, 40);
  return null;
}

export function solFetch(u, init) {
  return fetch(u, { ...init, headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; MultiSea/1.0; +https://multisea.io)', ...(init?.headers || {}) } });
}

export function solRaceOpts(payload, extra = {}) {
  const methods = (Array.isArray(payload) ? payload : [payload]).map(x => x?.method);
  const heavy = methods.some(m => SOL_HEAVY.has(m)) || JSON.stringify(payload).length > 4000;
  return heavy
    ? { timeoutMs: SOL_HEAVY_TIMEOUT_MS, hedgeMs: SOL_HEAVY_HEDGE_MS, fetchImpl: solFetch, ...extra }
    : { fetchImpl: solFetch, ...extra };
}

export function solRpcError(payload, err) {
  const msg = String(err?.message || err).slice(0, 200);
  const wrap = id => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: msg } });
  return Array.isArray(payload) ? payload.map(x => wrap(x?.id)) : wrap(payload?.id);
}

export async function solFanout(payload, extra = {}) {
  return rpcRace(SOL_RPCS, payload, solRaceOpts(payload, extra));
}
