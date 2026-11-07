import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect, overlay } from './wallet';
import { frame, esc, logo, chains } from './gx';
import { api, getSession, signIn, uploadImage } from './auth';
import { profileAvatar, profileName, shortAddr } from './names';
import { ownedNfts, insightOn } from './insight';

const el = frame('me', 'Edit profile', 'page profileedit');
let current: any = null, avatar = '', nft: any = null, msg = '';
const deployments = CFG.collections.flatMap(c => c.deployments.map(d => ({ ...d, collection: c.name })));
const GALLERY_CHAINS = ['base', 'ethereum', 'bnb', 'apechain', 'robinhood'].filter(k => (CFG.chains as any)[k]);
type GalNft = { chain: string; contract: string; id: string; name: string | null; collection: string | null; image: string | null; standard: string | null };
function media(u: string) { return u.startsWith('/media/') ? new URL(u, (import.meta.env.VITE_API_BASE as string) || 'https://api.multisea.io').href : u; }
function draw() {
  const a = wallet.address;
  el.innerHTML = `<div class="profeditor"><h1>Edit profile</h1><p class="mut">Choose how you appear across MultiSea, including holder chat.</p>
  ${!a ? '<div class="fcard cta"><p>Connect your wallet to edit your profile.</p><button class="bbtn" data-p="connect">Connect wallet</button></div>' : `
  <div class="profpreview">${avatar ? `<img src="${esc(media(avatar))}" alt="Profile preview">` : '<div class="pava">YOU</div>'}<div><b>${esc(profileName(a) || shortAddr(a))}</b><p class="mut small">${esc(a)}</p></div></div>
  <label>Display name <span class="mut small">Optional · up to 24 characters</span><input data-p="name" maxlength="24" value="${esc(current?.name || '')}" placeholder="Your MultiSea name"></label>
  <div class="fcard"><div class="gh">Profile picture</div><p class="mut small">Upload a square-cropped image, or pick an NFT your wallet owns. Images are stored by MultiSea.</p>
    <label class="lmdrop" data-drop="pfp"><input type="file" class="fin" accept="image/*" data-p="upload"><b>Drag &amp; drop your picture here</b><span class="mut small">or <u>browse files</u> · PNG, JPEG, GIF or WebP</span></label>
    <div class="orline"><span>or</span></div><button class="obtn" data-p="nft">Choose an NFT you own</button>
    ${avatar ? '<button class="lnk small removepfp" data-p="remove">Remove profile picture</button>' : ''}</div>
  <p class="${msg.startsWith('✓') ? 'ok' : 'err'}" data-p="msg">${esc(msg)}</p><button class="bbtn" data-p="save">Save profile</button> <a class="obtn" href="/u/${a}">View profile</a>`}</div>`;
}
async function load() {
  if (!wallet.address) { current = null; avatar = ''; draw(); return; }
  try { const j = await api(`/profiles?addresses=${wallet.address}`); current = j.profiles[wallet.address.toLowerCase()]; avatar = current.avatar; nft = current.nft; } catch {}
  draw();
}

function thumb(n: GalNft) {
  if (n.image) return n.image;
  const foot = CFG.collections.find(c => c.slug === 'lil-foots')?.deployments.find(d => d.chain === n.chain && d.address.toLowerCase() === n.contract);
  return foot ? `/img/lil-foots/s/${n.id}.webp` : '';
}
function label(n: GalNft) { return n.name || (n.collection ? `${n.collection} #${n.id}` : `#${n.id}`); }

