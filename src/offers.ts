// Collection offers: escrowed bids in each chain's native coin. UI is hidden on chains with no contract in config.
import { createWalletClient, custom, encodeFunctionData, formatUnits, parseUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import ART from '../config/collection-offers-artifact.json';
import { API, readClient, wallet, openConnect, overlay, vchain, ensureChain, friendly, esc } from './wallet';
import { preflight, assertSendable } from './txgas';
import { EXPIRY } from './seaorder';
import { usdRates, type UsdRates } from './shell';
const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="/logos/${k}.svg" alt="">`;

const chains = CFG.chains as Record<string, { name: string; native: string; chainId: number; explorer: string }>;
const ABI = ART.abi as any;
const ZERO = '0x0000000000000000000000000000000000000000';
const ERC721 = [
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
] as const;

export type Offer = {
  id: string; chain: string; slug?: string; buyer: string; collection: string;
  pricePerItem: string; quantity: string; remaining: string; expiry: number;
  royaltyBps?: number; feeBps?: number; cancelled?: boolean;
};
export type OffersPayload = { offers: Offer[]; contracts: Record<string, string>; best: Record<string, Offer> };

export const offersAddr = (k: string) => {
  const a = String((CFG as any).collectionOffers?.[k] || '');
  return /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a) ? a as Hex : null;
};
export const offersLive = (k: string) => !!offersAddr(k);
export const offerChainsOf = (deployments: { chain: string }[]) => deployments.map(d => d.chain).filter(offersLive);
export const anyOffersLive = (deployments: { chain: string }[]) => offerChainsOf(deployments).length > 0;

const fmt = (w: bigint) => (+formatUnits(w, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtUsd = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: n < 1000 ? 2 : 0, maximumFractionDigits: n < 1000 ? 2 : 0 });
export const pxKey = (native: string): keyof UsdRates => (native === 'APE' || native === 'BNB' ? native : 'ETH');
export const offerUsd = (o: Offer, rates: UsdRates | null | undefined) => {
  const px = rates?.[pxKey(chains[o.chain]?.native)] || 0;
  if (!px) return null;
  return Number(formatUnits(BigInt(o.pricePerItem), 18)) * px;
};

export async function loadOffers(slug: string, signal?: AbortSignal): Promise<OffersPayload> {
  const empty: OffersPayload = { offers: [], contracts: {}, best: {} };
  if (!API) return empty;
  try {
    const r = await fetch(`${API}/offers/${encodeURIComponent(slug)}`, { signal });
    if (!r.ok) return empty;
    const j = await r.json();
    return { offers: j.offers || [], contracts: j.contracts || {}, best: j.best || {} };
  } catch { return empty; }
}

export function offerStatHtml(best: Record<string, Offer> | undefined, selected: string | null | undefined, rates: UsdRates | null, deployments: { chain: string }[]) {
  if (!anyOffersLive(deployments)) return '';
  const live = offerChainsOf(deployments);
  const tip = live.map(k => {
    const o = best?.[k]; const c = chains[k];
    const usd = o ? offerUsd(o, rates) : null;
    const val = o ? `${fmt(BigInt(o.pricePerItem))} ${esc(c.native)}${usd != null ? ' · ' + fmtUsd(usd) : ''}` : '—';
    return `<div class="tipr">${logo(k)}<span>${esc(c.name)}</span><b>${val}</b></div>`;
  }).join('');
  const note = '<div class="tipnote">Best collection offer, paid in that chain\'s native coin. An offer on one chain can only be accepted with an NFT on that chain.</div>';
  let inner = '—';
  const sel = selected && live.includes(selected) ? selected : null;
  if (sel) {
    const o = best?.[sel]; const c = chains[sel];
    if (o) {
      const usd = offerUsd(o, rates);
      inner = `${logo(sel)} ${fmt(BigInt(o.pricePerItem))} ${esc(c.native)}${usd != null ? `<small class="usd">${fmtUsd(usd)}</small>` : ''}`;
    }
  } else {
    let top: { o: Offer; usd: number } | null = null;
    for (const k of live) {
      const o = best?.[k]; if (!o) continue;
      const usd = offerUsd(o, rates);
      if (usd == null) continue;
      if (!top || usd > top.usd) top = { o, usd };
    }
    if (top) inner = `${logo(top.o.chain)} ${fmtUsd(top.usd)}`;
    else {
      // rates missing: show the highest-price offer that shares a symbol, else first
      const list = live.map(k => best?.[k]).filter(Boolean) as Offer[];
      if (list.length) {
        const o = list.reduce((a, b) => BigInt(b.pricePerItem) > BigInt(a.pricePerItem) ? b : a);
        inner = `${logo(o.chain)} ${fmt(BigInt(o.pricePerItem))} ${esc(chains[o.chain].native)}`;
      }
    }
  }
  return `<div class="stat tip offerstat"><b>${inner}</b><span>Offer ⓘ</span><div class="tipbox">${tip}${note}</div></div>`;
}

const wcOf = (k: string) => createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
const closed = (m: HTMLElement) => new Promise<never>((_, rej) => m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) rej(Object.assign(new Error('closed'), { kind: 'closed' })); }));
const report = (k: string, h: string) => { fetch(`${API}/offers/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: k, txHash: h }) }).catch(() => {}); };

