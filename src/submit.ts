import CFG from '../config/collections.json';
import { pickHtml, picked, clearPick, resetPicks } from './filepick';
import { checkApi, onWallet, wallet, apiReady, openConnect, apiFeatures, API } from './wallet';
const mediaOn = () => apiFeatures.includes('media');
import { navHtml, bindNav, esc, soon, media } from './shell';
import { api, uploadImage, getSession, errMsg } from './auth';
const app = document.getElementById('app')!;
const chains = CFG.chains as Record<string, { name: string; rpc: string; rpcs?: string[] }>;
document.title = 'Submit a collection · MultiSea';
const DKEY = 'multisea-submit-draft';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

type Row = { chain: string; address: string };
let rows: Row[] = [{ chain: 'ethereum', address: '' }];
let esc_rows: Row[] = [];
const up: Record<string, string> = {};
let msg = ''; let msgCls = 'mut'; let done = ''; let busy = false; let upBusy = 0;
const checks = new Map<number, { cls: string; text: string }>();

function loadDraft(): Record<string, string> {
  try {
    const d = JSON.parse(sessionStorage.getItem(DKEY) || 'null');
    if (!d || typeof d !== 'object') return {};
    if (Array.isArray(d.rows) && d.rows.length) rows = d.rows.filter((r: any) => r && chains[r.chain]).map((r: any) => ({ chain: r.chain, address: String(r.address || '').trim() }));
    if (!rows.length) rows = [{ chain: 'ethereum', address: '' }];
    if (Array.isArray(d.esc_rows)) esc_rows = d.esc_rows.filter((r: any) => r && chains[r.chain]).map((r: any) => ({ chain: r.chain, address: String(r.address || '').trim() }));
    if (d.up?.logo) up.logo = d.up.logo;
    if (d.up?.banner) up.banner = d.up.banner;
    return d.fields && typeof d.fields === 'object' ? d.fields : {};
  } catch { return {}; }
}
function saveDraft(fields?: Record<string, string>) {
  try {
    const f = fields || keep();
    sessionStorage.setItem(DKEY, JSON.stringify({ fields: f, rows, esc_rows, up }));
  } catch {}
}

const chainOpts = (sel: string) => Object.entries(chains).map(([k, c]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

async function rpcRead(chain: string, to: string, data: string): Promise<{ rpcErr?: boolean; revert?: boolean; result?: string | null }> {
  const c = chains[chain]; if (!c) return { rpcErr: true };
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  const urls = [`${API}/rpc/${chain}`, ...(c.rpcs?.length ? c.rpcs : [c.rpc])];
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (!j) continue;
      if (j.error) return { revert: true, result: null };
      return { result: j.result ?? null };
    } catch {}
  }
  return { rpcErr: true };
}
const isHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);
const isWord = (v: unknown): v is string => isHex(v) && v.length >= 66;
// Returns true (verified ERC-721), false (definitely not ERC-721), or null (RPC unreachable — let Worker verify).
async function isErc721(chain: string, address: string): Promise<boolean | null> {
  const s721 = await rpcRead(chain, address, '0x01ffc9a780ac58cd' + '0'.repeat(56));
  if (s721.rpcErr) return null;
  if (isHex(s721.result) && BigInt(s721.result) === 1n) return true;
  const s1155 = await rpcRead(chain, address, '0x01ffc9a7d9b67a26' + '0'.repeat(56));
  if (isHex(s1155.result) && BigInt(s1155.result) === 1n) return false;
  const [dec, dead, bal, own1, own0] = await Promise.all([
    rpcRead(chain, address, '0x313ce567'),
    rpcRead(chain, address, '0xdeadbeef'),
    rpcRead(chain, address, '0x70a08231' + '0'.repeat(63) + '1'),
    rpcRead(chain, address, '0x6352211e' + '0'.repeat(63) + '1'),
    rpcRead(chain, address, '0x6352211e' + '0'.repeat(64)),
  ]);
  if (isWord(dec.result) || isWord(dead.result)) return false;
  const okOwner = (w: unknown) => isWord(w) && BigInt(w) !== 0n && BigInt(w) < (1n << 160n);
  if (isWord(bal.result) && (okOwner(own1.result) || okOwner(own0.result))) return true;
  if (s721.revert || (isHex(s721.result) && BigInt(s721.result) === 0n)) return false;
  return null;
}

