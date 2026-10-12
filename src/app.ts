// MultiSea entry: tiny path router (full-page navigation; 404.html serves this same app on GitHub Pages).
import './style.css';
import CFG from '../config/collections.json';
const path = location.pathname.replace(/\/+$/, '') || '/';
// Legacy links (?c=, ?item= on the old single-collection page) -> /c/<slug>
const q = new URLSearchParams(location.search);
if (path === '/' && (q.get('item') || q.get('tab') || q.get('c'))) { const s = q.get('c') || CFG.default; q.delete('c'); location.replace(`/c/${s}${q.toString() ? '?' + q : ''}`); }
const m = path.match(/^\/c\/([a-z0-9-]+)$/);
if (path === '/') import('./home');
else if (path === '/submit') import('./submit');
else if (path === '/admin') import('./admin');
else if (m && CFG.collections.some(c => c.slug === m[1])) import('./collection');
else if (m) import('./dyn');
else import('./home').then(h => h.notFound?.());
