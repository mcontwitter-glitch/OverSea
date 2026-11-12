// Themed chain picker over a native <select>: the select stays in the DOM (hidden) as the source of truth, so the
// page's existing change handlers and .value reads keep working. Same look and keys as the Collections sort menu.
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function chainPicker(sel: HTMLSelectElement, logoFor: (value: string) => string, label = 'Chain') {
  if (sel.dataset.cp) return; sel.dataset.cp = '1';
  const wrap = document.createElement('div'); wrap.className = 'cpick';
  const opts = [...sel.options];
  const row = (o: HTMLOptionElement) => `<img class="cl" src="${esc(logoFor(o.value))}" alt=""><span>${esc(o.text)}</span>`;
  wrap.innerHTML = `<button type="button" class="cpbtn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">${row(sel.selectedOptions[0] || opts[0])}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><ul class="csmenu cpmenu" role="listbox" tabindex="-1" hidden>${opts.map((o, i) => `<li role="option" data-i="${i}" aria-selected="${o.selected}" ${o.disabled ? 'aria-disabled="true"' : ''}>${row(o)}<i>✓</i></li>`).join('')}</ul>`;
  sel.hidden = true; sel.tabIndex = -1; sel.after(wrap); sel.parentElement?.classList.add('cp-on');
  const btn = wrap.querySelector<HTMLButtonElement>('.cpbtn')!, menu = wrap.querySelector<HTMLElement>('.cpmenu')!, lis = [...menu.querySelectorAll<HTMLElement>('li')];
  const ok = (n: number) => !opts[n].disabled;
  let i = 0; const hi = (n: number) => { i = n; lis.forEach((l, k) => l.classList.toggle('hi', k === i)); lis[i]?.scrollIntoView({ block: 'nearest' }); };
  const step = (d: number) => { for (let k = 1; k <= lis.length; k++) { const n = (i + d * k + lis.length * k) % lis.length; if (ok(n)) return hi(n); } };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  const close = (focus = false) => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); if (focus) btn.focus(); };
  const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); hi(Math.max(0, sel.selectedIndex)); menu.focus(); document.addEventListener('pointerdown', outside, true); };
  const pick = (n: number) => { if (!ok(n)) return; close(true); if (n === sel.selectedIndex) return; sel.selectedIndex = n; sel.dispatchEvent(new Event('change', { bubbles: true })); if (wrap.isConnected) { btn.firstElementChild!.replaceWith(...new DOMParser().parseFromString(row(opts[n]), 'text/html').body.childNodes); lis.forEach((l, k) => l.setAttribute('aria-selected', String(k === n))); } };
  btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden ? open() : close(); });
  btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  menu.addEventListener('click', e => { e.stopPropagation(); const l = (e.target as HTMLElement).closest<HTMLElement>('li'); if (l) pick(+l.dataset.i!); });
  menu.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') step(1); else if (e.key === 'ArrowUp') step(-1); else if (e.key === 'Home') { i = -1; step(1); } else if (e.key === 'End') { i = lis.length; step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') pick(i); else if (e.key === 'Escape') close(true); else if (e.key === 'Tab') { close(); return; } else return;
    e.preventDefault();
  });
}
