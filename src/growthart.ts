export const mediaURL = (u: string) => u.replace(/^ipfs:\/\//, 'https://w3s.link/ipfs/');
export const WORLD_ID = (id: bigint) => String(id & ((1n << 128n) - 1n));
export function inheritedAttribution(row: number[], a: number[], b: number[]) { return row.map((value, i) => ({ value, parent: value && value === a[i] && value !== b[i] ? 'Mother' : value && value === b[i] && value !== a[i] ? 'Father' : value ? 'Shared / rolled' : 'None' })); }
export function decodeUri(uri: string): string { if (uri.startsWith('data:application/json;base64,')) { const dec = new TextDecoder().decode(Uint8Array.from(atob(uri.split(',')[1]), c => c.charCodeAt(0))); return JSON.parse(dec).image || ''; } return uri; }
export function gatewaySvg(uri: string): string {
 const image = decodeUri(uri); if (!image.startsWith('data:image/svg+xml,')) return image;
 const svg = decodeURIComponent(image.split(',')[1]);
 return 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/href="ipfs:\/\/([^"]+)"/g, (_, p) => `href="${mediaURL('ipfs://' + p.replaceAll('&amp;', '&')).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`));
}
