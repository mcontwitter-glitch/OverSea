// MultiSea Bridge (testnet preview): lock an NFT in the source-chain escrow, LayerZero v2 releases it on the destination.
import { createPublicClient, createWalletClient, custom, http, parseAbi, formatEther, defineChain, type Address } from 'viem';
import { wallet, openConnect, onWallet } from './wallet';
import { esc } from './shell';
export type BCfg = { network: string; mode: string; feeWallet: string; supportedChains: number; lzGas: number; tiers: { min: number; max: number; eth: string; label?: string }[];
  chains: Record<string, { name: string; chainId: number; eid: number; rpc: string; explorer: string; factory: string | null; logo: string }>;
  collections: { id: string; slug: string; mirrorsSlug: string; name: string; native: string; contracts: Record<string, Address>; escrows: Record<string, Address>; img: string; fromBlock: Record<string, number> }[] };
let cfgP: Promise<BCfg | null> | null = null;
export const bridgeCfg = (): Promise<BCfg | null> => (cfgP ??= fetch('/bridge.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
export const ESCROW = parseAbi(['function quote(uint32,address,uint256,bytes) view returns (uint256,uint256)', 'function bridge(uint32,address,uint256,bytes) payable returns ((bytes32,uint64,(uint256,uint256)))', 'function platformFee() view returns (uint256)']);
export const NFT = parseAbi(['function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)', 'function approve(address,uint256)', 'function owner() view returns (address)', 'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
export const FACTORY = parseAbi(['function listingFee(uint256) view returns (uint256)', 'function list(address,uint32[]) payable returns (uint256,address)', 'function escrowOf(address) view returns (address)']);
const chainOf = (c: BCfg['chains'][string]) => defineChain({ id: c.chainId, name: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [new URL(c.rpc, location.origin).href] } } });
export const pubFor = (c: BCfg['chains'][string]) => createPublicClient({ chain: chainOf(c), transport: http(new URL(c.rpc, location.origin).href) });
export const lzOptions = (gas: number) => ('0x0003' + '01' + '0011' + '01' + gas.toString(16).padStart(32, '0')) as `0x${string}`;
export async function walletFor(c: BCfg['chains'][string]) {
  if (!wallet.address) { openConnect(); throw new Error('Connect a wallet first'); }
  const want = '0x' + c.chainId.toString(16);
  const cur = await wallet.provider.request({ method: 'eth_chainId' });
  if (cur !== want) {
    try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch (e: any) { if (e?.code === 4902) await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: c.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: [new URL(c.rpc, location.origin).href], blockExplorerUrls: [c.explorer] }] }); else throw e; }
  }
  return createWalletClient({ chain: chainOf(c), transport: custom(wallet.provider), account: wallet.address as Address });
}
const fmtE = (w: bigint) => { const s = formatEther(w); const [a, b = ''] = s.split('.'); return a + (b ? '.' + b.slice(0, 6).replace(/0+$/, '') : '') || '0'; };

