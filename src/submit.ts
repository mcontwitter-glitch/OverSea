import CFG from '../config/collections.json';
import { checkApi, onWallet, wallet, apiReady, openConnect } from './wallet';
import { apiFeatures } from './wallet';
const mediaOn = () => apiFeatures.includes('media');
import { navHtml, bindNav, esc, soon, media } from './shell';
import { api, uploadImage, getSession } from './auth';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; rpc: string }>;
document.title = 'Submit a collection · MultiSea';
let rows = [{ chain: 'ethereum', address: '' }]; let esc_rows: { chain: string; address: string }[] = [];
const up: Record<string, string> = {}; let msg = ''; let msgCls = 'mut'; let done = '';
const chainOpts = (sel: string) => Object.entries(chains).map(([k, c]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
async function isErc721(chain: string, address: string) {
  const r = await fetch(chains[chain].rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: '0x01ffc9a780ac58cd' + '0'.repeat(56) }, 'latest'] }) });
  const j = await r.json().catch(() => ({})); return !!j.result && j.result !== '0x' && BigInt(j.result) === 1n;
}
function render() {
  const off = !apiReady;
  app.innerHTML = `${navHtml('submit')}<section class="page form">
  <h2>Submit a collection</h2><p class="mut">List your multichain ERC-721 collection on MultiSea. Connect the wallet that deployed or owns it, then sign a message to prove it (Sign-In With Ethereum). An admin reviews every submission.</p>
  ${off ? soon('Submitting') : ''}
  ${done ? `<div class="okbox">✓ Submitted <b>${esc(done)}</b>. It's in the review queue.</div>` : ''}
  <fieldset ${off ? 'disabled' : ''}>
   <div class="two"><label>Project name<input name="name" maxlength="60" required></label><label>Slug <span class="mut small">multisea.io/c/<b class="slugpv">your-slug</b></span><input name="slug" pattern="[a-z0-9-]{3,40}" maxlength="40" placeholder="lowercase-with-dashes" required></label></div>
   <label>Description<textarea name="description" rows="4" maxlength="1000"></textarea></label>
   <div class="three"><label>Website<input name="website" placeholder="https://"></label><label>X<input name="x" placeholder="https://x.com/handle"></label><label>Discord<input name="discord" placeholder="https://discord.gg/…"></label></div>
   <div class="two"><label>Logo <span class="mut small">square image</span><div class="pick"><img class="pv lg" src="${esc(media(up.logo))}" alt="">${mediaOn() ? '<input type="file" accept="image/*" data-f="logo">' : '<span class="mut small">Image uploads coming soon</span>'}</div></label>
   <label>Banner <span class="mut small">about 3:1</span><div class="pick"><img class="pv bn" src="${esc(media(up.banner))}" alt="">${mediaOn() ? '<input type="file" accept="image/*" data-f="banner">' : '<span class="mut small">Image uploads coming soon</span>'}</div></label></div>
   <div class="gh">Chains & contracts <span class="mut small">(ERC-721, checked on-chain)</span></div>
   ${rows.map((r, i) => `<div class="crow"><select data-row="${i}" data-k="chain">${chainOpts(r.chain)}</select><input data-row="${i}" data-k="address" placeholder="0x… contract" value="${esc(r.address)}"><span class="chk" id="chk${i}"></span>${rows.length > 1 ? `<button type="button" class="x" data-rm="${i}">✕</button>` : ''}</div>`).join('')}
   <button type="button" class="pill" data-act="addrow">+ Add chain</button>
   <div class="gh">Escrow / vault addresses <span class="mut small">(optional, excluded from holder counts)</span></div>
   ${esc_rows.map((r, i) => `<div class="crow"><select data-erow="${i}" data-k="chain">${chainOpts(r.chain)}</select><input data-erow="${i}" data-k="address" placeholder="0x… escrow" value="${esc(r.address)}"><button type="button" class="x" data-erm="${i}">✕</button></div>`).join('')}
   <button type="button" class="pill" data-act="addesc">+ Add escrow</button>
   <p class="msg ${msgCls}">${esc(msg)}</p>
   <button class="bbtn go" type="button" data-act="submit">${wallet.address ? (getSession() ? 'Submit for review' : 'Sign in & submit') : 'Connect wallet to submit'}</button>
  </fieldset><div id="listpay"></div></section>`;
  import('./bridgeflag').then(f => f.bridgeEnabled()).then(on => { if (on) import('./listpay').then(m => { const el = document.getElementById('listpay'); if (el && !el.childElementCount) m.mountListPay(el); }); });
}
const val = (n: string) => (app.querySelector(`[name=${n}]`) as HTMLInputElement)?.value.trim() || '';
const keep = () => { const f: Record<string, string> = {}; app.querySelectorAll<HTMLInputElement>('[name]').forEach(i => (f[i.name] = i.value)); return f; };
const restore = (f: Record<string, string>) => app.querySelectorAll<HTMLInputElement>('[name]').forEach(i => { if (f[i.name] != null) i.value = f[i.name]; });
const rerender = () => { const f = keep(); render(); restore(f); };
app.addEventListener('input', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'slug') { t.value = t.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); (app.querySelector('.slugpv') as HTMLElement).textContent = t.value || 'your-slug'; }
  if (t.dataset.row) rows[+t.dataset.row][t.dataset.k as 'chain'] = t.value;
  if (t.dataset.erow) esc_rows[+t.dataset.erow][t.dataset.k as 'chain'] = t.value;
});
app.addEventListener('change', async e => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.row) { rows[+t.dataset.row][t.dataset.k as 'chain'] = t.value; const r = rows[+t.dataset.row]; const el = document.getElementById('chk' + t.dataset.row)!;
    if (/^0x[0-9a-fA-F]{40}$/.test(r.address)) { el.textContent = '…'; el.textContent = (await isErc721(r.chain, r.address)) ? '✓ ERC-721' : '✗ not ERC-721'; el.className = 'chk ' + (el.textContent.startsWith('✓') ? 'ok' : 'err'); } }
  if (t.type === 'file' && t.files?.[0]) { const k = t.dataset.f!; msg = 'Uploading ' + k + '… (you may be asked to sign in)'; msgCls = 'mut'; rerender();
    try { up[k] = await uploadImage(t.files[0], k === 'logo' ? 512 : 1500); msg = k + ' uploaded.'; } catch (er: any) { msg = er.message; msgCls = 'err'; } rerender(); }
});
app.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.closest('[data-act]') as HTMLElement | null;
  if (t.dataset.rm) { rows.splice(+t.dataset.rm, 1); rerender(); return; }
  if (t.dataset.erm) { esc_rows.splice(+t.dataset.erm, 1); rerender(); return; }
  if (!a) return;
  if (a.dataset.act === 'addrow') { rows.push({ chain: 'base', address: '' }); rerender(); }
  if (a.dataset.act === 'addesc') { esc_rows.push({ chain: rows[0].chain, address: '' }); rerender(); }
  if (a.dataset.act === 'submit') {
    if (!wallet.address) { openConnect(); return; }
    msg = 'Checking contracts on-chain…'; msgCls = 'mut'; rerender();
    try {
      for (const r of rows) if (!/^0x[0-9a-fA-F]{40}$/.test(r.address) || !(await isErc721(r.chain, r.address))) throw new Error(`${r.address || '(empty)'} on ${chains[r.chain].name} is not an ERC-721 contract`);
      msg = 'Check your wallet to sign…'; rerender();
      const j = await api('/submit', { auth: true, body: { name: val('name'), slug: val('slug'), description: val('description'), website: val('website'), x: val('x'), discord: val('discord'), logo: up.logo, banner: up.banner, deployments: rows, escrow: esc_rows.filter(r => r.address) } });
      done = j.slug; msg = ''; render(); window.scrollTo(0, 0);
    } catch (er: any) { msg = er.message; msgCls = 'err'; rerender(); }
  }
});
bindNav(); render(); onWallet(rerender); checkApi();
