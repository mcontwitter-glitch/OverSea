// Workers KV allows ~1 write per second to the same key; a faster second write fails with "KV PUT failed: 429". Retry after a pause.
export async function kput(K, key, val, opts) {
  for (let i = 0; ; i++) {
    try { return await K.put(key, val, opts); }
    catch (e) { if (i >= 4 || !/429|too many/i.test(String(e?.message || e))) throw e; await new Promise(r => setTimeout(r, 1100)); }
  }
}
