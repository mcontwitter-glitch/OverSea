import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, apiReady, openConnect } from './wallet';
import { navHtml, bindNav, esc, soon, media } from './shell';
import { api, signIn, getSession } from './auth';
const app = document.getElementById('app')!; document.title = 'Admin · MultiSea';
const chains = CFG.chains as Record<string, { name: string; explorer: string }>;
let pending: any[] | null = null; let err = '';
function render() {
  const s = getSession();
  app.innerHTML = `${navHtml()}<section class="page"><h2>Admin: review queue</h2>
  ${!apiReady ? soon('Admin review') : !wallet.address ? '<p>Connect the admin wallet.</p><button class="bbtn sm" data-act="connect">Connect wallet</button>' : !s ? '<p>Sign in to prove you control the admin wallet.</p><button class="bbtn sm" data-act="signin">Sign in</button>' : !s.isAdmin ? '<p class="err">This wallet is not an admin.</p>' : ''}
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  ${pending ? (pending.length ? pending.map(p => `<div class="qcard"><div class="qh">${p.logo ? `<img src="${esc(media(p.logo))}" alt="">` : ''}<div><b>${esc(p.name)}</b> <span class="mut">/c/${esc(p.slug)}</span><div class="mut small">by ${esc(p.submitter)} · ${esc(p.submittedAt)}</div></div></div>
    <p>${esc(p.description)}</p><div class="small">${p.deployments.map((d: any) => `<div><img class="cl" src="/logos/${d.chain}.svg" alt=""> ${esc(chains[d.chain]?.name)} <a href="${chains[d.chain]?.explorer}/address/${d.address}" target="_blank" rel="noopener" class="mono">${esc(d.address)}</a></div>`).join('')}</div>
    <div class="qa"><button class="bbtn sm" data-approve="${esc(p.slug)}">Approve</button><button class="bbtn sm ghost" data-reject="${esc(p.slug)}">Reject</button></div></div>`).join('') : '<p class="mut">No pending submissions.</p>') : ''}
  </section>`;
}
async function load() { err = ''; try { pending = (await api('/admin/pending', { auth: true })).pending; } catch (e: any) { err = e.message; } render(); }
app.addEventListener('click', async e => {
  const t = e.target as HTMLElement;
  if (t.dataset.act === 'connect') openConnect();
  if (t.dataset.act === 'signin') { try { await signIn('Sign in to MultiSea admin'); await load(); } catch (e: any) { err = e.message; render(); } }
  if (t.dataset.approve || t.dataset.reject) { const ap = !!t.dataset.approve; const slug = t.dataset.approve || t.dataset.reject;
    const reason = ap ? '' : prompt('Reason for rejection (optional)') || '';
    try { await api(`/admin/${ap ? 'approve' : 'reject'}/${slug}`, { auth: true, body: { reason } }); await load(); } catch (e: any) { err = e.message; render(); } }
});
bindNav(); render(); onWallet(() => { if (getSession()?.isAdmin) load(); else render(); }); checkApi().then(() => { if (getSession()?.isAdmin) load(); else render(); });
