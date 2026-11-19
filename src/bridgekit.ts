// MultiSea Bridge: lock an NFT in the source-chain escrow, LayerZero v2 releases it on the destination.
import { createPublicClient, createWalletClient, custom, http, parseAbi, formatEther, defineChain, type Address } from 'viem';
import { wallet, openConnect, onWallet, API } from './wallet';
import { esc } from './shell';
import { chainPicker } from './chainpick';
import { SOLANA_ON, SOL_SOON, onSolanaFlag } from './solflag';
export type BCfg = { network: string; mode: string; feeWallet: string; supportedChains: number; lzGas: number; tiers?: { min: number; max: number; eth: string; label?: string }[];
  chains: Record<string, { name: string; chainId: number; eid: number; rpc: string; explorer: string; factory: string | null; logo: string; native?: string; lzScan?: string }>;
  collections: { id: string; slug: string; mirrorsSlug: string; name: string; native: string; contracts: Record<string, Address>; escrows: Record<string, Address>; img: string; fromBlock: Record<string, number>; kind?: 'omni'; cid?: `0x${string}`; supply?: number }[] };
let cfgP: Promise<BCfg | null> | null = null;
// Static config + collections the server auto-listed from creator prepayments (GET /bridge/collections) on mainnet.
export const bridgeCfg = (): Promise<BCfg | null> => (cfgP ??= fetch('/bridge.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null).then(async (c: BCfg | null) => {
  if (!c || c.network !== 'mainnet' || !API) return c;
  try { const r = await fetch(API + '/bridge/collections'); if (r.ok) { const { collections } = await r.json(); for (const x of collections || []) if (!c.collections.some(y => y.slug === x.slug)) c.collections.push(x); } } catch {}
  return c; }));
export const ESCROW = parseAbi(['function quote(uint32,address,uint256,bytes) view returns (uint256,uint256)', 'function bridge(uint32,address,uint256,bytes) payable returns ((bytes32,uint64,(uint256,uint256)))', 'function platformFee() view returns (uint256)']);
export const NFT = parseAbi(['function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)', 'function approve(address,uint256)', 'function owner() view returns (address)', 'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
// Launchpad multichain drops (MultiSeaOmniDrop): the holder calls drop.moveTo, priced by the chain's OmniEscrow.quoteMove.
export const OMNI = parseAbi(['function quoteMove(bytes32,uint32,uint256,address) view returns (uint256,uint256)', 'function moveTo(uint32,uint256,address) payable']);
export const FACTORY = parseAbi(['function listingFee(uint32[]) view returns (uint256)', 'function list(address,uint32[]) payable returns (uint256,address)', 'function prepay(bytes32,uint32[]) payable', 'function escrowOf(address) view returns (address)']);
export const sym = (c: { native?: string }) => c.native || 'ETH';
const chainOf = (c: BCfg['chains'][string]) => defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: sym(c), symbol: sym(c), decimals: 18 }, rpcUrls: { default: { http: [new URL(c.rpc, location.origin).href] } } });
export const pubFor = (c: BCfg['chains'][string]) => createPublicClient({ chain: chainOf(c), transport: http(new URL(c.rpc, location.origin).href) });
export const lzOptions = (gas: number) => ('0x0003' + '01' + '0011' + '01' + gas.toString(16).padStart(32, '0')) as `0x${string}`;
export async function walletFor(c: BCfg['chains'][string]) {
  if (!wallet.address) { openConnect(); throw new Error('Connect a wallet first'); }
  const want = '0x' + c.chainId.toString(16);
  const cur = await wallet.provider.request({ method: 'eth_chainId' });
  if (cur !== want) {
    try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch (e: any) { if (e?.code === 4902) await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: c.name, nativeCurrency: { name: sym(c), symbol: sym(c), decimals: 18 }, rpcUrls: [new URL(c.rpc, location.origin).href], blockExplorerUrls: [c.explorer] }] }); else throw e; }
  }
  return createWalletClient({ chain: chainOf(c), transport: custom(wallet.provider), account: wallet.address as Address });
}
const fmtE = (w: bigint) => { const s = formatEther(w); const [a, b = ''] = s.split('.'); return a + (b ? '.' + b.slice(0, 6).replace(/0+$/, '') : '') || '0'; };