async function pickNft() {
  if (!wallet.address) { openConnect(); return; }
  const state: { loading: boolean; err: string; items: GalNft[]; filter: string; q: string; cursors: Record<string, string | null>; unsupported: string[]; failed: string[]; selected: GalNft | null; manual: boolean; moreBusy: boolean } = {
    loading: true, err: '', items: [], filter: '', q: '', cursors: {}, unsupported: [], failed: [], selected: null, manual: false, moreBusy: false,
  };
  const m = overlay(`<h3>Choose your NFT</h3><div class="nftgal" data-g></div>`);
  const box = m.querySelector('.wbox') as HTMLElement; box.classList.add('wide', 'nftgalbox');
  const root = m.querySelector('[data-g]') as HTMLElement;

  const visible = () => {
    const q = state.q.trim().toLowerCase();
    return state.items.filter(n => (!state.filter || n.chain === state.filter)
      && (!q || [n.name, n.collection, n.id, n.contract].some(x => (x || '').toLowerCase().includes(q))));
  };

  const paint = () => {
    if (state.manual) {
      root.innerHTML = `<p class="mut small">Enter a MultiSea collection deployment and token ID. Ownership is checked on-chain when you save.</p>
        <div class="nftpick"><label>Collection deployment<select data-m="dep">${deployments.map((d, i) => `<option value="${i}">${esc(d.collection)} · ${logo(d.chain)} ${esc(chains[d.chain].name)}</option>`).join('')}</select></label>
        <label>Token ID<input data-m="id" type="number" min="0" step="1" placeholder="e.g. 42"></label>
        <label>NFT image <span class="mut small">Square crop</span><input data-m="file" type="file" accept="image/*"><span class="mut small">Upload the NFT artwork.</span></label>
        <button class="bbtn" data-m="use">Use this NFT</button><button class="lnk small" data-m="back">← Back to gallery</button></div>`;
      return;
    }
    const list = visible();
    const chips = `<div class="nftgalfilters"><button class="pill${!state.filter ? ' on' : ''}" data-f="">All</button>${GALLERY_CHAINS.map(k => `<button class="pill${state.filter === k ? ' on' : ''}" data-f="${k}">${logo(k)} ${esc(chains[k].name)}</button>`).join('')}</div>
      <input class="nftgalsearch" data-q placeholder="Search by name, collection or token ID" value="${esc(state.q)}">`;
    let body = '';
    if (state.loading) body = `<div class="nftgalstate"><span class="spin"></span> Loading NFTs from your wallet…</div>`;
    else if (state.err && !state.items.length) body = `<div class="nftgalstate err">${esc(state.err)}<br><button class="obtn" data-m="retry" style="margin-top:10px">Retry</button></div>`;
    else if (!list.length) body = `<div class="nftgalstate"><b>No NFTs here</b><p class="mut small">${state.items.length ? 'Nothing matches this filter.' : 'This wallet does not hold NFTs on the indexed MultiSea chains yet.'}</p></div>`;
    else body = `<div class="nftgalgrid">${list.map((n, i) => {
      const sel = state.selected && state.selected.chain === n.chain && state.selected.contract === n.contract && state.selected.id === n.id;
      const src = thumb(n);
      return `<button type="button" class="nftgalcard${sel ? ' on' : ''}" data-i="${state.items.indexOf(n)}" title="${esc(label(n))}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="nftgalph">NFT</div>'}<div><b>${esc(label(n))}</b><span>${logo(n.chain)}${n.standard && /1155/.test(n.standard) ? ' · 1155' : ''}</span></div></button>`;
    }).join('')}</div>`;
    const hardFail = state.failed.filter(k => !state.unsupported.includes(k));
    const notes = [hardFail.length ? `Couldn’t reach ${hardFail.map(k => chains[k]?.name || k).join(', ')}.` : '',
      state.unsupported.length ? `${state.unsupported.map(k => chains[k]?.name || k).join(', ')} ${state.unsupported.length > 1 ? 'are' : 'is'} not on OpenSea yet${insightOn('bnb') && state.unsupported.includes('bnb') ? ' (BNB loaded via Insight when available)' : ''}.` : '']
      .filter(Boolean).join(' ');
    const canMore = state.filter ? !!state.cursors[state.filter] : Object.values(state.cursors).some(Boolean);
    root.innerHTML = `${chips}${body}
      ${notes ? `<p class="mut small nftgalnote">${esc(notes)}</p>` : ''}
      <div class="nftgalacts">${canMore ? `<button class="obtn" data-m="more"${state.moreBusy ? ' disabled' : ''}>${state.moreBusy ? 'Loading…' : 'Load more'}</button>` : ''}
        ${state.selected ? `<button class="bbtn" data-m="confirm">Use selected NFT</button>` : ''}
        <button class="lnk small" data-m="manual">Can't find it?</button></div>`;
  };

  const merge = (arr: GalNft[]) => {
    const seen = new Set(state.items.map(n => `${n.chain}:${n.contract}:${n.id}`));
    for (const n of arr) {
      if (!n.contract || n.id === '') continue;
      // Prefer ERC-721; keep ERC-1155 (ownership checked via balanceOf on save). Skip unknowns that look like 1155-only spam later.
      const k = `${n.chain}:${n.contract}:${n.id}`; if (seen.has(k)) continue; seen.add(k); state.items.push(n);
    }
  };

  async function loadOs(chain?: string, next?: string) {
    const q = new URLSearchParams(); if (chain) q.set('chain', chain); if (next) q.set('next', next);
    const j = await api(`/profile/nfts${q.toString() ? '?' + q : ''}`, { auth: true, statement: 'Load your MultiSea NFT gallery.' });
    merge(j.nfts || []);
    if (j.cursors) state.cursors = { ...state.cursors, ...j.cursors };
    if (chain && 'next' in j) state.cursors[chain] = j.next || null;
    state.failed = [...new Set([...(state.failed || []), ...(j.failed || [])])];
    state.unsupported = j.unsupported || state.unsupported;
  }

  async function loadBnb(page = 0) {
    if (!insightOn('bnb') || !wallet.address) return;
    try {
      const { nfts, more } = await ownedNfts('bnb', wallet.address, page, 50);
      merge(nfts);
      state.cursors.bnb = more ? String(page + 1) : null;
      state.unsupported = state.unsupported.filter(k => k !== 'bnb');
    } catch (e: any) {
      if (!state.items.length) state.failed = [...new Set([...state.failed, 'bnb'])];
    }
  }

  async function boot() {
    state.loading = true; state.err = ''; paint();
    try {
      await Promise.all([loadOs(), loadBnb(0)]);
      // Hard error only when OpenSea-backed chains failed and we have nothing to show (BNB Insight is best-effort).
      if (!state.items.length && state.failed.some(k => k !== 'bnb' && !state.unsupported.includes(k))) state.err = 'Could not load your NFTs. Try again, or use “Can\'t find it?”.';
    } catch (e: any) { state.err = e?.message || String(e); }
    state.loading = false; paint();
  }

  root.addEventListener('click', async e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-f],[data-i],[data-m]'); if (!t) return;
    if (t.dataset.f != null) { state.filter = t.dataset.f; paint(); return; }
    if (t.dataset.i != null) { state.selected = state.items[+t.dataset.i]; paint(); return; }
    const act = t.dataset.m;
    if (act === 'manual') { state.manual = true; paint(); return; }
    if (act === 'back') { state.manual = false; paint(); return; }
    if (act === 'retry') { boot(); return; }
    if (act === 'more') {
      state.moreBusy = true; paint();
      try {
        if (state.filter === 'bnb' && state.cursors.bnb) await loadBnb(+state.cursors.bnb);
        else if (state.filter && state.cursors[state.filter]) await loadOs(state.filter, state.cursors[state.filter] || undefined);
        else {
          for (const [k, n] of Object.entries(state.cursors)) {
            if (!n) continue;
            if (k === 'bnb') await loadBnb(+n); else await loadOs(k, n);
          }
        }
      } catch (e: any) { state.err = e?.message || String(e); }
      state.moreBusy = false; paint(); return;
    }
    if (act === 'confirm' && state.selected) {
      t.textContent = 'Preparing image…'; (t as HTMLButtonElement).disabled = true;
      try { await applyNft(state.selected); m.remove(); draw(); }
      catch (e: any) { t.textContent = e?.message || 'Failed'; (t as HTMLButtonElement).disabled = false; }
      return;
    }
    if (act === 'use') {
      const d = deployments[+(root.querySelector('[data-m=dep]') as HTMLSelectElement).value];
      const idEl = root.querySelector('[data-m=id]') as HTMLInputElement;
      const fileEl = root.querySelector('[data-m=file]') as HTMLInputElement;
      if (!idEl.value || !fileEl.files?.[0]) { fileEl.setCustomValidity('Choose the NFT image'); fileEl.reportValidity(); return; }
      t.textContent = 'Cropping and uploading…'; (t as HTMLButtonElement).disabled = true;
      try {
        const file = await square(fileEl.files[0]); const image = await uploadImage(file, 512);
        nft = { chain: d.chain, contract: d.address, id: idEl.value, image }; avatar = image; m.remove(); draw();
      } catch (e: any) { t.textContent = e?.message || 'Upload failed'; (t as HTMLButtonElement).disabled = false; }
    }
  });
  root.addEventListener('input', e => {
    const inp = e.target as HTMLInputElement; if (inp.dataset.q == null) return;
    state.q = inp.value; paint();
    const s = root.querySelector('.nftgalsearch') as HTMLInputElement | null; if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  });
  boot();
}

