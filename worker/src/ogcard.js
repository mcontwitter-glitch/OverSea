// 1200x630 share-card PNG for X/OG: banner (or token-art collage), avatar, name, floor, chain icons, MultiSea wordmark.
// Pure SVG rendered with resvg-wasm (images embedded as data URIs; resvg decodes PNG/JPEG/WebP/SVG).
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import WASM from '@resvg/resvg-wasm/index_bg.wasm';
import F600 from './og/inter-600.bin';
import F800 from './og/inter-800.bin';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode';
import WEBP_WASM from '@jsquash/webp/codec/dec/webp_dec.wasm';

const SITE = 'https://multisea.io';
let ready;
const init = () => (ready ||= initWasm(WASM));
let webpReady;
// resvg can't decode WebP (the site's thumbnails are .webp), so decode with libwebp and re-encode as a plain PNG.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u, c = 0xffffffff) => { for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export async function rgbaToPng(w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer); dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out; };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { png.set(p, o); o += p.length; } return png;
}
async function webpToPng(buf, max) {
  await (webpReady ||= initWebp(WEBP_WASM)); const im = await decodeWebp(buf);
  const src = new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), W = im.width, H = im.height;
  if (!max || (W <= max && H <= max)) return rgbaToPng(W, H, src);
  const k = max / Math.max(W, H), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k)), out = new Uint8Array(w * h * 4), s32 = new Uint32Array(src.buffer, src.byteOffset, W * H), o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) { const sy = Math.min(H - 1, Math.floor(y / k)) * W; for (let x = 0; x < w; x++) o32[y * w + x] = s32[sy + Math.min(W - 1, Math.floor(x / k))]; }
  return rgbaToPng(w, h, out);
}
const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' };
async function dataUri(url, ttl = 86400, max = 0) {
  if (!url) return '';
  try {
    const r = await fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true } }); if (!r.ok) return '';
    const buf = await r.arrayBuffer(); if (buf.byteLength > 4e6) return '';
    let t = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!t.startsWith('image/')) t = MIME[(url.split('?')[0].split('.').pop() || '').toLowerCase()] || 'image/png';
    if (t === 'image/webp' || new TextDecoder().decode(new Uint8Array(buf, 8, 4)) === 'WEBP') return `data:image/png;base64,${b64(await webpToPng(buf, max))}`;
    return `data:${t};base64,${b64(buf)}`;
  } catch { return ''; }
}
// Chain logos with <text> (ApeChain's "APE") are inlined so they use the card's fonts; resvg doesn't give nested SVG images any fonts.
async function logoSvg(c) {
  const url = `${SITE}/logos/${c}.svg`;
  try { const r = await fetch(url, { cf: { cacheTtl: 604800, cacheEverything: true } }); if (!r.ok) return ''; const t = await r.text();
    if (/<text/.test(t)) return { inline: t.replace(/font-family="[^"]*"/g, 'font-family="Inter"').replace(/font-weight="9\d\d"/g, 'font-weight="800"') };
    return `data:image/svg+xml;base64,${b64(new TextEncoder().encode(t))}`; } catch { return ''; }
}
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// d: { name, sub?, floor, chains[], banner?, avatar?, tiles[] (urls), item? { name, image, color? } }
export async function renderCard(d) {
  const [banner, avatar, itemImg, ...rest] = await Promise.all([
    dataUri(d.banner, 86400, 1200), dataUri(d.avatar, 86400, 200), dataUri(d.item?.image, 86400, 450),
    ...d.chains.map(c => logoSvg(c)),
    ...(d.banner ? [] : d.tiles.map(t => dataUri(t.url, 86400, 210))),
  ]);
  const logos = rest.slice(0, d.chains.length), tiles = rest.slice(d.chains.length);
  const W = 1200, H = 630, item = !!d.item;
  let bg = `<rect width="${W}" height="${H}" fill="#05070b"/>`;
  if (banner) bg += `<image href="${banner}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`;
  else { const cw = 200, chh = 210; tiles.forEach((t, i) => { const cx = (i % 6) * cw, cy = Math.floor(i / 6) * chh; bg += `<rect x="${cx}" y="${cy}" width="${cw}" height="${chh}" fill="#${d.tiles[i].color || '1a2230'}"/>${t ? `<image href="${t}" x="${cx}" y="${cy}" width="${cw}" height="${chh}" preserveAspectRatio="xMidYMid slice"/>` : ''}`; }); }
  const L = 64;
  const title = fit(item ? d.item.name : d.name, item ? 20 : 24);
  const ts = title.length > 18 ? 58 : 72;
  const tx = item ? L : L + 236;
  const chainRow = logos.map((l, i) => `<circle cx="${tx + 26 + i * 64}" cy="548" r="27" fill="#0b0f17" stroke="#45bdfa66" stroke-width="2"/>${l?.inline ? l.inline.replace('<svg ', `<svg x="${tx + 8 + i * 64}" y="530" width="36" height="36" `) : l ? `<image href="${l}" x="${tx + 8 + i * 64}" y="530" width="36" height="36"/>` : ''}`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05070b" stop-opacity="${item ? 0.7 : 0.35}"/><stop offset=".55" stop-color="#05070b" stop-opacity="${item ? 0.82 : 0.7}"/><stop offset="1" stop-color="#05070b" stop-opacity=".96"/></linearGradient>
<linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05070b" stop-opacity=".75"/><stop offset=".7" stop-color="#05070b" stop-opacity="0"/></linearGradient>
<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6fd8"/><stop offset=".45" stop-color="#2684ce"/><stop offset="1" stop-color="#45bdfa"/></linearGradient>
<clipPath id="av"><rect x="${L}" y="300" width="200" height="200" rx="28"/></clipPath><clipPath id="it"><rect x="690" y="70" width="450" height="450" rx="28"/></clipPath></defs>
${bg}<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#h)"/>
<rect x="0" y="${H - 8}" width="${W}" height="8" fill="url(#a)"/>
<text x="${L}" y="84" font-family="Inter" font-weight="800" font-size="38" fill="#ffffff">Multi<tspan fill="#45bdfa">Sea</tspan></text>
${item ? `<rect x="684" y="64" width="462" height="462" rx="32" fill="#45bdfa" fill-opacity=".9"/><rect x="690" y="70" width="450" height="450" rx="28" fill="#${d.item.color || '0b0f17'}"/>${itemImg ? `<image href="${itemImg}" x="690" y="70" width="450" height="450" clip-path="url(#it)" preserveAspectRatio="xMidYMid slice"/>` : ''}
<text x="${L}" y="300" font-family="Inter" font-weight="600" font-size="34" fill="#cfe9ff">${x(fit(d.name, 28))}</text>`
  : `<rect x="${L - 5}" y="295" width="210" height="210" rx="32" fill="#45bdfa" fill-opacity=".9"/><rect x="${L}" y="300" width="200" height="200" rx="28" fill="#0b0f17"/>${avatar ? `<image href="${avatar}" x="${L}" y="300" width="200" height="200" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>` : ''}`}
<text x="${tx}" y="${item ? 380 : 372}" font-family="Inter" font-weight="800" font-size="${ts}" fill="#ffffff">${x(title)}</text>
<text x="${tx}" y="${item ? 462 : 456}" font-family="Inter" font-weight="800" font-size="54" fill="#45bdfa">${x(d.floor || 'Omni chain NFTs')}</text>
${chainRow}
<text x="${W - 60}" y="${item ? 590 : 84}" text-anchor="end" font-family="Inter" font-weight="600" font-size="24" fill="#cfe9ff" fill-opacity=".85">multisea.io</text>
</svg>`;
  await init();
  const rv = new Resvg(svg, { font: { fontBuffers: [new Uint8Array(F600), new Uint8Array(F800)], defaultFontFamily: 'Inter', loadSystemFonts: false }, fitTo: { mode: 'width', value: W } });
  try { const img = rv.render(); try { return img.asPng(); } finally { img.free(); } } finally { rv.free(); }
}
