// Share on X + Copy link for collection pages and item views. Links go through the API's /s/ share-card page.
// Every shared link gets a fresh ?v= token so X always re-crawls the card instead of showing a stale/old preview.
import { esc } from './shell';
const shareUrl = (slug: string, item?: number) => `https://api.multisea.io/s/c/${encodeURIComponent(slug)}${item != null ? `?item=${item}` : ''}`;
const XI = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>';
const LI = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
// Append a short, increasing version token so the link is one X hasn't cached yet.
const freshUrl = (u: string) => u + (u.includes('?') ? '&' : '?') + 'v=' + Date.now().toString(36);
export const shareBtns = (slug: string, name: string, item?: number) => shareBtnsFor(shareUrl(slug, item), name);
export function shareBtnsFor(u: string, name: string) {
  return `<div class="sharebtns"><a class="obtn sm" href="#" data-sharex="${esc(u)}" data-sharename="${esc(name)}" target="_blank" rel="noopener">${XI} Share on X</a><button type="button" class="obtn sm" data-sharecopy="${esc(u)}">${LI} <span>Copy link</span></button></div>`;
}
document.addEventListener('click', e => {
  const x = (e.target as HTMLElement).closest<HTMLElement>('[data-sharex]');
  if (x) {
    e.preventDefault(); e.stopPropagation();
    const url = freshUrl(x.dataset.sharex!);
    const intent = `https://x.com/intent/post?text=${encodeURIComponent(x.dataset.sharename || '')}&url=${encodeURIComponent(url)}`;
    window.open(intent, '_blank', 'noopener');
    return;
  }
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sharecopy]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const s = b.querySelector('span')!;
  const done = () => { s.textContent = 'Copied'; b.classList.add('on'); setTimeout(() => { s.textContent = 'Copy link'; b.classList.remove('on'); }, 1500); };
  navigator.clipboard?.writeText(freshUrl(b.dataset.sharecopy!)).then(done).catch(() => {});
});
