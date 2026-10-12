// Build first-paint-friendly compact data: items.min.json (trait indices + avg color) and owners.min.json (owner table).
import fs from 'node:fs/promises'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'config/collections.json'), 'utf8'));
const slug = process.argv[2] || CFG.default; const D = path.join(ROOT, 'public/data', slug);
const items = JSON.parse(await fs.readFile(path.join(D, 'items.json'), 'utf8'));
const owners = JSON.parse(await fs.readFile(path.join(D, 'owners.json'), 'utf8'));
let ph = {}; try { ph = JSON.parse(await fs.readFile(path.join(ROOT, '.cache', slug, 'ph.json'), 'utf8')); } catch {}
const types = [...new Set(items.flatMap(i => i.attrs.map(a => a[0])))];
const vals = types.map(t => [...new Set(items.flatMap(i => i.attrs.filter(a => a[0] === t).map(a => a[1])))]);
const sameName = items.every(i => i.name === items[0].name.replace(/\d+$/, '') + i.id);
const imgBase = items[0].image.replace(/\d+$/, ''); const sameImg = items.every(i => i.image === imgBase + i.id);
const out = { v: 1, types, vals, namePrefix: sameName ? items[0].name.replace(/\d+$/, '') : null, imgBase: sameImg ? imgBase : null,
  // [id, rank, score, avgColorHex(no #), traitValueIdx per type (-1 = none), name?, image?]
  i: items.map(it => { const row = [it.id, it.rank, it.score, (ph[it.id]?.[0] || '#222').slice(1), types.map((t, k) => { const a = it.attrs.find(x => x[0] === t); return a ? vals[k].indexOf(a[1]) : -1; })]; if (!sameName) row.push(it.name); if (!sameImg) row.push(it.image); return row; }) };
await fs.writeFile(path.join(D, 'items.min.json'), JSON.stringify(out));
const chains = [...new Set(Object.values(owners).map(o => o.chain))]; const addrs = [...new Set(Object.values(owners).flatMap(o => [o.owner, ...(o.also || []).map(a => a.owner)]))];
const om = { chains, addrs, d: Object.fromEntries(Object.entries(owners).map(([id, o]) => [id, [chains.indexOf(o.chain), addrs.indexOf(o.owner), ...(o.also || []).flatMap(a => [chains.indexOf(a.chain), addrs.indexOf(a.owner)])]])) };
await fs.writeFile(path.join(D, 'owners.min.json'), JSON.stringify(om));
for (const f of ['items.json', 'items.min.json', 'owners.json', 'owners.min.json']) console.log(f, (await fs.stat(path.join(D, f))).size);