async function applyNft(n: GalNft) {
  let file: File | null = null;
  const src = thumb(n);
  if (src) {
    try {
      if (src.startsWith('/') && !src.startsWith('//')) {
        const r = await fetch(src); if (!r.ok) throw new Error('thumb ' + r.status);
        file = new File([await r.blob()], 'nft.png', { type: r.headers.get('content-type') || 'image/png' });
      } else {
        // Remote OpenSea / Insight images: try CORS fetch; fall back to drawing via <img crossOrigin>.
        try {
          const r = await fetch(src, { mode: 'cors', referrerPolicy: 'no-referrer' });
          if (!r.ok) throw new Error('http ' + r.status);
          file = new File([await r.blob()], 'nft.png', { type: r.headers.get('content-type') || 'image/png' });
        } catch {
          file = await rasterize(src);
        }
      }
    } catch { file = null; }
  }
  if (!file) {
    // Ask for a one-off upload tied to this NFT (ownership still checked on save).
    file = await askImage(n);
  }
  const cropped = await square(file); const image = await uploadImage(cropped, 512);
  nft = { chain: n.chain, contract: n.contract, id: n.id, image, ...(n.standard ? { standard: n.standard } : {}) };
  avatar = image;
}
function rasterize(url: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      c.toBlob(b => b ? resolve(new File([b], 'nft.png', { type: 'image/png' })) : reject(new Error('Could not read NFT image')), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load NFT image'));
    img.src = url;
  });
}
function askImage(n: GalNft): Promise<File> {
  return new Promise((resolve, reject) => {
    const sub = overlay(`<h3>NFT image needed</h3><p class="mut small">We couldn't pull the artwork for <b>${esc(label(n))}</b>. Upload a square crop of it.</p>
      <input type="file" accept="image/*"><button class="bbtn" style="margin-top:12px">Continue</button>`);
    const inp = sub.querySelector('input') as HTMLInputElement; const btn = sub.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', () => {
      if (!inp.files?.[0]) { inp.setCustomValidity('Choose an image'); inp.reportValidity(); return; }
      const f = inp.files[0]; sub.remove(); resolve(f);
    });
    sub.addEventListener('click', e => { if (e.target === sub || (e.target as HTMLElement).classList.contains('mx')) reject(new Error('Cancelled')); });
  });
}

