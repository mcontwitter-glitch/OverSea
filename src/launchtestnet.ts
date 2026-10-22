// STAGING ONLY (VITE_LP_TESTNET=1): the multichain launchpad drop page wired to REAL testnet contracts
// (config/launchpad.testnet.json). Mints, flushes and moves are real transactions signed by the visitor's wallet on
// Base Sepolia (supply hub), Sepolia and Robinhood testnet. Never part of the production build.
import T from '../config/launchpad.testnet.json';
import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbi, formatEther, type Address } from 'viem';
import { navHtml, bindNav, esc } from './shell';
import { wallet, onWallet, openConnect, API } from './wallet';

type TC = { name: string; chainId: number; eid: number; native: string; rpc: string; explorer: string; contracts?: Record<string, string>; status?: string; lzNoPathway?: string[] };
const CH = T.chains as unknown as Record<string, TC>;
const DROP = (T as any).drops?.[0] as { slug: string; name: string; symbol: string; collectionId: `0x${string}`; maxSupply: number; batchK: number; batchTMin: number; chains: string[]; addresses: Record<string, Address> };
const HUB = T.hubChain; const LOGO: Record<string, string> = { baseSepolia: 'base', sepolia: 'ethereum', robinhoodTestnet: 'robinhood', curtis: 'apechain', bscTestnet: 'bnb' };
// Testnet executors on Robinhood/Curtis -> Base Sepolia have nativeCap = 0 (no native drop), so a REQUEST from there carries
// no hub budget: the hub's CONFIRM is OWED and relayed with retryLeg (anyone can pay it; staging: the MultiSea relayer).
const NO_DROP = new Set(['robinhoodTestnet', 'curtis']);
const D = parseAbi(['function quoteMint(uint256,uint256,address,uint128) view returns (uint256 price, uint256 lz)', 'function mint(address,uint256,uint256,bytes32[],uint128) payable',
  'function totalAssigned() view returns (uint256)', 'function maxSupply() view returns (uint32)', 'function mintedHere() view returns (uint32)', 'function pendingQty() view returns (uint32)',
  'function existsHere(uint256) view returns (bool)', 'function isActiveHere(uint256) view returns (bool)', 'function ownerOf(uint256) view returns (address)', 'function nextRid() view returns (uint256)',
  'function requests(uint256) view returns (address to, address payer, uint32 qty, uint32 start, uint8 status, uint128 paid)',
  'event Minted(address indexed to, uint256 indexed phaseId, uint256 firstId, uint256 qty, uint256 paid)', 'event MintRequested(uint256 indexed rid, address indexed to, uint256 qty, uint256 paid)']);
const E = parseAbi(['function queueOf(bytes32) view returns (uint64 oldest, uint32 ids, uint32 head, uint32 tail)', 'function poolOf(bytes32) view returns (uint256)', 'function flushReady(bytes32) view returns (bool)',
  'function quoteHubValue(bytes32,uint32,uint256) view returns (uint256)', 'function flush(bytes32) payable', 'function quoteFlush(bytes32) view returns (uint256 ids, uint256 fees)']);
const chainOf = (k: string) => defineChain({ id: CH[k].chainId, name: CH[k].name, nativeCurrency: { name: CH[k].native, symbol: CH[k].native, decimals: 18 }, rpcUrls: { default: { http: [CH[k].rpc] } } });
const pubs: Record<string, any> = {}; const pub = (k: string) => (pubs[k] ??= createPublicClient({ chain: chainOf(k), transport: http(CH[k].rpc, { retryCount: 2 }) }));
const tx = (k: string, h: string) => `<a href="${CH[k].explorer}/tx/${h}" target="_blank" rel="noopener" class="mono">${h.slice(0, 10)}…</a> · <a href="https://testnet.layerzeroscan.com/tx/${h}" target="_blank" rel="noopener">LayerZero scan</a>`;
const addr = (k: string, a: string) => `<a href="${CH[k].explorer}/address/${a}" target="_blank" rel="noopener" class="mono">${a.slice(0, 6)}…${a.slice(-4)}</a>`;
const fmt = (w: bigint, d = 6) => Number(formatEther(w)).toFixed(d).replace(/0+$/, '').replace(/\.$/, '');

