// Content hashes for brand assets referenced from TS, so Vite's chunk hashes change when images change.
import fs from 'node:fs'; import crypto from 'node:crypto';
const files = ['brand/icon-64.webp', 'brand/icon-128.webp', 'brand/banner-900.webp', 'brand/banner-1500.webp', 'brand/banner-2048.webp', 'brand/banner-1500.jpg', 'brand/devices-1400.webp', 'brand/devices-800.webp', 'brand/devices-1400.jpg'];
const v = {}; for (const f of files) v[f] = '/' + f + '?v=' + crypto.createHash('md5').update(fs.readFileSync('public/' + f)).digest('hex').slice(0, 8);
fs.writeFileSync('src/assetv.json', JSON.stringify(v, null, 1) + '\n'); console.log('assetv', Object.keys(v).length);