type St = { col: number; from: string; to: string; ids: number[]; loading: boolean; sel: number | null; recip: string; quote: { p: bigint; lz: bigint } | null; status: string; cls: string; busy: boolean; link: string; solAddr: string };
export async function mountBridge(el: HTMLElement, opts: { slug?: string } = {}) {
  const cfg0 = await bridgeCfg();
  if (!cfg0) { el.innerHTML = `<div class="bridge"><p class="mut">Bridging isn't set up for this collection yet.</p></div>`; return; }
  if (!cfg0.collections.length) { el.innerHTML = `<div class="bridge"><div class="gh">Bridge</div><p class="mut">The MultiSea bridge is live on ${Object.values(cfg0.chains).map(c => esc(c.name)).join(', ')}. No collections are listed yet. Own a collection? <a href="/submit">List it for bridging</a>: you pay only the deploy gas.</p></div>`; return; }
  const cols = opts.slug ? cfg0.collections.filter(c => c.slug === opts.slug || c.mirrorsSlug === opts.slug) : cfg0.collections;
  if (!cols.length) { el.innerHTML = `<div class="bridge"><p class="mut">Bridging isn't set up for this collection yet.</p></div>`; return; }
  // Solana for existing multichain collections whose Solana side exists (src/solexist.ts): EVM -> Solana through the chain's
  // mover, Solana -> EVM through the program's move_out. A local chains copy, so the shared bridge config is untouched.
  const SX = SOLANA_ON && cols.some(c => c.kind === 'omni' && c.cid) ? await import('./solexist') : null;
  const solOk = await Promise.all(cols.map(c => (SX && c.kind === 'omni' && c.cid ? SX.hasSolanaSide(c.cid) : false)));
  const cfg: BCfg = solOk.some(Boolean) ? { ...cfg0, chains: { ...cfg0.chains, solana: { name: 'Solana', chainId: 0, eid: SX!.SOL_EID, rpc: '', explorer: 'https://solscan.io', factory: null, logo: 'solana', native: 'SOL' } } } : cfg0;
  const SW = SX ? await import('./solwallet') : null;
  const keys = (i: number) => [...Object.keys(cols[i].contracts), ...(solOk[i] ? ['solana'] : [])];
  const isSol = (k: string) => k === 'solana';
  const solMe = () => SW?.solWallet.pubkey?.toBase58() || '';
  const s: St = { col: 0, from: keys(0)[0], to: keys(0)[1], ids: [], loading: false, sel: null, recip: '', quote: null, status: '', cls: 'mut', busy: false, link: '', solAddr: '' };
  const C = () => cols[s.col];
  // Recipient picker: the connected wallets + every wallet on their MultiSea profile (src/walletlinks.ts), filtered to the destination type.
  type Pick = { addr: string; kind: 'evm' | 'sol'; label: string };
  let picks: Pick[] = [];
  const shortA = (a: string) => `${a.slice(0, a.startsWith('0x') ? 6 : 4)}…${a.slice(-4)}`;
  const sameA = (a: string, b: string) => (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);
  async function loadPicks() {
    const evm = wallet.address || '', sw = solMe(); const out: Pick[] = [];
    const add = (addr: string, kind: 'evm' | 'sol', label: string) => { if (addr && !out.some(x => sameA(x.addr, addr))) out.push({ addr, kind, label }); };
    add(evm, 'evm', 'Connected'); add(sw, 'sol', 'Connected');
    try { const { profileWallets } = await import('./walletlinks');
      const ps = await Promise.all([evm, sw].filter(Boolean).map(a => profileWallets(a).catch(() => null)));
      for (const p of ps) { if (!p) continue; add(p.profile, 'evm', 'Profile'); for (const w of p.wallets || []) add(w.addr, w.kind, 'Linked'); } } catch {}
    picks = out; if (el.isConnected) draw();
  }
  const picksHtml = () => { const want = isSol(s.to) ? 'sol' : 'evm'; const list = picks.filter(p => p.kind === want); if (!list.length) return '';
    return `<div class="bpicks">${list.map(p => `<button type="button" class="bpick ${s.recip && sameA(s.recip, p.addr) ? 'on' : ''}" data-pick="${esc(p.addr)}" title="${esc(p.addr)}"><span class="mono">${esc(shortA(p.addr))}</span><em>${esc(p.label)}</em></button>`).join('')}</div>`; };
  // Inbound-to-Solana messages that LayerZero verified but did not deliver (src/soldeliver.ts): any Solana wallet can deliver.
  type Stuck = import('./soldeliver').Pending;
  const D: { list: Stuck[]; msg: Record<string, string>; cls: Record<string, string>; busy: string } = { list: [], msg: {}, cls: {}, busy: '' };
  const colCids = new Set(cols.map(c => (c.cid || '').toLowerCase()).filter(Boolean));
  const word = (h: string, i: number) => h.replace(/^0x/, '').slice(i * 64, i * 64 + 64);
  const stuckLabel = (m: Stuck) => { const id = parseInt(word(m.payload, 2) || '0', 16); const col = cols.find(c => (c.cid || '').replace(/^0x/, '').toLowerCase() === word(m.payload, 1).toLowerCase());
    let to = ''; try { const w4 = m.payload.replace(/^0x/, "").slice(-64); if (SX && w4.length === 64) { const b = SX.b58of(w4); to = `${b.slice(0, 4)}…${b.slice(-4)}`; } } catch {}
    return `${col ? esc(col.name) + ' ' : ''}${id ? '#' + id : 'Message'} from ${esc(cfg.chains[Object.keys(cfg.chains).find(k => cfg.chains[k].eid === m.srcEid) || '']?.name || m.srcChain)}${to ? ' to ' + to : ''}`; };
  async function refreshStuck() {
    if (!SOLANA_ON) return;
    try { const all = await (await import('./soldeliver')).stuckInbound();
      D.list = opts.slug ? all.filter(m => colCids.has('0x' + word(m.payload, 1).toLowerCase())) : all; } catch {}
    draw();
  }
  const stuckHtml = () => !D.list.length ? '' : `<div class="bfee bstuck"><div class="gh">Waiting for delivery on Solana</div>
     <p class="mut small">LayerZero verified ${D.list.length === 1 ? 'this move' : 'these moves'}, but its automatic delivery to Solana failed. Any Solana wallet can deliver it now (network fee about 0.00001 SOL); the NFT goes to the recipient, not to the wallet that pays.</p>
     ${D.list.map(m => `<div class="bstk"><span>${stuckLabel(m)} · <a href="${esc(m.scan)}" target="_blank" rel="noopener">LayerZero Scan ↗</a></span>
       <button class="bbtn" data-act="deliver" data-guid="${esc(m.guid)}" ${D.busy ? 'disabled' : ''}>${D.busy === m.guid ? 'Delivering…' : solMe() ? 'Deliver' : 'Connect Solana wallet to deliver'}</button>
       ${D.msg[m.guid] ? `<p class="msg ${D.cls[m.guid] || 'mut'}">${D.msg[m.guid]}</p>` : ''}</div>`).join('')}</div>`;
  async function doDeliver(guid: string) {
    const m = D.list.find(x => x.guid === guid); if (!m || D.busy) return;
    if (!solMe()) { (await import('./solmenu')).openSolConnect(); return; }
    D.busy = guid; D.cls[guid] = 'mut'; D.msg[guid] = 'Checking the message on Solana…'; draw();
    try { const r = await (await import('./soldeliver')).deliver(m, t => { D.msg[guid] = esc(t); draw(); });
      D.cls[guid] = 'ok'; D.msg[guid] = r.already ? '✓ Already delivered.' : `✓ Delivered. <a href="https://solscan.io/tx/${r.sig}" target="_blank" rel="noopener">View transaction ↗</a>`;
      D.busy = ''; draw(); setTimeout(() => { D.list = D.list.filter(x => x.guid !== guid); refreshStuck(); if (isSol(s.from) || isSol(s.to)) loadIds(); }, 4000);
    } catch (e: any) { D.cls[guid] = 'err'; D.msg[guid] = esc(/reject|denied|cancel/i.test(e?.message || '') ? 'Rejected in wallet.' : (e?.message || String(e))); D.busy = ''; draw(); }
  }
  const N = () => sym(cfg.chains[s.from]);
  const chainOpt = (sel: string, other: string) => keys(s.col).map(k => `<option value="${k}" ${k === sel ? 'selected' : ''} ${k === other ? 'disabled' : ''}>${esc(cfg.chains[k].name)}</option>`).join('');
  const lg = (k: string) => `<img class="cl" src="/logos/${cfg.chains[k].logo}.svg" alt="">`;
  function draw() {
    const q = s.quote; const tot = q ? q.p + q.lz : 0n;
    el.innerHTML = `<div class="bridge">
     <div class="bhead"><div><h2>Bridge</h2><p class="mut">Move an NFT between chains. It's locked in the escrow contract on the source chain and released from the escrow on the destination by a LayerZero v2 message.</p></div><span class="tnet">${esc(cfg.network)}${cfg.mode === 'fork' ? ' · preview' : ''}</span></div>
     ${cols.length > 1 ? `<label class="bl">Collection<select data-k="col">${cols.map((c, i) => `<option value="${i}" ${i === s.col ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : `<div class="bcol"><img src="${C().img}1.webp" alt=""><b>${esc(C().name)}</b><span class="mut small">${keys(s.col).length} chains</span></div>`}
     <div class="bft"><label class="bl">From<div class="bsel">${lg(s.from)}<select data-k="from">${chainOpt(s.from, s.to)}</select></div></label>
      <button class="bswap" data-act="swap" title="Swap" aria-label="Swap chains">⇄</button>
      <label class="bl">To<div class="bsel">${lg(s.to)}<select data-k="to">${chainOpt(s.to, s.from)}</select></div></label></div>
     ${SOLANA_ON ? '' : `<p class="mut small solsoon"><img class="cl" src="/logos/solana.svg" alt=""> ${SOL_SOON}</p>`}
     <div class="gh">Your NFTs on ${esc(cfg.chains[s.from].name)}</div>
     <div class="bnfts">${isSol(s.from) && !solMe() ? `<div class="bempty"><p class="mut">Connect your Solana wallet to see your NFTs on Solana.</p><button class="bbtn" data-act="solconnect">Connect Phantom, Solflare…</button></div>`
       : !isSol(s.from) && !wallet.address ? `<div class="bempty"><p class="mut">Connect your wallet to see your NFTs.</p><button class="bbtn" data-act="connect">Connect wallet</button></div>`
       : s.loading ? '<div class="spin"></div>' : s.ids.length ? s.ids.map(id => `<button class="bnft ${s.sel === id ? 'on' : ''}" data-id="${id}"><img src="${C().img}${id}.webp" alt="" loading="lazy" width="96" height="96"><span>#${id}</span></button>`).join('')
       : `<p class="mut">No ${esc(C().name)} NFTs in this wallet on ${esc(cfg.chains[s.from].name)}.</p>`}</div>
     <label class="bl">Recipient on ${esc(cfg.chains[s.to].name)}<input data-k="recip" placeholder="${esc(isSol(s.to) ? solMe() || 'Solana address' : wallet.address || '0x…')}" value="${esc(s.recip)}"></label>
     ${picksHtml()}
     ${isSol(s.to) && !solMe() && !s.recip ? '<p class="mut small">Enter a Solana address, or <button class="lnk small" data-act="solconnect">connect Phantom / Solflare</button> to receive it in that wallet.</p>' : ''}
     ${isSol(s.from) ? `<div class="bfee"><div><span>Move fee</span><b>${SX!.MOVE_FEE_SOL} SOL</b></div><div><span>LayerZero delivery</span><b>quoted at signing</b></div><p class="mut small">Paid in SOL from your Solana wallet. The LayerZero fee is charged at its live quote (capped at ${SX!.MAX_LZ_SOL} SOL).</p></div>` : `<div class="bfee"><div><span>Platform fee</span><b>${C().kind === 'omni' ? (q ? `${fmtE(q.p)} ${N()}` : '…') : `$0.30${q ? ` ≈ ${fmtE(q.p)} ${N()}` : ''}`}</b></div><div><span>LayerZero delivery</span><b>${q ? fmtE(q.lz) + ' ' + N() : '…'}</b></div><div class="tot"><span>Total</span><b>${q ? fmtE(tot) + ' ' + N() : '…'}</b></div>
      ${C().kind === 'omni' ? `<p class="mut small">The LayerZero fee is quoted by the ${isSol(s.to) ? 'Solana mover' : 'escrow'} and any excess is refunded.${isSol(s.to) ? ' First time: one extra approval lets the mover lock the NFT in the escrow.' : ''}</p>` : `<p class="mut small">$0.30 is priced live from the ${esc(N())}/USD price feed on ${esc(cfg.chains[s.from].name)}. The LayerZero fee is quoted by the endpoint and any excess is refunded.</p>`}</div>`}
     ${stuckHtml()}
     <p class="msg ${s.cls}">${s.status}${s.link ? ` <a href="${esc(s.link)}" target="_blank" rel="noopener">View transaction ↗</a>` : ''}</p>
     <button class="bbtn go" data-act="bridge" ${s.busy || ((isSol(s.from) ? solMe() : wallet.address) && s.sel == null) ? 'disabled' : ''}>${isSol(s.from) && !solMe() ? 'Connect Solana wallet' : !isSol(s.from) && !wallet.address ? 'Connect wallet' : s.sel == null ? 'Select an NFT' : s.busy ? 'Working…' : `Bridge #${s.sel} to ${esc(cfg.chains[s.to].name)}`}</button>
    </div>`;
    el.querySelectorAll<HTMLSelectElement>('select[data-k=from],select[data-k=to]').forEach(x => chainPicker(x, k => `/logos/${cfg.chains[k].logo}.svg`, x.dataset.k === 'from' ? 'From chain' : 'To chain'));
  }
  async function loadIds() {
    s.ids = []; s.sel = null;
    if (isSol(s.from)) { const me = solMe(); if (!me) return draw(); s.loading = true; draw();
      try { const all = Array.from({ length: C().supply || 0 }, (_, i) => i + 1); const m = await SX!.solCopies(C().cid!, all); s.ids = all.filter(id => m.get(id) === me); }
      catch (e: any) { s.status = 'Could not load NFTs on Solana: ' + (e.message || e); s.cls = 'err'; }
      s.loading = false; return draw(); }
    if (!wallet.address) return draw();
    s.loading = true; draw();
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const token = C().contracts[s.from];
      if (C().kind === 'omni') { // fixed supply: read ownerOf for every id (one batched JSON-RPC call)
        // One Multicall3 eth_call (a 100-call JSON-RPC batch gets HTTP 429 from Robinhood's RPC, which read as "no NFTs").
        const bp = createPublicClient({ chain: chainOf(c), transport: http(new URL(c.rpc, location.origin).href) });
        const all = Array.from({ length: C().supply || 0 }, (_, i) => i + 1);
        const read = (ids: number[]) => bp.multicall({ multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11', allowFailure: true, batchSize: 0, contracts: ids.map(id => ({ address: token, abi: NFT, functionName: 'ownerOf', args: [BigInt(id)] })) }) as Promise<{ status: string; result?: unknown }[]>;
        let res: { status: string; result?: unknown }[];
        try { res = await read(all); } catch { res = []; for (let i = 0; i < all.length; i += 20) res.push(...await read(all.slice(i, i + 20))); }
        if (res.length !== all.length) throw new Error('owner read incomplete');
        s.ids = all.filter((_, i) => res[i].status === 'success' && String(res[i].result).toLowerCase() === wallet.address!.toLowerCase());
        s.loading = false; return draw();
      }
      const logs = await pub.getLogs({ address: token, event: NFT[5] as any, args: { to: wallet.address as Address }, fromBlock: BigInt(C().fromBlock?.[s.from] || 0) });
      const cand = [...new Set(logs.map((l: any) => Number(l.args.tokenId)))];
      const own = await Promise.all(cand.map(id => pub.readContract({ address: token, abi: NFT, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null)));
      s.ids = cand.filter((_, i) => (own[i] as string | null)?.toLowerCase() === wallet.address!.toLowerCase()).sort((a, b) => a - b);
    } catch (e: any) { s.status = 'Could not load NFTs: ' + (e.shortMessage || e.message); s.cls = 'err'; }
    s.loading = false; draw();
  }
  async function quote() {
    if (isSol(s.from)) { s.quote = null; return draw(); }
    if (isSol(s.to)) { try { const r = (s.recip && SX!.isSolAddr(s.recip)) ? s.recip : solMe() || '11111111111111111111111111111111';
      const [p, lz] = await pubFor(cfg.chains[s.from]).readContract({ address: SX!.moverOf(s.from), abi: SX!.MOVER, functionName: 'quoteToSolana', args: [C().cid!, BigInt(s.sel ?? 1), SX!.sol32(r)] }) as [bigint, bigint];
      s.quote = { p, lz }; } catch (e: any) { s.quote = null; s.status = 'Fee quote unavailable: ' + (e.shortMessage || e.message); s.cls = 'err'; } return draw(); }
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const to = (s.recip || wallet.address || cfg.feeWallet) as Address;
      const [p, lz] = C().kind === 'omni' ? await pub.readContract({ address: C().escrows[s.from], abi: OMNI, functionName: 'quoteMove', args: [C().cid!, cfg.chains[s.to].eid, BigInt(s.sel ?? 1), to] })
        : await pub.readContract({ address: C().escrows[s.from], abi: ESCROW, functionName: 'quote', args: [cfg.chains[s.to].eid, to, BigInt(s.sel ?? 1), lzOptions(cfg.lzGas)] });
      s.quote = { p, lz };
    } catch (e: any) { s.quote = null; s.status = 'Fee quote unavailable: ' + (e.shortMessage || e.message); s.cls = 'err'; }
    draw();
  }
  async function doBridge() {
    if (isSol(s.from)) return fromSolana();
    if (!wallet.address) return openConnect();
    if (s.sel == null) return;
    if (isSol(s.to)) return toSolana();
    const to = (s.recip || wallet.address) as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { s.status = 'Recipient must be a 0x address.'; s.cls = 'err'; return draw(); }
    s.busy = true; s.link = ''; s.status = 'Switching network…'; s.cls = 'mut'; draw();
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const w = await walletFor(c); const token = C().contracts[s.from]; const escrow = C().escrows[s.from]; const id = BigInt(s.sel);
      if (C().kind === 'omni') { // no approval: the drop locks the token in its escrow itself
        const [p, lz] = await pub.readContract({ address: escrow, abi: OMNI, functionName: 'quoteMove', args: [C().cid!, cfg.chains[s.to].eid, id, to] });
        s.quote = { p, lz }; s.status = `Confirm the move (${fmtE(p + lz)} ${N()}) in your wallet…`; draw();
        const h = await w.writeContract({ address: token, abi: OMNI, functionName: 'moveTo', args: [cfg.chains[s.to].eid, id, to], value: p + (lz * 102n) / 100n });
        await finish(h);
      } else {
      const ok = (await pub.readContract({ address: token, abi: NFT, functionName: 'getApproved', args: [id] })).toLowerCase() === escrow.toLowerCase()
        || (await pub.readContract({ address: token, abi: NFT, functionName: 'isApprovedForAll', args: [wallet.address as Address, escrow] }));
      if (!ok) { s.status = `Step 1/2: approve the escrow for #${s.sel} in your wallet…`; draw();
        const h = await w.writeContract({ address: token, abi: NFT, functionName: 'approve', args: [escrow, id] }); await pub.waitForTransactionReceipt({ hash: h }); }
      const [p, lz] = await pub.readContract({ address: escrow, abi: ESCROW, functionName: 'quote', args: [cfg.chains[s.to].eid, to, id, lzOptions(cfg.lzGas)] });
      s.quote = { p, lz }; s.status = `Step 2/2: confirm the bridge (${fmtE(p + lz)} ${N()}) in your wallet…`; draw();
      const value = p + (lz * 102n) / 100n; // small buffer; excess refunded by the escrow
      const h = await w.writeContract({ address: escrow, abi: ESCROW, functionName: 'bridge', args: [cfg.chains[s.to].eid, to, id, lzOptions(cfg.lzGas)], value });
      await finish(h);
      }
      async function finish(h: `0x${string}`) {
      const r = await pub.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error('Transaction reverted');
      s.link = cfg.mode === 'fork' ? '' : `https://${cfg.network === 'mainnet' ? '' : 'testnet.'}layerzeroscan.com/tx/${h}`;
      s.status = `✓ #${s.sel} locked on ${c.name}. LayerZero is delivering it to ${cfg.chains[s.to].name}${cfg.mode === 'fork' ? ' (preview relayer, a few seconds)' : ' (usually 1-3 minutes)'}.`; s.cls = 'ok';
      const dst = cfg.chains[s.to]; const dpub = pubFor(dst); const dtoken = C().contracts[s.to];
      for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 3000));
        const o = await dpub.readContract({ address: dtoken, abi: NFT, functionName: 'ownerOf', args: [id] }).catch(() => null);
        if ((o as string | null)?.toLowerCase() === to.toLowerCase()) { s.status = `✓ Delivered: #${s.sel} is now on ${dst.name}.`; break; } }
      }
    } catch (e: any) { s.status = e?.code === 4001 ? 'Rejected in wallet.' : (e.shortMessage || e.message || String(e)); s.cls = 'err'; }
    s.busy = false; await loadIds(); quote();
  }
  // EVM -> Solana: approve the chain's mover for the id (once), then mover.toSolana locks it in the V1 escrow and LayerZero
  // makes the Solana copy active in the recipient's wallet.
  async function toSolana() {
    const to = s.recip || solMe();
    if (!SX!.isSolAddr(to)) { s.status = 'Recipient must be a Solana address (connect Phantom / Solflare or paste one).'; s.cls = 'err'; return draw(); }
    s.busy = true; s.link = ''; s.status = 'Switching network…'; s.cls = 'mut'; draw();
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const w = await walletFor(c); const token = C().contracts[s.from]; const mover = SX!.moverOf(s.from); const id = BigInt(s.sel!);
      const ok = (await pub.readContract({ address: token, abi: NFT, functionName: 'getApproved', args: [id] })).toLowerCase() === mover.toLowerCase()
        || (await pub.readContract({ address: token, abi: NFT, functionName: 'isApprovedForAll', args: [wallet.address as Address, mover] }));
      if (!ok) { s.status = `Step 1/2: allow the MultiSea Solana mover to lock #${s.sel} in the escrow…`; draw();
        const h = await w.writeContract({ address: token, abi: NFT, functionName: 'approve', args: [mover, id] }); await pub.waitForTransactionReceipt({ hash: h }); }
      const [p, lz] = await pub.readContract({ address: mover, abi: SX!.MOVER, functionName: 'quoteToSolana', args: [C().cid!, id, SX!.sol32(to)] }) as [bigint, bigint];
      s.quote = { p, lz }; s.status = `${ok ? '' : 'Step 2/2: '}confirm the move to Solana (${fmtE(p + lz)} ${N()}) in your wallet…`; draw();
      const h = await w.writeContract({ address: mover, abi: SX!.MOVER, functionName: 'toSolana', args: [C().cid!, id, SX!.sol32(to)], value: p + (lz * 102n) / 100n });
      const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('Transaction reverted');
      s.link = `https://layerzeroscan.com/tx/${h}`;
      s.status = `✓ #${s.sel} locked on ${c.name}. LayerZero is delivering it to Solana (usually a few minutes).`; s.cls = 'ok'; draw();
      for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 6000));
        const o = (await SX!.solCopies(C().cid!, [Number(id)]).catch(() => null))?.get(Number(id));
        if (o === to) { s.status = `✓ Delivered: #${s.sel} is now in ${to.slice(0, 4)}…${to.slice(-4)} on Solana.`; D.list = D.list.filter(m => m.srcTx.toLowerCase() !== h.toLowerCase()); break; }
        if (i >= 9 && i % 5 === 0) { await refreshStuck(); // after ~1 min: verified on Solana but not delivered = the Deliver button below
          if (D.list.some(m => m.srcTx.toLowerCase() === h.toLowerCase())) { s.status = `#${s.sel} is locked on ${c.name} and verified on Solana, but LayerZero's automatic delivery did not run. Press Deliver below to finish it with your Solana wallet.`; s.cls = 'mut'; draw(); } } }
    } catch (e: any) { s.status = e?.code === 4001 ? 'Rejected in wallet.' : (e.shortMessage || e.message || String(e)); s.cls = 'err'; }
    s.busy = false; await loadIds(); quote();
  }
  // Solana -> EVM: move_out locks the Solana copy and sends MOVE to the destination chain's V1 escrow, which releases the id.
  async function fromSolana() {
    if (!solMe()) { (await import('./solmenu')).openSolConnect(); return; }
    if (s.sel == null) return;
    const to = (s.recip || wallet.address || '') as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { s.status = `Enter the 0x address to receive it on ${cfg.chains[s.to].name}, or connect your EVM wallet.`; s.cls = 'err'; return draw(); }
    s.busy = true; s.link = ''; s.status = 'Approve the move in your Solana wallet…'; s.cls = 'mut'; draw();
    try {
      const id = s.sel; const sig = await SX!.solToEvm(C().cid!, id, cfg.chains[s.to].eid, C().escrows[s.to], to);
      s.link = `https://solscan.io/tx/${sig}`;
      s.status = `✓ #${id} locked on Solana. LayerZero is delivering it to ${cfg.chains[s.to].name} (usually a few minutes).`; s.cls = 'ok'; draw();
      const dpub = pubFor(cfg.chains[s.to]); const dtoken = C().contracts[s.to];
      for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 6000));
        const o = await dpub.readContract({ address: dtoken, abi: NFT, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null);
        if ((o as string | null)?.toLowerCase() === to.toLowerCase()) { s.status = `✓ Delivered: #${id} is now on ${cfg.chains[s.to].name}.`; break; } }
    } catch (e: any) { s.status = /reject|denied|cancel/i.test(e?.message || '') ? 'Rejected in wallet.' : (e.message || String(e)); s.cls = 'err'; }
    s.busy = false; await loadIds(); quote();
  }
  el.onchange = e => { e.stopPropagation(); const t = e.target as HTMLSelectElement; const k = t.dataset.k;
    if (k === 'col') { s.col = +t.value; s.from = keys(s.col)[0]; s.to = keys(s.col)[1]; loadIds(); quote(); }
    if (k === 'from' || k === 'to') { const was = isSol(s.to); (s as any)[k] = t.value; if (was !== isSol(s.to)) s.recip = ''; loadIds(); quote(); }
    if (k === 'recip') { s.recip = t.value.trim(); quote(); } };
  el.onclick = e => { e.stopPropagation(); const t = e.target as HTMLElement; const a = t.closest('[data-act]') as HTMLElement | null; const n = t.closest('[data-id]') as HTMLElement | null;
    const pk = t.closest('[data-pick]') as HTMLElement | null;
    if (pk) { s.recip = pk.dataset.pick || ''; s.status = ''; quote(); return; }
    if (n) { s.sel = +n.dataset.id!; s.status = ''; draw(); quote(); return; }
    if (!a) return;
    if (a.dataset.act === 'swap') { [s.from, s.to] = [s.to, s.from]; if (isSol(s.from) || isSol(s.to)) s.recip = ''; loadIds(); quote(); }
    if (a.dataset.act === 'connect') openConnect();
    if (a.dataset.act === 'solconnect') import('./solmenu').then(m => m.openSolConnect());
    if (a.dataset.act === 'bridge') doBridge();
    if (a.dataset.act === 'deliver') doDeliver(a.dataset.guid || ''); };
  el.oninput = e => e.stopPropagation();
  onWallet(() => { if (el.isConnected) { loadIds(); quote(); loadPicks(); } });
  onSolanaFlag(() => { if (el.isConnected) draw(); });
  SW?.onSolWallet(() => { if (!el.isConnected) return; loadPicks(); if (isSol(s.from) || isSol(s.to)) { loadIds(); quote(); } else if (D.list.length) draw(); });
  draw(); loadIds(); quote(); refreshStuck(); loadPicks();
}
