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
      for (const [k, a] of Object.entries(bc.contracts || {})) if (chains[k] && !dep.some(x => x.chain === k && lc(x.address) === lc(a))) { dep.push({ chain: k, address: lc(a), mirror: true }); await K.put('idx:' + k + ':' + lc(a), slug); }
      for (const [k, a] of Object.entries(bc.escrows || {})) if (chains[k] && !esc.some(x => x.chain === k && lc(x.address) === lc(a))) esc.push({ chain: k, address: lc(a), label: 'MultiSea bridge escrow' });
      if (bc.mirrorsSlug !== slug) await K.put('bcol:' + js, JSON.stringify({ ...bc, mirrorsSlug: slug }));
      return saveCollectionPatch(env, slug, { deployments: dep, escrow: esc });
    }
    return null;
  };
}