app.innerHTML = `<div id="subnav">${navHtml('submit')}</div><section class="page form"><div id="subform"></div><div id="listpay"></div></section>`;
const subnav = document.getElementById('subnav')!;
const subform = document.getElementById('subform')!;
let listpayMounted = false;
function mountLP() {
  if (listpayMounted) return;
  listpayMounted = true;
  import('./bridgeflag').then(f => f.bridgeEnabled()).then(on => {
    if (on) import('./listpay').then(m => { const el = document.getElementById('listpay'); if (el && !el.childElementCount) m.mountListPay(el); });
  });
}

function render(initFields?: Record<string, string>) {
  const off = !apiReady;
  subnav.innerHTML = navHtml('submit');
  subform.innerHTML = `
  <h2>Submit a collection</h2><p class="mut">List your multichain ERC-721 collection on MultiSea. Connect the wallet that deployed or owns it, then sign a message to prove it (Sign-In With Ethereum). An admin reviews every submission.</p>
  ${off ? soon('Submitting') : ''}
  ${done ? `<div class="okbox">✓ <b>${esc(done)}</b> was saved for review (pending:${esc(done)}). MultiSea will review it — you can close this page.</div>` : ''}
  <fieldset ${off ? 'disabled' : ''}>
   <div class="two"><label>Project name<input name="name" maxlength="60" required></label><label>Slug <span class="mut small">multisea.io/c/<b class="slugpv">your-slug</b></span><input name="slug" pattern="[a-z0-9-]{3,40}" maxlength="40" placeholder="lowercase-with-dashes" required></label></div>
   <label>Description<textarea name="description" rows="4" maxlength="1000"></textarea></label>
   <div class="three"><label>Website<input name="website" placeholder="https://"></label><label>X<input name="x" placeholder="https://x.com/handle"></label><label>Discord<input name="discord" placeholder="https://discord.gg/…"></label></div>
   <div class="two"><label>Logo <span class="mut small">square image</span>${pickHtml('logo', media(up.logo), mediaOn())}</label>
   <label>Banner <span class="mut small">about 3:1</span>${pickHtml('banner', media(up.banner), mediaOn())}</label></div>
   <div class="gh">Chains & contracts <span class="mut small">(ERC-721, checked on-chain)</span></div>
   ${rows.map((r, i) => { const c = checks.get(i); return `<div class="crow"><select data-row="${i}" data-k="chain">${chainOpts(r.chain)}</select><input data-row="${i}" data-k="address" placeholder="0x… contract" value="${esc(r.address)}"><span class="chk ${c?.cls || ''}" id="chk${i}">${esc(c?.text || '')}</span>${rows.length > 1 ? `<button type="button" class="x" data-rm="${i}">✕</button>` : ''}</div>`; }).join('')}
   <button type="button" class="pill" data-act="addrow">+ Add chain</button>
   <div class="gh">Escrow / vault addresses <span class="mut small">(optional, excluded from holder counts)</span></div>
   ${esc_rows.map((r, i) => `<div class="crow"><select data-erow="${i}" data-k="chain">${chainOpts(r.chain)}</select><input data-erow="${i}" data-k="address" placeholder="0x… escrow" value="${esc(r.address)}"><button type="button" class="x" data-erm="${i}">✕</button></div>`).join('')}
   <button type="button" class="pill" data-act="addesc">+ Add escrow</button>
   <p class="msg ${msgCls}">${esc(msg)}</p>
   <button class="bbtn go" type="button" data-act="submit" ${busy ? 'disabled' : ''}>${busy ? 'Submitting…' : wallet.address ? (getSession() ? 'Submit for review' : 'Sign in & submit') : 'Connect wallet to submit'}</button>
  </fieldset>`;
  if (initFields) restore(initFields);
  mountLP();
}

