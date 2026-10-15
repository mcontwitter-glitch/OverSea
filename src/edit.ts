// "Edit collection" modal for verified collection owners (SIWE-authorized in the Worker).
import { api, uploadImage } from './auth';
import { pickHtml, picked, resetPicks } from './filepick';
import { esc, media } from './shell';
import { apiFeatures } from './wallet';
const mediaOn = () => apiFeatures.includes('media');
export type Editable = { slug: string; name: string; description?: string; website?: string; x?: string; discord?: string; logo?: string; banner?: string; royalty?: { recipient: string; bps: number } | null };
export function openEdit(c: Editable, onSaved: (c: any) => void) {
  resetPicks();
  const m = document.createElement('div'); m.className = 'modal wov';
  m.innerHTML = `<div class="wbox form"><button class="x mx">✕</button><h3>Edit ${esc(c.name)}</h3>
   <label>Logo <span class="mut small">(square, re-encoded to WebP ≤512px)</span>${pickHtml('logo', media(c.logo), mediaOn())}</label>
   <label>Banner <span class="mut small">(wide, ≤1500px)</span>${pickHtml('banner', media(c.banner), mediaOn())}</label>
   <label>Description<textarea name="description" maxlength="1000" rows="4">${esc(c.description || '')}</textarea></label>
   <label>Website<input name="website" placeholder="https://" value="${esc(c.website || '')}"></label>
   <label>X<input name="x" placeholder="https://x.com/handle" value="${esc(c.x || '')}"></label>
   <label>Discord<input name="discord" placeholder="https://discord.gg/…" value="${esc(c.discord || '')}"></label>
   <div class="gh">Creator royalty <span class="mut small">(MultiSea listings; 0–10%, leave 0 for none)</span></div>
   <div class="crow"><input name="roybps" type="text" inputmode="decimal" placeholder="0" value="${c.royalty?.bps ? c.royalty.bps / 100 : ''}" style="width:90px;flex:none"><span class="mut">%</span><input name="royto" placeholder="Payout address 0x…" value="${esc(c.royalty?.recipient || '')}"></div>
   <p class="msg"></p><button class="bbtn save">Sign & save</button></div>`;
  document.body.appendChild(m);
  const up: Record<string, string> = {}; const msg = m.querySelector('.msg') as HTMLElement;
  m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) m.remove(); });
  m.querySelectorAll<HTMLInputElement>('input[type=file]').forEach(inp => inp.addEventListener('change', async () => {
    const f = inp.files?.[0]; if (!f) return; picked(inp); const k = inp.dataset.f!;
    msg.className = 'msg mut'; msg.textContent = 'Uploading ' + k + '…';
    try { up[k] = await uploadImage(f, k === 'logo' ? 512 : 1500); (inp.closest('.pick')!.querySelector('.pv') as HTMLImageElement).src = media(up[k]); msg.textContent = k + ' uploaded.'; }
    catch (e: any) { msg.className = 'msg err'; msg.textContent = e.message; }
  }));
  m.querySelector('.save')!.addEventListener('click', async () => {
    const v = (n: string) => (m.querySelector(`[name=${n}]`) as HTMLInputElement).value.trim();
    msg.className = 'msg mut'; msg.textContent = 'Check your wallet to sign…';
    try { const pct = parseFloat(v('roybps') || '0'); if (!(pct >= 0 && pct <= 10)) throw new Error('Royalty must be between 0 and 10%'); if (pct > 0 && !/^0x[0-9a-fA-F]{40}$/.test(v('royto'))) throw new Error('Enter a valid royalty payout address');
      const royalty = pct > 0 ? { recipient: v('royto'), bps: Math.round(pct * 100) } : null;
      const j = await api(`/collections/${c.slug}/update`, { auth: true, body: { description: v('description'), website: v('website'), x: v('x'), discord: v('discord'), royalty, ...up } }); onSaved(j.collection); m.remove(); }
    catch (e: any) { msg.className = 'msg err'; msg.textContent = e.message; }
  });
}
export const linksHtml = (c: { website?: string; x?: string; discord?: string }) => {
  const x = c.x && !c.x.startsWith('http') ? 'https://x.com/' + c.x.replace('@', '') : c.x;
  return [c.website && `<a href="${esc(c.website)}" target="_blank" rel="noopener">🌐 Website</a>`, x && `<a href="${esc(x)}" target="_blank" rel="noopener">𝕏</a>`, c.discord && `<a href="${esc(c.discord)}" target="_blank" rel="noopener">Discord</a>`].filter(Boolean).join('');
};
