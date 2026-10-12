// Download original images (cached in .cache/<slug>/img) and build WebP thumbnails + tiny placeholders.
// Output: public/img/<slug>/s/<id>.webp (384px cards), public/img/<slug>/m/<id>.webp (768px cap, modal), .cache/<slug>/ph.json (avg color, used by compact.mjs).
import fs from 'node:fs/promises'; import path from 'node:path'; import sharp from 'sharp';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'config/collections.json'), 'utf8'));
const COL = CFG.collections.find(c => c.slug === (process.argv[2] || CFG.default));
const CACHE = path.join(ROOT, '.cache', COL.slug, 'img'); const S = path.join(ROOT, 'public/img', COL.slug, 's'), M = path.join(ROOT, 'public/img', COL.slug, 'm');
for (const d of [CACHE, S, M]) await fs.mkdir(d, { recursive: true });
const items = JSON.parse(await fs.readFile(path.join(ROOT, 'public/data', COL.slug, 'items.json'), 'utf8'));
let seadn = {}; try { seadn = JSON.parse(await fs.readFile(path.join(ROOT, '.cache', COL.slug, 'seadn.json'), 'utf8')); } catch {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function orig(it) {
  const f = path.join(CACHE, String(it.id));
  try { const b = await fs.readFile(f); if (b.length > 1000) return b; } catch {}
  // Try OpenSea's CDN copy first (fast), then the IPFS gateways from config.
  const urls = [...(seadn[it.id] ? [seadn[it.id]] : []), ...COL.ipfsGateways.map(g => g + it.image)];
  for (let a = 0; a < 6; a++) for (const u of urls) {
    try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
      const r = await fetch(u, { signal: ac.signal }); clearTimeout(t);
      if (!r.ok || !/image/.test(r.headers.get('content-type') || '')) continue;
      const b = Buffer.from(await r.arrayBuffer()); await fs.writeFile(f, b); return b; } catch {}
    await sleep(1500 * (a + 1));
  }
  return null;
}
const ph = {}; let i = 0, done = 0, fail = [];
await Promise.all(Array.from({ length: 16 }, async () => {
  while (i < items.length) {
    const it = items[i++]; const b = await orig(it); if (!b) { fail.push(it.id); continue; }
    const sOut = path.join(S, it.id + '.webp'), mOut = path.join(M, it.id + '.webp');
    const img = sharp(b);
    await img.clone().resize(384, 384, { fit: 'cover' }).webp({ quality: 74, effort: 5 }).toFile(sOut);
    await img.clone().resize(768, 768, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 78, effort: 5 }).toFile(mOut);
    const { dominant } = await img.stats();
    const tiny = await img.clone().resize(8, 8).webp({ quality: 40 }).toBuffer();
    ph[it.id] = ['#' + [dominant.r, dominant.g, dominant.b].map(x => x.toString(16).padStart(2, '0')).join(''), 'data:image/webp;base64,' + tiny.toString('base64')];
    if (++done % 250 === 0) console.log(new Date().toISOString().slice(11, 19), done);
  }
}));
await fs.writeFile(path.join(ROOT, '.cache', COL.slug, 'ph.json'), JSON.stringify(ph));
console.log('done', done, 'failed', fail.length, fail.slice(0, 20));
