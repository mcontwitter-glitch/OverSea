// Holders tab: wallets linked to one MultiSea profile count as ONE holder (counts summed, chains combined, shown under the
// profile wallet so the row carries the profile name). `profileOf` comes from /profile/resolve (walletlinks.resolveProfiles).
export type HolderLoc = { chain: string; owner: string; also?: HolderLoc[] };
export type HolderRow = [string, { n: number; chains: Set<string>; wallets: Set<string> }];
export const holderKey = (a: string) => (a.startsWith('0x') ? a.toLowerCase() : a);
export function mergeHolders(locs: HolderLoc[], profileOf: Record<string, string> = {}, only?: Set<string>): HolderRow[] {
  const by = new Map<string, HolderRow[1]>();
  for (const l of locs) for (const x of [l, ...(l.also || [])]) {
    if (only?.size && !only.has(x.chain)) continue;
    const w = holderKey(x.owner), k = profileOf[w] || w;
    const h = by.get(k) || { n: 0, chains: new Set<string>(), wallets: new Set<string>() };
    h.n++; h.chains.add(x.chain); h.wallets.add(w); by.set(k, h);
  }
  return [...by.entries()].sort((a, b) => b[1].n - a[1].n);
}
/** How many wallet-holders disappear when linked wallets are merged (for the Owners stat). */
export function mergedAway(locs: HolderLoc[], profileOf: Record<string, string>) {
  const wallets = new Set(locs.flatMap(l => [l, ...(l.also || [])]).map(x => holderKey(x.owner)));
  return wallets.size - mergeHolders(locs, profileOf).length;
}
