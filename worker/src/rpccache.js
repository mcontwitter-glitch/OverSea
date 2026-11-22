// Short edge cache for rarely-changing contract reads proxied through POST /rpc/:chain.
// Only plain eth_call {to, data} at 'latest' with a known view selector is cached; anything else goes straight to the RPCs.
// Supply counters get a short TTL so the mint page catches up quickly after a mint.
const TTL = {
  '0xb76b8ced': 60,  // phases()
  '0xb9186d7d': 60,  // priceOf(uint256)
  '0xd5abeb01': 60,  // maxSupply()
  '0x06fdde03': 300, // name()
  '0x95d89b41': 300, // symbol()
  '0x313ce567': 300, // decimals()
  '0x01ffc9a7': 300, // supportsInterface(bytes4)
  '0xe8a3d485': 60,  // contractURI()
  '0xf48b7d11': 15,  // mintedHere()
  '0x6430ab8c': 15,  // phaseMinted(uint256)
  '0x18160ddd': 15,  // totalSupply()
};
export function rpcCacheTtl(x) {
  if (x?.method !== 'eth_call' || !Array.isArray(x.params)) return 0;
  const [call, tag = 'latest'] = x.params;
  if (tag !== 'latest' || !call || typeof call !== 'object') return 0;
  if (Object.keys(call).some(k => k !== 'to' && k !== 'data' && k !== 'input')) return 0;
  const data = String(call.data || call.input || '').toLowerCase();
  if (!/^0x[0-9a-f]{8}/.test(data) || data.length > 2 + 8 + 64 * 4 || !/^0x[0-9a-fA-F]{40}$/.test(call.to || '')) return 0;
  return TTL[data.slice(0, 10)] || 0;
}
export async function rpcCacheKey(chain, x) {
  const call = x.params[0]; const raw = `${chain}|${String(call.to).toLowerCase()}|${String(call.data || call.input).toLowerCase()}`;
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return 'rpc:' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
