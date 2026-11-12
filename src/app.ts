// MultiSea entry: tiny path router (full-page navigation; 404.html serves this same app on GitHub Pages).
import './style.css';
import CFG from '../config/collections.json';
const path = location.pathname.replace(/\/+$/, '') || '/';
// Legacy links (?c=, ?item= on the old single-collection page) -> /c/<slug>
const q = new URLSearchParams(location.search);
if (path === '/' && (q.get('item') || q.get('tab') || q.get('c'))) { const s = q.get('c') || CFG.default; q.delete('c'); location.replace(`/c/${s}${q.toString() ? '?' + q : ''}`); }
const m = path.match(/^\/c\/([a-z0-9-]+)$/);
if (path === '/') import('./home');
else if (path === '/btc' || /^\/btc\/(c\/[A-Za-z0-9_-]+|i\/[0-9a-f]{64}i\d+|me)$/.test(path)) import('./btcpage');
else if (path === '/submit') import('./submit');
else if (path === '/list-collection') import('./listpage');
else if (path === '/bridge') import('./bridgepage');
else if (path === '/admin') import('./admin');
else if (path === '/launchpad/testnet' && import.meta.env.VITE_LP_TESTNET === '1') import('./launchtestnet'); // staging build only
else if (path === '/launchpad' || /^\/launchpad\/[a-z0-9-]{3,40}$/.test(path)) import('./launchpad');
else if (/^\/r\/[0-9a-fA-F]{8}$/.test(path)) { const code = path.slice(3).toLowerCase(); if (!localStorage.getItem('multisea-ref')) localStorage.setItem('multisea-ref', JSON.stringify({ code, at: Date.now() })); location.replace('/?ref=' + code); }
else if (path === '/referrals') import('./referrals');
else if (path === '/revenue-share') import('./revshare');
else if (path === '/cart') import('./cartpage');
else if (path === '/holders' || /^\/holders\/[a-z0-9-]+$/.test(path)) import('./holders');
else if (path === '/me/profile') import('./profile');
else if (path === '/me') import('./me');
else if (path === '/bundles') import('./bundles');
else if (/^\/w\/\d{1,5}$/.test(path)) import('./footwallet');
else if (/^\/w\/multi-islands\/\d{1,3}$/.test(path)) import('./islandwallet');
else if (path === '/quests' || /^\/u\/0x[0-9a-fA-F]{40}$/.test(path)) import('./quests');
else if (m && CFG.collections.some(c => c.slug === m[1])) import('./collection');
else if (m) import('./dyn');
else import('./home').then(h => h.notFound?.());
