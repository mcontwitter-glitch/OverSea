// /w/<id>: the LIL FOOTS foot wallet. One ERC-6551 account per foot, same address on Base, Ethereum, ApeChain, BNB and
// Robinhood. Reads are live (hub + RPC multicalls, NFTs via the Worker/OpenSea). The owner can send from the account:
// directly on the chain where the foot is active (account.execute), or as a LayerZero command through the hubs.
import { createWalletClient, custom, encodeAbiParameters, encodeFunctionData, encodePacked, formatUnits, getAddress, isAddress, keccak256, parseAbi, parseUnits, type Hex } from 'viem';
import { renderSVG } from 'uqr';
import { wallet, onWallet, readClient, bulkClient, ensureChain, vchain, friendly, openConnect, overlay, API } from './wallet';
import { usdRates, type UsdRates } from './shell';
import { frame, chains, esc, short, logo } from './gx';
import { FW, FW_CHAINS, EID, chainOfEid, FOOT_ADDR, FOOT_SUPPLY, ABSTRACT_VAULT, footTba, footName, footEns, parseFootName, NATIVE, TOKENS, chainBalances, chainUsd, rateOf, fmtUsd, MC3, type FwChain, type ChainBal } from './footkit';

const HUB = parseAbi([
  'function liveOwner(uint256) view returns (address)', 'function isPaused(uint256) view returns (bool)',
  'function lockState(uint256) view returns ((bool locked,uint64 lockId,bytes32 snapshotHash,uint64 saleableAfter,bool ackedByBase))',
  'function cachedOwner(uint256) view returns (address,uint64)', 'function activeChain(uint256) view returns (uint32)', 'function trueOwner(uint256) view returns (address)', 'function isBaseLocked(uint256) view returns (bool)',
  'function ensureAccount(uint256) returns (address)', 'function reportArrival(uint256) payable', 'function unlock(uint256) payable',
  'function lockForListingWithOptions(uint256 id, bytes32 snapshotHash, bytes lockOpts, bytes ackOpts) payable returns (uint64)',
  'function quoteMessage(uint32 dstEid, uint8 msgType, bytes body, bytes extraOptions) view returns (uint256)',
  'function quoteCommand((uint256 tokenId,uint32 targetEid,uint64 nonce,uint64 deadline,uint64 ownerEpoch,(address to,uint256 value,bytes data)[] calls,bytes lzOptions) c, address signer) view returns (uint256)',
  'function sendCommand((uint256 tokenId,uint32 targetEid,uint64 nonce,uint64 deadline,uint64 ownerEpoch,(address to,uint256 value,bytes data)[] calls,bytes lzOptions) cd) payable',
  'function used(uint256,uint64) view returns (bool)',
]);
const REG = parseAbi(['function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)']);
const ACC = parseAbi(['function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)']);
const ERC721 = parseAbi(['function ownerOf(uint256) view returns (address)', 'function safeTransferFrom(address from, address to, uint256 tokenId)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)']);
const ERC20T = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const MT = { CMD_EXEC: 3, ACTIVE_UPDATE: 5, LOCK: 7, LOCK_ACK: 8, UNLOCK: 9 } as const;
const BASE_EID = EID.base;
const CALL_T = { type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] } as const;
const CMD_T = { type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'targetEid', type: 'uint32' }, { name: 'nonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'ownerEpoch', type: 'uint64' }, { name: 'calls', ...CALL_T }, { name: 'lzOptions', type: 'bytes' }] } as const;
type Call = { to: Hex; value: bigint; data: Hex };
type Cmd = { tokenId: bigint; targetEid: number; nonce: bigint; deadline: bigint; ownerEpoch: bigint; calls: Call[]; lzOptions: Hex };
type Lock = { locked: boolean; lockId: bigint; snapshotHash: Hex; saleableAfter: bigint; ackedByBase: boolean };
type CS = { k: FwChain; ok: boolean; live: Hex | null; lock: Lock | null; paused: boolean | null; deployed: boolean | null; bal: ChainBal; usd: number | null; epoch: bigint };
type Nft = { chain: string; contract: string; id: string; name: string | null; collection: string | null; image: string | null; standard: string | null };
const ZERO = '0x0000000000000000000000000000000000000000';
/** LayerZero type-3 executor option: extra lzReceive value (native drop) for the next hop, no extra gas. */
const dropOpt = (v: bigint) => encodePacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint128', 'uint128'], [3, 1, 33, 1, 0n, v]);
const pad = (v: bigint, pct = 20n) => v + (v * pct) / 100n;
const rnd64 = () => { const a = crypto.getRandomValues(new Uint32Array(2)); return (BigInt(a[0]) << 32n) | BigInt(a[1]); };
const fmtAmt = (v: bigint, d: number, max = 4) => { const n = +formatUnits(v, d); return n === 0 ? '0' : n < 10 ** -max ? '<' + (10 ** -max).toFixed(max) : n.toLocaleString(undefined, { maximumFractionDigits: max }); };
const nat = (k: string) => chains[k]?.native || 'ETH';

const id = +(location.pathname.match(/^\/w\/(\d+)/)?.[1] || 0);
const pg = frame('', `${footName(id)} wallet`, 'fwpage');
const S: { tba: Hex; regOk: boolean | null; cs: CS[]; base: { active: number; trueOwner: Hex | null; baseLocked: boolean } | null; abs: { owner: Hex | null; inVault: boolean } | null; nfts: Nft[] | null; nftNote: string; nftAt: number | null; rates: UsdRates | null; loaded: boolean } =
  { tba: footTba(id), regOk: null, cs: [], base: null, abs: null, nfts: null, nftNote: '', nftAt: null, rates: null, loaded: false };

const I = {
  send: '<svg class="fi" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>', recv: '<svg class="fi" viewBox="0 0 24 24"><path d="M17 7 7 17M16 17H7V8"/></svg>',
  lock: '<svg class="fi" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>', unlock: '<svg class="fi" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  refresh: '<svg class="fi" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  item: '<svg class="fi" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m4 15 4-4 5 5 3-3 4 4"/></svg>', copy: '<svg class="fi" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};
const CC: Record<string, string> = { base: '#2c6bff', ethereum: '#627eea', apechain: '#0054fa', bnb: '#f0b90b', robinhood: '#c3f53c' };

// ---------------------------------------------------------------- reads
const activeOn = () => S.cs.find(c => c.live && c.live !== ZERO) || null;
const owner = () => (activeOn()?.live as Hex) || null;
const isOwner = () => !!(wallet.address && owner() && wallet.address.toLowerCase() === owner()!.toLowerCase());

async function readChain(k: FwChain): Promise<CS> {
  const pc = readClient(k); const big = BigInt(id);
  const [hub, code, bal] = await Promise.all([
    pc.multicall({ multicallAddress: MC3, allowFailure: true, contracts: [{ address: FW.hub, abi: HUB, functionName: 'liveOwner', args: [big] }, { address: FW.hub, abi: HUB, functionName: 'lockState', args: [big] }, { address: FW.hub, abi: HUB, functionName: 'isPaused', args: [big] }, { address: FW.hub, abi: HUB, functionName: 'cachedOwner', args: [big] }] }).catch(() => null),
    pc.getCode({ address: S.tba }).then((c: Hex | undefined) => c || '0x').catch(() => null), chainBalances(k, [S.tba]).then(r => r[0])]);
  const g = (i: number) => (hub && hub[i].status === 'success' ? hub[i].result : null);
  return { k, ok: !!hub && hub[0].status === 'success', live: g(0) as Hex | null, lock: g(1) as Lock | null, paused: g(2) as boolean | null, deployed: code == null ? null : code !== '0x', bal, usd: null, epoch: ((g(3) as any)?.[1] as bigint) ?? 0n };
}
// NFT list freshness. The Worker edge-caches /foot/<id>/nfts for 30 s (10 s if a chain failed); OpenSea itself usually
// needs ~1-5 min to index a new transfer. So the page re-polls the (cached, cheap) list every NFT_POLL_MS while the tab
// is visible, for NFT_POLL_FOR_MS after the last load/refresh, and the Refresh button asks the Worker to skip its cache
// (`?fresh=1`, which the Worker honours at most once per 10 s per foot).
export const NFT_POLL_MS = 30_000, NFT_POLL_FOR_MS = 10 * 60_000;
let nftSeq = 0, pollT: ReturnType<typeof setTimeout> | null = null, pollUntil = 0, lastNftFetch = 0, busy = false;
async function loadNfts(fresh = false) {
  const my = ++nftSeq; lastNftFetch = Date.now();
  // Worker -> OpenSea. One retry; per-chain gaps are named instead of hiding the whole list.
  const getNfts = async () => { const r = await fetch(`${API}/foot/${id}/nfts${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { http: r.status }); return j; };
  try {
    const j = await getNfts().catch(async () => { await new Promise(r => setTimeout(r, 1500)); return getNfts(); });
    const list: Nft[] = (j.nfts || []).filter((n: any) => !n.error); const name = (k: string) => chains[k]?.name;
    // OpenSea does not index some chains (BNB): read LIL FOOTS held by this account there from chain instead.
    const onchain = await Promise.all((j.unsupported || []).filter((k: string) => FOOT_ADDR[k]).map((k: string) => footsHeldOnchain(k, S.tba as Hex).catch(() => null)));
    const readOk = new Set<string>(); (j.unsupported || []).filter((k: string) => FOOT_ADDR[k]).forEach((k: string, i: number) => { const r = onchain[i]; if (r) { readOk.add(k); list.push(...r); } });
    if (my !== nftSeq) return;
    const un = (j.unsupported || []).filter((k: string) => !readOk.has(k)).map(name).filter(Boolean);
    const failed = [...new Set<string>([...(j.failed || []), ...(j.nfts || []).filter((n: any) => n.error).map((n: any) => n.chain)])].map(name).filter(Boolean);
    S.nfts = list; S.nftAt = typeof j.at === 'number' ? j.at : Date.now();
    S.nftNote = [un.length ? `NFTs on ${un.join(', ')} are not indexed by OpenSea.` : '', failed.length ? `Couldn't load NFTs on ${failed.join(', ')} right now; refresh to retry.` : ''].filter(Boolean).join(' ');
  } catch (e: any) {
    if (my !== nftSeq) return;
    if (S.nfts && S.nftAt) return; // a background re-poll failed: keep the list we already show
    S.nfts = null; S.nftNote = e instanceof TypeError ? "NFT list unavailable: couldn't reach api.multisea.io (check ad-blockers / privacy settings or your connection)." : `NFT list unavailable right now (MultiSea API${e?.http ? ' ' + e.http : ''}); refresh to retry.`;
  }
}
async function loadChains() {
  const big = BigInt(id);
  const reg = readClient('base').readContract({ address: FW.registry, abi: REG, functionName: 'account', args: [FW.impl, ('0x' + '0'.repeat(64)) as Hex, FW.baseChainId, FW.baseFoot, big] }).then((a: Hex) => { S.regOk = getAddress(a) === getAddress(S.tba); if (!S.regOk) S.tba = getAddress(a); }).catch(() => { S.regOk = null; });
  const base = readClient('base').multicall({ multicallAddress: MC3, allowFailure: true, contracts: [{ address: FW.hub, abi: HUB, functionName: 'activeChain', args: [big] }, { address: FW.hub, abi: HUB, functionName: 'trueOwner', args: [big] }, { address: FW.hub, abi: HUB, functionName: 'isBaseLocked', args: [big] }] })
    .then((r: any[]) => { S.base = { active: Number(r[0].result ?? 0), trueOwner: r[1].result || null, baseLocked: !!r[2].result }; }).catch(() => {});
  const abs = readClient('abstract').readContract({ address: FOOT_ADDR.abstract, abi: ERC721, functionName: 'ownerOf', args: [big] }).then((o: Hex) => { S.abs = { owner: o, inVault: o.toLowerCase() === ABSTRACT_VAULT.toLowerCase() }; }).catch(() => { S.abs = { owner: null, inVault: false }; });
  await reg;
  const [cs, rates] = await Promise.all([Promise.all(FW_CHAINS.map(readChain)), usdRates(), base, abs]);
  S.rates = rates; S.cs = cs.map(c => ({ ...c, usd: chainUsd(c.k, c.bal, rates) })); S.loaded = true;
}
function schedulePoll() {
  if (pollT) clearTimeout(pollT); pollT = null; if (Date.now() >= pollUntil) return;
  pollT = setTimeout(async () => { if (document.visibilityState === 'visible' && !busy) { await loadNfts(); render(); } schedulePoll(); }, NFT_POLL_MS);
}
/** Full read (chains + NFTs). `fresh` = user asked (Refresh button, after a send): skip the Worker's NFT cache. */
async function load(fresh = false) {
  busy = true; if (S.loaded) render();
  const nfts = loadNfts(fresh);
  await loadChains(); render();
  await nfts; busy = false; render();
  pollUntil = Date.now() + NFT_POLL_FOR_MS; schedulePoll();
}
// Back on the tab after a while (e.g. sent an NFT from another tab/app): re-read the list once and restart the poll window.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || busy || !S.loaded || Date.now() - lastNftFetch < NFT_POLL_MS) return;
  loadNfts().then(render); pollUntil = Date.now() + NFT_POLL_FOR_MS; schedulePoll();
});

// ---------------------------------------------------------------- view
// LIL FOOTS held by `who` on `k`, via balanceOf + an ownerOf sweep (only when the balance is non-zero).
async function footsHeldOnchain(k: string, who: Hex): Promise<Nft[]> {
  const pc = bulkClient(k); const token = FOOT_ADDR[k];
  const bal = await pc.readContract({ address: token, abi: ERC721B, functionName: 'balanceOf', args: [who] }) as bigint; if (!bal) return [];
  const out: Nft[] = []; const ids = Array.from({ length: FOOT_SUPPLY }, (_, i) => i + 1);
  for (let i = 0; i < ids.length && out.length < Number(bal); i += 1100) { const part = ids.slice(i, i + 1100);
    const r: any[] = await pc.multicall({ multicallAddress: MC3, allowFailure: true, batchSize: 0, contracts: part.map(id => ({ address: token, abi: ERC721B, functionName: 'ownerOf', args: [BigInt(id)] })) });
    r.forEach((x, n) => { if (x.status === 'success' && String(x.result).toLowerCase() === who.toLowerCase()) out.push({ chain: k, contract: token.toLowerCase(), id: String(part[n]), name: footName(part[n]), collection: 'lil-foots', image: null, standard: 'erc721' } as any); }); }
  return out;
}
const ERC721B = parseAbi(['function ownerOf(uint256) view returns (address)', 'function balanceOf(address) view returns (uint256)']);
const nftImg = (n: Nft) => n.contract.toLowerCase() === FOOT_ADDR[n.chain]?.toLowerCase() ? `/img/lil-foots/s/${n.id}.webp` : n.image || '';
function assetCount() { let a = 0; S.cs.forEach(c => { if (c.bal.native) a++; c.bal.tokens.forEach(t => { if (t) a++; }); }); return a; }
function total() { if (!S.cs.length) return null; let t = 0; for (const c of S.cs) { if (c.usd == null) return null; t += c.usd; } return t; }
function tokLines(c: CS) {
  const rows: string[] = []; const r = S.rates!;
  if (c.bal.native) { const u = rateOf(NATIVE[c.k].px, r); rows.push(`<div class="fwtok"><b>${fmtAmt(c.bal.native, 18)} ${esc(NATIVE[c.k].symbol)}</b><span class="mut mono">${u != null ? fmtUsd(+formatUnits(c.bal.native, 18) * u) : ''}</span></div>`); }
  TOKENS[c.k].forEach((t, i) => { const v = c.bal.tokens[i]; if (!v) return; const u = rateOf(t.px, r); rows.push(`<div class="fwtok"><b>${fmtAmt(v, t.decimals)} ${esc(t.symbol)}</b><span class="mut mono">${u != null ? fmtUsd(+formatUnits(v, t.decimals) * u) : ''}</span></div>`); });
  const ns = (S.nfts || []).filter(n => n.chain === c.k);
  if (ns.length) rows.push(`<div class="fwnin">${ns.slice(0, 3).map(n => `<img src="${esc(nftImg(n))}" alt="">`).join('')}+ ${ns.length} NFT${ns.length > 1 ? 's' : ''} inside</div>`);
  return rows.join('') || `<div class="mut small">${c.ok || c.bal.ok ? 'Empty' : 'Couldn’t read this chain'}</div>`;
}
function statusText() {
  const f = activeOn();
  if (!S.loaded) return 'Reading 5 chains…';
  if (f) return `Active on ${chains[f.k].name}`;
  if (S.abs?.owner && !S.abs.inVault) return 'On Abstract (outside the wallet network)';
  return 'Not active on any of the 5 chains';
}
function render() {
  const f = activeOn(); const own = owner(); const me = isOwner(); const tot = total(); const lk = f?.lock?.locked ? f.lock : null;
  const dep = S.cs.filter(c => c.deployed).map(c => chains[c.k].name);
  const qr = renderSVG(S.tba, { border: 1, ecc: 'M' });
  const stack = FW_CHAINS.map(k => logo(k, 'cl')).join('');
  const canAct = me && !!f && !f.paused;
  const why = !wallet.address ? 'Connect the wallet that owns this foot' : !f ? 'The foot is not active on any of the 5 chains' : !me ? 'Only the owner of this foot can do this' : f.paused ? 'Paused by the guardian' : '';
  const nfts = S.nfts || [];
  pg.innerHTML = `<div class="fw">
  <section class="fwcard fwid glow">
    <div class="fwtop"><div class="fwnftw"><img class="fwnft" src="/img/lil-foots/m/${id}.webp" alt="${esc(footName(id))}" onerror="this.src='/img/lil-foots/s/${id}.webp'"></div><div style="min-width:0"><span class="fwtag">NFT wallet · ERC-6551</span><h1>${esc(footName(id))}</h1><div class="fwens">foot${id}<b>.multisea</b></div></div></div>
    <div class="fwaddr"><div style="min-width:0"><div class="mut small">Token-bound account${S.regOk === false ? ' (from registry)' : ''}</div><span class="mono fwfull">${S.tba}</span><span class="mono fwshort">${short(S.tba)}</span></div><button class="fwcopy" data-copy="${S.tba}" title="Copy address" aria-label="Copy address">${I.copy}</button></div>
    <div class="fwsame"><span class="ok">✓ Same address on 5 chains</span><span class="fwstack">${stack}</span></div>
    <div class="fwacts">
      <button class="fwbtn pri" data-fw="send" ${canAct && !lk ? '' : 'disabled'} title="${esc(lk ? 'Unlock the wallet first' : why)}"><span class="ic">${I.send}</span>Send</button>
      <button class="fwbtn on" data-fw="recv"><span class="ic">${I.recv}</span>Receive</button>
      <button class="fwbtn" data-fw="${lk ? 'unlock' : 'lock'}" ${canAct ? '' : 'disabled'} title="${esc(why)}"><span class="ic">${lk ? I.unlock : I.lock}</span>${lk ? 'Unlock wallet' : 'Lock wallet'}</button>
      <a class="fwbtn" href="/c/lil-foots?item=${id}"><span class="ic">${I.item}</span>Item page</a>
    </div>
    ${!wallet.address ? `<div class="fwnote">View only. <a href="" data-fw="connect">Connect</a> the owner wallet to send or lock.</div>` : !me && S.loaded ? `<div class="fwnote">View only: you are not the owner of this foot${own ? ` (${short(own)})` : ''}.</div>` : ''}
    <div class="fwrecv" id="fwrecv"><div class="fwqr">${qr}<img class="c" src="/img/lil-foots/s/${id}.webp" alt=""></div><div><h4>Receive on any of 5 chains</h4><div class="hint">Send to <b>${esc(footName(id))}</b> or <b>${esc(footEns(id))}</b> instead of a 0x address. MultiSea resolves it to this foot's wallet.</div><span class="fwpill mono">${short(S.tba)}</span></div></div>
    <div class="fwown">
      <div class="orow"><span class="mut">Controlled by</span><b class="mono">${own ? `${short(own)}${me ? ' (you)' : ''}` : S.loaded ? '-' : '…'}</b></div>
      <div class="orow"><span class="mut">Status</span><b>${f ? logo(f.k) + ' ' : ''}${esc(statusText())}</b></div>
      <div class="orow"><span class="mut">Account</span><b>${!S.loaded ? '…' : dep.length ? `Deployed on ${esc(dep.join(', '))}` : 'Counterfactual (created on first use)'}</b></div>
      <div class="orow"><span class="mut">Listing lock</span><b>${!S.loaded ? '…' : lk ? `<span class="warn">Locked #${lk.lockId}${lk.ackedByBase ? '' : ' (Base ack pending)'}</span>` : S.base?.baseLocked ? '<span class="warn">Locked on Base</span>' : '<span class="ok">Unlocked</span>'}</b></div>
      <div class="orow"><span class="mut">Collection</span><b>LIL FOOTS</b></div>
      <div class="orow"><span class="mut">Standard</span><b>ERC-721 + ERC-6551 account</b></div>
    </div>
  </section>
  <div class="fwright">
    <div class="fwhero">
      <section class="fwcard fwtotal"><h3>Total value inside this foot</h3><div class="v silver">${tot == null ? (S.loaded ? '-' : '…') : (() => { const [a, b] = fmtUsd(tot).split('.'); return `${a}<small>.${b}</small>`; })()}</div>
        <div class="mut small">5 chains · ${assetCount()} asset${assetCount() === 1 ? '' : 's'} · ${S.nfts ? nfts.length : '?'} NFT${nfts.length === 1 ? '' : 's'} · tokens priced live, NFTs not priced</div>
        <div class="fwbar">${tot ? S.cs.filter(c => c.usd).map(c => `<i style="flex:${Math.max(1, Math.round((c.usd! / tot) * 1000))};background:${CC[c.k]}" title="${esc(chains[c.k].name)} ${fmtUsd(c.usd)}"></i>`).join('') : '<i style="flex:1;background:#1d1f23"></i>'}</div></section>
      <section class="fwsell"><div><div class="big">Sell this foot = <em>everything inside</em> goes to the new owner</div><p>The wallet belongs to the NFT. Transfer or sell ${esc(footName(id))} and its tokens and NFTs on all 5 chains move with it.</p><a class="cta" href="/c/lil-foots?item=${id}">View on MultiSea →</a></div><div class="box"><img src="/img/lil-foots/s/${id}.webp" alt=""><span>${assetCount() + nfts.length} items</span></div></section>
    </div>
    <section class="fwcard fwsec"><div class="sechd"><h3>Balances by chain</h3><span class="mut small mono">Same TBA · ${short(S.tba)}</span></div>
      <div class="fwgrid">${S.cs.length ? S.cs.map(c => `<div class="fwch ${f?.k === c.k ? 'here' : ''}"><div class="chh"><span class="chn">${logo(c.k)}${esc(chains[c.k].name)}</span><span class="chv">${c.usd == null ? '-' : fmtUsd(c.usd)}</span></div>${tokLines(c)}<div class="fwchs">${f?.k === c.k ? '<i class="g">Active here</i>' : ''}<i>${c.deployed == null ? '?' : c.deployed ? 'Account deployed' : 'Counterfactual'}</i></div></div>`).join('') : FW_CHAINS.map(k => `<div class="fwch sk"><div class="chh"><span class="chn">${logo(k)}${esc(chains[k].name)}</span><span class="chv">…</span></div></div>`).join('')}</div></section>
    <div class="fwbot">
      <section class="fwcard fwsec"><div class="sechd"><h3>NFTs inside the foot${nfts.length ? ` <span class="mut small">${nfts.length}</span>` : ''}</h3><span class="fwrf"><span class="mut small" title="NFT list re-checks every 30 s for 10 min while this tab is open">${busy ? 'Checking…' : S.nftAt ? `Updated ${esc(new Date(S.nftAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}` : ''}</span><button class="fwrbtn" data-fw="refresh" ${busy ? 'disabled' : ''} title="Re-read all 5 chains and the NFT list now" aria-label="Refresh wallet contents">${I.refresh}<span>Refresh</span></button></span></div>
        ${S.nfts == null && !S.nftNote ? '<div class="mut small">Loading…</div>' : nfts.length ? `<div class="fwnftg">${nfts.slice(0, 12).map(n => `<div class="nftc"><img src="${esc(nftImg(n))}" alt="" loading="lazy"><div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div></div>`).join('')}</div>` : `<div class="mut small">${S.nfts ? 'No NFTs inside yet.' : ''}</div>`}
        ${S.nftNote ? `<div class="mut small" style="margin-top:8px">${esc(S.nftNote)}</div>` : ''}</section>
      <section class="fwcard fwsec"><div class="sechd"><h3>Status on each chain</h3><span class="mut small">live from the hubs</span></div>
        <div class="fwst"><div class="h"><span>Chain</span><span>Foot</span><span>Account</span><span>Lock</span></div>${S.cs.map(c => `<div><span>${logo(c.k)} ${esc(chains[c.k].name)}</span><span>${!c.ok ? '<i class="mut">unreadable</i>' : c.live && c.live !== ZERO ? '<b class="ok">Active here</b>' : '<i class="mut">Not here</i>'}</span><span>${c.deployed == null ? '?' : c.deployed ? 'Deployed' : '<i class="mut">Counterfactual</i>'}</span><span>${c.paused ? '<b class="warn">Paused</b>' : c.lock?.locked ? `<b class="warn">Locked #${c.lock.lockId}</b>` : '<i class="mut">-</i>'}</span></div>`).join('')}</div>
        <div class="mut small" style="margin-top:10px">Base controller: ${S.base ? (S.base.active ? `active chain <b>${esc(chains[chainOfEid(S.base.active) || '']?.name || 'EID ' + S.base.active)}</b>` : 'active chain not reported yet') + (S.base.trueOwner && S.base.trueOwner !== ZERO ? ` · owner ${short(S.base.trueOwner)}` : '') : '…'}${S.abs?.owner && !activeOn() ? ` · Abstract: ${S.abs.inVault ? 'in the bridge vault' : 'held by ' + short(S.abs.owner)}` : ''}${S.regOk ? ' · address verified with registry.account()' : ''}</div></section>
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------- actions
type Asset = { key: string; k: FwChain; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
function assets(): Asset[] {
  const out: Asset[] = [];
  S.cs.forEach(c => { if (c.bal.native) out.push({ key: `${c.k}|n`, k: c.k, kind: 'native', label: NATIVE[c.k].symbol, bal: c.bal.native, decimals: 18 });
    TOKENS[c.k].forEach((t, i) => { const v = c.bal.tokens[i]; if (v) out.push({ key: `${c.k}|${t.address}`, k: c.k, kind: 'erc20', label: t.symbol, bal: v, decimals: t.decimals, token: t.address }); }); });
  (S.nfts || []).forEach(n => { if ((FW_CHAINS as readonly string[]).includes(n.chain)) out.push({ key: `${n.chain}|${n.contract}|${n.id}`, k: n.chain as FwChain, kind: 'nft', label: n.name || `#${n.id}`, bal: 1n, decimals: 0, nft: n }); });
  return out;
}
/** Recipient: 0x address, "LIL FOOT #n" or "footN.multisea" (resolves to that foot's account). */
export function resolveRecipient(s: string): { address: Hex; foot: number | null } | null {
  const t = s.trim(); if (isAddress(t)) return { address: getAddress(t), foot: null };
  const f = parseFootName(t); return f ? { address: footTba(f), foot: f } : null;
}
function wc(k: string) { return createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) }); }
async function gasCost(k: FwChain, est: () => Promise<bigint>) { try { const [g, p] = await Promise.all([est(), readClient(k).getGasPrice()]); return pad(g * p, 20n); } catch { return null; } }
const feeTxt = (k: string, v: bigint | null) => (v == null ? '-' : `${fmtAmt(v, 18, 6)} ${esc(nat(k))}${S.rates ? (() => { const r = rateOf(NATIVE[k as FwChain]?.px || 'ETH', S.rates!); return r ? ` (~${fmtUsd(+formatUnits(v, 18) * r)})` : ''; })() : ''}`);

type Plan = { route: 'local' | 'remote'; from: FwChain; steps: { label: string; k: FwChain; fee: bigint | null; run: () => Promise<Hex> }[]; notes: string[] };
function callFor(a: Asset, to: Hex, amt: bigint): Call {
  if (a.kind === 'native') return { to, value: amt, data: '0x' };
  if (a.kind === 'erc20') return { to: a.token!, value: 0n, data: encodeFunctionData({ abi: ERC20T, functionName: 'transfer', args: [to, amt] }) };
  const n = a.nft!; const big = BigInt(n.id);
  return n.standard === 'erc1155' ? { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [S.tba, to, big, amt || 1n, '0x'] }) }
    : { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC721, functionName: 'safeTransferFrom', args: [S.tba, to, big] }) };
}
async function plan(a: Asset, call: Call): Promise<Plan> {
  const f = activeOn()!; const C = f.k, T = a.k; const me = wallet.address as Hex; const big = BigInt(id); const hubC = readClient(C);
  const tgt = S.cs.find(c => c.k === T)!;
  if (C === T) { // local: the owner calls the account directly on the chain where the foot is active
    const steps: Plan['steps'] = []; const notes = [`Runs directly on ${chains[C].name}: your wallet calls the foot's account (execute). No LayerZero message.`];
    if (!tgt.deployed) { steps.push({ label: `Create the foot's account on ${chains[C].name} (one time)`, k: C, fee: await gasCost(C, () => hubC.estimateContractGas({ address: FW.hub, abi: HUB, functionName: 'ensureAccount', args: [big], account: me })), run: () => wc(C).writeContract({ account: me, address: FW.hub, abi: HUB, functionName: 'ensureAccount', args: [big], chain: vchain(C) }) }); notes.push('First use: the account is created on this chain (anyone can create it; you pay the gas once).'); }
    steps.push({ label: `Send from the foot's account on ${chains[C].name}`, k: C, fee: tgt.deployed ? await gasCost(C, () => hubC.estimateContractGas({ address: S.tba, abi: ACC, functionName: 'execute', args: [call.to, call.value, call.data, 0], account: me })) : null, run: () => wc(C).writeContract({ account: me, address: S.tba, abi: ACC, functionName: 'execute', args: [call.to, call.value, call.data, 0], chain: vchain(C) }) });
    return { route: 'local', from: C, steps, notes };
  }
  // remote: a command sent from the active chain C, routed by the Base controller, executed on T
  const cmd: Cmd = { tokenId: big, targetEid: EID[T], nonce: rnd64(), deadline: BigInt(Math.floor(Date.now() / 1000) + 25 * 60), ownerEpoch: 0n, calls: [call], lzOptions: '0x' };
  const notes: string[] = []; const steps: Plan['steps'] = [];
  const base = readClient('base');
  if (C !== 'base' && T !== 'base') {
    const hop2 = await base.readContract({ address: FW.hub, abi: HUB, functionName: 'quoteMessage', args: [EID[T], MT.CMD_EXEC, encodeAbiParameters([CMD_T, { type: 'uint64' }], [cmd as any, 0n]), '0x'] }) as bigint;
    cmd.lzOptions = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }], ['0x', dropOpt(pad(hop2, 25n)), '0x']);
    notes.push(`Two LayerZero hops: ${chains[C].name} → Base (route) → ${chains[T].name} (execute). The Base → ${chains[T].name} fee (${fmtAmt(pad(hop2, 25n), 18, 6)} ETH on Base) is prepaid inside the first message.`);
  } else notes.push(C === 'base' ? `One LayerZero message: Base → ${chains[T].name}.` : `One LayerZero message: ${chains[C].name} → Base, executed on Base.`);
  if (C !== 'base' && S.base?.active !== EID[C]) {
    const o = f.live as Hex; const body = encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint64' }], [big, o, f.epoch, BigInt(Math.floor(Date.now() / 1000))]);
    const fee = pad(await hubC.readContract({ address: FW.hub, abi: HUB, functionName: 'quoteMessage', args: [BASE_EID, MT.ACTIVE_UPDATE, body, '0x'] }) as bigint, 15n);
    steps.push({ label: `Tell Base the foot is on ${chains[C].name} (one time, then wait ~1-3 min)`, k: C, fee, run: async () => { const h = await wc(C).writeContract({ account: me, address: FW.hub, abi: HUB, functionName: 'reportArrival', args: [big], value: fee, chain: vchain(C) }); return h; } });
    notes.push(`Base has not recorded ${chains[C].name} as this foot's active chain yet, so it would reject the command. Step 1 registers it (permissionless; MultiSea's keeper normally does this).`);
  }
  const fee1 = await hubC.readContract({ address: FW.hub, abi: HUB, functionName: 'quoteCommand', args: [cmd as any, me] }) as bigint;
  const value = pad(fee1, 10n);
  if (!tgt.deployed) notes.push(`First use on ${chains[T].name}: the hub creates the account there while executing (covered by the message gas).`);
  notes.push('Expires in 25 minutes if not delivered. Unused fee is refunded by LayerZero.');
  steps.push({ label: `Send the command from ${chains[C].name}`, k: C, fee: value, run: async () => { if (steps.length > 1) { const b = await base.readContract({ address: FW.hub, abi: HUB, functionName: 'activeChain', args: [big] }) as number; if (Number(b) !== EID[C]) throw Object.assign(new Error('Base has not received the registration yet. Wait a minute and try again.'), { kind: 'stale' }); }
    cmd.deadline = BigInt(Math.floor(Date.now() / 1000) + 25 * 60); return wc(C).writeContract({ account: me, address: FW.hub, abi: HUB, functionName: 'sendCommand', args: [cmd as any], value, chain: vchain(C) }); } });
  return { route: 'remote', from: C, steps, notes };
}
async function runSteps(p: Plan, el: HTMLElement) {
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i]; el.innerHTML = `Step ${i + 1}/${p.steps.length}: ${esc(s.label)}. Confirm in your wallet…`;
    await ensureChain(s.k); const h = await s.run();
    el.innerHTML = `Waiting for ${esc(chains[s.k].name)}… <a href="${chains[s.k].explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
    await readClient(s.k).waitForTransactionReceipt({ hash: h, timeout: 240_000 });
    if (i < p.steps.length - 1 && /Tell Base/.test(s.label)) { el.innerHTML = 'Waiting for Base to receive the registration (LayerZero)…'; const t0 = Date.now(); while (Date.now() - t0 < 10 * 60_000) { await new Promise(r => setTimeout(r, 8000)); const b = await readClient('base').readContract({ address: FW.hub, abi: HUB, functionName: 'activeChain', args: [BigInt(id)] }).catch(() => 0); if (Number(b) === EID[s.k]) break; } }
  }
}

function openSend(pre?: string) {
  const list = assets(); const f = activeOn()!;
  const m = overlay(`<div class="fwsend"><h2>Send from ${esc(footName(id))}</h2>
    <div class="lbl">From <span>Foot wallet · controlled by you</span></div>
    <div class="fld"><img src="/img/lil-foots/s/${id}.webp" class="av" alt=""><span class="mono">${short(S.tba)}</span><span class="grow"></span><span class="mut small">Active on ${logo(f.k)} ${esc(chains[f.k].name)}</span></div>
    <div class="lbl">Asset</div>
    <select class="fld sel" data-k="asset">${list.length ? list.map(a => `<option value="${esc(a.key)}" ${a.key === pre ? 'selected' : ''}>${esc(chains[a.k].name)} · ${esc(a.label)}${a.kind === 'nft' ? ' (NFT)' : ` · ${fmtAmt(a.bal, a.decimals, 6)}`}</option>`).join('') : '<option value="">This wallet is empty</option>'}</select>
    <div class="lbl" data-amtl>Amount <span data-k="bal"></span></div>
    <div class="fld"><input data-k="amt" inputmode="decimal" placeholder="0.0" autocomplete="off"><button class="obtn sm" data-k="max">Max</button></div>
    <div class="lbl">To <span>NFT name, .multisea name or 0x address</span></div>
    <div class="fld"><input data-k="to" placeholder="LIL FOOT #1204, foot1204.multisea or 0x…" autocomplete="off" spellcheck="false"></div>
    <div data-k="res"></div>
    <div class="fwsum" data-k="sum"><div class="mut small">Pick an asset, amount and recipient to see the route and fees.</div></div>
    <button class="bbtn" data-k="go" disabled>Send</button><div class="fwmsg" data-k="msg"></div></div>`);
  const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
  let cur: Plan | null = null; let seq = 0;
  const asset = () => list.find(a => a.key === q('asset').value) || null;
  const sync = () => { const a = asset(); const nft = a?.kind === 'nft' && a.nft?.standard !== 'erc1155'; (m.querySelector('[data-amtl]') as HTMLElement).hidden = !!nft; (q('amt').parentElement as HTMLElement).hidden = !!nft; q('bal').textContent = a && !nft ? `Balance ${fmtAmt(a.bal, a.decimals, 6)} ${a.label}` : ''; };
  const update = async () => {
    const my = ++seq; cur = null; q('go').setAttribute('disabled', ''); sync();
    const a = asset(); const r = resolveRecipient(q('to').value); const raw = q('to').value.trim();
    q('res').innerHTML = !raw ? '' : !r ? '<div class="fwres bad">Not a 0x address or a LIL FOOT name.</div>' : r.foot ? `<div class="fwres"><img src="/img/lil-foots/s/${r.foot}.webp" alt=""><div style="flex:1;min-width:0"><b>${esc(footName(r.foot))} ✓</b><div class="mut small">${esc(footEns(r.foot))} · resolves to its token-bound account (ERC-6551)</div><div class="mono">${r.address}</div><div class="ok small">✓ Same address on all 5 chains · goes to whoever owns that foot</div></div></div>` : '';
    if (!a || !r) { q('sum').innerHTML = '<div class="mut small">Pick an asset, amount and recipient to see the route and fees.</div>'; return; }
    if (r.address.toLowerCase() === S.tba.toLowerCase()) { q('sum').innerHTML = '<div class="err small">That is this foot\'s own wallet.</div>'; return; }
    let amt = 1n; if (a.kind !== 'nft' || a.nft?.standard === 'erc1155') { try { amt = parseUnits(q('amt').value.trim() || '0', a.decimals); } catch { amt = 0n; } if (amt <= 0n) { q('sum').innerHTML = '<div class="mut small">Enter an amount.</div>'; return; } if (amt > a.bal) { q('sum').innerHTML = '<div class="err small">More than the wallet holds.</div>'; return; } }
    q('sum').innerHTML = '<div class="mut small">Quoting route and fees…</div>';
    try {
      const p = await plan(a, callFor(a, r.address, amt)); if (my !== seq) return; cur = p;
      const totalFee = p.steps.reduce((s, x) => s + (x.fee || 0n), 0n);
      q('sum').innerHTML = `<div><span class="mut">Route</span><b>${p.route === 'local' ? `Direct on ${esc(chains[p.from].name)}` : `LayerZero command from ${esc(chains[p.from].name)}`}</b></div>
        ${p.steps.map((s, i) => `<div><span class="mut">${i + 1}. ${esc(s.label)}</span><b>${s.fee == null ? 'gas (est. after step 1)' : (p.route === 'remote' && i === p.steps.length - 1 ? 'LayerZero fee ' : 'gas ~') + feeTxt(s.k, s.fee)}</b></div>`).join('')}
        <div><span class="mut">You pay</span><b>${feeTxt(p.from, totalFee)} on ${esc(chains[p.from].name)}</b></div>
        <div><span class="mut">Recipient gets</span><b>${a.kind === 'nft' ? esc(a.label) : `${fmtAmt(amt, a.decimals, 6)} ${esc(a.label)}`} on ${esc(chains[a.k].name)}</b></div>
        <ul class="fwnotes">${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
      q('go').removeAttribute('disabled'); q('go').textContent = p.steps.length > 1 ? `Send (${p.steps.length} steps)` : 'Send';
    } catch (e) { if (my === seq) q('sum').innerHTML = `<div class="err small">Couldn't quote: ${esc(friendly(e, f.k))}</div>`; }
  };
  let t: any; const deb = () => { clearTimeout(t); t = setTimeout(update, 350); };
  m.addEventListener('input', deb); m.addEventListener('change', deb);
  m.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null; if (!b) return;
    if (b.dataset.k === 'max') { const a = asset(); if (a) { q('amt').value = formatUnits(a.bal, a.decimals); deb(); } }
    if (b.dataset.k === 'go' && cur) { const msg = q('msg'); b.setAttribute('disabled', ''); try { await runSteps(cur, msg); msg.innerHTML = `<span class="ok">✓ Sent.${cur.route === 'remote' ? ' LayerZero delivers it in a few minutes; balances refresh when it lands.' : ''}</span>`; setTimeout(() => { sessionStorage.removeItem('multisea-fw'); load(true); }, 4000); } catch (err) { msg.innerHTML = `<span class="err">${esc(friendly(err, cur.from))}</span>`; b.removeAttribute('disabled'); } }
  });
  sync(); if (pre) update();
}

