// Sweep the floor + multi-collection / cross-chain cart. Checkout batches per chain:
//  - MultiSea native listings: one Seaport fulfillAvailableOrders tx per chain (sold items are skipped + refunded)
//  - OpenSea listings: OpenSea fulfillment data, one tx per item
//  - Not enough on a chain: Relay moves funds from another chain first (MultiSea fee: $0.30 per top-up)
import { createWalletClient, custom, encodeFunctionData, parseAbiItem, concat, type Hex } from 'viem';
import { API, wallet, openConnect, overlay, ensureChain, readClient, vchain, friendly } from './wallet';
import { usdRates } from './shell';
import { chains, esc, logo, fmtWei, usdTxt, cart, addToCart, removeFromCart, clearCart, reportFill, topUpQuote, runRelay, balances, closed, type CartItem } from './gx';
import { fulfillAvailableCalldata, fulfillCalldata } from './seaorder';

const toArr = (v: any): any => (Array.isArray(v) ? v.map(toArr) : v && typeof v === 'object' ? Object.values(v).map(toArr) : v);
const rateOf = (r: any, k: string) => (r as any)?.[chains[k]?.native] || 0;

/** Sweep modal: cheapest N of the given listings (any chain), then sweep now or add to cart. */
export async function openSweep(all: CartItem[], colName: string) {
  const rates = await usdRates();
  const byChain = [...new Set(all.map(l => l.chain))];
  const st = { n: Math.min(10, all.length), on: new Set(byChain) };
  const m = overlay(`<div class="bhead"><div><div class="mut">${esc(colName)}</div><h3>🧹 Sweep the floor</h3></div></div><div class="bbody sweep"></div>`);
  m.querySelector('.wbox')!.classList.add('wide');
  const body = m.querySelector('.bbody') as HTMLElement;
  const pick = () => all.filter(l => st.on.has(l.chain)).sort((a, b) => usdOf(a) - usdOf(b)).slice(0, st.n);
  const usdOf = (l: CartItem) => l.price * (rateOf(rates, l.chain) || 1);
  body.innerHTML = `<div class="swrow"><label>Items<input class="swn" type="number" min="1" max="${all.length}" value="${st.n}"></label><input class="swr" type="range" min="1" max="${Math.max(1, Math.min(50, all.length))}" value="${st.n}"><span class="mut small">${all.length} listed</span></div>
    <div class="pills">${byChain.map(k => `<button class="pill on" data-swc="${k}">${logo(k)} ${esc(chains[k].name)}</button>`).join('')}</div><div class="swout"></div>`;
  const out = body.querySelector('.swout') as HTMLElement;
  const draw = () => {
    const sel = pick(); const per: Record<string, number> = {}; sel.forEach(l => per[l.chain] = (per[l.chain] || 0) + l.price);
    const usd = sel.reduce((s, l) => s + l.price * rateOf(rates, l.chain), 0);
    const msFee = sel.filter(l => l.source === 'multisea').reduce((s, l) => s + l.price * 0.005 * rateOf(rates, l.chain), 0);
    out.innerHTML = `<div class="swlist">${sel.map(l => `<div class="swi">${l.img ? `<img src="${esc(l.img)}" alt="">` : '<span class="ph"></span>'}<span>${esc(l.name)}</span>${logo(l.chain)}<b>${+l.price.toFixed(5)} ${esc(l.currency)}</b><i class="src ${l.source === 'multisea' ? 'ms' : 'os'}">${l.source === 'multisea' ? 'MultiSea' : 'OpenSea'}</i></div>`).join('') || '<p class="mut">No listings on the selected chains.</p>'}</div>
      <div class="kv bkv">${Object.entries(per).map(([k, v]) => `<span>${logo(k)} ${esc(chains[k].name)}</span><b>${+v.toFixed(6)} ${esc(chains[k].native)}</b>`).join('')}
        <span>MultiSea fee</span><b>${usdTxt(msFee) || '$0.00'} <i class="usd">included in MultiSea listings</i></b>
        <span>Total</span><b class="xtot">${usdTxt(usd)}</b></div>
      <p class="mut small">Batched per chain: MultiSea listings fill in one Seaport transaction per chain; OpenSea listings fill one by one. Items sold meanwhile are skipped and not charged. Missing funds on a chain can be moved from another chain via Relay.</p>
      <div class="two"><button class="bbtn ghost addc" ${sel.length ? '' : 'disabled'}>Add ${sel.length} to cart</button><button class="bbtn go" ${sel.length ? '' : 'disabled'}>🧹 Sweep ${sel.length} now</button></div>`;
  };
  body.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.classList.contains('swn') || t.classList.contains('swr')) { st.n = Math.max(1, Math.min(all.length, +t.value || 1)); (body.querySelector(t.classList.contains('swn') ? '.swr' : '.swn') as HTMLInputElement).value = String(st.n); draw(); } });
  body.addEventListener('click', e => {
    const t = e.target as HTMLElement; const c = t.closest('[data-swc]') as HTMLElement;
    if (c) { const k = c.dataset.swc!; st.on.has(k) ? st.on.delete(k) : st.on.add(k); c.classList.toggle('on', st.on.has(k)); draw(); return; }
    if (t.closest('.addc')) { const n = pick().length; addToCart(pick()); out.innerHTML = `<p class="ok">✓ Added ${n} items to your cart.</p><a class="bbtn" href="/cart">Open cart</a>`; return; }
    if (t.closest('.go')) { const sel = pick(); m.remove(); checkout(sel); }
  });
  draw();
}

