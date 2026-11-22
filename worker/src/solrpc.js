// Read-only Solana JSON-RPC proxy (POST /rpc/solana). Hedged across public RPCs so the collection page
// does not call solana-rpc.publicnode.com from the browser (CORS, rate limits, mixed content on previews).
import { rpcRace } from './rpcrace.js';

export const SOL_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
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

export async function solFanout(payload) {
  const big = JSON.stringify(payload).length > 4000;
  return rpcRace(SOL_RPCS, payload, big ? { timeoutMs: 8000, hedgeMs: 1500 } : {});
}