type St = { col: number; from: string; to: string; ids: number[]; loading: boolean; sel: number | null; recip: string; quote: { p: bigint; lz: bigint } | null; status: string; cls: string; busy: boolean; link: string };
export async function mountBridge(el: HTMLElement, opts: { slug?: string } = {}) {
  const cfg0 = await bridgeCfg();
  if (!cfg0 || !cfg0.collections.length) { el.innerHTML = `<div class="bridge"><p class="mut">Bridging isn't set up for this collection yet.</p></div>`; return; }
  const cfg: BCfg = cfg0;
  const cols = opts.slug ? cfg.collections.filter(c => c.slug === opts.slug || c.mirrorsSlug === opts.slug) : cfg.collections;
  if (!cols.length) { el.innerHTML = `<div class="bridge"><p class="mut">Bridging isn't set up for this collection yet.</p></div>`; return; }
  const keys = (i: number) => Object.keys(cols[i].contracts);
  const s: St = { col: 0, from: keys(0)[0], to: keys(0)[1], ids: [], loading: false, sel: null, recip: '', quote: null, status: '', cls: 'mut', busy: false, link: '' };
  const C = () => cols[s.col];
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
     <div class="gh">Your NFTs on ${esc(cfg.chains[s.from].name)}</div>
     <div class="bnfts">${!wallet.address ? `<div class="bempty"><p class="mut">Connect your wallet to see your NFTs.</p><button class="bbtn" data-act="connect">Connect wallet</button></div>`
       : s.loading ? '<div class="spin"></div>' : s.ids.length ? s.ids.map(id => `<button class="bnft ${s.sel === id ? 'on' : ''}" data-id="${id}"><img src="${C().img}${id}.webp" alt="" loading="lazy" width="96" height="96"><span>#${id}</span></button>`).join('')
       : `<p class="mut">No ${esc(C().name)} NFTs in this wallet on ${esc(cfg.chains[s.from].name)}.</p>`}</div>
     <label class="bl">Recipient on ${esc(cfg.chains[s.to].name)}<input data-k="recip" placeholder="${esc(wallet.address || '0x…')}" value="${esc(s.recip)}"></label>
     <div class="bfee"><div><span>Platform fee</span><b>$0.30${q ? ` ≈ ${fmtE(q.p)} ETH` : ''}</b></div><div><span>LayerZero delivery</span><b>${q ? fmtE(q.lz) + ' ETH' : '…'}</b></div><div class="tot"><span>Total</span><b>${q ? fmtE(tot) + ' ETH' : '…'}</b></div>
      <p class="mut small">$0.30 is priced live from the Chainlink ETH/USD feed. The LayerZero fee is quoted by the endpoint and any excess is refunded.</p></div>
     <p class="msg ${s.cls}">${s.status}${s.link ? ` <a href="${esc(s.link)}" target="_blank" rel="noopener">View transaction ↗</a>` : ''}</p>
     <button class="bbtn go" data-act="bridge" ${s.busy || (wallet.address && s.sel == null) ? 'disabled' : ''}>${!wallet.address ? 'Connect wallet' : s.sel == null ? 'Select an NFT' : s.busy ? 'Working…' : `Bridge #${s.sel} to ${esc(cfg.chains[s.to].name)}`}</button>
    </div>`;
  }
  async function loadIds() {
    s.ids = []; s.sel = null; if (!wallet.address) return draw();
    s.loading = true; draw();
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const token = C().contracts[s.from];
      const logs = await pub.getLogs({ address: token, event: NFT[5] as any, args: { to: wallet.address as Address }, fromBlock: BigInt(C().fromBlock?.[s.from] || 0) });
      const cand = [...new Set(logs.map((l: any) => Number(l.args.tokenId)))];
      const own = await Promise.all(cand.map(id => pub.readContract({ address: token, abi: NFT, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null)));
      s.ids = cand.filter((_, i) => (own[i] as string | null)?.toLowerCase() === wallet.address!.toLowerCase()).sort((a, b) => a - b);
    } catch (e: any) { s.status = 'Could not load NFTs: ' + (e.shortMessage || e.message); s.cls = 'err'; }
    s.loading = false; draw();
  }
  async function quote() {
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const to = (s.recip || wallet.address || cfg.feeWallet) as Address;
      const [p, lz] = await pub.readContract({ address: C().escrows[s.from], abi: ESCROW, functionName: 'quote', args: [cfg.chains[s.to].eid, to, BigInt(s.sel ?? 1), lzOptions(cfg.lzGas)] });
      s.quote = { p, lz };
    } catch (e: any) { s.quote = null; s.status = 'Fee quote unavailable: ' + (e.shortMessage || e.message); s.cls = 'err'; }
    draw();
  }
  async function doBridge() {
    if (!wallet.address) return openConnect();
    if (s.sel == null) return;
    const to = (s.recip || wallet.address) as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { s.status = 'Recipient must be a 0x address.'; s.cls = 'err'; return draw(); }
    s.busy = true; s.link = ''; s.status = 'Switching network…'; s.cls = 'mut'; draw();
    try {
      const c = cfg.chains[s.from]; const pub = pubFor(c); const w = await walletFor(c); const token = C().contracts[s.from]; const escrow = C().escrows[s.from]; const id = BigInt(s.sel);
      const ok = (await pub.readContract({ address: token, abi: NFT, functionName: 'getApproved', args: [id] })).toLowerCase() === escrow.toLowerCase()
        || (await pub.readContract({ address: token, abi: NFT, functionName: 'isApprovedForAll', args: [wallet.address as Address, escrow] }));
      if (!ok) { s.status = `Step 1/2: approve the escrow for #${s.sel} in your wallet…`; draw();
        const h = await w.writeContract({ address: token, abi: NFT, functionName: 'approve', args: [escrow, id] }); await pub.waitForTransactionReceipt({ hash: h }); }
      const [p, lz] = await pub.readContract({ address: escrow, abi: ESCROW, functionName: 'quote', args: [cfg.chains[s.to].eid, to, id, lzOptions(cfg.lzGas)] });
      s.quote = { p, lz }; s.status = `Step 2/2: confirm the bridge (${fmtE(p + lz)} ETH) in your wallet…`; draw();
      const value = p + (lz * 102n) / 100n; // small buffer; excess refunded by the escrow
      const h = await w.writeContract({ address: escrow, abi: ESCROW, functionName: 'bridge', args: [cfg.chains[s.to].eid, to, id, lzOptions(cfg.lzGas)], value });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error('Transaction reverted');
      s.link = cfg.mode === 'fork' ? '' : `https://testnet.layerzeroscan.com/tx/${h}`;
      s.status = `✓ #${s.sel} locked on ${c.name}. LayerZero is delivering it to ${cfg.chains[s.to].name}${cfg.mode === 'fork' ? ' (preview relayer, a few seconds)' : ' (usually 1-3 minutes)'}.`; s.cls = 'ok';
      const dst = cfg.chains[s.to]; const dpub = pubFor(dst); const dtoken = C().contracts[s.to];
      for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 3000));
        const o = await dpub.readContract({ address: dtoken, abi: NFT, functionName: 'ownerOf', args: [id] }).catch(() => null);
        if ((o as string | null)?.toLowerCase() === to.toLowerCase()) { s.status = `✓ Delivered: #${s.sel} is now on ${dst.name}.`; break; } }
    } catch (e: any) { s.status = e?.code === 4001 ? 'Rejected in wallet.' : (e.shortMessage || e.message || String(e)); s.cls = 'err'; }
    s.busy = false; await loadIds(); quote();
  }
  el.onchange = e => { e.stopPropagation(); const t = e.target as HTMLSelectElement; const k = t.dataset.k;
    if (k === 'col') { s.col = +t.value; s.from = keys(s.col)[0]; s.to = keys(s.col)[1]; loadIds(); quote(); }
    if (k === 'from' || k === 'to') { (s as any)[k] = t.value; loadIds(); quote(); }
    if (k === 'recip') { s.recip = t.value.trim(); quote(); } };
  el.onclick = e => { e.stopPropagation(); const t = e.target as HTMLElement; const a = t.closest('[data-act]') as HTMLElement | null; const n = t.closest('[data-id]') as HTMLElement | null;
    if (n) { s.sel = +n.dataset.id!; s.status = ''; draw(); quote(); return; }
    if (!a) return;
    if (a.dataset.act === 'swap') { [s.from, s.to] = [s.to, s.from]; loadIds(); quote(); }
    if (a.dataset.act === 'connect') openConnect();
    if (a.dataset.act === 'bridge') doBridge(); };
  el.oninput = e => e.stopPropagation();
  onWallet(() => { if (el.isConnected) { loadIds(); quote(); } });
  draw(); loadIds(); quote();
}
