// Pure helpers for Solana wallet detection and mobile browse (universal) links.
// Solflare documents that browse deeplinks must be clicked by the user — a JS
// location.href assignment often will not open the app on iOS/Android.

/** Universal-link browse URLs that open the current page in the wallet's in-app browser. */
export function walletBrowseLink(id: 'phantom' | 'solflare', href: string, origin: string) {
  const u = encodeURIComponent(href), r = encodeURIComponent(origin);
  if (id === 'phantom') return `https://phantom.app/ul/browse/${u}?ref=${r}`;
  return `https://solflare.com/ul/v1/browse/${u}?ref=${r}`;
}

/** Solflare provider: window.solflare (isSolflare / connect) or window.solana.isSolflare. */
export function detectSolflare(w: any) {
  const s = w?.solflare;
  if (s && (s.isSolflare === true || typeof s.connect === 'function')) return s;
  if (w?.solana?.isSolflare) return w.solana;
  return undefined;
}

export function isSolMobile(ua: string, maxTouchPoints = 0) {
  return /Android|iPhone|iPad|iPod/i.test(ua) || (maxTouchPoints > 1 && /Macintosh/i.test(ua));
}
