import GATES from './gates.js';

const MAX_MESSAGES = 50;
const MAX_TEXT = 500;
const keyOf = id => String(id || '').replace(/^chat:[^:]+:/, '');

/** Holder-only group chat. KV keys are ordered by time, so list(reverse) is a page newest-first;
 * responses are reversed for the UI (oldest to newest). No public writes or client-supplied addresses. */
export function makeHolderChat({ CFG, lc, bad, ADDR, admins, requireSession, getCollection, rpcFanout, canEdit }) {
  const gates = GATES.gates || {};
  // Collection owners (admin, editor, approved submitter or contract owner()) may set a display name; cached per isolate.
  const ownerCache = new Map();
  async function isOwner(env, slug, address) {
    const k = `${slug}:${lc(address)}`, c = ownerCache.get(k); if (c && c.t > Date.now()) return c.v;
    const v = !!(await canEdit(env, slug, address).catch(() => ({ ok: false }))).ok; ownerCache.set(k, { v, t: Date.now() + 600_000 }); return v;
  }
  const postTimes = new Map(); // isolate-local throttle; Cloudflare abuse limits can supplement this later
  function limited(address) {
    const now = Date.now(), a = (postTimes.get(address) || []).filter(t => now - t < 60_000);
    a.push(now); postTimes.set(address, a); if (postTimes.size > 5000) postTimes.clear();
    return a.length > 6;
  }
  async function holdings(env, slug, address) {
    if (!ADDR.test(address || '')) return false;
    const gate = gates[slug]; if (!gate) bad('holder chat not found', 404);
    const cacheKey = `chatgate:${slug}:${lc(address)}`;
    const cached = await env.COLLECTIONS.get(cacheKey, 'json');
    if (cached && cached.exp > Date.now()) return cached.ok === true;
    const col = await getCollection(env, slug);
    if (!col) { await env.COLLECTIONS.put(cacheKey, JSON.stringify({ ok: false, exp: Date.now() + 300_000 })); return false; }
    let ok = false;
    await Promise.all((col.deployments || []).map(async d => {
      if (ok || !CFG.chains[d.chain] || !ADDR.test(d.address || '')) return;
      try {
        const out = await rpcFanout(CFG.chains[d.chain], { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: d.address, data: '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] });
        const result = Array.isArray(out) ? out[0]?.result : out?.result;
        if (result && BigInt(result) >= BigInt(gate.minBalance)) ok = true;
      } catch { /* fail closed if every deployment cannot be read */ }
    }));
    await env.COLLECTIONS.put(cacheKey, JSON.stringify({ ok, exp: Date.now() + 300_000 }));
    return ok;
  }
  async function holder(req, env, slug) {
    const s = await requireSession(req, env);
    if (!(await holdings(env, slug, s.address))) bad(gates[slug]?.lockedText || 'holders only', 403);
    const mute = await env.COLLECTIONS.get(`chatmute:${slug}:${lc(s.address)}`, 'json');
    if (mute && mute.until > Date.now()) return { ...s, muted: true };
    return s;
  }
  async function verifyHolderSignature(env, fields) {
    const slug = (fields.resources || []).map(r => String(r).match(/^multisea:holders:([a-z0-9-]+)$/)?.[1]).find(Boolean);
    if (!slug) return;
    if (!gates[slug]) bad('holder chat not found', 404);
    if (!(await holdings(env, slug, fields.address))) bad(gates[slug].lockedText, 403);
  }
  async function page(env, slug, before) {
    const opt = { prefix: `chat:${slug}:`, limit: MAX_MESSAGES * 3, reverse: true };
    if (before) opt.end = `chat:${slug}:${before}`;
    const listed = await env.COLLECTIONS.list(opt);
    const rows = (await Promise.all(listed.keys.map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(Boolean);
    const visible = rows.filter(r => !r.deleted).slice(0, MAX_MESSAGES);
    const oldest = visible[visible.length - 1];
    return { messages: visible.reverse(), next: visible.length === MAX_MESSAGES && oldest ? keyOf(oldest.id) : null };
  }
  function admin(s, env) { if (!admins(env).includes(lc(s.address))) bad('admin only', 403); }
  return {
    holdings, verifyHolderSignature,
    async handle(req, env, url, p, M, body) {
      if (p[0] !== 'holders') return undefined;
      const slug = p[1]; if (!gates[slug]) bad('holder chat not found', 404);
      if (M === 'GET' && p[2] === 'messages' && p.length === 3) {
        const s = await holder(req, env, slug); const out = await page(env, slug, url.searchParams.get('before'));
        return { ...out, address: s.address, isAdmin: admins(env).includes(s.address), isOwner: await isOwner(env, slug, s.address), muted: !!s.muted, pollAfter: 4000 };
      }
      if (M === 'POST' && p[2] === 'messages' && p.length === 3) {
        const s = await holder(req, env, slug); if (s.muted) bad('you are muted in this holder chat', 403);
        if (limited(`${slug}:${s.address}`)) bad('slow down: up to 6 messages per minute', 429);
        const b = await body();
        let text = String(b.text || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        if (!text) bad('message is empty'); if (text.length > MAX_TEXT) bad(`message must be ${MAX_TEXT} characters or fewer`);
        const name = !(await isOwner(env, slug, s.address)) ? '' : String(b.name || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
        const now = Date.now(), id = `${String(now).padStart(16, '0')}:${crypto.randomUUID()}`;
        const rec = { id, address: lc(s.address), name, text, at: now, deleted: false };
        await env.COLLECTIONS.put(`chat:${slug}:${id}`, JSON.stringify(rec));
        return { ok: true, message: rec };
      }
      if (M === 'POST' && p[2] === 'messages' && p[3] && p[4] === 'delete') {
        const s = await requireSession(req, env); admin(s, env);
        const id = decodeURIComponent(p[3]); if (!/^\d{16}:[0-9a-f-]{36}$/.test(id)) bad('invalid message');
        const key = `chat:${slug}:${id}`, rec = await env.COLLECTIONS.get(key, 'json'); if (!rec) bad('message not found', 404);
        await env.COLLECTIONS.put(key, JSON.stringify({ ...rec, deleted: true, deletedBy: s.address, deletedAt: Date.now() })); return { ok: true };
      }
      if (M === 'POST' && p[2] === 'mute') {
        const s = await requireSession(req, env); admin(s, env); const b = await body();
        const address = lc(b.address); if (!ADDR.test(address)) bad('invalid address');
        const minutes = Math.floor(Number(b.minutes)); if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30 * 1440) bad('mute must be 1 minute to 30 days');
        const until = Date.now() + minutes * 60_000;
        await env.COLLECTIONS.put(`chatmute:${slug}:${address}`, JSON.stringify({ by: s.address, until })); return { ok: true, until };
      }
      bad('not found', 404);
    }
  };
}
