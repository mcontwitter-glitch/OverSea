// Build MultiSea brand assets. Run scripts/brand-new.py first (creates brand/logo-full-1024.png + brand/logo-icon-1024.png).
import sharp from 'sharp'; import fs from 'node:fs/promises';
const O = 'public/brand'; await fs.mkdir(O, { recursive: true });
const full = 'brand/logo-full-1024.png', icon = 'brand/logo-icon-1024.png';
for (const s of [512, 256, 128]) {
  await sharp(full).resize(s, s).png({ compressionLevel: 9 }).toFile(`${O}/logo-${s}.png`);
  await sharp(full).resize(s, s).webp({ quality: 88 }).toFile(`${O}/logo-${s}.webp`);
}
for (const s of [128, 96, 64]) {
  await sharp(icon).resize(s, s).png({ compressionLevel: 9 }).toFile(`${O}/icon-${s}.png`);
  await sharp(icon).resize(s, s).webp({ quality: 90 }).toFile(`${O}/icon-${s}.webp`);
}
for (const s of [16, 32, 48]) await sharp(icon).resize(s, s).png().toFile(`public/favicon-${s}.png`);
const onBlack = async (src, s, out) => sharp({ create: { width: s, height: s, channels: 4, background: '#000000' } }).composite([{ input: await sharp(src).resize(s, s).toBuffer() }]).png().toFile(out);
await onBlack(icon, 180, 'public/apple-touch-icon.png');
await onBlack(full, 192, 'public/icon-192.png');
await onBlack(full, 512, 'public/icon-512.png');
const p32 = await sharp(icon).resize(32, 32).png().toBuffer();
const ico = Buffer.alloc(22); ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 32; ico[7] = 32; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(p32.length, 14); ico.writeUInt32LE(22, 18);
await fs.writeFile('public/favicon.ico', Buffer.concat([ico, p32]));
const ban = sharp('brand/banner-src.png');
await ban.clone().resize(2048).webp({ quality: 82 }).toFile(`${O}/banner-2048.webp`);
await ban.clone().resize(1500).webp({ quality: 82 }).toFile(`${O}/banner-1500.webp`);
await ban.clone().resize(900).webp({ quality: 80 }).toFile(`${O}/banner-900.webp`);
await ban.clone().resize(1500).jpeg({ quality: 84, mozjpeg: true }).toFile(`${O}/banner-1500.jpg`);
await ban.clone().resize(1200, 630, { fit: 'cover', position: 'centre' }).png({ compressionLevel: 9 }).toFile('public/og-image.png');
await fs.writeFile('public/site.webmanifest', JSON.stringify({ name: 'MultiSea', short_name: 'MultiSea', description: 'Multichain NFT collections in one place', start_url: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 1));
console.log('brand assets built');
