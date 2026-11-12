export const mediaURL = (u: string) => u.replace(/^ipfs:\/\//, 'https://w3s.link/ipfs/');
export const WORLD_ID = (id: bigint) => String(id & ((1n << 128n) - 1n));
export function inheritedAttribution(row: number[], a: number[], b: number[]) { return row.map((value, i) => ({ value, parent: value && value === a[i] && value !== b[i] ? 'Mother' : value && value === b[i] && value !== a[i] ? 'Father' : value ? 'Shared / rolled' : 'None' })); }
export function decodeUri(uri: string): string { if (uri.startsWith('data:application/json;base64,')) { const dec = new TextDecoder().decode(Uint8Array.from(atob(uri.split(',')[1]), c => c.charCodeAt(0))); return JSON.parse(dec).image || ''; } return uri; }
export function gatewaySvg(uri: string): string {
 const image = decodeUri(uri); if (!image.startsWith('data:image/svg+xml')) return image;
 const encoded = image.split(',')[1];
 const svg = image.startsWith('data:image/svg+xml;base64,') ? new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))) : decodeURIComponent(encoded);
 return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/href="ipfs:\/\/([^"]+)"/g, (_, p) => `href="${mediaURL('ipfs://' + p.replaceAll('&amp;', '&')).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`));
}
/** Byte-exact port of AgentGrowthArt.compose: no layers keeps the image; otherwise a 350x350 SVG of
 *  <image> tags (base first, then trait-type order) with & " < > XML-escaped, base64 data URI. */
export function contractLayeredSvg(base: string, arts: string[]): string {
 const layers = arts.filter(Boolean); if (!layers.length) return base;
 const x = (u: string) => u.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
 const img = (u: string) => `<image href="${x(u)}" width="350" height="350"/>`;
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 350">${img(base)}${layers.map(img).join('')}</svg>`;
 let bin = ''; for (const b of new TextEncoder().encode(svg)) bin += String.fromCharCode(b);
 return 'data:image/svg+xml;base64,' + btoa(bin);
}
