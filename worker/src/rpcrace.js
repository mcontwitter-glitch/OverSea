// Hedged JSON-RPC across a chain's public RPC list: start the first URL, and if it has not answered within
// `hedgeMs` (or fails) start the next one; the first good answer wins and the others are aborted.
// Each attempt has its own timeout. Up to `rounds` passes over the list.
// A JSON-RPC rate-limit / internal / capacity error counts as a failure so the next URL is tried.
export const RPC_HEDGE_MS = 400, RPC_TIMEOUT_MS = 3000;
export const isRpcBusy = out => (Array.isArray(out) ? out : [out]).some(x => x?.error && (x.error.code === -32005 || x.error.code === -32603 || /rate|limit|capacity|timeout|unavailable/i.test(x.error.message || '')));

export function rpcRace(urls, payload, { hedgeMs = RPC_HEDGE_MS, timeoutMs = RPC_TIMEOUT_MS, rounds = 2, fetchImpl = fetch } = {}) {
  const queue = []; for (let r = 0; r < rounds; r++) queue.push(...urls);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let next = 0, running = 0, done = false, last = 'no rpc', timer = null;
    const ctrls = new Set();
    const finish = (ok, v) => { if (done) return; done = true; clearTimeout(timer); for (const c of ctrls) try { c.abort(); } catch {} ok ? resolve(v) : reject(new Error(v)); };
    const launch = () => {
      clearTimeout(timer);
      if (done) return;
      if (next >= queue.length) { if (!running) finish(false, last); return; }
      const u = queue[next++]; running++;
      const ac = new AbortController(); ctrls.add(ac);
      const to = setTimeout(() => ac.abort(), timeoutMs);
      fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ac.signal })
        .then(async r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const out = await r.json();
          if (isRpcBusy(out)) throw new Error((Array.isArray(out) ? out : [out]).find(x => x?.error)?.error?.message || 'busy');
          finish(true, out);
        })
        .catch(e => { last = u + ' ' + (e?.name === 'AbortError' ? 'timeout' : (e?.message || e)); if (!done) { running--; launch(); } })
        .finally(() => { clearTimeout(to); ctrls.delete(ac); });
      // Hedge: if this attempt is still pending after hedgeMs, start the next URL alongside it.
      timer = setTimeout(() => { if (running < 3) launch(); }, hedgeMs);
    };
    launch();
  });
}
