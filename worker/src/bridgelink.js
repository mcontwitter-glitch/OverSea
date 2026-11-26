import { kput } from './kvput.js';
// Mirrors of a bridged collection become part of its record (deployments + escrows) so the collection page, holder counts and trading cover every chain.
// Called when the bridge job publishes (collection already approved) and on approval (job already finished). A collection that is still pending is
// merged at approval, because the finished bridge collection (bcol:) and the nft -> job marker (bnft:) are kept in KV.
export function makeLinkBridge({ chains, lc, saveCollectionPatch }) {
  return async function linkBridge(env, slug, col0) {
    const K = env.COLLECTIONS; const col = col0 || await K.get('col:' + slug, 'json'); if (!col) return null;
    for (const d of col.deployments || []) {
      const js = await K.get('bnft:' + d.chain + ':' + lc(d.address)); if (!js) continue;
      const bc = await K.get('bcol:' + js, 'json'); if (!bc) continue;
      const dep = [...col.deployments], esc = [...(col.escrow || [])];
      for (const [k, a] of Object.entries(bc.contracts || {})) if (chains[k] && !dep.some(x => x.chain === k && lc(x.address) === lc(a))) { dep.push({ chain: k, address: lc(a), mirror: true }); await kput(K, 'idx:' + k + ':' + lc(a), slug); }
      for (const [k, a] of Object.entries(bc.escrows || {})) if (chains[k] && !esc.some(x => x.chain === k && lc(x.address) === lc(a))) esc.push({ chain: k, address: lc(a), label: 'MultiSea bridge escrow' });
      if (bc.mirrorsSlug !== slug) await kput(K, 'bcol:' + js, JSON.stringify({ ...bc, mirrorsSlug: slug }));
      return saveCollectionPatch(env, slug, { deployments: dep, escrow: esc });
    }
    return null;
  };
}

// A creator who only pays the bridge listing on /submit (no collection form) has no collection record, so the finished bridge never shows on the
// marketplace. The factory only lets the contract's owner() list, so a finished bridge job IS an owner-verified listing: publish it as an approved
// collection (source 'bridge-listing') and merge the mirrors. Skips anything already covered by a collection or a pending submission (those keep
// their own review / link path), so it is idempotent and safe to run from the cron and after every job.
export function makePublishBridged({ lc, linkBridge }) {
  return async function publishBridged(env, only) {
    const K = env.COLLECTIONS; const out = [];
    const keys = async prefix => { const names = []; let cursor; do { const l = await K.list({ prefix, cursor }); names.push(...l.keys.map(k => k.name)); cursor = l.list_complete ? undefined : l.cursor; } while (cursor); return names; };
    const cols = (await Promise.all((await keys('col:')).map(n => K.get(n, 'json')))).filter(Boolean);
    const pend = (await Promise.all((await keys('pending:')).map(n => K.get(n, 'json')))).filter(Boolean);
    const known = new Set([...cols, ...pend].flatMap(c => (c.deployments || []).map(d => d.chain + ':' + lc(d.address))));
    const slugs = new Set(cols.map(c => c.slug));
    for (const name of only ? ['bcol:' + only] : await keys('bcol:')) {
      const bc = await K.get(name, 'json'); if (!bc?.slug || !bc.native) continue;
      const nft = lc(bc.contracts?.[bc.native]); if (!nft) continue;
      if (slugs.has(bc.slug) || known.has(bc.native + ':' + nft)) continue;
      const job = await K.get('bjob:' + bc.slug, 'json'); if (!job?.direct) continue; // launchpad drops get their collection from the launchpad
      const esc = bc.escrows?.[bc.native];
      const idStart = Number.isInteger(job.firstId) ? job.firstId : 1;
      const supply = job.supply > 0 ? job.supply : undefined;
      const col = { slug: bc.slug, name: bc.name, description: '', logo: '', banner: '', deployments: [{ chain: bc.native, address: nft }], escrow: esc ? [{ chain: bc.native, address: lc(esc), label: 'MultiSea bridge escrow' }] : [],
        submitter: job.owner, status: 'approved', approvedAt: new Date().toISOString(), source: 'bridge-listing',
        ...(supply ? { supply, idStart, idEnd: idStart + supply - 1 } : {}) };
      await kput(K, 'col:' + bc.slug, JSON.stringify(col)); await kput(K, 'idx:' + bc.native + ':' + nft, bc.slug);
      await linkBridge(env, bc.slug, col); slugs.add(bc.slug); out.push(bc.slug);
    }
    return out;
  };
}
