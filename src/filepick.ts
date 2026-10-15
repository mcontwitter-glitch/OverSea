// Styled image picker: visually-hidden native input + pill button, filename in muted text, local thumbnail preview.
import { esc } from './shell';
const names: Record<string, string> = {}; const local: Record<string, string> = {};
export function pickHtml(k: 'logo' | 'banner', src: string, enabled: boolean) {
  const img = local[k] || src;
  return `<div class="pick"><img class="pv ${k === 'logo' ? 'lg' : 'bn'}" src="${esc(img)}" alt="">${enabled
    ? `<span class="fpick"><input type="file" class="fin" accept="image/*" data-f="${k}"><span class="upbtn" aria-hidden="true">${k === 'logo' ? 'Upload logo' : 'Upload banner'}</span><span class="fname mut small">${esc(names[k] || 'No file chosen')}</span></span>`
    : '<span class="mut small">Image uploads coming soon</span>'}</div>`;
}
/** Call on change: records the name, shows a local thumbnail immediately. */
export function picked(inp: HTMLInputElement) {
  const f = inp.files?.[0]; const k = inp.dataset.f; if (!f || !k) return;
  names[k] = f.name; if (local[k]) URL.revokeObjectURL(local[k]); local[k] = URL.createObjectURL(f);
  const pick = inp.closest('.pick'); if (!pick) return;
  (pick.querySelector('.pv') as HTMLImageElement).src = local[k];
  (pick.querySelector('.fname') as HTMLElement).textContent = f.name;
}
export function resetPicks() { for (const k in local) URL.revokeObjectURL(local[k]); for (const o of [names, local]) for (const k in o) delete o[k]; }
