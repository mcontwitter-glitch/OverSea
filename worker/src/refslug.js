// Referral link slugs derived from MultiSea display names.
// KV: refslug:<slug> → address (permanent; old names keep crediting the same wallet)
//     refslugof:<addr> → current slug (cleared when the name is removed or cannot be slugified)
//     refslugs:<addr> → JSON array of every slug ever reserved by that wallet
export const HEX_CODE = /^[0-9a-f]{8}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;

export const isHexCode = s => HEX_CODE.test(String(s || '').toLowerCase());

/** Lowercase slug: spaces, dots and underscores become hyphens. Empty if too short/long after cleanup. */
export function rawSlug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[ . _]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length >= 2 && s.length <= 24 ? s : '';
}

/** Usable name-link slug, or '' if the name cannot be used in /r/<slug> (including 8-hex, which is reserved for numeric codes). */
export function slugify(name) {
  const s = rawSlug(name);
  return !s || isHexCode(s) ? '' : s;
}

export async function resolveRef(env, token) {
  const c = String(token || '').trim().toLowerCase();
  if (!c) return null;
  if (isHexCode(c)) {
    const a = await env.COLLECTIONS.get('refcode:' + c);
    return a ? { address: a, code: c, kind: 'code' } : null;
  }
  if (!SLUG_RE.test(c)) return null;
  const a = await env.COLLECTIONS.get('refslug:' + c);
  return a ? { address: a, slug: c, kind: 'slug' } : null;
}

export async function reserveSlug(env, addr, name) {
  addr = String(addr || '').toLowerCase();
  const slug = slugify(name);
  if (!slug) {
    await env.COLLECTIONS.delete('refslugof:' + addr);
    return null;
  }
  const cur = await env.COLLECTIONS.get('refslug:' + slug);
  if (cur && cur !== addr) return null;
  if (!cur) await env.COLLECTIONS.put('refslug:' + slug, addr);
  await env.COLLECTIONS.put('refslugof:' + addr, slug);
  const list = (await env.COLLECTIONS.get('refslugs:' + addr, 'json')) || [];
  if (!list.includes(slug)) {
    list.push(slug);
    await env.COLLECTIONS.put('refslugs:' + addr, JSON.stringify(list));
  }
  return slug;
}

/** Current name-link slug for a wallet. If they have a usable name but it was never reserved, reserve it now. */
export async function currentSlug(env, addr, name) {
  const s = slugify(name);
  if (!s) return null;
  addr = String(addr || '').toLowerCase();
  const owner = await env.COLLECTIONS.get('refslug:' + s);
  if (owner === addr) return s;
  if (owner) return null;
  return reserveSlug(env, addr, name);
}

export async function slugTakenByOther(env, addr, name) {
  const s = rawSlug(name);
  if (!s || isHexCode(s)) return false;
  const owner = await env.COLLECTIONS.get('refslug:' + s);
  return !!(owner && owner !== String(addr || '').toLowerCase());
}
