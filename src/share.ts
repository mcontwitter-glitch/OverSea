// Share on X + Copy link for collection pages and item views. Links go through the API's /s/ share-card page.
import { esc } from './shell';
const shareUrl = (slug: string, item?: number) => `https://api.multisea.io/s/c/${encodeURIComponent(slug)}${item != null ? `?item=${item}` : ''}`;
const XI = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>';
const LI = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
export function shareBtns(slug: string, name: string, item?: number) {
  const u = shareUrl(slug, item);
  const x = `https://x.com/intent/post?text=${encodeURIComponent(name)}&url=${encodeURIComponent(u)}`;
  return `<div class="sharebtns"><a class="obtn sm" href="${esc(x)}" target="_blank" rel="noopener">${XI} Share on X</a><button type="button" class="obtn sm" data-sharecopy="${esc(u)}">${LI} <span>Copy link</span></button></div>`;
}
document.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sharecopy]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const s = b.querySelector('span')!;
  const done = () => { s.textContent = 'Copied'; b.classList.add('on'); setTimeout(() => { s.textContent = 'Copy link'; b.classList.remove('on'); }, 1500); };
  navigator.clipboard?.writeText(b.dataset.sharecopy!).then(done).catch(() => {});
});