// Listing lock: freezes the wallet (no sends) until unlocked; it is what a LIL FOOTS listing uses (FootListingZone).
function snapshot(): Hex {
  const items: { eid: number; token: Hex; kind: number; identifier: bigint; amount: bigint }[] = [];
  S.cs.forEach(c => { if (c.bal.native) items.push({ eid: EID[c.k], token: ZERO, kind: 0, identifier: 0n, amount: c.bal.native }); TOKENS[c.k].forEach((t, i) => { const v = c.bal.tokens[i]; if (v) items.push({ eid: EID[c.k], token: t.address, kind: 1, identifier: 0n, amount: v }); }); });
  (S.nfts || []).forEach(n => { const k = n.chain as FwChain; if (EID[k]) items.push({ eid: EID[k], token: n.contract as Hex, kind: n.standard === 'erc1155' ? 3 : 2, identifier: BigInt(n.id), amount: 1n }); });
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'tuple[]', components: [{ name: 'eid', type: 'uint32' }, { name: 'token', type: 'address' }, { name: 'kind', type: 'uint8' }, { name: 'identifier', type: 'uint256' }, { name: 'amount', type: 'uint256' }] }], [BigInt(id), items]));
}
async function openLock(unlock: boolean) {
  const f = activeOn()!; const C = f.k; const big = BigInt(id); const me = wallet.address as Hex;
  const m = overlay(`<div class="fwsend"><h2>${unlock ? 'Unlock' : 'Lock'} ${esc(footName(id))}'s wallet</h2><p class="mut">${unlock ? 'Sends become possible again. The listing cooldown starts over on the next lock.' : 'Freezes the wallet on every chain: no sends (local or remote) until you unlock. This is the same lock a LIL FOOTS listing uses, so a buyer gets exactly what is inside. Incoming transfers still arrive.'}</p><div class="fwsum" data-k="sum"><div class="mut small">Quoting…</div></div><button class="bbtn" data-k="go" disabled>${unlock ? 'Unlock' : 'Lock'} wallet</button><div class="fwmsg" data-k="msg"></div></div>`);
  const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLElement;
  try {
    let value = 0n; let run: () => Promise<Hex>; const pc = readClient(C);
    if (unlock) {
      if (C !== 'base') value = pad(await pc.readContract({ address: FW.hub, abi: HUB, functionName: 'quoteMessage', args: [BASE_EID, MT.UNLOCK, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [big, f.lock!.lockId]), '0x'] }) as bigint, 10n);
      run = () => wc(C).writeContract({ account: me, address: FW.hub, abi: HUB, functionName: 'unlock', args: [big], value, chain: vchain(C) });
    } else {
      const snap = snapshot(); let lockOpts: Hex = '0x';
      if (C !== 'base') { // LOCK -> Base, and Base's LOCK_ACK reply is prepaid as a native drop inside the LOCK message
        const ack = await readClient('base').readContract({ address: FW.hub, abi: HUB, functionName: 'quoteMessage', args: [EID[C], MT.LOCK_ACK, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }], [big, 1n, 0n]), '0x'] }) as bigint;
        lockOpts = dropOpt(pad(ack, 25n));
        value = pad(await pc.readContract({ address: FW.hub, abi: HUB, functionName: 'quoteMessage', args: [BASE_EID, MT.LOCK, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes' }], [big, 1n, snap, '0x']), lockOpts] }) as bigint, 5n);
      }
      run = () => wc(C).writeContract({ account: me, address: FW.hub, abi: HUB, functionName: 'lockForListingWithOptions', args: [big, snap, lockOpts, '0x'], value, chain: vchain(C) });
    }
    const gas = await gasCost(C, () => pc.estimateContractGas({ address: FW.hub, abi: HUB, functionName: unlock ? 'unlock' : 'lockForListingWithOptions', args: (unlock ? [big] : [big, snapshot(), '0x', '0x']) as any, value, account: me }));
    q('sum').innerHTML = `<div><span class="mut">On</span><b>${logo(C)} ${esc(chains[C].name)}</b></div><div><span class="mut">LayerZero fee</span><b>${C === 'base' ? 'none (Base is the controller)' : feeTxt(C, value)}</b></div><div><span class="mut">Gas</span><b>${gas == null ? '-' : '~' + feeTxt(C, gas)}</b></div>${!unlock && C !== 'base' ? '<ul class="fwnotes"><li>Includes the Base → ' + esc(chains[C].name) + ' acknowledgement. A few percent extra is kept and refunded on unlock.</li></ul>' : ''}`;
    q('go').removeAttribute('disabled');
    q('go').addEventListener('click', async () => { q('go').setAttribute('disabled', ''); try { await ensureChain(C); const h = await run(); q('msg').innerHTML = `Waiting for ${esc(chains[C].name)}… <a href="${chains[C].explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`; await pc.waitForTransactionReceipt({ hash: h, timeout: 240_000 }); q('msg').innerHTML = `<span class="ok">✓ ${unlock ? 'Unlocked' : 'Locked'}.</span>`; load(true); } catch (e) { q('msg').innerHTML = `<span class="err">${esc(friendly(e, C))}</span>`; q('go').removeAttribute('disabled'); } });
  } catch (e) { q('sum').innerHTML = `<div class="err small">Couldn't quote: ${esc(friendly(e, C))}</div>`; }
}

