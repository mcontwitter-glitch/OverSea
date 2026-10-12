// Build MultiSea brand assets from brand/*-src.png -> public/brand + favicons + og image.
import sharp from 'sharp'; import fs from 'node:fs/promises';
const O = 'public/brand'; await fs.mkdir(O, { recursive: true });
// Logo: find the navy square's bounding box (non-white, opaque pixels), crop, mask to a transparent rounded square.
const src = sharp('brand/logo-src.png').ensureAlpha();
const { data, info } = await src.clone().raw().toBuffer({ resolveWithObject: true });
let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  const i = (y * info.width + x) * 4; const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
  if (a > 200 && r + g + b < 300) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
}
const side = Math.min(x1 - x0, y1 - y0) + 1;
const S = 1024, R = Math.round(S * 0.2);
const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}" rx="${R}" ry="${R}" fill="#fff"/></svg>`);
const logo = await sharp('brand/logo-src.png').extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).resize(S, S, { fit: 'fill' }).ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
await fs.writeFile('brand/logo-1024.png', logo);
for (const s of [512, 256, 128, 64]) {
  await sharp(logo).resize(s, s).png({ compressionLevel: 9, palette: false }).toFile(`${O}/logo-${s}.png`);
  await sharp(logo).resize(s, s).webp({ quality: 88 }).toFile(`${O}/logo-${s}.webp`);
}
for (const s of [16, 32, 48]) await sharp(logo).resize(s, s).png().toFile(`public/favicon-${s}.png`);
await sharp(logo).resize(192, 192).png().toFile('public/icon-192.png');
await sharp(logo).resize(512, 512).png().toFile('public/icon-512.png');
// apple-touch: full-bleed square on navy (iOS rounds it itself)
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#0b1f4d' } }).composite([{ input: await sharp(logo).resize(180, 180).toBuffer() }]).png().toFile('public/apple-touch-icon.png');
// favicon.ico (PNG-in-ICO, 32px)
const p32 = await sharp(logo).resize(32, 32).png().toBuffer();
const ico = Buffer.alloc(22); ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 32; ico[7] = 32; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(p32.length, 14); ico.writeUInt32LE(22, 18);
await fs.writeFile('public/favicon.ico', Buffer.concat([ico, p32]));
// Banner
const ban = sharp('brand/banner-src.png');
await ban.clone().resize(1500).webp({ quality: 82 }).toFile(`${O}/banner-1500.webp`);
await ban.clone().resize(900).webp({ quality: 80 }).toFile(`${O}/banner-900.webp`);
await ban.clone().resize(1500).png({ compressionLevel: 9 }).toFile(`${O}/banner-1500.png`);
// og:image 1200x630: banner (1200x400) centered on navy
const b1200 = await ban.clone().resize(1200, 400).toBuffer();
await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#0b1f4d' } }).composite([{ input: b1200, top: 115, left: 0 }]).png({ compressionLevel: 9 }).toFile('public/og-image.png');
await fs.writeFile('public/site.webmanifest', JSON.stringify({ name: 'MultiSea', short_name: 'MultiSea', description: 'Multichain NFT collections in one place', start_url: '/', display: 'standalone', background_color: '#081633', theme_color: '#0b1f4d', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 1));
console.log('bbox', x0, y0, x1, y1, 'side', side);
