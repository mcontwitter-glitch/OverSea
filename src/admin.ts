import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, apiReady, openConnect } from './wallet';
import { navHtml, bindNav, esc, soon, media } from './shell';
import { api, signIn, getSession } from './auth';
import { feesHtml, loadFees, claim } from './fees';
import { apiFeatures } from './wallet';
import { localDrops, saveLocal, isLocalHost } from './launchdata';
const app = document.getElementById('app')!; document.title = 'Admin · MultiSea';
const chains = CFG.chains as Record<string, { name: string; explorer: string }>;
let pending: any[] | null = null; let err = ''; let drops: any[] | null = null;
// Launchpad drop submissions share this review queue. Worker drops: wei prices + allowlistCounts; local preview drops (localhost only,
// saved by /launchpad/create while the Worker endpoints are undeployed): native prices + allowlist arrays.
const wei = (v: any) => (typeof v === 'string' && /^\d+$/.test(v) ? +v / 1e18 : +v);
function dropCard(d: any, local: boolean) {
  const ch = (d.chains || []).map((c: any) => typeof c === 'string' ? { chain: c } : c);
  const ph = (d.phases || []).map((p: any, i: number) => `<div>${i + 1}. <b>${esc(p.name)}</b> · ${esc(p.kind)} · ${wei(p.price) || 'free'} · ${p.maxPerWallet ? 'max ' + p.maxPerWallet : 'no limit'} · ${new Date(p.start * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC${p.kind === 'allowlist' ? ` · ${(d.allowlistCounts?.[i] ?? p.allowCount ?? p.allowlist?.length ?? 0)} wallets` : ''}</div>`).join('');
  return `<div class="qcard lqcard"><div class="qh">${d.img ? `<img src="${esc(d.img)}" alt="">` : d.logo ? `<img src="${esc(media(d.logo))}" alt="">` : ''}<div><b>${esc(d.name)}</b> <span class="ldtag drop">🚀 Drop</span>${d.mode === 'multichain' ? ' <span class="ldtag mc">Multichain</span>' : ''}${local ? ' <span class="ldtag demo">Local preview</span>' : ''} <span class="mut">/launchpad/${esc(d.slug)}</span><div class="mut small">by ${esc(d.submitter || d.creator || 'no wallet connected (preview)')} · ${esc(d.submittedAt)}</div></div></div>
    ${d.description ? `<p>${esc(d.description)}</p>` : ''}
    <div class="kv small"><span>Drop type</span><b>${d.mode === 'multichain' ? 'Multichain (escrow): one shared supply, LayerZero moves' : 'Single chain per contract'}</b><span>${d.mode === 'multichain' ? 'Initial pools' : 'Chains / supply'}</span><b>${ch.map((c: any) => `<img class="cl" src="/logos/${c.chain}.svg" alt=""> ${esc(chains[c.chain]?.name || c.chain)}${c.supply ? ' ' + c.supply.toLocaleString() : ''}`).join(' · ')}</b><span>Total supply</span><b>${(+d.maxSupply).toLocaleString()} (reserve ${d.creatorReserve || 0})</b><span>Royalty</span><b>${(d.royaltyBps || 0) / 100}%</b><span>Reveal</span><b>${esc(d.reveal)}</b><span>Metadata</span><b class="mono">${esc(d.baseURI || d.preRevealURI || '-')}</b><span>Payout</span><b class="mono">${esc(d.payout || 'creator wallet')}</b></div>
    <div class="small ldrev">${ph}</div>
    <div class="qa"><button class="bbtn sm" data-dapprove="${esc(d.slug)}" data-local="${local ? 1 : ''}">Approve drop</button><button class="bbtn sm ghost" data-dreject="${esc(d.slug)}" data-local="${local ? 1 : ''}">Reject</button></div></div>`;
}
function dropsHtml(admin: boolean) {
  const loc = isLocalHost() ? localDrops().filter(d => d.status === 'pending') : [];
  if (!admin && !loc.length) return '';
  const remote = admin ? drops || [] : [];
  return `<div class="gh pad">Launchpad drops</div>${loc.length ? '<p class="mut small">Local preview submissions (this browser, localhost only; not from the Worker).</p>' : ''}
   ${remote.map(d => dropCard(d, false)).join('')}${loc.map(d => dropCard(d, true)).join('')}${!remote.length && !loc.length ? '<p class="mut">No pending drops.</p>' : ''}`;
}
function render() {
  const s = getSession();
  app.innerHTML = `${navHtml('admin')}<section class="page"><h2>${getSession()?.isFee && !getSession()?.isAdmin ? 'Admin' : 'Admin: review queue'}</h2>
  ${!apiReady ? soon('Admin review') : !wallet.address ? '<p>Connect the admin wallet.</p><button class="bbtn sm" data-act="connect">Connect wallet</button>' : !s ? '<p>Sign in to prove you control the admin wallet.</p><button class="bbtn sm" data-act="signin">Sign in</button>' : !s.isAdmin && !s.isFee ? '<p class="err">This wallet is not an admin.</p>' : ''}
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  ${pending ? (pending.length ? pending.map(p => `<div class="qcard"><div class="qh">${p.logo ? `<img src="${esc(media(p.logo))}" alt="">` : ''}<div><b>${esc(p.name)}</b> <span class="mut">/c/${esc(p.slug)}</span><div class="mut small">by ${esc(p.submitter)} · ${esc(p.submittedAt)}</div></div></div>
    <p>${esc(p.description)}</p><div class="small">${p.deployments.map((d: any) => `<div><img class="cl" src="/logos/${d.chain}.svg" alt=""> ${esc(chains[d.chain]?.name)} <a href="${chains[d.chain]?.explorer}/address/${d.address}" target="_blank" rel="noopener" class="mono">${esc(d.address)}</a></div>`).join('')}</div>
    <div class="qa"><button class="bbtn sm" data-approve="${esc(p.slug)}">Approve</button><button class="bbtn sm ghost" data-reject="${esc(p.slug)}">Reject</button></div></div>`).join('') : '<p class="mut">No pending submissions.</p>') : ''}
  ${dropsHtml(!!s?.isAdmin)}
  ${s && (s.isAdmin || s.isFee) ? feesHtml() : ''}
  </section>`;
}
async function load() { err = ''; const s = getSession(); loadFees(render); if (!s?.isAdmin) { render(); return; } try { pending = (await api('/admin/pending', { auth: true })).pending; if (apiFeatures.includes('launchpad')) drops = (await api('/admin/launchpad/pending', { auth: true })).pending; } catch (e: any) { err = e.message; } render(); }
app.addEventListener('click', async e => {
  const t = e.target as HTMLElement;
  if (t.dataset.act === 'connect') openConnect();
  if (t.dataset.claim) { claim(+t.dataset.claim, render); return; }
  if (t.dataset.act === 'signin') { try { await signIn('Sign in to MultiSea admin'); await load(); } catch (e: any) { err = e.message; render(); } }
  if (t.dataset.dapprove || t.dataset.dreject) { const ap = !!t.dataset.dapprove; const slug = (t.dataset.dapprove || t.dataset.dreject)!;
    const reason = ap ? '' : prompt('Reason for rejection (optional)') || '';
    if (t.dataset.local) { saveLocal(localDrops().map(d => d.slug === slug ? { ...d, status: ap ? 'approved' : 'rejected' } : d)); render(); return; }
    try { await api(`/admin/launchpad/${ap ? 'approve' : 'reject'}/${slug}`, { auth: true, body: { reason } }); await load(); } catch (e: any) { err = e.message; render(); } return; }
  if (t.dataset.approve || t.dataset.reject) { const ap = !!t.dataset.approve; const slug = t.dataset.approve || t.dataset.reject;
    const reason = ap ? '' : prompt('Reason for rejection (optional)') || '';
    try { await api(`/admin/${ap ? 'approve' : 'reject'}/${slug}`, { auth: true, body: { reason } }); await load(); } catch (e: any) { err = e.message; render(); } }
});
bindNav(); render(); const ok = () => { const s = getSession(); return !!(s?.isAdmin || s?.isFee); };
onWallet(() => { if (ok()) load(); else render(); }); checkApi().then(() => { if (ok()) load(); else render(); });