type Prep = { chain: string; native: { item: CartItem; order: any }[]; os: { item: CartItem; tx: any; value: bigint; data: Hex }[]; gone: CartItem[]; value: bigint; msFeeWei: bigint };
async function prepare(items: CartItem[], status: (s: string) => void): Promise<Prep[]> {
  const groups: Record<string, CartItem[]> = {}; items.forEach(i => (groups[i.chain] ??= []).push(i));
  const out: Prep[] = [];
  for (const [k, list] of Object.entries(groups)) {
    const p: Prep = { chain: k, native: [], os: [], gone: [], value: 0n, msFeeWei: 0n };
    status(`Checking ${list.length} listing${list.length > 1 ? 's' : ''} on ${esc(chains[k].name)}…`);
    await Promise.all(list.map(async it => {
      try {
        if (it.source === 'multisea') {
          const r = await fetch(`${API}/native/order/${k}/${it.orderHash}`); if (!r.ok) { p.gone.push(it); return; }
          const o = await r.json(); p.native.push({ item: it, order: o });
          const v = o.parameters.consideration.reduce((s: bigint, c: any) => s + BigInt(c.startAmount), 0n); p.value += v;
          p.msFeeWei += o.parameters.consideration.slice(1).filter((c: any) => c.recipient.toLowerCase() === '0x25411039f77529a543344603bd8acdd65faba4d0').reduce((s: bigint, c: any) => s + BigInt(c.startAmount), 0n);
        } else {
          const fr = await fetch(`${API}/fulfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: it.orderHash, chain: chains[k].openseaSlug, protocolAddress: it.protocolAddress, fulfiller: wallet.address }) });
          if (!fr.ok) { p.gone.push(it); return; }
          const tx = (await fr.json()).transaction; const abi = parseAbiItem('function ' + tx.function) as any;
          let data = encodeFunctionData({ abi: [abi], functionName: abi.name, args: Object.values(tx.input_data).map(toArr) }); if (tx.calldata_suffix) data = concat([data, tx.calldata_suffix as Hex]);
          const value = BigInt(tx.value || 0); p.os.push({ item: it, tx, value, data }); p.value += value;
        }
      } catch { p.gone.push(it); }
    }));
    out.push(p);
  }
  return out;
}

/** Checkout any set of items (one or many chains). */
export async function checkout(items: CartItem[]) {
  if (!wallet.address) { openConnect(); return; }
  const me = wallet.address as Hex;
  const m = overlay(`<div class="bhead"><div><div class="mut">${items.length} item${items.length > 1 ? 's' : ''} · ${new Set(items.map(i => i.chain)).size} chain(s)</div><h3>Checkout</h3></div></div><div class="bbody"><div class="spin"></div> Preparing…</div>`);
  m.querySelector('.wbox')!.classList.add('wide');
  const body = m.querySelector('.bbody') as HTMLElement; const status = (s: string) => { body.innerHTML = `<div class="spin"></div> ${s}`; };
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const [preps, bal, rates] = await Promise.all([prepare(items, status), balances(), usdRates()]);
    const live = preps.filter(p => p.native.length || p.os.length);
    if (!live.length) throw Object.assign(new Error('None of these listings are still available.'), { kind: 'stale' });
    const gone = preps.flatMap(p => p.gone);
    const short = (p: Prep) => { const b = bal[p.chain] ?? 0n; const need = p.value + 10n ** 15n / 2n; return b >= need ? 0n : need - b; };
    const totalUsd = live.reduce((s, p) => s + +fmtWei(p.value).replace(/,/g, '') * rateOf(rates, p.chain), 0);
    const feeUsd = live.reduce((s, p) => s + +fmtWei(p.msFeeWei).replace(/,/g, '') * rateOf(rates, p.chain), 0);
    const needTop = live.filter(p => short(p) > 0n);
    const topUsd = needTop.length * 0.3;
    body.innerHTML = `${gone.length ? `<p class="err small">${gone.length} item(s) are no longer available and were removed.</p>` : ''}
      <div class="kv bkv">${live.map(p => `<span>${logo(p.chain)} ${esc(chains[p.chain].name)} · ${p.native.length + p.os.length} item(s)</span><b>${fmtWei(p.value)} ${esc(chains[p.chain].native)} <i class="usd">${usdTxt(+fmtWei(p.value).replace(/,/g, '') * rateOf(rates, p.chain))}</i></b>`).join('')}
        <span>MultiSea fee</span><b>${usdTxt(feeUsd + topUsd)} <i class="usd">${topUsd ? `incl. $0.30 × ${needTop.length} cross-chain top-up` : 'included'}</i></b>
        <span>Total</span><b class="xtot">${usdTxt(totalUsd + topUsd)} <i class="usd">+ gas</i></b></div>
      ${needTop.map(p => `<p class="mut small">${logo(p.chain)} Short ${fmtWei(short(p))} ${esc(chains[p.chain].native)} on ${esc(chains[p.chain].name)}: Relay will move it from your richest chain first.</p>`).join('')}
      <p class="mut small">Transactions: ${live.map(p => `${esc(chains[p.chain].name)} ${(p.native.length ? 1 : 0) + p.os.length}`).join(', ')}. You confirm each in ${esc(wallet.name || 'your wallet')}.</p>
      <button class="bbtn go">Confirm ${live.reduce((s, p) => s + p.native.length + p.os.length, 0)} purchase(s)</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    const done: string[] = []; const failed: string[] = []; const log: string[] = [];
    for (const p of live) {
      const c = chains[p.chain];
      try {
        const need = short(p);
        if (need > 0n) {
          const src = Object.entries(bal).filter(([k, b]) => k !== p.chain && b && chains[k].native === c.native).sort((a, b) => (b[1]! > a[1]! ? 1 : -1))[0]?.[0];
          if (!src) throw new Error(`Not enough ${c.native} on ${c.name} and no other chain to bridge from.`);
          status(`Quoting Relay ${esc(chains[src].name)} → ${esc(c.name)}…`); const q = await topUpQuote(src, p.chain, need);
          await runRelay(q.quote, src, s => status(s));
        }
        status(`Switching to ${esc(c.name)}…`); await ensureChain(p.chain);
        const wc = createWalletClient({ chain: vchain(p.chain), transport: custom(wallet.provider) }); const pub = readClient(p.chain);
        if (p.native.length) {
          const orders = p.native.map(x => ({ parameters: x.order.parameters, signature: x.order.signature }));
          const call = orders.length === 1 ? { data: fulfillCalldata(orders[0].parameters, orders[0].signature), value: p.native[0].order.parameters.consideration.reduce((s: bigint, x: any) => s + BigInt(x.startAmount), 0n) } : fulfillAvailableCalldata(orders);
          status(`Confirm ${orders.length} MultiSea item(s) on ${esc(c.name)} in your wallet…`);
          const h = await wc.sendTransaction({ account: me, to: p.native[0].order.protocolAddress, value: call.value, data: call.data });
          status(`Pending on ${esc(c.name)}… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`);
          const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
          if (rc.status === 'success') { reportFill(p.chain, h); done.push(...p.native.map(x => x.item.key)); log.push(`<a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">${esc(c.name)}: ${orders.length} MultiSea ↗</a>`); } else failed.push(...p.native.map(x => x.item.key));
        }
        for (const o of p.os) {
          status(`Confirm ${esc(o.item.name)} (OpenSea) in your wallet…`);
          try { const h = await wc.sendTransaction({ account: me, to: o.tx.to, value: o.value, data: o.data }); const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status === 'success') { reportFill(p.chain, h); done.push(o.item.key); log.push(`<a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">${esc(o.item.name)} ↗</a>`); } else failed.push(o.item.key); }
          catch (e: any) { if (e?.code === 4001 || /rejected/i.test(e?.message || '')) throw e; failed.push(o.item.key); }
        }
      } catch (e: any) { failed.push(...p.native.map(x => x.item.key), ...p.os.map(x => x.item.key)); log.push(`<span class="errc">${esc(c.name)}: ${esc(friendly(e, p.chain))}</span>`); }
    }
    clearCart([...done, ...gone.map(g => g.key)]);
    body.innerHTML = `${done.length ? `<p class="ok">✓ Bought ${done.length} item(s).</p>` : ''}${failed.length ? `<p class="err">${failed.length} item(s) not bought (kept in your cart).</p>` : ''}<div class="small">${log.join('<br>')}</div><a class="bbtn" href="/cart">Back to cart</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e)); }
}

/** /cart page */
export function cartPage(el: HTMLElement) {
  const draw = async () => {
    const c = cart(); const rates = await usdRates();
    const per: Record<string, CartItem[]> = {}; c.forEach(i => (per[i.chain] ??= []).push(i));
    const usd = c.reduce((s, i) => s + i.price * rateOf(rates, i.chain), 0);
    const fee = c.filter(i => i.source === 'multisea').reduce((s, i) => s + i.price * 0.005 * rateOf(rates, i.chain), 0);
    el.innerHTML = `<h2>Cart</h2><p class="mut">Buy across collections and chains in one go. Use <b>🧹 Sweep</b> on any collection page to add the cheapest N.</p>
      ${c.length ? Object.entries(per).map(([k, l]) => `<div class="fcard"><div class="gh">${logo(k)} ${esc(chains[k].name)} <span class="mut small">${l.length} item(s) · ${l.filter(x => x.source === 'multisea').length ? '1 batched Seaport tx' : ''}${l.filter(x => x.source === 'opensea').length ? ` + ${l.filter(x => x.source === 'opensea').length} OpenSea tx` : ''}</span></div>
        ${l.map(i => `<div class="swi">${i.img ? `<img src="${esc(i.img)}" alt="">` : '<span class="ph"></span>'}<span>${esc(i.name)}</span><b>${+i.price.toFixed(5)} ${esc(i.currency)}</b><i class="src ${i.source === 'multisea' ? 'ms' : 'os'}">${i.source === 'multisea' ? 'MultiSea' : 'OpenSea'}</i><button class="x sm" data-rm="${esc(i.key)}">✕</button></div>`).join('')}</div>`).join('') : '<div class="empty">Your cart is empty. <a href="/c/lil-foots">Sweep a collection →</a></div>'}
      ${c.length ? `<div class="kv bkv"><span>Items</span><b>${c.length}</b><span>MultiSea fee</span><b>${usdTxt(fee) || '$0.00'} <i class="usd">included · +$0.30 per cross-chain top-up if needed</i></b><span>Total</span><b class="xtot">${usdTxt(usd)}</b></div>
        <div class="two"><button class="bbtn ghost" data-act="clear-cart">Clear</button><button class="bbtn" data-act="checkout">Checkout</button></div>` : ''}`;
  };
  el.addEventListener('click', e => { const t = e.target as HTMLElement; const r = t.closest('[data-rm]') as HTMLElement; if (r) { removeFromCart(r.dataset.rm!); draw(); } if (t.dataset.act === 'clear-cart') { clearCart(); draw(); } if (t.dataset.act === 'checkout') checkout(cart()); });
  draw(); return draw;
}
