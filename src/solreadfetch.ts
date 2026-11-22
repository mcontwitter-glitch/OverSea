// Shared by the collection-page Solana connection: first successful JSON-RPC response among a list of
// URLs (Worker /rpc/solana, then publicnode). The next URL starts after hedgeMs, or immediately if one fails.
export function firstGoodSolRead(urls: string[], init: RequestInit = {}, hedgeMs = 600, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false, last = 'no rpc', timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean, v: Response | string) => { if (done) return; done = true; if (timer) clearTimeout(timer); ok ? resolve(v as Response) : reject(new Error(String(v))); };
    const launch = () => {
      if (done) return;
      if (next >= urls.length) { if (!running) finish(false, last); return; }
      const u = urls[next++]; running++;
      const headers = new Headers(init.headers || undefined); headers.set('content-type', 'application/json');
      fetchImpl(u, { ...init, headers })
        .then(async r => {
          const text = await r.text();
          let good = r.ok;
          if (good) {
            try { const j = JSON.parse(text); good = Array.isArray(j) ? j.length > 0 && j.every(x => x && !x.error) : !!(j && typeof j === 'object' && !j.error && 'result' in j); }
            catch { good = false; }
          }
          if (!good) throw new Error((u + ' bad').slice(0, 120));
          finish(true, new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }));
        })
        .catch(e => { last = e?.message || String(e); running--; if (!done) launch(); });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (!done) launch(); }, hedgeMs);
    };
    launch();
  });
}