const app = document.getElementById('app')!;
let sel = HUB, qty = 1; let st: any = null; let quote: { price: bigint; lz: bigint; hubValue: bigint } | null = null; let quoteErr = '';
let pend: { k: string; hash: string; stage: 'sent' | 'mined' | 'confirmed' | 'error'; first?: number; n: number; rid?: bigint; msg?: string; batch?: string } | null = null;
let mine: Record<string, number[]> = {}; let flushTx = ''; let health = '';

async function load() {
  const h = pub(HUB); const esc0 = CH[HUB].contracts!.omniEscrow as Address;
  const [assigned, q, pool, ready, plan] = await Promise.all([h.readContract({ address: DROP.addresses[HUB], abi: D, functionName: 'totalAssigned' }), h.readContract({ address: esc0, abi: E, functionName: 'queueOf', args: [DROP.collectionId] }),
    h.readContract({ address: esc0, abi: E, functionName: 'poolOf', args: [DROP.collectionId] }), h.readContract({ address: esc0, abi: E, functionName: 'flushReady', args: [DROP.collectionId] }), h.readContract({ address: esc0, abi: E, functionName: 'quoteFlush', args: [DROP.collectionId] })]);
  const per = await Promise.all(DROP.chains.map(k => pub(k).readContract({ address: DROP.addresses[k], abi: D, functionName: 'mintedHere' }).catch(() => 0)));
  st = { assigned: Number(assigned), queued: Number(q[1]), oldest: Number(q[0]), pool, ready, flushFee: plan[1], per: Object.fromEntries(DROP.chains.map((k, i) => [k, Number(per[i])])) };
  if (wallet.address) { const who = wallet.address.toLowerCase(); const ids = Array.from({ length: Math.min(st.assigned, DROP.maxSupply) }, (_, i) => BigInt(i + 1)); const m: Record<string, number[]> = {};
    await Promise.all(DROP.chains.map(async k => { const o = await Promise.all(ids.map(id => pub(k).readContract({ address: DROP.addresses[k], abi: D, functionName: 'ownerOf', args: [id] }).catch(() => null)));
      m[k] = ids.filter((_, i) => (o[i] as string | null)?.toLowerCase() === who).map(Number); })); mine = m; }
}
async function requote() {
  quote = null; quoteErr = ''; const to = (wallet.address || T.deployer) as Address;
  try { let hubValue = 0n;
    if (sel !== HUB && !NO_DROP.has(sel)) hubValue = ((await pub(HUB).readContract({ address: CH[HUB].contracts!.omniEscrow as Address, abi: E, functionName: 'quoteHubValue', args: [DROP.collectionId, CH[sel].eid, BigInt(qty)] })) as bigint) * 13n / 10n;
    const [price, lz] = await pub(sel).readContract({ address: DROP.addresses[sel], abi: D, functionName: 'quoteMint', args: [0n, BigInt(qty), to, hubValue] }) as [bigint, bigint];
    quote = { price, lz, hubValue }; } catch (e: any) { quoteErr = e?.shortMessage || String(e); }
}
const nextBatch = () => { if (!st) return ''; const left = Math.max(0, DROP.batchK - st.queued); const mins = st.oldest ? Math.max(0, Math.ceil((st.oldest + DROP.batchTMin * 60 - Date.now() / 1000) / 60)) : DROP.batchTMin;
  if (st.queued === 0) return `next batch starts with the next mint (every ${DROP.batchK} IDs or ${DROP.batchTMin} min)`;
  return left === 0 || mins === 0 ? `batch due now (${st.queued} queued, anyone can flush)` : `next batch in ~${left} mints / ${mins} min (${st.queued} queued)`; };