el.addEventListener('click', async e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-p]'); if (!b) return;
  try {
    if (b.dataset.p === 'connect') openConnect();
    if (b.dataset.p === 'nft') await pickNft();
    if (b.dataset.p === 'remove') { avatar = ''; nft = null; draw(); }
    if (b.dataset.p === 'save') {
      if (!getSession()) await signIn('Save your MultiSea profile.', ['multisea:profile']);
      b.textContent = 'Saving…';
      const j = await api('/profile', { auth: true, body: { name: (el.querySelector('[data-p=name]') as HTMLInputElement).value, avatar: nft ? '' : avatar, nft } });
      current = j.profile; avatar = current.avatar; nft = current.nft; msg = '✓ Profile saved';
      const { invalidateProfiles } = await import('./names'); invalidateProfiles(wallet.address!); draw();
    }
  } catch (e: any) { msg = e?.message || String(e); draw(); }
});
async function uploadPfp(f: File) {
  try {
    msg = 'Uploading square crop…'; draw(); const file = await square(f); avatar = await uploadImage(file, 512); nft = null; msg = '✓ Image uploaded. Save your profile to apply it.'; draw();
  } catch (e: any) { msg = e?.message || String(e); draw(); }
}
el.addEventListener('dragover', e => { const z = (e.target as HTMLElement).closest('[data-drop=pfp]'); if (!z) return; e.preventDefault(); z.classList.add('over'); });
el.addEventListener('dragleave', e => { (e.target as HTMLElement).closest('[data-drop=pfp]')?.classList.remove('over'); });
el.addEventListener('drop', e => { const z = (e.target as HTMLElement).closest('[data-drop=pfp]'); if (!z) return; e.preventDefault(); z.classList.remove('over');
  const f = e.dataTransfer?.files?.[0]; if (f) uploadPfp(f); });
el.addEventListener('change', async e => {
  const inp = e.target as HTMLInputElement; if (inp.dataset.p !== 'upload' || !inp.files?.[0]) return;
  await uploadPfp(inp.files[0]);
});
async function square(file: File): Promise<File> {
  const bmp = await createImageBitmap(file), n = Math.min(bmp.width, bmp.height), size = Math.min(1024, n);
  const c = document.createElement('canvas'); c.width = c.height = size;
  c.getContext('2d')!.drawImage(bmp, (bmp.width - n) / 2, (bmp.height - n) / 2, n, n, 0, 0, size, size);
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not crop image'); return new File([blob], 'profile.png', { type: 'image/png' });
}
onWallet(load); load(); draw();
export { profileAvatar };