pg.addEventListener('click', e => {
  const t = e.target as HTMLElement; const c = t.closest('[data-copy]') as HTMLElement | null;
  if (c) { navigator.clipboard?.writeText(c.dataset.copy!).then(() => { c.classList.add('done'); setTimeout(() => c.classList.remove('done'), 1200); }).catch(() => {}); return; }
  const b = t.closest('[data-fw]') as HTMLElement | null; if (!b || b.hasAttribute('disabled')) return; e.preventDefault();
  const a = b.dataset.fw;
  if (a === 'connect') openConnect();
  else if (a === 'recv') document.getElementById('fwrecv')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (a === 'send') openSend();
  else if (a === 'refresh') { sessionStorage.removeItem('multisea-fw'); load(true); }
  else if (a === 'lock' || a === 'unlock') openLock(a === 'unlock');
});
onWallet(() => render());
if (!(id >= 1 && id <= FOOT_SUPPLY)) pg.innerHTML = `<div class="fcard"><h2>No such foot</h2><p class="mut">LIL FOOTS ids run from 1 to ${FOOT_SUPPLY}.</p></div>`;
else { render(); load(); }
// Read-only test hook for the preview E2E (quotes only; never signs): enabled with localStorage multisea-debug=1.
if (localStorage.getItem('multisea-debug') === '1') (window as any).__fw = { S, load, loadNfts, plan, resolveRecipient, callFor, openLock, openSend };
