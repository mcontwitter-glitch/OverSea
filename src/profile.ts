import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect } from './wallet';
import { frame, esc, logo, chains } from './gx';
import { api, getSession, signIn, uploadImage } from './auth';
import { picked } from './filepick';
import { profileAvatar, profileName, shortAddr } from './names';

const el = frame('me', 'Edit profile', 'page profileedit');
let current: any = null, avatar = '', nft: any = null, msg = '';
const deployments = CFG.collections.flatMap(c => c.deployments.map(d => ({ ...d, collection: c.name })));
function media(u: string) { return u.startsWith('/media/') ? new URL(u, (import.meta.env.VITE_API_BASE as string) || 'https://api.multisea.io').href : u; }
function draw() {
  const a = wallet.address;
  el.innerHTML = `<div class="profeditor"><h1>Edit profile</h1><p class="mut">Choose how you appear across MultiSea, including holder chat.</p>
  ${!a ? '<div class="fcard cta"><p>Connect your wallet to edit your profile.</p><button class="bbtn" data-p="connect">Connect wallet</button></div>' : `
  <div class="profpreview">${avatar ? `<img src="${esc(media(avatar))}" alt="Profile preview">` : '<div class="pava">YOU</div>'}<div><b>${esc(profileName(a) || shortAddr(a))}</b><p class="mut small">${esc(a)}</p></div></div>
  <label>Display name <span class="mut small">Optional · up to 24 characters</span><input data-p="name" maxlength="24" value="${esc(current?.name || '')}" placeholder="Your MultiSea name"></label>
  <div class="fcard"><div class="gh">Profile picture</div><p class="mut small">Upload a square-cropped image, or use an NFT you own. Images are stored by MultiSea.</p>
    <span class="fpick"><input type="file" class="fin" accept="image/*" data-f="logo" data-p="upload"><span class="upbtn" aria-hidden="true">Upload image</span><span class="fname mut small">PNG, JPEG, GIF or WebP</span></span>
    <div class="orline"><span>or</span></div><button class="obtn" data-p="nft">Choose an NFT you own</button>
    ${avatar ? '<button class="lnk small removepfp" data-p="remove">Remove profile picture</button>' : ''}</div>
  <p class="${msg.startsWith('✓') ? 'ok' : 'err'}" data-p="msg">${esc(msg)}</p><button class="bbtn" data-p="save">Save profile</button> <a class="obtn" href="/u/${a}">View profile</a>`}</div>`;
}
async function load() {
  if (!wallet.address) { current = null; avatar = ''; draw(); return; }
  try { const j = await api(`/profiles?addresses=${wallet.address}`); current = j.profiles[wallet.address.toLowerCase()]; avatar = current.avatar; nft = current.nft; } catch {}
  draw();
}
async function pickNft() {
  const m = (await import('./wallet')).overlay(`<h3>Choose your NFT</h3><p class="mut small">Your ownership is checked on-chain when you save.</p><div class="nftpick"><label>Collection deployment<select>${deployments.map((d, i) => `<option value="${i}">${esc(d.collection)} · ${logo(d.chain)} ${esc(chains[d.chain].name)}</option>`).join('')}</select></label><label>Token ID<input type="number" min="0" step="1" placeholder="e.g. 42"></label><label>NFT image <span class="mut small">Square crop</span><input type="file" accept="image/*"><span class="mut small">Upload the NFT artwork; ownership is checked before it becomes your pfp.</span></label><button class="bbtn">Use this NFT</button></div>`);
  m.querySelector('button')!.addEventListener('click', async () => {
    const d = deployments[+(m.querySelector('select') as HTMLSelectElement).value], ins = m.querySelectorAll('input');
    if (!ins[0].value || !ins[1].files?.[0]) { ins[1].setCustomValidity('Choose the NFT image'); ins[1].reportValidity(); return; }
    const btn=m.querySelector('button')!; btn.textContent='Cropping and uploading…'; btn.disabled=true;
    try { const file=await square(ins[1].files[0]); const image=await uploadImage(file,512); nft = { chain: d.chain, contract: d.address, id: ins[0].value, image }; avatar = image; m.remove(); draw(); } catch(e:any) { btn.textContent=e?.message||'Upload failed'; btn.disabled=false; }
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
el.addEventListener('change', async e => {
  const inp = e.target as HTMLInputElement; if (inp.dataset.p !== 'upload' || !inp.files?.[0]) return;
  try {
    picked(inp); msg = 'Uploading square crop…'; const file = await square(inp.files[0]); avatar = await uploadImage(file, 512); nft = null; msg = '✓ Image uploaded. Save your profile to apply it.'; draw();
  } catch (e: any) { msg = e?.message || String(e); draw(); }
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
