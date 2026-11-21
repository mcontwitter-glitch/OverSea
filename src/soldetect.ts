// Pure helpers for Solana wallet detection and mobile browse (universal) links.
// Solflare documents that browse deeplinks must be clicked by the user — a JS
// location.href assignment often will not open the app on iOS/Android.
// On Android, some browsers (and Play-link fallbacks) ignore https universal
// links, so we use an intent: URL that opens the app directly.

export function isAndroid(ua: string) {
  return /Android/i.test(ua);
}

/** Universal-link (iOS/desktop) or Android intent browse URLs that open the current page in the wallet's in-app browser. */
export function walletBrowseLink(id: 'phantom' | 'solflare', href: string, origin: string, ua = '') {
  const u = encodeURIComponent(href), r = encodeURIComponent(origin);
  const android = isAndroid(ua);
  if (id === 'phantom') {
    const https = `https://phantom.app/ul/browse/${u}?ref=${r}`;
    if (!android) return https;
    return `intent://ul/browse/${u}?ref=${r}#Intent;scheme=https;host=phantom.app;package=app.phantom;S.browser_fallback_url=${encodeURIComponent(https)};end`;
  }
  const https = `https://solflare.com/ul/v1/browse/${u}?ref=${r}`;
  if (!android) return https;
  // scheme=solflare matches the app's custom-scheme handler (solflare://ul/v1/browse/...);
  // the documented https://solflare.com/ul/v1/browse/... link is the fallback.
  return `intent://ul/v1/browse/${u}?ref=${r}#Intent;scheme=solflare;package=com.solflare.mobile;S.browser_fallback_url=${encodeURIComponent(https)};end`;
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
