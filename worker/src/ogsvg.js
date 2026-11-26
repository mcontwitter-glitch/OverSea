// SVG for the referral share card (1200x630). Pure string builder so tests can run without wasm.
const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const REF_CARD = { width: 1200, height: 630, subtitle: 'I invited you to MultiSea' };

/** First letter of a display name, or "M" when the label is a wallet address. */
export function monogramOf(name) {
  const s = String(name || '').trim();
  if (!s || /^0x/i.test(s)) return 'M';
  const ch = [...s].find(c => /[\p{L}\p{N}]/u.test(c));
  return (ch || 'M').toUpperCase();
}

// d: { name, avatar? }  avatar is an already-inlined data URI or empty
export function refCardSvg(d) {
  const W = REF_CARD.width, H = REF_CARD.height, L = 64;
  const name = fit(String(d.name || 'MultiSea'), 24);
  const ts = name.length > 18 ? 58 : 72;
  const avatar = d.avatar || '';
  const mono = monogramOf(d.name);
  const img = avatar
    ? `<image href="${avatar}" x="${L}" y="210" width="200" height="200" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="${L + 100}" y="340" text-anchor="middle" font-family="Inter" font-weight="800" font-size="92" fill="#45bdfa">${x(mono)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1f6fd8"/><stop offset=".45" stop-color="#2684ce"/><stop offset="1" stop-color="#45bdfa"/></linearGradient>
<clipPath id="av"><rect x="${L}" y="210" width="200" height="200" rx="28"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="#05070b"/>
<rect x="0" y="${H - 8}" width="${W}" height="8" fill="url(#a)"/>
<text x="${L}" y="84" font-family="Inter" font-weight="800" font-size="38" fill="#ffffff">Multi<tspan fill="#45bdfa">Sea</tspan></text>
<text x="${W - 60}" y="84" text-anchor="end" font-family="Inter" font-weight="600" font-size="24" fill="#cfe9ff" fill-opacity=".85">multisea.io</text>
<rect x="${L - 5}" y="205" width="210" height="210" rx="32" fill="#45bdfa" fill-opacity=".9"/><rect x="${L}" y="210" width="200" height="200" rx="28" fill="#0b0f17"/>
${img}
<text x="${L + 236}" y="300" font-family="Inter" font-weight="800" font-size="${ts}" fill="#ffffff">${x(name)}</text>
<text x="${L + 236}" y="372" font-family="Inter" font-weight="800" font-size="36" fill="#45bdfa">${x(REF_CARD.subtitle)}</text>
</svg>`;
}
