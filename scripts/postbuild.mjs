// SPA fallback for GitHub Pages: serve the app for /c/<slug>, /submit, /admin.
import fs from 'node:fs'; import crypto from 'node:crypto';
// Cache-bust brand assets in html/manifest. JS references come from src/assetv.json (build-time), so Vite chunk hashes change with the images.
const assets = ['brand/logo-512.png','brand/logo-256.png','brand/logo-128.png','brand/icon-128.png','brand/icon-64.png','brand/icon-64.webp','brand/icon-128.webp','brand/banner-2048.webp','brand/banner-1500.webp','brand/banner-900.webp','brand/banner-1500.jpg','favicon-16.png','favicon-32.png','favicon-48.png','favicon.ico','apple-touch-icon.png','icon-192.png','icon-512.png','og-image.png','site.webmanifest'];
const hv = f => crypto.createHash('md5').update(fs.readFileSync('dist/' + f)).digest('hex').slice(0, 8);
const files = ['dist/index.html', 'dist/site.webmanifest'];
const order = [...assets.filter(a => a !== 'site.webmanifest'), 'site.webmanifest'];
for (const a of order) { if (!fs.existsSync('dist/' + a)) continue; const v = hv(a); const re = new RegExp('(/' + a.replace(/[.]/g, '\\.') + ')(\\?v=[0-9a-f]+)?(?=[\\s"\'`),])', 'g');
  for (const f of files) { const t = fs.readFileSync(f, 'utf8'); const n = t.replace(re, `$1?v=${v}`); if (n !== t) fs.writeFileSync(f, n); } }
fs.copyFileSync('dist/index.html', 'dist/404.html');
for (const p of ['submit', 'admin', 'list-collection', 'referrals', 'revenue-share', 'cart', 'bundles', 'quests']) { fs.mkdirSync(`dist/${p}`, { recursive: true }); fs.copyFileSync('dist/index.html', `dist/${p}/index.html`); }
fs.mkdirSync('dist/c/lil-foots', { recursive: true }); fs.copyFileSync('dist/index.html', 'dist/c/lil-foots/index.html');
fs.writeFileSync('dist/.nojekyll', ''); console.log('postbuild: 404.html + route copies');
