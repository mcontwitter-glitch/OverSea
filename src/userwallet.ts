// A public address wallet, not an ERC-6551 account: every send comes directly from the connected owner.
import { createWalletClient, custom, encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { renderSVG } from 'uqr';
import { wallet, onWallet, readClient, ensureChain, vchain, friendly, openConnect, openKeyExport, API } from './wallet';
import { chains, esc, short, logo } from './gx';
import { loadProfile, profileAvatar, profileName } from './names';
import { FW_CHAINS, chainBalances, chainUsd, NATIVE, TOKENS, fmtUsd, rateOf, parseFootName, footTba, type ChainBal, type FwChain } from './footkit';
import { usdRates, type UsdRates } from './shell';
import CFG from '../config/collections.json';
import { ownedNfts, insightOn, walletTransfers, collectionTransfers, type OwnedNft } from './insight';
import { sol, onSol, shortSol, signSolMessage } from './solconnect';
import { openSolConnect } from './solmenu';
import { profileWallets, authorizeLink, finishLink, unlinkWallet, MAX_LINKED, type ProfileWallets } from './walletlinks';
import { imageSrc } from './datauri';
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)']);
const ERC721 = parseAbi(['function safeTransferFrom(address,address,uint256)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address,address,uint256,uint256,bytes)', 'function balanceOf(address,uint256) view returns (uint256)']);
type Nft = OwnedNft & { wallet?: string; quantity?: string; acquiredTs?: number; mintedTs?: number; acquiredBlock?: number; mintedBlock?: number };
type Bal = { k: string; bal: ChainBal; usd: number | null };
type Asset = { key: string; k: string; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
type Tx = { to: Hex; value: bigint; data: Hex };
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const imageUrl = (s: string | null) => imageSrc(s, API);
// MultiSea's own collections use the site's thumbnails (animated for Island's), whatever image the indexer returned.
const OWN = new Map(CFG.collections.flatMap(c => c.deployments.map(d => [d.chain + ':' + d.address.toLowerCase(), c] as const)));
const ownCol = (n: Nft) => { const c = OWN.get(n.chain + ':' + String(n.contract).toLowerCase()); const id = Number(n.id); return c && Number.isInteger(id) && id >= c.idStart && id <= c.idEnd ? { c, id } : null; };
const own = (n: Nft): Nft => { const x = ownCol(n); return x ? { ...n, image: `/img/${x.c.slug}/s/${x.id}.webp` } : n; };
const itemHref = (n: Nft) => { const x = ownCol(n); return x ? `/c/${x.c.slug}?item=${x.id}` : (n as any).href || ''; };
const chainName = (k: string) => chains[k]?.name || (k === 'solana' ? 'Solana' : k);
const nftKey = (n: Nft) => `${n.chain}|${n.contract.toLowerCase()}|${n.id}`;
const nftCard = (n: Nft, me: boolean) => {
  const href = itemHref(n);
  const send = me && /^(erc721|erc1155)$/.test(n.standard || '') ? `<button type="button" class="obtn sm" data-send="${esc(nftKey(n))}">Send</button>` : '';
  const pack = /1155/.test(n.standard || '') || (n as any).pack;
  const inner = `${imageUrl(n.image) ? `<img src="${esc(imageUrl(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chainName(n.chain))}${pack ? ' · pack' : ''}${n.quantity && n.quantity !== '1' ? ' × ' + esc(n.quantity) : ''}${send}${pack ? ` · <a href="/my-packs">Open</a>` : ''}</div>`;
  return href ? `<a class="nftc" href="${esc(href)}">${inner}</a>` : `<div class="nftc">${inner}</div>`;
};
const NFT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'] as const;
function colInfo(n: Nft): { key: string; label: string } {
  const x = ownCol(n);
  if (x) return { key: 'ms:' + x.c.slug, label: x.c.name };
  const ms = (n as any).msSlug && CFG.collections.find(c => c.slug === (n as any).msSlug); if (ms) return { key: 'ms:' + ms.slug, label: ms.name };
  const slug = (n.collection || '').trim();
  const key = slug ? 'col:' + slug.toLowerCase() : 'ct:' + n.chain + ':' + String(n.contract).toLowerCase();
  const fromName = (n.name || '').replace(/\s*#\s*\d+\s*$/, '').trim();
  const label = fromName || (slug ? slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : short(n.contract));
  return { key, label };
}
function cmpNew(a: Nft, b: Nft, ts: (n: Nft) => number | undefined, block: (n: Nft) => number | undefined) {
  const at = ts(a), bt = ts(b);
  if (at && bt && at !== bt) return bt - at;
  if (at && !bt) return -1;
  if (bt && !at) return 1;
  const ab = block(a), bb = block(b);
  if (ab && bb && ab !== bb) return bb - ab;
  if (ab && !bb) return -1;
  if (bb && !ab) return 1;
  const aid = Number(a.id), bid = Number(b.id);
  if (Number.isFinite(aid) && Number.isFinite(bid) && aid !== bid) return bid - aid;
  if (Number.isFinite(aid) && !Number.isFinite(bid)) return -1;
  if (Number.isFinite(bid) && !Number.isFinite(aid)) return 1;
  return (a.name || '#' + a.id).localeCompare(b.name || '#' + b.id, undefined, { numeric: true, sensitivity: 'base' });
}
let dropDateCache: Map<string, number> | null = null;
async function dropDates() {
  if (dropDateCache) return dropDateCache;
  const out = new Map<string, number>();
  try {
    const j = await (await fetch(`${API}/launchpad/drops`)).json();
    for (const d of j.drops || []) {
      if (!d.slug) continue;
      const starts = (d.phases || []).map((p: any) => Number(p.start) || 0).filter((n: number) => n > 0);
      let ts = starts.length ? Math.min(...starts) : 0;
      if (!ts && d.approvedAt) ts = Math.floor(Date.parse(d.approvedAt) / 1000);
      if (!ts && d.submittedAt) ts = Math.floor(Date.parse(d.submittedAt) / 1000);
      if (ts) out.set(d.slug, ts);
    }
  } catch {}
  dropDateCache = out;
  return out;
}
function rememberMint(map: Map<string, { ts: number; block: number }>, key: string, ts: number, block: number) {
  const prev = map.get(key); if (!prev || ts < prev.ts) map.set(key, { ts, block });
}
async function attachTimes(list: Nft[], owner: string) {
  const me = owner.toLowerCase();
  const acquired = new Map<string, { ts: number; block: number }>(), minted = new Map<string, { ts: number; block: number }>(), mintedId = new Map<string, { ts: number; block: number }>();
  const need = [...new Set(list.map(n => n.chain).filter(insightOn))];
  const cols = [...new Set(list.map(n => ownCol(n)?.c).filter((c): c is NonNullable<typeof c> => !!c))];
  const [drops] = await Promise.all([
    dropDates(),
    ...need.map(k => walletTransfers(k, owner).then(xs => {
      for (const x of xs) {
        const key = `${x.chain}|${String(x.contract).toLowerCase()}|${String(x.id)}`;
        if (x.to.toLowerCase() === me && x.type !== 'burn') {
          const prev = acquired.get(key); if (!prev || x.ts > prev.ts) acquired.set(key, { ts: x.ts, block: x.block });
        }
        if (x.type === 'mint') rememberMint(minted, key, x.ts, x.block);
      }
    }).catch(() => {})),
    ...cols.flatMap(c => c.deployments.filter(d => insightOn(d.chain)).map(d => collectionTransfers(d.chain, d.address, 500).then(xs => {
      for (const x of xs) if (x.type === 'mint') {
        rememberMint(minted, `${x.chain}|${String(x.contract).toLowerCase()}|${String(x.id)}`, x.ts, x.block);
        rememberMint(mintedId, 'ms:' + c.slug + ':' + String(x.id), x.ts, x.block);
      }
    }).catch(() => {}))),
  ]);
  for (const n of list) {
    const a = acquired.get(nftKey(n)); if (a) { n.acquiredTs = a.ts; n.acquiredBlock = a.block; }
    const x = ownCol(n);
    const m = minted.get(nftKey(n)) || (x ? mintedId.get('ms:' + x.c.slug + ':' + x.id) : undefined);
    const colTs = x ? drops.get(x.c.slug) : undefined;
    if (m) { n.mintedTs = m.ts; n.mintedBlock = m.block; }
    else if (colTs) n.mintedTs = colTs;
  }
}
export function mountUserWallet(root: HTMLElement, address: Hex) {
  const allChains = [...FW_CHAINS, 'abstract'];
  const S = { balances: [] as Bal[], rates: null as UsdRates | null, nfts: null as Nft[] | null, note: '', cursors: {} as Record<string, string>, insightPage: {} as Record<string, number>, busy: false, receive: false, chain: '', col: '', sort: 'recent' as 'recent' | 'minted' | 'az',
    prof: undefined as ProfileWallets | null | undefined, mine: [] as Bal[], wal: '', add: /^#add-(solana|wallet)$/.test(location.hash), pending: '' , lnErr: '', lnBusy: '' };
  const me0 = address.toLowerCase();
  const isMe = () => !!wallet.address && wallet.address.toLowerCase() === me0;
  // Multi-wallet profile: `primary` owns the name/avatar; NFTs and balances are combined across its wallets.
  const primary = () => S.prof?.profile || me0;
  const linked = () => S.prof?.wallets || [];
  const evmWallets = () => [...new Set([primary(), ...linked().filter(w => w.kind === 'evm').map(w => w.addr)])] as Hex[];
  const solWallets = () => linked().filter(w => w.kind === 'sol').map(w => w.addr);
  const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === primary();
  const PKEY = () => 'msea-link-pending:' + primary();
  try { const p = JSON.parse(sessionStorage.getItem('msea-link-pending:' + me0) || 'null'); if (p && Date.now() - p.t < 540_000) { S.pending = p.nonce; S.add = true; } } catch {}
  const wnfts = () => (S.nfts || []).filter(n => !S.wal || n.wallet === S.wal);
  const multi = () => evmWallets().length + solWallets().length > 1;
  const wlabel = (a: string) => (a.startsWith('0x') ? short(a) : shortSol(a));
  const assets = (): Asset[] => {
    const out: Asset[] = [];
    S.mine.forEach(c => {
      if (c.bal.native) out.push({ key: c.k + '|native', k: c.k, kind: 'native', label: chains[c.k].native, bal: c.bal.native, decimals: 18 });
      (TOKENS[c.k as FwChain] || []).forEach((t, i) => { const b = c.bal.tokens[i]; if (b) out.push({ key: c.k + '|' + t.address, k: c.k, kind: 'erc20', label: t.symbol, bal: b, decimals: t.decimals, token: t.address }); });
    });
    (S.nfts || []).filter(n => (!n.wallet || n.wallet === me0) && chains[n.chain] && /^(erc721|erc1155)$/.test(n.standard || '')).forEach(n => out.push({ key: nftKey(n), k: n.chain, kind: 'nft', label: n.name || '#' + n.id, bal: BigInt(n.quantity || '1'), decimals: 0, nft: n }));
    return out;
  };
  const wkey = (n: Nft) => (n.wallet || '') + '|' + nftKey(n);
  let buf: Nft[] | null = null; // refresh collects here so the grid doesn't flash empty
  const merge = (list: Nft[], w: string) => { const out = [...new Map([...((buf ?? S.nfts) || []), ...list.map(own).map(n => ({ ...n, wallet: w }))].map(n => [wkey(n), n])).values()]; if (buf) buf = out; else S.nfts = out; };
  // Cursor / insight-page keys are `${wallet}|${chain}` so each linked EVM wallet pages on its own.
  async function walletNftsOf(w: Hex, fresh: boolean) {
    const r = await fetch(`${API}/wallet/${w}/nfts${fresh ? "?fresh=1" : ""}`); if (!r.ok) throw Error(`NFT list unavailable (API ${r.status}).`);
    const j = await r.json(); merge(j.nfts || [], w);
    Object.entries(j.cursors || {}).forEach(([k, c]) => { S.cursors[w + '|' + k] = c as string; });
    const failures = new Set<string>(j.failed || []), unsupported: string[] = [];
    await Promise.all((j.unsupported || []).map(async (k: string) => {
      if (!insightOn(k)) { unsupported.push(k); return; }
      try { const x = await ownedNfts(k, w); merge(x.nfts, w); if (x.more) S.insightPage[w + '|' + k] = 1; } catch { failures.add(k); }
    }));
    return { notes: (j.notes || []) as string[], failures, unsupported };
  }
  async function nfts(fresh = false) {
    buf = []; S.cursors = {}; S.insightPage = {};
    const ws = evmWallets(); const res = await Promise.allSettled(ws.map(w => walletNftsOf(w, fresh)));
    const got = buf as Nft[]; buf = null;
    if (res.every(r => r.status === 'rejected')) { S.nfts = null; throw (res[0] as PromiseRejectedResult).reason; }
    S.nfts = [...got, ...(S.nfts || []).filter(n => n.chain === 'solana')];
    const failures = new Set<string>(), unsupported = new Set<string>(), notes = new Set<string>();
    res.forEach(r => { if (r.status === 'fulfilled') { r.value.failures.forEach(k => failures.add(k)); r.value.unsupported.forEach(k => unsupported.add(k)); r.value.notes.forEach(n => notes.add(n)); } });
    const down = ws.filter((_, i) => res[i].status === 'rejected');
    S.note = [...notes, down.length ? `Couldn't load NFTs of ${down.map(short).join(', ')}; refresh to retry.` : '', failures.size ? `Couldn't load all NFTs on ${[...failures].map(k => chains[k]?.name || k).join(', ')}; refresh to retry.` : '', unsupported.size ? `NFT indexing unavailable on ${[...unsupported].map(k => chains[k]?.name || k).join(', ')}.` : ''].filter(Boolean).join(' ');
    await Promise.all(ws.map(w => attachTimes((S.nfts || []).filter(n => n.wallet === w), w)));
  }
  // Linked wallets (worker KV) and the Solana NFTs of the Solana ones (src/solnfts.ts, public RPC, free).
  let profTask: Promise<void> | null = null;
  const fetchProf = (fresh = false) => (profTask ??= profileWallets(address, fresh).then(p => { S.prof = p; if (p && p.profile !== me0) loadProfile(p.profile).then(draw); draw(); }).finally(() => { profTask = null; }));
  async function loadSol(fresh = false) {
    const ws = solWallets(); if (!ws.length) return;
    const { solanaNfts } = await import('./solnfts');
    const rs = await Promise.all(ws.map(w => solanaNfts(w, fresh).then(r => ({ ...r, w })).catch(() => ({ nfts: [], note: 'Couldn’t load Solana NFTs; refresh to retry.', w }))));
    S.nfts = [...(S.nfts || []).filter(n => n.chain !== 'solana'), ...rs.flatMap(r => (r.nfts as unknown as Nft[]).map(n => ({ ...n, wallet: r.w })))];
    const ns = [...new Set(rs.map(r => r.note).filter(Boolean))]; if (ns.length) S.note = [S.note, ...ns].filter(Boolean).join(' ');
  }
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  async function evmSignAs(addr: string, message: string) {
    if (!wallet.provider || wallet.address?.toLowerCase() !== addr.toLowerCase()) throw Error(`Connect ${short(addr)} first.`);
    return createWalletClient({ transport: custom(wallet.provider) }).signMessage({ account: wallet.address as Hex, message });
  }
  const setPending = (n: string) => { S.pending = n; try { n ? sessionStorage.setItem(PKEY(), JSON.stringify({ nonce: n, t: Date.now() })) : sessionStorage.removeItem(PKEY()); } catch {} };
  async function linkStep(a: string) {
    S.lnErr = '';
    if (a === 'auth') { S.lnBusy = `Approve in your profile wallet (${short(primary())})…`; draw(); setPending(await authorizeLink(primary(), m => evmSignAs(primary(), m))); }
    if (a === 'sol' || a === 'evm') {
      const w = a === 'sol' ? sol.address : wallet.address; if (!w) throw Error(a === 'sol' ? 'Connect a Solana wallet first.' : 'Connect the EVM wallet to add first.');
      S.lnBusy = `Approve in ${a === 'sol' ? sol.name : 'your wallet'} (${wlabel(w)})…`; draw();
      try { S.prof = await finishLink(S.pending, w, async m => (a === 'sol' ? b64(await signSolMessage(m)) : evmSignAs(w, m))); }
      catch (e: any) { if (/expired|unknown/i.test(e?.message || '')) setPending(''); throw e; }
      setPending(''); S.add = false; if (location.hash) history.replaceState(null, '', location.pathname);
      S.lnBusy = ''; draw(); await load(true);
    }
    S.lnBusy = '';
  }
  async function doUnlink(w: string) {
    const by = isOwner() ? primary() : wallet.address?.toLowerCase() === w ? w : sol.address === w ? w : '';
    if (!by) throw Error('Connect the profile wallet or that wallet to unlink it.');
    S.lnErr = ''; S.lnBusy = `Approve unlink in your wallet…`; draw();
    S.prof = await unlinkWallet(primary(), w, by, async m => (by.startsWith('0x') ? evmSignAs(by, m) : b64(await signSolMessage(m))));
    S.lnBusy = ''; if (S.wal === w) S.wal = ''; S.nfts = (S.nfts || []).filter(n => n.wallet !== w); await load(true);
  }
  const canUnlink = (w: string) => isOwner() || wallet.address?.toLowerCase() === w || sol.address === w;
  const walletChip = (w: string, kind: 'evm' | 'sol', main = false) => kind === 'evm'
    ? `<a class="chipw" href="/u/${esc(w)}" title="${esc(w)}${main ? ' · profile wallet' : ''}"><img src="/logos/ethereum.svg" alt="">${esc(short(w))}${main && multi() ? ' <span class="mut">★</span>' : ''}</a>`
    : `<a class="chipw sol" href="https://solscan.io/account/${esc(w)}" target="_blank" rel="noopener" title="${esc(w)}"><img src="/logos/solana.svg" alt="">${esc(shortSol(w))}</a>`;
  const walletsRow = () => `<div class="uwsol uwwallets">${walletChip(primary(), 'evm', true)}${linked().map(w => `<span class="uwwl">${walletChip(w.addr, w.kind)}${canUnlink(w.addr) ? `<button class="lnk small" data-uwl="unlink" data-w="${esc(w.addr)}" ${S.lnBusy ? 'disabled' : ''}>Unlink</button>` : ''}</span>`).join('')}${isOwner() && S.prof !== undefined && linked().length < MAX_LINKED && !S.add ? `<button class="chipw add" data-uwl="add">＋ Add wallet</button>` : ''}</div>${!S.add && S.lnErr ? `<p class="err small">${esc(S.lnErr)}</p>` : ''}${!S.add && S.lnBusy ? `<p class="mut small"><span class="spin"></span> ${esc(S.lnBusy)}</p>` : ''}`;
  const addCard = () => {
    const done1 = !!S.pending, evmOther = !!wallet.address && wallet.address.toLowerCase() !== primary();
    return `<div class="solcard"><h4>Add a wallet to this profile<button class="x sm" data-uwl="close" aria-label="Close">✕</button></h4>
      <div class="mut small">Its NFTs and balances then show here with your others, and collection pages count your wallets as one holder. Free: you only sign messages, no transaction. Up to ${MAX_LINKED} wallets; linked wallets are public on your profile.</div>
      <ul class="steps"><li><span class="n ${done1 ? 'd' : 'c'}">${done1 ? '✓' : '1'}</span><div><b>Confirm with your profile wallet</b><div class="mut small">${done1 ? `Confirmed by ${esc(short(primary()))} · valid 10 minutes` : isOwner() ? `<button class="obtn sm" data-uwl="auth" ${S.lnBusy ? 'disabled' : ''}>Sign with ${esc(short(primary()))}</button>` : `Connect ${esc(short(primary()))} to start.`}</div></div></li>
      <li><span class="n ${done1 ? 'c' : ''}">2</span><div style="min-width:0;flex:1"><b>Sign with the wallet you're adding</b>${done1 ? `<div class="mut small" style="margin-top:6px"><b>Solana:</b> ${sol.address ? `<button class="bbtn solb sm" data-uwl="sol" ${S.lnBusy ? 'disabled' : ''}>Sign with ${esc(sol.name)} · ${esc(shortSol(sol.address))}</button> <button class="lnk small" data-uwl="solconnect">change</button>` : '<button class="obtn sm" data-uwl="solconnect">Connect Phantom, Solflare…</button>'}</div>
        <div class="mut small" style="margin-top:6px"><b>EVM:</b> ${evmOther ? `<button class="obtn sm" data-uwl="evm" ${S.lnBusy ? 'disabled' : ''}>Sign with ${esc(short(wallet.address!))}</button>` : 'switch to the other account in your wallet app (or <button class="lnk small" data-uwl="connect">connect another wallet</button>); this page stays open.'}</div>` : ''}</div></li></ul>
      ${S.lnBusy ? `<p class="mut small"><span class="spin"></span> ${esc(S.lnBusy)}</p>` : ''}${S.lnErr ? `<p class="err small">${esc(S.lnErr)}</p>` : ''}</div>`;
  };
  const sumBal = (xs: ChainBal[]): ChainBal => ({ ok: xs.every(x => x.ok), native: xs.some(x => x.native == null) ? null : xs.reduce((n, x) => n + x.native!, 0n), tokens: (xs[0]?.tokens || []).map((_, i) => xs.some(x => x.tokens[i] == null) ? null : xs.reduce((n, x) => n + x.tokens[i]!, 0n)) });
  async function load(fresh = false) {
    if (S.busy) return; S.busy = true; draw();
    await (profTask ?? fetchProf(fresh));
    const ws = evmWallets(), mi = ws.indexOf(me0 as Hex);
    const nftTask = nfts(fresh).catch(e => { S.note = friendly(e); }).then(draw);
    const solTask = nftTask.then(() => loadSol(fresh)).catch(() => {}).then(draw);
    const rates = await usdRates().catch(() => ({ ETH: null, APE: null, BNB: null } as UsdRates)); S.rates = rates;
    const price = (k: string, bal: ChainBal) => {
      const usd = k === 'abstract' ? !bal.ok || (bal.native && rates.ETH == null) ? null : Number(formatUnits(bal.native || 0n, 18)) * (rates.ETH || 0) : chainUsd(k as FwChain, bal, rates);
      // A missing token balance is a partial chain read, never a misleading zero.
      const missingPrice = k !== 'abstract' && (TOKENS[k as FwChain] || []).some((t, i) => bal.tokens[i] && t.px !== 'USD' && rates[t.px] == null);
      return { k, bal, usd: missingPrice || bal.tokens.some(v => v == null) ? null : usd };
    };
    const per = await Promise.all(allChains.map(async k => k === 'abstract'
      ? Promise.all(ws.map(a => readClient(k).getBalance({ address: a }).then((native: bigint) => ({ native, tokens: [], ok: true } as ChainBal)).catch(() => ({ native: null, tokens: [], ok: false } as ChainBal))))
      : chainBalances(k as FwChain, ws)));
    S.balances = allChains.map((k, i) => price(k, sumBal(per[i])));
    S.mine = mi < 0 ? [] : allChains.map((k, i) => price(k, per[i][mi]));
    await nftTask; await solTask; S.busy = false; draw();
  }
  function collections() {
    const seen = new Map<string, string>();
    for (const n of S.nfts || []) { const c = colInfo(n); if (!seen.has(c.key)) seen.set(c.key, c.label); }
    const ms = CFG.collections.map(c => 'ms:' + c.slug);
    return [...seen.entries()].sort((a, b) => {
      const ia = ms.indexOf(a[0]), ib = ms.indexOf(b[0]);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1; if (ib >= 0) return 1;
      return a[1].localeCompare(b[1], undefined, { sensitivity: 'base' });
    });
  }
  function visible(): Nft[] {
    const list = (S.nfts || []).filter(n => (!S.wal || n.wallet === S.wal) && (!S.chain || n.chain === S.chain) && (!S.col || colInfo(n).key === S.col));
    if (S.sort === 'az') return [...list].sort((a, b) => (a.name || '#' + a.id).localeCompare(b.name || '#' + b.id, undefined, { numeric: true, sensitivity: 'base' }));
    if (S.sort === 'minted') return [...list].sort((a, b) => cmpNew(a, b, n => n.mintedTs, n => n.mintedBlock));
    return [...list].sort((a, b) => cmpNew(a, b, n => n.acquiredTs, n => n.acquiredBlock));
  }
  function draw() {

    const me = isMe(), owner = isOwner(), name = profileName(primary()) || profileName(address) || short(primary()), avatar = imageUrl(profileAvatar(primary()) || profileAvatar(address) || null);
    const total = S.balances.length && S.balances.every(c => c.usd != null) ? S.balances.reduce((n, c) => n + c.usd!, 0) : null;
    root.innerHTML = `<div class="fw uw"><section class="fwcard fwid glow"><div class="fwtop"><div class="fwnftw">${avatar ? `<img class="fwnft" src="${esc(avatar)}" alt="Profile picture">` : `<div class="fwnft uwletter">${esc(name[0].toUpperCase())}</div>`}</div><div style="min-width:0"><span class="fwtag">MultiSea profile</span><h1>${esc(name)}</h1></div></div>
      <div class="fwaddr"><span class="mono fwfull">${address}</span><button class="fwcopy" data-uw="copy" aria-label="Copy address">⧉</button></div>
      ${walletsRow()}${S.add && (owner || S.pending) ? addCard() : ''}${me && !owner && S.prof ? `<div class="fwnote">This wallet is linked to the profile of <a href="/u/${esc(primary())}">${esc(name)}</a>. Edit the profile from ${esc(short(primary()))}.</div>` : ''}
      <div class="fwacts">${me ? '<button class="fwbtn pri" data-uw="send">↗ Send</button>' : ''}<button class="fwbtn on" data-uw="receive">↙ Receive</button>${me ? `${owner ? '<a class="fwbtn" href="/me/profile">Edit profile</a>' : ''}<a class="fwbtn" href="/me">My activity</a><button class="fwbtn" data-uw="copy">Copy address</button>${wallet.provider?.isMultiSeaEmbedded ? '<button class="fwbtn" data-uw="export">🔑 Export private key</button>' : ''}` : ''}</div>
      ${!me ? `<div class="fwnote">View only.${!wallet.address ? ' <button class="lnk" data-uw="connect">Connect</button> your wallet to send from your own profile.' : ' Only the connected owner can send.'}</div>` : ''}
      ${S.receive ? `<div class="fwrecv"><div class="fwqr">${renderSVG(address, { border: 1, ecc: 'M' })}</div><div><h4>Receive NFTs and crypto</h4><div class="hint">Use this address on the supported chain. Transfers stay on the chain used by the sender.</div></div></div>` : ''}
      <p class="small"><a href="/me?as=${address}">NFT activity across chains →</a></p></section>
      <div class="fwright"><section class="fwcard fwtotal"><h3>Total value</h3><div class="v silver">${S.balances.length ? fmtUsd(total) : '…'}</div><div class="mut small">${evmWallets().length > 1 ? evmWallets().length + ' EVM wallets combined · ' : ''}6 chains · coins and tokens priced live · NFTs not priced${S.balances.some(c => c.usd == null) ? ' · total unavailable: incomplete balances or prices' : ''}</div></section>
      <section class="fwcard fwsec"><div class="sechd"><h3>Balances by chain</h3></div><div class="fwgrid">${allChains.map(k => {
        const c = S.balances.find(c => c.k === k); const rows: string[] = [];
        if (c?.bal.native) rows.push(`<div class="fwtok"><b>${fmt(c.bal.native)} ${esc(chains[k].native)}</b></div>`);
        (TOKENS[k as FwChain] || []).forEach((t, i) => { const v = c?.bal.tokens[i]; if (v) rows.push(`<div class="fwtok"><b>${fmt(v, t.decimals)} ${esc(t.symbol)}</b></div>`); });
        return `<div class="fwch" data-chain="${k}"><div class="chh"><span class="chn">${logo(k)}${esc(chains[k].name)}</span><span class="chv">${c ? fmtUsd(c.usd) : '…'}</span></div>${rows.join('') || `<div class="mut small">${!c ? 'Loading…' : !c.bal.ok ? 'Couldn’t read this chain' : 'Empty'}</div>`}${c && c.bal.tokens.some(v => v == null) ? '<div class="mut small">Some token balances unavailable</div>' : ''}${k === 'abstract' ? '<div class="mut small">Native coin only</div>' : ''}</div>`;
      }).join('')}</div></section>
      <section class="fwcard fwsec"><div class="sechd"><h3>NFTs${S.nfts ? ' · ' + visible().length + (visible().length !== S.nfts.length ? ' of ' + S.nfts.length : '') : ''}</h3><div class="nfttools"><select class="sort" data-uw-sort aria-label="Sort NFTs">${[['recent', 'Most recent'], ['minted', 'Recently minted'], ['az', 'A–Z']].map(([v, n]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select><button class="fwrbtn" data-uw="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Refresh'}</button></div></div>
      ${S.nfts?.length && multi() ? `<div class="chips">${[['', 'All wallets'], ...evmWallets().map(w => [w, short(w)]), ...solWallets().map(w => [w, shortSol(w)])].map(([w, l]) => `<button type="button" class="chip ${S.wal === w ? 'on' : ''}" data-nft-wal="${esc(w)}">${w ? `<img class="chipico" src="/logos/${w.startsWith('0x') ? 'ethereum' : 'solana'}.svg" alt="">` : ''}${esc(l)} <em>${(S.nfts || []).filter(n => !w || n.wallet === w).length}</em></button>`).join('')}</div>` : ''}
      ${S.nfts?.length ? `<div class="chips">${[['','All', wnfts().filter(n => !S.col || colInfo(n).key === S.col).length] as [string, string, number], ...[...NFT_CHAINS, ...(solWallets().length || S.nfts.some(n => n.chain === 'solana') ? ['solana'] : [])].map(k => [k, chainName(k), wnfts().filter(n => n.chain === k && (!S.col || colInfo(n).key === S.col)).length] as [string, string, number])].map(([k, n, c]) => `<button type="button" class="chip ${S.chain === k ? 'on' : ''}" data-nft-chain="${esc(k)}">${k ? logo(k) : ''}${esc(n)} <em>${c}</em></button>`).join('')}</div>
      <div class="chips">${[['','All', wnfts().filter(n => !S.chain || n.chain === S.chain).length] as [string, string, number], ...collections().map(([k, n]) => [k, n, wnfts().filter(x => colInfo(x).key === k && (!S.chain || x.chain === S.chain)).length] as [string, string, number])].map(([k, n, c]) => `<button type="button" class="chip ${S.col === k ? 'on' : ''}" data-nft-col="${esc(k)}">${esc(n)} <em>${c}</em></button>`).join('')}</div>
      ${visible().length ? `<div class="fwnftg">${visible().map(n => nftCard(n, me && (!n.wallet || n.wallet === me0))).join('')}</div>` : `<p class="mut small">${S.chain || S.col ? 'No NFTs match these filters.' : 'No NFTs found.'}</p>`}` : `<p class="mut small">${S.nfts == null ? S.busy ? 'Loading NFTs…' : 'NFT list unavailable.' : 'No NFTs found.'}</p>`}
      ${[...Object.keys(S.cursors).map(k => ['more', k]), ...Object.keys(S.insightPage).map(k => ['insight', k])].map(([t, wk]) => { const [w, k] = wk.split('|'); return `<button class="obtn sm" data-${t}="${esc(wk)}">More on ${esc(chains[k].name)}${evmWallets().length > 1 ? ' · ' + esc(short(w)) : ''}</button>`; }).join('')}
      ${S.note ? `<p class="mut small">${esc(S.note)}</p>` : ''}</section></div></div>`;
  }
  async function resolveRecipient(raw: string): Promise<Hex> {
    const s = raw.trim(); if (isAddress(s)) return getAddress(s);
    const id = parseFootName(s); if (id) return footTba(id);
    if (s.toLowerCase().endsWith('.eth')) { const a = await readClient('ethereum').getEnsAddress({ name: normalize(s) }); if (a) return a; throw Error('ENS name has no address.'); }
    throw Error('Enter a 0x address, .eth name or LIL FOOT name.');
  }
  function txFor(a: Asset, to: Hex, amount: bigint): Tx {
    if (a.kind === 'native') return { to, value: amount, data: '0x' };
    if (a.kind === 'erc20') return { to: a.token!, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }) };
    const n = a.nft!;
    return { to: n.contract as Hex, value: 0n, data: n.standard === 'erc1155' ? encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [address, to, BigInt(n.id), amount, '0x'] }) : encodeFunctionData({ abi: ERC721, functionName: 'safeTransferFrom', args: [address, to, BigInt(n.id)] }) };
  }
  function openSend(pre?: string) {
    if (!isMe() || document.querySelector('.uwsend')) return;
    const screen = document.createElement('section');
    screen.className = 'uwsend'; screen.setAttribute('role', 'dialog'); screen.setAttribute('aria-modal', 'true'); screen.setAttribute('aria-labelledby', 'uwsend-title');
    screen.innerHTML = `<header class="uwsend-head"><button class="uwsend-back" aria-label="Back">←</button><h1 id="uwsend-title">Send</h1></header><main class="uwsend-body"></main>`;
    const back = screen.querySelector('button')!, body = screen.querySelector('main')!;
    const prev = document.activeElement as HTMLElement | null, scrollY = window.scrollY;
    const savedBody = document.body.style.cssText, savedOverflow = document.documentElement.style.overflow;
    document.body.style.position = 'fixed'; document.body.style.top = `-${scrollY}px`; document.body.style.width = '100%'; document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(screen);
    let inStep = false, busySending = false, disposeStep = () => {};
    const close = () => { disposeStep(); screen.remove(); document.removeEventListener('keydown', keys); document.body.style.cssText = savedBody; document.documentElement.style.overflow = savedOverflow; window.scrollTo(0, scrollY); prev?.focus({ preventScroll: true }); };
    const goBack = () => { if (busySending) return; if (inStep) showList(); else close(); };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      if (e.key === 'Tab') {
        const focusable = [...screen.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keys); back.addEventListener('click', goBack);
    const icon = (a: Asset) => a.kind === 'nft' ? `<span class="uwsend-icon">${imageUrl(a.nft!.image) ? `<img class="uwsend-thumb" src="${esc(imageUrl(a.nft!.image))}" alt="">` : '<span>NFT</span>'}${logo(a.k, 'uwsend-badge')}</span>` : `<span class="uwsend-icon">${a.label === 'ETH' || a.label === 'WETH' ? logo('ethereum', 'uwsend-coin') : a.label === 'APE' || a.label === 'WAPE' ? logo('apechain', 'uwsend-coin') : a.label === 'BNB' ? logo('bnb', 'uwsend-coin') : `<span class="uwsend-symbol">${esc(a.label.slice(0, 4))}</span>`}${logo(a.k, 'uwsend-badge')}</span>`;
    const assetUsd = (a: Asset) => {
      if (!S.rates || a.kind === 'nft') return null;
      const px = a.kind === 'native' ? NATIVE[a.k as FwChain]?.px || 'ETH' : TOKENS[a.k as FwChain]?.find(t => t.address === a.token)?.px;
      const rate = px ? rateOf(px, S.rates) : null;
      return rate == null ? null : Number(formatUnits(a.bal, a.decimals)) * rate;
    };
    // USD for an amount of this asset / for native-coin gas on chain k (same live rates as the asset card).
    const rateFor = (a: Asset) => { if (!S.rates || a.kind === 'nft') return null; const px = a.kind === 'native' ? NATIVE[a.k as FwChain]?.px || 'ETH' : TOKENS[a.k as FwChain]?.find(t => t.address === a.token)?.px; return px ? rateOf(px, S.rates) : null; };
    const usdTxt = (v: number | null) => (v == null || !isFinite(v) ? '' : v > 0 && v < 0.01 ? '<$0.01' : fmtUsd(v));
    const amtUsd = (a: Asset, amt: bigint) => { const r = rateFor(a); return r == null ? null : Number(formatUnits(amt, a.decimals)) * r; };
    const gasUsd = (k: string, wei: bigint) => { const r = S.rates ? rateOf(NATIVE[k as FwChain]?.px || 'ETH', S.rates) : null; return r == null ? null : Number(formatUnits(wei, 18)) * r; };
    function showList() {
      disposeStep(); inStep = false; back.setAttribute('aria-label', 'Close Send');
      const list = assets(), tokens = list.filter(a => a.kind !== 'nft' && a.bal > 0n);
      // Same NFT collection as the profile, including any unsupported transfer standards (shown but disabled).
      const nfts = S.nfts || [];
      body.innerHTML = `<div class="uwsend-content"><h2>Tokens</h2><div class="uwsend-tokens">${tokens.map(a => `<button class="uwsend-token" data-pick="${esc(a.key)}">${icon(a)}<span class="uwsend-label"><b>${esc(a.label)}</b><small>${esc(chains[a.k].name)}</small></span><span class="uwsend-value"><b>${fmt(a.bal, a.decimals)}</b><small>${fmtUsd(assetUsd(a))}</small></span><span class="uwsend-chevron">›</span></button>`).join('') || '<p class="mut">No token balances.</p>'}</div><h2 class="uwsend-nfttitle">NFTs</h2><div class="uwsend-nfts">${nfts.map(n => `<button class="uwsend-nft" data-pick="${esc(nftKey(n))}" ${list.some(a => a.key === nftKey(n)) ? '' : 'disabled title="Transfer standard unavailable"'}><span class="uwsend-art">${imageUrl(n.image) ? `<img src="${esc(imageUrl(n.image))}" alt="" loading="lazy">` : '<span class="uwmissing">NFT</span>'}${logo(n.chain, 'uwsend-badge')}</span><b>${esc(n.name || '#' + n.id)}</b><small>${esc(chains[n.chain]?.name || n.chain)}</small></button>`).join('')}</div>${!nfts.length ? '<p class="mut">No NFTs found.</p>' : ''}${S.note ? `<p class="uwsend-note">${esc(S.note)}</p>` : ''}</div>`;
      body.scrollTop = 0;
      body.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach(b => b.addEventListener('click', () => { const a = list.find(a => a.key === b.dataset.pick); if (a) showStep(a); }));
      back.focus();
    }
    function showStep(a: Asset) {
      disposeStep(); inStep = true; back.setAttribute('aria-label', 'Back to assets');
      const single = a.kind === 'nft' && a.nft?.standard === 'erc721';
      body.innerHTML = `<div class="uwsend-content uwsend-step fwsend"><div class="uwsend-selected">${icon(a)}<div><b>${esc(a.label)}</b><small>${esc(chains[a.k].name)}</small></div><span class="uwsend-value"><b>${a.kind === 'nft' ? 'NFT' : fmt(a.bal, a.decimals)}</b>${a.kind !== 'nft' ? `<small>${fmtUsd(assetUsd(a))}</small>` : ''}</span></div><p class="uwsend-note">Direct transfer on ${esc(chains[a.k].name)}. You pay normal gas. No bridging.</p><div data-amount ${single ? 'hidden' : ''}><label class="lbl" for="uwamt">Amount <span data-k="balance"></span></label><div class="fld"><input id="uwamt" data-k="amount" placeholder="0.0" inputmode="decimal" autocomplete="off"><button type="button" class="uwsend-max" data-k="max">Max</button></div><div class="mut small" data-k="usd" aria-live="polite"></div></div><label class="lbl" for="uwto">Recipient</label><div class="fld"><input id="uwto" data-k="to" placeholder="0x…, name.eth, LIL FOOT #N" autocomplete="off" spellcheck="false"></div><div class="fwsum" data-k="summary" aria-live="polite">Enter an amount and recipient to estimate gas.</div><button class="bbtn" data-k="go" disabled>Send</button><div class="fwmsg" data-k="msg" role="status"></div></div>`;
      body.scrollTop = 0;
      const m = body.querySelector<HTMLElement>('.uwsend-step')!;
      const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
      let seq = 0, sending = false, sent = false;
      let quote: { a: Asset; tx: Tx; gas: bigint; price: bigint; fingerprint: string } | null = null;
      const fingerprint = () => [a.key, q('amount').value, q('to').value].join('|');
      const update = async () => {
        if (sending || sent || !m.isConnected) return;
        const my = ++seq; quote = null; q('go').disabled = true;
        const single = a.kind === 'nft' && a.nft?.standard === 'erc721';
        (m.querySelector('[data-amount]') as HTMLElement).hidden = single;
        q('balance').textContent = a.kind === 'nft' && !single ? 'ERC-1155' : `Balance ${fmt(a.bal, a.decimals)}`;
        if (!q('to').value.trim()) { q('summary').textContent = 'Enter a recipient to estimate gas.'; return; }
        const fp = fingerprint(); q('summary').textContent = 'Estimating gas…';
        try {
          if (!isMe()) throw Error('Connect the profile owner wallet.');
          if (!single && !/^\d+(?:\.\d+)?$/.test(q('amount').value.trim())) throw Error('Enter a positive amount.');
          const amount = single ? 1n : parseUnits(q('amount').value.trim(), a.decimals);
          if (!single && (q('amount').value.split('.')[1]?.length || 0) > a.decimals) throw Error('Too many decimal places.');
          const to = await resolveRecipient(q('to').value);
          if (/^0x0{40}$/i.test(to) || to.toLowerCase() === address.toLowerCase()) throw Error('Enter a different, nonzero recipient.');
          const pc = readClient(a.k);
          const balance = a.nft?.standard === 'erc1155' ? await pc.readContract({ address: a.nft.contract as Hex, abi: ERC1155, functionName: 'balanceOf', args: [address, BigInt(a.nft.id)] }) as bigint : a.bal;
          if (amount <= 0n || amount > balance) throw Error('Amount exceeds balance or is zero.');
          const tx = txFor(a, to, amount);
          const [estimate, price, native] = await Promise.all([pc.estimateGas({ account: address, ...tx }), pc.getGasPrice(), pc.getBalance({ address })]);
          const gas = estimate * 120n / 100n;
          if (tx.value + gas * price > native) throw Error('Insufficient funds for amount + gas on this chain.');
          if (my !== seq || fp !== fingerprint() || !m.isConnected) return;
          quote = { a, tx, gas, price, fingerprint: fp };
          q('summary').innerHTML = `<div><span>Direct on</span><b>${esc(chains[a.k].name)}</b></div><div><span>Recipient</span><b class="mono" style="overflow-wrap:anywhere">${to}</b></div><div><span>Amount</span><b>${fmt(amount, a.decimals)} ${esc(a.label)}${usdTxt(amtUsd(a, amount)) ? ` (≈ ${usdTxt(amtUsd(a, amount))})` : ''}</b></div><div><span>Estimated gas</span><b>~${fmt(gas * price)} ${esc(chains[a.k].native)}${usdTxt(gasUsd(a.k, gas * price)) ? ` (≈ ${usdTxt(gasUsd(a.k, gas * price))})` : ''}</b></div>`;
          q('go').disabled = false;
        } catch (e) { if (my === seq) q('summary').innerHTML = `<span class="err">${esc(friendly(e, a.k))}</span>`; }
      };
      let timer: ReturnType<typeof setTimeout>;
      const liveUsd = () => { const el = q('usd'); if (!el || a.kind === 'nft') return; let amt = 0n; try { amt = parseUnits(q('amount').value.trim() || '0', a.decimals); } catch {} const t = amt > 0n ? usdTxt(amtUsd(a, amt)) : ''; el.textContent = t ? `≈ ${t}` : ''; };
      const changed = () => { liveUsd(); if (sending || sent || !m.isConnected) return; ++seq; quote = null; q('go').disabled = true; clearTimeout(timer); timer = setTimeout(update, 400); };
      m.addEventListener('input', changed);
      disposeStep = () => { ++seq; clearTimeout(timer); };
      q('max').addEventListener('click', async () => {
        if (sending || sent) return;
        const my = ++seq; quote = null; q('go').disabled = true; q('max').disabled = true; clearTimeout(timer);
        try {
          const pc = readClient(a.k); let balance = a.bal;
          if (a.kind === 'native') {
            const to = await resolveRecipient(q('to').value);
            if (/^0x0{40}$/i.test(to) || to.toLowerCase() === address.toLowerCase()) throw Error('Enter a different, nonzero recipient.');
            const [native, estimate, price] = await Promise.all([pc.getBalance({ address }), pc.estimateGas({ account: address, to, value: 1n }), pc.getGasPrice()]);
            // Reserve buffered gas rather than offering the entire native balance.
            const reserve = estimate * 150n / 100n * price; balance = native > reserve ? native - reserve : 0n;
            if (!balance) throw Error('Not enough native coin to cover gas.');
          } else if (a.nft?.standard === 'erc1155') balance = await pc.readContract({ address: a.nft.contract as Hex, abi: ERC1155, functionName: 'balanceOf', args: [address, BigInt(a.nft.id)] }) as bigint;
          if (my !== seq || !m.isConnected) return;
          q('amount').value = formatUnits(balance, a.decimals); liveUsd(); await update();
        } catch (e) { if (my === seq && m.isConnected) q('summary').innerHTML = `<span class="err">${esc(friendly(e, a.k))}</span>`; }
        finally { if (m.isConnected) q('max').disabled = false; }
      });
      q('go').addEventListener('click', async () => {
        if (sending || sent || !quote || quote.fingerprint !== fingerprint()) return;
        const plan = quote; sending = true; busySending = true; back.disabled = true; q('go').disabled = true; ++seq;
        q('max').disabled = true;
        m.querySelectorAll('input,select').forEach(e => (e as HTMLInputElement).disabled = true);
        let hash: Hex | null = null;
        try {
          if (!isMe()) throw Error('Connect the profile owner wallet.');
          await ensureChain(plan.a.k); if (!isMe()) throw Error('Wallet changed. Reconnect the profile owner.');
          q('msg').textContent = 'Confirm the transfer in your wallet…';
          hash = await createWalletClient({ chain: vchain(plan.a.k), transport: custom(wallet.provider) }).sendTransaction({ account: address, chain: vchain(plan.a.k), ...plan.tx, gas: plan.gas });
          sent = true;
          const link = `<a href="${chains[plan.a.k].explorer}/tx/${hash}" target="_blank" rel="noopener">View transaction ↗</a>`;
          q('msg').innerHTML = `Submitted. ${link}`;
          const receipt = await readClient(plan.a.k).waitForTransactionReceipt({ hash, timeout: 120000 });
          q('msg').innerHTML = `${receipt.status === 'success' ? '✓ Sent.' : 'Transaction reverted.'} ${link}`;
          load(true);
        } catch (e) {
          q('msg').innerHTML = `<span class="err">${esc(friendly(e, plan.a.k))}</span>${hash ? ` <a href="${chains[plan.a.k].explorer}/tx/${hash}" target="_blank" rel="noopener">View submitted transaction ↗</a>` : ''}`;
        } finally {
          sending = false; busySending = false; back.disabled = false;
          if (!sent) { q('max').disabled = false; m.querySelectorAll('input,select').forEach(e => (e as HTMLInputElement).disabled = false); update(); }
        }
      });
      update(); back.focus();
    }
    const selected = pre && assets().find(a => a.key === pre);
    if (selected) showStep(selected); else showList();
  }
  root.addEventListener('change', e => {
    const s = e.target as HTMLSelectElement; if (s.hasAttribute('data-uw-sort')) { S.sort = s.value as typeof S.sort; draw(); }
  });
  root.addEventListener('click', async e => {
    const lb = (e.target as HTMLElement).closest<HTMLElement>('[data-uwl]');
    if (lb) { e.preventDefault(); const a = lb.dataset.uwl!;
      if (a === 'add') { S.add = true; S.lnErr = ''; draw(); return; }
      if (a === 'close') { S.add = false; setPending(''); if (location.hash) history.replaceState(null, '', location.pathname); draw(); return; }
      if (a === 'solconnect') { openSolConnect(); return; }
      if (a === 'connect') { openConnect(); return; }
      if (S.lnBusy) return;
      (a === 'unlink' ? doUnlink(lb.dataset.w!) : linkStep(a)).catch(x => { S.lnBusy = ''; S.lnErr = x?.code === 4001 || /reject|denied|cancel/i.test(x?.message || '') ? 'Signature cancelled in wallet.' : friendly(x); }).then(draw); return;
    }
    const walBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-nft-wal]');
    if (walBtn) { S.wal = walBtn.dataset.nftWal || ''; draw(); return; }
    const chainBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-nft-chain]');
    if (chainBtn) { S.chain = chainBtn.dataset.nftChain || ''; draw(); return; }
    const colBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-nft-col]');
    if (colBtn) { S.col = colBtn.dataset.nftCol || ''; draw(); return; }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-uw],[data-send],[data-more],[data-insight]'); if (!b || b.hasAttribute('disabled')) return;
    const action = b.dataset.uw;
    if (action === 'copy') navigator.clipboard?.writeText(address).then(() => { b.textContent = b.classList.contains('fwcopy') ? '✓' : 'Copied ✓'; }).catch(() => {});
    if (action === 'receive') { S.receive = !S.receive; draw(); }
    if (action === 'connect') openConnect();
    if (action === 'export' && isMe() && wallet.provider?.isMultiSeaEmbedded) openKeyExport();
    if (action === 'send' || b.dataset.send) { e.preventDefault(); openSend(b.dataset.send); }
    if (action === 'refresh') load(true);
    const k = b.dataset.more || b.dataset.insight;
    if (k) { const [w, ck] = k.split('|') as [Hex, string]; b.setAttribute('disabled', ''); try {
      if (b.dataset.more) {
        const r = await fetch(`${API}/wallet/${w}/nfts?chain=${ck}&next=${encodeURIComponent(S.cursors[k])}`); if (!r.ok) throw Error('NFT page unavailable');
        const j = await r.json(); if (j.failed?.length) throw Error('NFT page unavailable'); merge(j.nfts || [], w); delete S.cursors[k]; Object.entries(j.cursors || {}).forEach(([c, v]) => { S.cursors[w + '|' + c] = v as string; });
      } else { const j = await ownedNfts(ck, w, S.insightPage[k]); merge(j.nfts, w); if (j.more) S.insightPage[k]++; else delete S.insightPage[k]; }
      await attachTimes((S.nfts || []).filter(n => n.wallet === w), w);
    } catch (e) { S.note = `Couldn't load more NFTs on ${chains[ck].name}: ${friendly(e)}`; } draw(); }
  });
  onWallet(() => draw()); onSol(() => draw()); loadProfile(address).then(draw); draw(); load();
}