function costBox() {
  const nat = CH[sel].native;
  if (quoteErr) return `<p class="err small">Quote failed: ${esc(quoteErr)}</p>`;
  if (!quote) return '<p class="mut small"><span class="spin"></span> Quoting on-chain…</p>';
  const total = quote.price + quote.lz;
  const lzLine = sel === HUB
    ? `<div><span>Escrow copies on ${DROP.chains.length - 1} chains (batched, LayerZero)</span><b>${fmt(quote.lz, 8)} ${nat}<i class="usd">your share of one batch message per chain · quoteBatchShare()</i><i class="usd ldbuf">Unused batch buffer goes to MultiSea</i></b></div>`
    : `<div><span>Cross-chain (LayerZero): request to the Base Sepolia hub${NO_DROP.has(sel) ? '' : ' + confirm + copy-pool share'}</span><b>${fmt(quote.lz, 8)} ${nat}<i class="usd">${NO_DROP.has(sel) ? 'testnet executor: no native drop on this pathway, confirm relayed by MultiSea' : `incl. ${fmt(quote.hubValue, 8)} ETH dropped on Base Sepolia (+30% buffer, unspent part claimable)`}</i><i class="usd ldbuf">Unused batch buffer goes to MultiSea</i></b></div>`;
  return `<div class="kv ldkv"><div><span>Mint price</span><b>${qty} × ${fmt(quote.price / BigInt(qty), 8)} = ${fmt(quote.price, 8)} ${nat}</b></div><div><span>MultiSea fee</span><b>0.5% <i class="usd">included in price, taken at withdraw</i></b></div>${lzLine}<div class="xtot"><span>Total (msg.value)</span><b>${fmt(total, 8)} ${nat}</b></div></div>`;
}
function pendBox() {
  if (!pend) return '';
  const c = CH[pend.k]; const ids = pend.first ? `#${pend.first}${pend.n > 1 ? `–#${pend.first + pend.n - 1}` : ''}` : `${pend.n} NFT${pend.n > 1 ? 's' : ''}`;
  if (pend.stage === 'error') return `<div class="ldpend"><b>Mint failed</b><p class="err small">${esc(pend.msg || '')}</p></div>`;
  if (pend.k === HUB) return `<div class="ldpend ${pend.stage === 'mined' ? 'done' : ''}"><b>${pend.stage === 'mined' ? `✓ Minted ${ids} · Active on ${c.name}` : '<span class="spin"></span> Minting on Base Sepolia…'}</b><ul>
    <li>${pend.stage === 'mined' ? '<i class="ok">✓</i>' : '<span class="spin"></span>'}<span>Tx ${tx(pend.k, pend.hash)}</span></li>
    ${pend.stage === 'mined' ? `<li><i class="q">⏳</i><span class="ldq">Escrow copies queued · ${esc(pend.batch || nextBatch())}</span></li>` : ''}</ul></div>`;
  return `<div class="ldpend ${pend.stage === 'confirmed' ? 'done' : ''}"><b>${pend.stage === 'confirmed' ? `✓ Minted ${ids} · Active on ${c.name}` : '<span class="spin"></span> Minting… confirming across chains'}</b><ul>
    <li>${pend.stage !== 'sent' ? '<i class="ok">✓</i>' : '<span class="spin"></span>'}<span>Request sent on ${c.name}: ${tx(pend.k, pend.hash)}</span></li>
    <li>${pend.stage === 'confirmed' ? '<i class="ok">✓</i>' : '<span class="spin"></span>'}<span>Base Sepolia hub assigns the IDs, ${c.name} receives CONFIRM${NO_DROP.has(pend.k) ? ' (relayed)' : ''}</span></li>
    <li><i class="q">⏳</i><span class="ldq">Escrow copies queued on the hub · ${esc(nextBatch())}</span></li></ul></div>`;
}
function render() {
  document.title = `${DROP?.name || 'Testnet'} · Launchpad staging · MultiSea`;
  if (!DROP) { app.innerHTML = `${navHtml('launchpad')}<section class="ldwrap"><p>No testnet drop configured.</p></section>`; bindNav(); return; }
  const live = DROP.chains; const pct = st ? (st.assigned / DROP.maxSupply) * 100 : 0;
  app.innerHTML = `${navHtml('launchpad')}<section class="ldrop"><div class="ldtn">
   <div class="ldhint" style="margin:8px 0 14px">🧪 <b>Testnet staging</b>: real transactions on Base Sepolia (supply hub), Sepolia and Robinhood testnet. Testnet tokens only. ${health}</div>
   <div class="ldtags"><span class="ldtag mc">Multichain</span><span class="ldst live"><i></i>Live</span><span class="ldtag">Batched escrow copies · K=${DROP.batchK} · T=${DROP.batchTMin} min</span></div>
   <h1 style="margin:8px 0">${esc(DROP.name)} <span class="mut small">${esc(DROP.symbol)}</span></h1>
   <div class="ldprog big"><div class="ldprogh"><b>${st ? pct.toFixed(0) : '…'}% minted</b><span>${st ? st.assigned : '…'} / ${DROP.maxSupply} · shared across ${live.length} chains</span></div><div class="ldbar"><i style="width:${pct}%"></i></div>
    <div class="ldperch">${live.map(k => `<span><img class="cl" src="/logos/${LOGO[k]}.svg" alt=""> ${CH[k].name}: ${st ? st.per[k] : '…'}</span>`).join('')}</div>
    <div class="mut small" style="margin-top:6px">Escrow copies: ${st ? `${st.queued} queued · pool ${fmt(st.pool, 8)} ETH · ${esc(nextBatch())}` : '…'}</div></div>
   <div class="fcard ldmintbox">
    <div class="gh">Mint on <span class="mut small">you pay on this chain · your NFT is Active here</span></div><div class="ldchsel">${live.map(k => `<button class="ldch ${k === sel ? 'on' : ''}" data-ch="${k}"><img class="cl" src="/logos/${LOGO[k]}.svg" alt=""><span><b>${CH[k].name}</b><em>${k === HUB ? 'Instant · cheapest' : 'Confirms via Base Sepolia'}</em></span></button>`).join('')}</div>
    <div class="ldqty"><span class="gh">Quantity</span><div class="qpick"><button data-q="-1" ${qty <= 1 ? 'disabled' : ''} aria-label="Less">−</button><input type="number" value="${qty}" readonly aria-label="Quantity"><button data-q="1" ${qty >= 10 ? 'disabled' : ''} aria-label="More">+</button></div></div>
    ${costBox()}
    <button class="bbtn ldmint" data-act="mint" ${pend && (pend.stage === 'sent' || (pend.k !== HUB && pend.stage === 'mined')) ? 'disabled' : ''}>${wallet.address ? `Mint ${qty} on ${CH[sel].name}` : 'Connect wallet to mint'}</button>
    ${pendBox()}
    ${st?.ready ? `<button class="obtn sm" data-act="flush" style="margin-top:8px">Flush escrow copies now (permissionless, ${fmt(st.flushFee, 8)} ETH from the pool)</button>` : ''}${flushTx ? `<p class="small">Flush: ${tx(HUB, flushTx)}</p>` : ''}
   </div>
   ${wallet.address ? `<div class="fcard" style="margin-top:14px"><div class="gh">Your NFTs <span class="mut small">read on-chain (ownerOf) on every chain</span></div>${live.map(k => `<div class="ldtnrow"><span><img class="cl" src="/logos/${LOGO[k]}.svg" alt=""> ${CH[k].name}</span><b>${(mine[k] || []).length ? (mine[k] || []).map(i => '#' + i).join(' ') + ' <em>Active</em>' : '<i class="mut">none</i>'}</b></div>`).join('')}</div>` : ''}
   <div class="fcard" style="margin-top:14px"><div class="gh">Contracts <span class="mut small">testnet, unaudited</span></div>${live.map(k => `<div class="ldtnrow"><span><img class="cl" src="/logos/${LOGO[k]}.svg" alt=""> ${CH[k].name}</span><b class="small">drop ${addr(k, DROP.addresses[k])} · escrow ${addr(k, CH[k].contracts!.omniEscrow)} · factory ${addr(k, CH[k].contracts!.factory)}</b></div>`).join('')}</div>
  </div></section>`;
  bindNav();
  app.querySelectorAll('[data-ch]').forEach(b => b.addEventListener('click', async () => { sel = (b as HTMLElement).dataset.ch!; quote = null; render(); await requote(); render(); }));
  app.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', async () => { qty = Math.max(1, Math.min(10, qty + Number((b as HTMLElement).dataset.q))); quote = null; render(); await requote(); render(); }));
  app.querySelector('[data-act=mint]')?.addEventListener('click', mint);
  app.querySelector('[data-act=flush]')?.addEventListener('click', flush);
}
async function walletOn(k: string) {
  const c = CH[k]; const hex = '0x' + c.chainId.toString(16);
  if (parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16) !== c.chainId) {
    try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
    catch { await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }] }); }
  }
  return createWalletClient({ chain: chainOf(k), transport: custom(wallet.provider), account: wallet.address as Address });
}
async function mint() {
  if (!wallet.address) return openConnect();
  const k = sel; const n = qty;
  try { await requote(); if (!quote) throw new Error(quoteErr || 'no quote');
    const w = await walletOn(k); const before = st?.queued ?? 0;
    const hash = await w.writeContract({ address: DROP.addresses[k], abi: D, functionName: 'mint', args: [wallet.address as Address, 0n, BigInt(n), [], quote.hubValue], value: quote.price + quote.lz, chain: chainOf(k), account: wallet.address as Address });
    pend = { k, hash, stage: 'sent', n }; render();
    const r = await pub(k).waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('transaction reverted');
    const logs = r.logs.filter((l: any) => l.address.toLowerCase() === DROP.addresses[k].toLowerCase());
    const { decodeEventLog } = await import('viem');
    for (const l of logs) { try { const e: any = decodeEventLog({ abi: D, data: l.data, topics: l.topics }); if (e.eventName === 'Minted') pend.first = Number(e.args.firstId); if (e.eventName === 'MintRequested') pend.rid = e.args.rid; } catch {} }
    await load(); pend.stage = 'mined'; if (k === HUB) pend.batch = st.queued > before || st.queued ? nextBatch() : 'batch sent with this mint (K reached)'; render();
    if (k !== HUB && pend.rid) { const rid = pend.rid; const poll = async () => { const q = await pub(k).readContract({ address: DROP.addresses[k], abi: D, functionName: 'requests', args: [rid] }) as any;
      if (Number(q[4]) === 2) { pend!.stage = 'confirmed'; pend!.first = Number(q[3]); await load(); render(); return; } if (Number(q[4]) === 3) { pend!.stage = 'error'; pend!.msg = 'Hub rejected the request (sold out / wallet limit): payment refunded.'; render(); return; } setTimeout(poll, 8000); }; poll(); }
  } catch (e: any) { pend = { k, hash: '', stage: 'error', n, msg: e?.shortMessage || e?.message || String(e) }; render(); }
}
async function flush() {
  try { const w = await walletOn(HUB); const hash = await w.writeContract({ address: CH[HUB].contracts!.omniEscrow as Address, abi: E, functionName: 'flush', args: [DROP.collectionId], value: 0n, chain: chainOf(HUB), account: wallet.address as Address });
    flushTx = hash; render(); await pub(HUB).waitForTransactionReceipt({ hash }); await load(); render(); } catch (e: any) { flushTx = ''; alert(e?.shortMessage || e?.message || e); }
}
render();
fetch(API + '/health').then(r => r.json()).then(j => { health = j.lpNetwork === 'testnet' ? '· Staging Worker: connected (testnet)' : ''; render(); }).catch(() => {});
load().then(render).then(requote).then(render);
onWallet(() => load().then(requote).then(render));
setInterval(() => { if (!pend || pend.stage !== 'sent') load().then(render).catch(() => {}); }, 30_000);
