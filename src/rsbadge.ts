// 💰 badge on a collection header when that collection has revenue share enabled.
// Fetched after first paint; hidden when disabled or when the request fails.
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type RsConfig = { enabled?: boolean; feeShareBps?: number; royaltyShareBps?: number };

export function revshareEnabled(cfg: RsConfig | null | undefined): cfg is RsConfig {
  return !!cfg && cfg.enabled === true;
}

export function revshareTip(cfg: RsConfig): string {
  const fee = (Number(cfg.feeShareBps) || 0) / 100;
  let tip = `Revenue share on: holders earn ${fee}% of MultiSea's fee`;
  const roy = Number(cfg.royaltyShareBps) || 0;
  if (roy > 0) tip += ` and ${roy / 100}% of the creator royalty`;
  return tip;
}

export function revshareBadgeHtml(slug: string, cfg: RsConfig | null | undefined): string {
  if (!revshareEnabled(cfg)) return '';
  return `<a class="rsbadge" href="/revenue-share?c=${encodeURIComponent(slug)}" title="${esc(revshareTip(cfg))}">💰</a>`;
}

/** GET /revshare/:slug → config. Returns null on failure; never throws. */
export async function loadRevshareConfig(api: string, slug: string, fetchImpl: typeof fetch = fetch): Promise<RsConfig | null> {
  try {
    const r = await fetchImpl(`${api}/revshare/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const j = await r.json();
    const cfg = j && (j.config || (typeof j.enabled === 'boolean' ? j : null));
    return cfg && typeof cfg === 'object' ? cfg as RsConfig : null;
  } catch {
    return null;
  }
}
