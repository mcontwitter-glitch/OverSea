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
else if (path === '/list-collection') import('./listpage');
else if (path === '/bridge') import('./bridgepage');
else if (path === '/admin') import('./admin');
else if (/^\/r\/[0-9a-fA-F]{8}$/.test(path)) { const code = path.slice(3).toLowerCase(); if (!localStorage.getItem('multisea-ref')) localStorage.setItem('multisea-ref', JSON.stringify({ code, at: Date.now() })); location.replace('/?ref=' + code); }
else if (path === '/referrals') import('./referrals');
else if (path === '/revenue-share') import('./revshare');
else if (path === '/cart') import('./cartpage');
else if (path === '/bundles') import('./bundles');
else if (path === '/quests' || /^\/u\/0x[0-9a-fA-F]{40}$/.test(path)) import('./quests');
else if (m && CFG.collections.some(c => c.slug === m[1])) import('./collection');
else if (m) import('./dyn');
else import('./home').then(h => h.notFound?.());
