// Shared GET with backoff: used so a 429 or blip does not wipe a page that already has data.
export async function apiFetch(url: string, opts: { retries?: number } = {}): Promise<Response | null> {
  const n = Math.max(1, opts.retries ?? 3);
  let last: Response | null = null;
  for (let i = 0; i < n; i++) {
    last = await fetch(url).catch(() => null);
    if (last?.ok) return last;
    const retryable = !last || last.status === 429 || last.status >= 500;
    if (!retryable || i === n - 1) break;
    const ra = Number(last?.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 && ra < 15 ? ra * 1000 : Math.min(4000, 400 * 2 ** i);
    await new Promise(r => setTimeout(r, wait + Math.floor(Math.random() * 120)));
  }
  return last;
}
