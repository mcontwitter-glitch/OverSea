/** Decode on-chain tokenURIs (data:application/json;base64 and data:image/*) for MultiSea pages. */

const NFT_GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://gw.ipfs-lens.dev/ipfs/',
  'https://nftstorage.link/ipfs/',
];
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[kmiy][a-z2-7]{50,}|bae[a-z2-7]{50,})(\/.*)?$/i;
const defaultApi = () => (typeof location !== 'undefined' && /(?:^|\.)multisea\.io$/i.test(location.hostname) ? 'https://api.multisea.io' : '');

/** Path inside /ipfs/... if `s` is ipfs:// or a public gateway URL. */
export function ipfsPath(s: string | null | undefined): string {
  const m = String(s || '').trim().match(/^(?:ipfs:\/\/(?:ipfs\/)?|https?:\/\/[^/]+\/(?:ipfs\/)+)(.+?)(?:\?.*)?$/i);
  if (!m) return '';
  const path = m[1].replace(/^ipfs\//, '').replace(/\/+$/, '');
  return CID.test(path) ? path : '';
}

export function decodeDataJson(uri: string): Record<string, unknown> | null {
  if (!uri) return null;
  const m = uri.match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/i);
  if (!m) return null;
  try {
    const body = m[1] ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    const j = JSON.parse(body);
    return j && typeof j === 'object' ? j as Record<string, unknown> : null;
  } catch { return null; }
}

/** Resolve a metadata image / tokenURI to something safe to put in <img src>. IPFS URLs go through the MultiSea proxy. */
export function imageSrc(s: string | null | undefined, apiBase = ''): string {
  if (!s) return '';
  if (s.startsWith('data:image/')) return s;
  if (s.startsWith('data:application/json')) {
    const j = decodeDataJson(s);
    const img = j && typeof j.image === 'string' ? j.image : '';
    return img.startsWith('data:image/') || img.startsWith('https://') || img.startsWith('ipfs://') || img.startsWith('/') ? imageSrc(img, apiBase) : '';
  }
  const path = ipfsPath(s);
  if (path) {
    const api = (apiBase || defaultApi()).replace(/\/$/, '');
    return api ? `${api}/img/ipfs/${path}` : NFT_GATEWAYS[0] + path;
  }
  if (s.startsWith('/media/')) return (apiBase || '') + s;
  if (/^(https:\/\/|\/img\/|\/media\/)/.test(s)) return s;
  return '';
}

/** Cycle the MultiSea IPFS proxy, an optional CDN alt, then public gateways. Used as <img onerror>. */
export function nftImgFallback(el: HTMLImageElement) {
  const orig = el.dataset.img || el.getAttribute('src') || '';
  const path = ipfsPath(orig) || ipfsPath(el.currentSrc || el.src);
  const api = (el.dataset.imgApi || defaultApi()).replace(/\/$/, '');
  const list: string[] = [];
  if (path && api) list.push(`${api}/img/ipfs/${path}`);
  if (el.dataset.imgAlt) list.push(el.dataset.imgAlt);
  if (path) for (const g of NFT_GATEWAYS) list.push(g + path);
  const seen = new Set<string>();
  const alts = list.filter(u => u && !seen.has(u) && (seen.add(u), true));
  const cur = el.currentSrc || el.src;
  const i = alts.findIndex(u => u === cur);
  const next = i >= 0 ? alts[i + 1] : alts.find(u => u !== cur);
  if (!next) { el.onerror = null; el.classList.add('broken'); return; }
  el.src = next;
}

export function installNftImgFallback() {
  (window as any).__nftImgFb = nftImgFallback;
}
