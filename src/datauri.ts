/** Decode on-chain tokenURIs (data:application/json;base64 and data:image/*) for MultiSea pages. */

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

/** Resolve a metadata image / tokenURI to something safe to put in <img src>. */
export function imageSrc(s: string | null | undefined, apiBase = ''): string {
  if (!s) return '';
  if (s.startsWith('data:image/')) return s;
  if (s.startsWith('data:application/json')) {
    const j = decodeDataJson(s);
    const img = j && typeof j.image === 'string' ? j.image : '';
    return img.startsWith('data:image/') || img.startsWith('https://') || img.startsWith('ipfs://') || img.startsWith('/') ? imageSrc(img, apiBase) : '';
  }
  if (s.startsWith('ipfs://')) return 'https://ipfs.filebase.io/ipfs/' + s.slice(7);
  if (s.startsWith('/media/')) return (apiBase || '') + s;
  if (/^(https:\/\/|\/img\/|\/media\/)/.test(s)) return s;
  return '';
}
