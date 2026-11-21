// GET /onchain-uri/<collectionId>/<tokenId>
// Spoke (non-home) tokenURI points here. We eth_call previewURI/tokenURI on the home-chain
// drop and return the decoded JSON (image is a data: URI). Marketplaces that fetch this
// HTTPS URL will render the art; the spoke itself is not fully on-chain.
import { createPublicClient, http, parseAbi } from 'viem';

const ABI = parseAbi([
  'function previewURI(uint256 id) view returns (string)',
  'function tokenURI(uint256 id) view returns (string)',
]);

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' } });
}

function decodeDataJson(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const m = uri.match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/i);
  if (!m) return null;
  try {
    const body = m[1] ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    return JSON.parse(body);
  } catch { return null; }
}

export async function handleOnchainUri(req, env, url, { chains, kv }) {
  const p = url.pathname.split('/').filter(Boolean); // onchain-uri, cid, id
  if (p[0] !== 'onchain-uri' || p.length < 3) return null;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } });
  if (req.method !== 'GET') return jsonRes({ error: 'method' }, 405);
  let cid = p[1]; if (!cid.startsWith('0x')) cid = '0x' + cid;
  if (!/^0x[0-9a-fA-F]{64}$/.test(cid)) return jsonRes({ error: 'bad collection id' }, 400);
  const id = Number(p[2].replace(/\.json$/, ''));
  if (!Number.isInteger(id) || id < 1) return jsonRes({ error: 'bad token id' }, 400);
  const rec = await kv?.get('onchaincid:' + cid.toLowerCase(), 'json').catch(() => null);
  if (!rec?.home || !rec?.homeChain) return jsonRes({ error: 'unknown collection' }, 404);
  const c = chains[rec.homeChain];
  if (!c?.rpc) return jsonRes({ error: 'no rpc for home chain' }, 502);
  const pc = createPublicClient({ transport: http(c.rpc) });
  let uri = '';
  try {
    uri = await pc.readContract({ address: rec.home, abi: ABI, functionName: 'previewURI', args: [BigInt(id)] });
  } catch {
    try { uri = await pc.readContract({ address: rec.home, abi: ABI, functionName: 'tokenURI', args: [BigInt(id)] }); }
    catch (e) { return jsonRes({ error: 'tokenURI failed', detail: String(e?.shortMessage || e?.message || e).slice(0, 200) }, 502); }
  }
  const meta = decodeDataJson(uri);
  if (meta) return jsonRes(meta);
  if (typeof uri === 'string' && uri.startsWith('{')) { try { return jsonRes(JSON.parse(uri)); } catch {} }
  return jsonRes({ error: 'home tokenURI was not on-chain JSON', tokenURI: String(uri).slice(0, 120) }, 502);
}