const val = (n: string) => (subform.querySelector(`[name=${n}]`) as HTMLInputElement)?.value.trim() || '';
const keep = () => { const f: Record<string, string> = {}; subform.querySelectorAll<HTMLInputElement>('[name]').forEach(i => (f[i.name] = i.value)); return f; };
const restore = (f: Record<string, string>) => {
  subform.querySelectorAll<HTMLInputElement>('[name]').forEach(i => { if (f[i.name] != null) i.value = f[i.name]; });
  const pv = subform.querySelector('.slugpv') as HTMLElement | null;
  if (pv) pv.textContent = (f.slug || '').trim() || 'your-slug';
};
const rerender = () => { const f = keep(); render(f); };

function checkFormInputs(): string | null {
  if (!val('name')) return 'Project name is required.';
  const slug = val('slug');
  if (!SLUG_RE.test(slug)) return 'Slug must be 3-40 lowercase letters, digits, or dashes, and start/end with a letter or digit.';
  const w = val('website');
  if (w && /[\s<>"']/.test(w)) return 'Website must be a valid URL without spaces.';
  const x = val('x');
  if (x && /[\s<>"']/.test(x)) return 'X link must be an x.com/handle URL or @handle.';
  const d = val('discord');
  if (d && /[\s<>"']/.test(d)) return 'Discord link must be a valid discord.gg or discord.com URL.';
  for (const r of rows) {
    r.address = r.address.trim();
    if (!ADDR_RE.test(r.address)) return `Enter a valid 0x contract address on ${chains[r.chain].name}.`;
  }
  for (const r of esc_rows) {
    r.address = r.address.trim();
    if (r.address && !ADDR_RE.test(r.address)) return `Escrow address on ${chains[r.chain].name} must be a valid 0x address.`;
  }
  return null;
}

async function runContractCheck(idx: number) {
  const r = rows[idx]; if (!r) return;
  r.address = r.address.trim();
  const el = document.getElementById('chk' + idx);
  if (!ADDR_RE.test(r.address)) { checks.delete(idx); if (el) { el.textContent = ''; el.className = 'chk'; } return; }
  checks.set(idx, { cls: '', text: '…' });
  if (el) { el.textContent = '…'; el.className = 'chk'; }
  const ok = await isErc721(r.chain, r.address);
  const st = ok === true ? { cls: 'ok', text: '✓ ERC-721' } : ok === false ? { cls: 'err', text: '✗ not ERC-721' } : { cls: 'mut', text: '? verify on submit' };
  checks.set(idx, st);
  const el2 = document.getElementById('chk' + idx);
  if (el2) { el2.textContent = st.text; el2.className = 'chk ' + st.cls; }
}

subform.addEventListener('input', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'slug') { t.value = t.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); (subform.querySelector('.slugpv') as HTMLElement).textContent = t.value || 'your-slug'; }
  if (t.dataset.row) { const idx = +t.dataset.row; rows[idx][t.dataset.k as 'chain'] = t.dataset.k === 'address' ? t.value.trim() : t.value; checks.delete(idx); }
  if (t.dataset.erow) esc_rows[+t.dataset.erow][t.dataset.k as 'chain'] = t.dataset.k === 'address' ? t.value.trim() : t.value;
  saveDraft();
});
subform.addEventListener('change', async e => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.row) {
    const idx = +t.dataset.row;
    rows[idx][t.dataset.k as 'chain'] = t.dataset.k === 'address' ? t.value.trim() : t.value;
    if (t.dataset.k === 'address') t.value = rows[idx].address;
    saveDraft();
    await runContractCheck(idx);
  }
  if (t.dataset.erow) {
    const idx = +t.dataset.erow;
    esc_rows[idx][t.dataset.k as 'chain'] = t.dataset.k === 'address' ? t.value.trim() : t.value;
    if (t.dataset.k === 'address') t.value = esc_rows[idx].address;
    saveDraft();
  }
  if (t.type === 'file' && t.files?.[0]) {
    const k = t.dataset.f as 'logo' | 'banner';
    picked(t);
    msg = 'Uploading ' + k + '…' + (getSession() ? '' : ' (you may be asked to sign in)');
    msgCls = 'mut';
    rerender();
    upBusy++;
    try {
      up[k] = await uploadImage(t.files[0], k === 'logo' ? 512 : 1500);
      msg = k + ' uploaded.';
      msgCls = 'ok';
      saveDraft();
    } catch (er: any) {
      if (!up[k]) clearPick(k);
      msg = errMsg(er, 'Image upload failed');
      msgCls = 'err';
    } finally { upBusy = Math.max(0, upBusy - 1); }
    rerender();
  }
});
subform.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.closest('[data-act]') as HTMLElement | null;
  if (t.dataset.rm) { rows.splice(+t.dataset.rm, 1); checks.clear(); saveDraft(); rerender(); return; }
  if (t.dataset.erm) { esc_rows.splice(+t.dataset.erm, 1); saveDraft(); rerender(); return; }
  if (!a || busy) return;
  if (a.dataset.act === 'addrow') { rows.push({ chain: 'base', address: '' }); saveDraft(); rerender(); }
  if (a.dataset.act === 'addesc') { esc_rows.push({ chain: rows[0].chain, address: '' }); saveDraft(); rerender(); }
  if (a.dataset.act === 'submit') {
    saveDraft();
    if (upBusy > 0) { msg = 'Wait for your image upload to finish…'; msgCls = 'mut'; rerender(); return; }
    if (!wallet.address) { openConnect(); msg = 'Connect your wallet first, then click Submit again.'; msgCls = 'mut'; rerender(); return; }
    const verr = checkFormInputs();
    if (verr) { msg = verr; msgCls = 'err'; rerender(); subform.querySelector('.msg')?.scrollIntoView({ block: 'nearest' }); return; }
    busy = true;
    msg = 'Checking contracts on-chain…'; msgCls = 'mut'; rerender();
    try {
      for (const [i, r] of rows.entries()) {
        const ok = await isErc721(r.chain, r.address);
        if (ok === false) {
          checks.set(i, { cls: 'err', text: '✗ not ERC-721' });
          throw new Error(`${r.address} on ${chains[r.chain].name} is not an ERC-721 contract`);
        }
        if (ok === true) checks.set(i, { cls: 'ok', text: '✓ ERC-721' });
      }
      msg = getSession() ? 'Submitting for review…' : 'Check your wallet to sign…';
      rerender();
      const j = await api('/submit', {
        auth: true,
        body: {
          name: val('name'), slug: val('slug'), description: val('description'),
          website: val('website'), x: val('x'), discord: val('discord'),
          logo: up.logo, banner: up.banner,
          deployments: rows.map(r => ({ chain: r.chain, address: r.address.trim() })),
          escrow: esc_rows.map(r => ({ chain: r.chain, address: r.address.trim() })).filter(r => r.address),
        },
      });
      if (!j?.slug) throw new Error('Server did not confirm the submission. Please try again.');
      done = j.slug; msg = ''; msgCls = 'mut'; busy = false;
      rows = [{ chain: 'ethereum', address: '' }]; esc_rows = [];
      delete up.logo; delete up.banner; checks.clear(); resetPicks();
      sessionStorage.removeItem(DKEY);
      render({}); window.scrollTo(0, 0);
    } catch (er: any) {
      busy = false; msg = errMsg(er, 'Submission failed'); msgCls = 'err'; rerender();
      subform.querySelector('.msg')?.scrollIntoView({ block: 'nearest' });
    }
  }
});

bindNav();
const initialFields = loadDraft();
render(initialFields);
onWallet(rerender);
checkApi();
