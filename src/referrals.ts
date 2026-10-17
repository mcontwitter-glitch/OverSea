// Referrals dashboard: your /r/<code> link, friends, earnings; admin view + config.
import { wallet, onWallet, openConnect, checkApi } from './wallet';
import { usdRates } from './shell';
import { api, getSession, signIn } from './auth';
import { frame, getJ, esc, short, logo, fmtWei, usdTxt, chains, connectCta } from './gx';
const el = frame('referrals', 'Referrals');
let data: any = null, admin: any = null, err = '', msg = '';
async function load() { err = ''; data = null; draw(); if (!wallet.address) return; try { data = await getJ('/ref/stats/' + wallet.address.toLowerCase()); } catch (e: any) { err = e.message; } draw(); if (getSession()?.isAdmin) loadAdmin(); }
async function loadAdmin() { try { admin = await api('/admin/growth', { auth: true }); } catch (e: any) { err = e.message; } draw(); }
async function draw() {
  const r = await usdRates(); const u = (k: string, w: string) => +fmtWei(w).replace(/,/g, '') * ((r as any)[chains[k]?.native] || 0);
  const link = data ? `${location.origin}${data.path}` : '';
  const earnUsd = data ? Object.entries(data.earnings.perChain || {}).reduce((s, [k, w]) => s + u(k, w as string), 0) : 0;
  el.innerHTML = `<div class="ghero"><h1>Referrals</h1><p class="lpsub">Share your link. When friends buy on MultiSea, you earn <b>${data ? data.refBps / 100 : 20}% of MultiSea's 0.5% fee</b> on their purchases, for good. First link they open wins (first-touch, stored permanently).</p></div>
  ${!wallet.address ? connectCta('Connect a wallet to get your referral link. The code is derived from your wallet address.') : !data ? (err ? `<p class="err">${esc(err)}</p>` : '<div class="spin"></div> Loading…') : `
  <div class="fcard"><div class="gh">Your link</div><div class="reflink"><input readonly value="${esc(link)}"><button class="bbtn sm" data-act="copy">Copy</button><a class="obtn sm" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent('Multichain NFTs on MultiSea ' + link)}">Share on X</a></div>
    ${msg ? `<p class="ok small">${esc(msg)}</p>` : ''}${data.referredBy ? `<p class="mut small">You were referred by <span class="mono">${short(data.referredBy)}</span>.</p>` : ''}</div>
  <div class="gstats"><div class="gstat"><b>${data.friends.length}</b><span>Friends</span></div><div class="gstat"><b>${data.earnings.sales || 0}</b><span>Referred sales</span></div><div class="gstat"><b>${usdTxt(earnUsd) || '$0.00'}</b><span>Earned</span></div></div>
  <div class="fcard"><div class="gh">Earnings by chain</div>${Object.keys(data.earnings.perChain || {}).length ? Object.entries(data.earnings.perChain).map(([k, w]) => `<div class="frow">${logo(k)}<span><b>${esc(chains[k]?.name)}</b><em>${fmtWei(w as string)} ${esc(chains[k]?.native)} <i class="usd">${usdTxt(u(k, w as string))}</i></em></span></div>`).join('') : '<p class="mut small">No earnings yet. They accrue as your friends buy MultiSea listings.</p>'}
    <p class="mut small">Earnings accrue in the MultiSea ledger and are paid from the fee wallet.</p></div>
  <div class="fcard"><div class="gh">Friends</div>${data.friends.length ? `<div class="tbl"><div class="tr th"><span>Wallet</span><span>Joined</span><span>Sales</span></div>${data.friends.map((f: any) => `<div class="tr"><span class="mono">${short(f.address)}</span><span>${f.at ? new Date(f.at).toLocaleDateString() : '-'}</span><span>${f.sales || 0}</span></div>`).join('')}</div>` : '<p class="mut small">No friends yet. Share your link!</p>'}</div>`}
  ${getSession()?.isAdmin ? adminHtml() : wallet.address ? '<p class="mut small"><a href="" data-act="admin">Admin? Sign in for the referral admin view.</a></p>' : ''}`;
}
function adminHtml() {
  if (!admin) return '<div class="fcard"><div class="spin"></div> Loading admin…</div>';
  return `<div class="fcard admin"><div class="gh">Admin · referral program</div>
    <div class="two"><label>Referrer share of the 0.5% fee (%)<input data-k="refBps" type="number" min="0" max="50" step="1" value="${admin.config.refBps / 100}"></label><label>Revenue-share cap (% of fee)<input data-k="rsFeeCapBps" type="number" min="0" max="80" step="1" value="${admin.config.rsFeeCapBps / 100}"></label></div>
    <button class="bbtn sm" data-act="savecfg">Save</button>
    <div class="gh">Top referrers</div>${admin.referrers.length ? `<div class="tbl"><div class="tr th"><span>Referrer</span><span>Sales</span><span>Accrued</span></div>${admin.referrers.map((x: any) => `<div class="tr"><span class="mono">${short(x.address)}</span><span>${x.sales}</span><span>${Object.entries(x.perChain || {}).map(([k, w]) => `${logo(k)} ${fmtWei(w as string)}`).join(' ')}</span></div>`).join('')}</div>` : '<p class="mut small">None yet.</p>'}
    <div class="gh">Recent referral sales</div>${admin.refSales.length ? admin.refSales.slice(0, 15).map((s: any) => `<div class="frow">${logo(s.chain)}<span><b>${short(s.referrer)} ← ${short(s.buyer)}</b><em>${fmtWei(s.amount)} ${esc(chains[s.chain]?.native)} (${s.refBps / 100}% of fee)</em></span></div>`).join('') : '<p class="mut small">None yet.</p>'}
    <div class="gh">Revenue-share claim requests</div>${admin.revshareClaims.length ? admin.revshareClaims.slice(0, 15).map((c: any) => `<div class="frow"><span><b>${esc(c.slug)} · ${c.ids.length} token(s) · ${esc(c.status)}</b><em>${short(c.who)} → ${esc(chains[c.dest.chain]?.name)} · ${c.legs.map((l: any) => fmtWei(l.wei) + ' ' + chains[l.chain]?.native).join(' + ')}</em></span></div>`).join('') : '<p class="mut small">None.</p>'}
    <p class="mut small">Payouts: ${admin.payouts.enabled ? 'enabled' : esc(admin.payouts.reason)} · Badge signer: ${admin.badgeSigner ? 'configured' : 'setup needed'}</p></div>`;
}
el.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.dataset.act;
  if (a === 'connect') openConnect();
  if (a === 'copy') { const i = el.querySelector('.reflink input') as HTMLInputElement; navigator.clipboard?.writeText(i.value).catch(() => { i.select(); document.execCommand('copy'); }); msg = 'Copied!'; draw(); }
  if (a === 'admin') { e.preventDefault(); try { await signIn('Sign in to MultiSea admin'); loadAdmin(); } catch (x: any) { err = x.message; draw(); } }
  if (a === 'savecfg') { const v = (k: string) => Math.round(+(el.querySelector(`[data-k=${k}]`) as HTMLInputElement).value * 100); try { await api('/admin/growth/config', { auth: true, body: { refBps: v('refBps'), rsFeeCapBps: v('rsFeeCapBps') } }); await loadAdmin(); } catch (x: any) { err = x.message; draw(); } }
});
onWallet(load); checkApi().then(load);