async function cfgOf(slug: string) {
  const r = await fetch(`${API}/offers/config/${encodeURIComponent(slug)}`).then(x => x.ok ? x.json() : null).catch(() => null);
  return r || { feeRecipient: (ART as any).feeRecipient, feeBps: 50, royalty: null, contracts: (CFG as any).collectionOffers || {}, maxExpiryDays: 180 };
}

export type MakeCtx = { slug: string; name: string; deployments: { chain: string; address: string }[] };
export async function openMakeOffer(ctx: MakeCtx, onDone?: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const live = offerChainsOf(ctx.deployments);
  if (!live.length) return;
  const m = overlay(`<div class="bhead"><div><div class="mut">${esc(ctx.name)}</div><h3>Make collection offer</h3></div></div><div class="bbody"><div class="spin"></div> Loading…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const cfg = await cfgOf(ctx.slug);
    const rates = await usdRates().catch(() => null);
    let chain = live[0];
    let exp: keyof typeof EXPIRY = '7d';
    const paint = () => {
      const c = chains[chain]; const px = rates?.[pxKey(c.native)];
      const priceEl = body.querySelector<HTMLInputElement>('[data-price]');
      const qtyEl = body.querySelector<HTMLInputElement>('[data-qty]');
      const price = priceEl ? parseUnits(priceEl.value || '0', 18) : 0n;
      const qty = BigInt(Math.max(1, Math.min(100_000, Math.floor(+(qtyEl?.value || '1') || 1))));
      const total = price * qty;
      const fee = total * 50n / 10_000n;
      const royBps = cfg.royalty?.bps ? BigInt(cfg.royalty.bps) : 0n;
      const roy = royBps ? total * royBps / 10_000n : 0n;
      const usd = px && total > 0n ? ' ≈ ' + fmtUsd(Number(formatUnits(total, 18)) * px) : '';
      const feeRow = body.querySelector('[data-fees]');
      if (feeRow) feeRow.innerHTML = `<div class="kv bkv"><span>You deposit</span><b>${fmt(total)} ${esc(c.native)}${usd}</b><span>MultiSea fee (0.5%)</span><b>${fmt(fee)} ${esc(c.native)}</b>${royBps ? `<span>Creator royalty (${Number(royBps) / 100}%)</span><b>${fmt(roy)} ${esc(c.native)}</b>` : ''}<span>Seller receives (per item)</span><b>${price > 0n ? fmt(price - (price * 50n / 10_000n) - (royBps ? price * royBps / 10_000n : 0n)) : '0'} ${esc(c.native)}</b></div>`;
    };
    body.innerHTML = `<p class="mut small">Your offer is in ${'native coin on the chain you pick'}. A seller can accept it only with an NFT from this collection that is on that chain.</p>
      <div class="sl"><span>Chain</span><div class="pills">${live.map((k, i) => `<button type="button" class="pill${i === 0 ? ' on' : ''}" data-chain="${k}">${logo(k)} ${esc(chains[k].name)} · ${esc(chains[k].native)}</button>`).join('')}</div></div>
      <div class="sl"><span>Price per item</span><div class="prow"><input data-price type="text" inputmode="decimal" placeholder="0.0" autocomplete="off"><span data-nat>${esc(chains[chain].native)}</span></div></div>
      <div class="sl"><span>Quantity</span><input data-qty type="number" min="1" max="100000" value="1" style="width:120px"></div>
      <div class="sl"><span>Expires in</span><div class="pills">${Object.keys(EXPIRY).map((k, i) => `<button type="button" class="pill${i === 1 ? ' on' : ''}" data-exp="${k}">${k.replace('d', ' day' + (k === '1d' ? '' : 's'))}</button>`).join('')}</div></div>
      <div data-fees></div>
      <p class="mut small">You can cancel anytime and get unused funds back. After it expires, anyone can trigger the refund to you.</p>
      <button class="bbtn go">Review offer</button>`;
    paint();
    body.addEventListener('input', paint);
    body.addEventListener('click', ev => {
      const t = ev.target as HTMLElement;
      const ch = t.closest('[data-chain]') as HTMLElement | null;
      if (ch) { chain = ch.dataset.chain!; body.querySelectorAll('[data-chain]').forEach(x => x.classList.toggle('on', x === ch)); const nat = body.querySelector('[data-nat]'); if (nat) nat.textContent = chains[chain].native; paint(); }
      const ex = t.closest('[data-exp]') as HTMLElement | null;
      if (ex) { exp = ex.dataset.exp as keyof typeof EXPIRY; body.querySelectorAll('[data-exp]').forEach(x => x.classList.toggle('on', x === ex)); }
    });
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    const price = parseUnits((body.querySelector<HTMLInputElement>('[data-price]')!.value || '0').trim() || '0', 18);
    const qtyN = Math.max(1, Math.min(100_000, Math.floor(+(body.querySelector<HTMLInputElement>('[data-qty]')!.value || '1') || 1)));
    if (price <= 0n) throw Object.assign(new Error('Enter a price greater than zero.'), { kind: 'stale' });
    const qty = BigInt(qtyN);
    const value = price * qty;
    const to = offersAddr(chain)!;
    const collection = ctx.deployments.find(d => d.chain === chain)!.address as Hex;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + EXPIRY[exp]);
    const royTo = (cfg.royalty?.vaults?.[chain] || cfg.royalty?.recipient || ZERO) as Hex; // a RevShareVault on this chain, if the founder set one up
    const royBps = Number(cfg.royalty?.bps || 0);
    const data = encodeFunctionData({ abi: ABI, functionName: 'makeOffer', args: [collection, price, qty, expiry, royTo, royBps] });
    const c = chains[chain]; const me = wallet.address as Hex;
    body.innerHTML = '<div class="spin"></div> Checking balance…';
    const pre = await preflight(chain, { to, data, value });
    if (!pre.enough || pre.reverted) assertSendable(chain, pre, value);
    body.innerHTML = `<div class="kv bkv"><span>Offer</span><b>${fmt(price)} ${esc(c.native)} × ${qtyN}</b><span>You deposit</span><b>${fmt(value)} ${esc(c.native)}</b><span>Chain</span><b>${logo(chain)} ${esc(c.name)}</b><span>Expires</span><b>${exp}</b><span>Network gas (est.)</span><b>~${fmt(pre.costWei)} ${esc(c.native)}</b></div>
      <p class="mut small">You'll confirm in ${esc(wallet.name || 'your wallet')}. Funds stay in the offers contract until a holder accepts or you cancel.</p>
      <button class="bbtn go">Confirm offer</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    await ensureChain(chain);
    const gas = assertSendable(chain, await preflight(chain, { to, data, value }), value);
    const h = await wcOf(chain).sendTransaction({ account: me, to, value, data, ...(gas ? { gas } : {}) });
    const link = `${c.explorer}/tx/${h}`;
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await readClient(chain).waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Transaction reverted.');
    report(chain, h); onDone?.();
    body.innerHTML = `<p class="ok">✓ Offer is live on ${esc(c.name)}.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, (e as any).chain)); }
}

export type AcceptCtx = { id: number; name: string; img: string; chain: string; contract: string; slug: string; offer: Offer };
export async function openAccept(ctx: AcceptCtx, onDone?: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const { offer } = ctx; const k = offer.chain; const c = chains[k]; const to = offersAddr(k);
  if (!to) return;
  const m = overlay(`<div class="bhead"><img src="${esc(ctx.img)}" alt=""><div><div class="mut">${esc(c.name)} · Accept collection offer</div><h3>${esc(ctx.name)}</h3></div></div><div class="bbody"><div class="spin"></div> Checking…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const me = wallet.address as Hex;
    const pub = readClient(k);
    const approved = await pub.readContract({ address: ctx.contract as Hex, abi: ERC721, functionName: 'isApprovedForAll', args: [me, to] });
    const data = encodeFunctionData({ abi: ABI, functionName: 'accept', args: [BigInt(offer.id), BigInt(ctx.id)] });
    const price = BigInt(offer.pricePerItem);
    const fee = price * 50n / 10_000n;
    const roy = offer.royaltyBps ? price * BigInt(offer.royaltyBps) / 10_000n : 0n;
    const net = price - fee - roy;
    const rates = await usdRates().catch(() => null);
    const usdBit = (w: bigint) => { const px = rates?.[pxKey(c.native)]; if (!px) return ''; const v = Number(formatUnits(w, 18)) * px; return ` (${'$' + v.toLocaleString(undefined, { minimumFractionDigits: v < 1000 ? 2 : 0, maximumFractionDigits: v < 1000 ? 2 : 0 })})`; };
    body.innerHTML = `<div class="kv bkv"><span>You receive</span><b>${fmt(net)} ${esc(c.native)}${usdBit(net)}</b><span>Offer price</span><b>${fmt(price)} ${esc(c.native)}${usdBit(price)}</b><span>MultiSea fee (0.5%)</span><b>${fmt(fee)} ${esc(c.native)}</b>${roy ? `<span>Creator royalty</span><b>${fmt(roy)} ${esc(c.native)}</b>` : ''}<span>Chain</span><b>${logo(k)} ${esc(c.name)}</b></div>
      ${approved ? '' : `<p class="mut small">You'll first approve the MultiSea offers contract to transfer this NFT (one-time per collection on ${esc(c.name)}).</p>`}
      <p class="mut small">This NFT must stay in your wallet on ${esc(c.name)} until the transaction confirms. If this collection uses a transfer validator (for example Creator Token / EIP-7702 rules), the creator may need to allowlist the offers contract.</p>
      <button class="bbtn go">Accept offer</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    await ensureChain(k);
    if (!approved) {
      const approval = encodeFunctionData({ abi: ERC721, functionName: 'setApprovalForAll', args: [to, true] });
      const pre = await preflight(k, { to: ctx.contract, data: approval, value: 0n }).catch(() => null);
      if (pre && !pre.enough) throw Object.assign(new Error(`You need a little ${c.native} on ${c.name} to pay the one-time approval fee (about $0.01). Add some ${c.native} on ${c.name} and try again.`), { kind: 'stale' });
      if (pre?.reverted) throw Object.assign(new Error(friendly({ shortMessage: pre.reverted }, k)), { kind: 'stale' });
      body.innerHTML = '<div class="spin"></div> Approve the offers contract in your wallet…';
      const h1 = await wcOf(k).writeContract({ account: me, address: ctx.contract as Hex, abi: ERC721, functionName: 'setApprovalForAll', args: [to, true] });
      const rc1 = await pub.waitForTransactionReceipt({ hash: h1, timeout: 180_000 });
      if (rc1.status !== 'success') throw new Error('Approval transaction reverted.');
    }
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    const pre = await preflight(k, { to, data, value: 0n });
    if (pre.reverted) throw Object.assign(new Error(friendly({ shortMessage: pre.reverted, data: pre.reverted }, k) || `This accept would fail on ${c.name} right now (the offer may have been filled, cancelled, or this NFT moved). Nothing was sent.`), { kind: 'stale' });
    if (!pre.enough) throw Object.assign(new Error(`You need a little ${c.native} on ${c.name} to pay the gas to accept this offer.`), { kind: 'stale' });
    const gas = pre.gas;
    const h = await wcOf(k).sendTransaction({ account: me, to, data, value: 0n, ...(gas ? { gas } : {}) });
    const link = `${c.explorer}/tx/${h}`;
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Transaction reverted. The offer may have been cancelled or this NFT moved.');
    report(k, h); onDone?.();
    body.innerHTML = `<p class="ok">✓ Sold! You received ${fmt(net)} ${esc(c.native)}.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, ctx.chain)); }
}

export async function openCancel(offer: Offer, onDone?: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const k = offer.chain; const c = chains[k]; const to = offersAddr(k);
  if (!to) return;
  const expired = Math.floor(Date.now() / 1000) >= Number(offer.expiry);
  const refund = BigInt(offer.remaining) * BigInt(offer.pricePerItem);
  const fn = expired ? 'refundExpired' : 'cancel';
  const m = overlay(`<div class="bhead"><div><div class="mut">${esc(c.name)} · ${expired ? 'Claim expired offer' : 'Cancel offer'}</div><h3>Refund ${fmt(refund)} ${esc(c.native)}</h3></div></div><div class="bbody">
    <p class="mut small">${expired ? 'This offer has expired. Unused funds go back to your wallet.' : 'Cancel this collection offer and withdraw the unused deposit.'}</p>
    <button class="bbtn go">${expired ? 'Claim refund' : 'Cancel and withdraw'}</button></div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    const me = wallet.address as Hex;
    const data = encodeFunctionData({ abi: ABI, functionName: fn, args: [BigInt(offer.id)] });
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    await ensureChain(k);
    const pre = await preflight(k, { to, data, value: 0n });
    if (pre.reverted) throw Object.assign(new Error(friendly({ shortMessage: pre.reverted }, k) || 'This refund would fail right now.'), { kind: 'stale' });
    if (!pre.enough) throw Object.assign(new Error(`You need a little ${c.native} on ${c.name} to pay the gas.`), { kind: 'stale' });
    const h = await wcOf(k).sendTransaction({ account: me, to, data, value: 0n, ...(pre.gas ? { gas: pre.gas } : {}) });
    const link = `${c.explorer}/tx/${h}`;
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Transaction reverted.');
    report(k, h); onDone?.();
    body.innerHTML = `<p class="ok">✓ ${fmt(refund)} ${esc(c.native)} returned to your wallet.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, k)); }
}

export function bestOfferOn(offers: Offer[], chain: string): Offer | null {
  const now = Math.floor(Date.now() / 1000);
  const open = offers.filter(o => o.chain === chain && !o.cancelled && Number(o.remaining) > 0 && Number(o.expiry) > now);
  if (!open.length) return null;
  return open.reduce((a, b) => BigInt(b.pricePerItem) > BigInt(a.pricePerItem) ? b : a);
}

export function myOpenOffers(offers: Offer[], address?: string | null) {
  const me = address?.toLowerCase(); if (!me) return [];
  const now = Math.floor(Date.now() / 1000);
  return offers.filter(o => o.buyer === me && !o.cancelled && Number(o.remaining) > 0 && (Number(o.expiry) > now || true));
}
