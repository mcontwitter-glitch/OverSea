// Admin: bridge jobs (launchpad prepaid + direct listings), operator gas per chain, and Retry / Scan now. Paused jobs show why (gas or token range).
import { api } from './auth';
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let st: any = null; let err = ''; let busy = ''; let msg = '';
export async function loadBridgeAdmin(rerender: () => void) {
  try { st = await api('/admin/bridge/status', { auth: true }); err = ''; } catch (e: any) { err = e.message || String(e); }
  rerender();
}
export function bridgeAdminHtml(): string {
  if (!st && !err) return '';
  const jobs: any[] = st?.jobs || [];
  const act = jobs.filter(j => j.step !== 'done');
  return `<div class="fees"><div class="fh"><h2>Bridge jobs</h2><button class="pill sm" data-bscan="1" ${busy ? 'disabled' : ''}>${busy === 'scan' ? 'Scanning…' : 'Scan &amp; run now'}</button></div>
    <p class="mut small">Direct listings (owner paid <span class="mono">factory.list</span>) and launchpad prepaid drops. Gas comes from the listing fee that lands in the operator wallet; if a chain runs short the job pauses here with the reason.</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}${msg ? `<p class="small">${esc(msg)}</p>` : ''}
    ${st ? `<div class="mut small">Operator <span class="mono">${esc(st.operator || 'not set')}</span>${st.operatorIsGasWallet === false ? ' · <b class="err">differs from a factory gasWallet: listing fees do not reach it</b>' : ''}<br>${Object.entries(st.balances || {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</div>
    <div class="mut small">Scan cursor: ${Object.entries(st.scan || {}).map(([k, v]: any) => `${esc(k)} #${esc(v.block ?? '–')}${v.err ? ` <span class="err">${esc(v.err)}</span>` : ''}`).join(' · ')}</div>` : ''}
    ${act.length ? act.map(j => `<div class="fcard"><b>${esc(j.slug)}</b> <span class="tag ${j.state === 'live' ? 'ok' : ''}">${esc(j.state)}</span> <span class="mut small">${j.direct ? 'direct' : 'launchpad'} · step ${esc(j.step)} · mirrors ${j.mirrors?.length || 0} · wired ${j.wired?.length || 0}</span>
      ${j.waiting ? `<div class="small warn">⏸ ${esc(j.waiting)}${j.waitingSince ? ` (since ${esc(j.waitingSince)})` : ''}</div>` : ''}${j.hold ? `<div class="small warn">⏸ ${esc(j.hold)}</div>` : ''}${j.err ? `<div class="small err">${esc(j.err)} (tries ${j.tries})</div>` : ''}${j.note ? `<div class="mut small">${esc(j.note)}</div>` : ''}
      <button class="pill sm" data-bretry="${esc(j.slug)}" ${busy ? 'disabled' : ''}>Retry</button></div>`).join('') : '<p class="mut small">No active bridge jobs.</p>'}
    ${jobs.length - act.length ? `<div class="mut small">${jobs.length - act.length} finished job(s).</div>` : ''}</div>`;
}
export async function bridgeAdminAct(kind: 'scan' | 'retry', slug: string, rerender: () => void) {
  if (busy) return; busy = kind; msg = ''; rerender();
  try { if (kind === 'scan') { const r = await api('/admin/bridge/scan', { auth: true, body: {} }); msg = 'Scan done: ' + JSON.stringify(r.results || []).slice(0, 300); }
    else { const r = await api('/admin/bridge/retry/' + encodeURIComponent(slug), { auth: true, body: {} }); msg = `${slug}: ${r.job}`; } }
  catch (e: any) { msg = e.message || String(e); }
  busy = ''; await loadBridgeAdmin(rerender);
}
