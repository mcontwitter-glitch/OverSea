// One cart across chains: pay with any token you hold on any chain; MultiSea plans one Relay route per
// destination chain and batches the origin-chain transactions into as few wallet confirmations as possible.
//  - One step (Relay call execution): open Seaport orders (MultiSea native listings, zone 0) are bought by
//    Relay's solver on the destination chain via fulfillAdvancedOrder(recipient = buyer). Atomic per chain:
//    if a listing sells mid-route the call reverts and Relay refunds the payment on the origin chain.
//  - Two step (fallback): OpenSea (signed-zone) listings bind the zone signature to msg.sender, so Relay
//    moves funds to the buyer's own wallet on that chain and the buyer confirms there. Unspent funds stay in
//    the buyer's wallet (credit).
import { createWalletClient, custom, erc20Abi, formatUnits, parseAbi, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, overlay, ensureChain, readClient, vchain, friendly, openConnect } from './wallet';
import { usdRates } from './shell';
import { chains, esc, logo, usdTxt, clearCart, reportFill, closed, sleep, type CartItem } from './gx';
import { prepare, checkout as classicCheckout, type Prep } from './cart';
import { fulfillAvailableCalldata, fulfillCalldata } from './seaorder';
import { RELAY, ZERO, FLAT_FEE_USD, relayQuote, advancedFulfillCalldata, oneStepOk } from './xpaycore';
import { gasUnits, gasFor } from './txgas';

type Tok = { symbol: string; address: string; decimals: number; permit?: boolean };
// Tokens Relay can route from (addresses from Relay /chains). Native coins are always included.
const ERC20: Record<string, Tok[]> = {
  ethereum: [{ symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, permit: true }, { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 }, { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 }, { symbol: 'APE', address: '0x4d224452801aced8b2f0aebe155379bb5d594381', decimals: 18 }],
  base: [{ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, permit: true }, { symbol: 'USDT', address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6 }, { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 }],
  abstract: [{ symbol: 'USDC', address: '0x84a71ccd554cc1b02749b35d22f684cc8ec987e1', decimals: 6 }],
  bnb: [{ symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 }],
  robinhood: [{ symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, permit: true }],
};
const L1 = new Set(['ethereum']); // expensive origin gas
export type Src = { id: string; chain: string; token: string; symbol: string; decimals: number; bal: bigint; usd: number; px: number; permit: boolean };
const num = (x: any) => Number(x || 0);
const fmtU = (v: bigint, d: number, max = 6) => (+formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: max });
const pxOf = (r: any, sym: string) => (/^(USDC|USDT|USDG)$/.test(sym) ? 1 : sym === 'WETH' ? r.ETH || 0 : r[sym] || 0);
const rateOf = (r: any, k: string) => r?.[chains[k]?.native] || 0;
const ownerAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const statusAbi = parseAbi(['function getOrderStatus(bytes32) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)']);

export async function detectSources(me: Hex): Promise<Src[]> {
  const r: any = await usdRates(); const out: Src[] = [];
  await Promise.all(Object.keys(chains).map(async k => {
    const pub = readClient(k);
    const nb = await pub.getBalance({ address: me }).catch(() => null);
    if (nb != null) { const px = rateOf(r, k); out.push({ id: `${k}:native`, chain: k, token: ZERO, symbol: chains[k].native, decimals: 18, bal: nb, px, usd: +formatUnits(nb, 18) * px, permit: false }); }
    await Promise.all((ERC20[k] || []).map(async t => {
      const b = await pub.readContract({ address: t.address as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [me] }).catch(() => null);
      if (b == null) return; const px = pxOf(r, t.symbol);
      out.push({ id: `${k}:${t.address}`, chain: k, token: t.address, symbol: t.symbol, decimals: t.decimals, bal: b, px, usd: +formatUnits(b, t.decimals) * px, permit: !!t.permit });
    }));
  }));
  return out.sort((a, b) => b.usd - a.usd);
}

/** Cheapest-route heuristic: fewer Relay routes, cheap origin gas, gasless permits; must cover the cart. */
export function rankSources(srcs: Src[], legs: { chain: string; usd: number; oneStep: boolean }[], needUsd: number) {
  return srcs.map(s => {
    const routes = legs.filter(l => !(l.chain === s.chain && s.token === ZERO)).length;
    const est = routes * (FLAT_FEE_USD + 0.1) + (L1.has(s.chain) ? 1.5 * Math.max(1, routes) : 0.03 * routes) - (s.permit ? 0.02 : 0);
    return { s, est, ok: s.usd >= needUsd * 1.01 + est };
  }).sort((a, b) => (a.ok === b.ok ? a.est - b.est : a.ok ? -1 : 1));
}

type Call = { to: Hex; data: Hex; value: bigint; gas?: bigint };
type Leg = {
  chain: string; prep: Prep; items: CartItem[];
  one: { item: CartItem; order: any }[]; oneVal: bigint;            // Relay call execution
  restCalls: { keys: string[]; label: string; call: Call }[]; restVal: bigint; // buyer-executed on the chain
  direct: boolean; callQ?: any; bridgeQ?: any; bridgeNeed: bigint; destGasUsd: number; itemsUsd: number;
};
export type Plan = { src: Src; legs: Leg[]; gone: CartItem[]; tokenTotal: bigint; totalUsd: number; subtotalUsd: number; feeUsd: number; routes: number; gasUsd: number; confirmations: number; batch: boolean; at: number };

async function revalidate(p: Prep) {
  const pub = readClient(p.chain); const keep: Prep['native'] = [];
  await Promise.all(p.native.map(async x => {
    const o = x.order.parameters; const nft = o.offer[0];
    const [st, owner] = await Promise.all([
      pub.readContract({ address: x.order.protocolAddress, abi: statusAbi, functionName: 'getOrderStatus', args: [x.order.orderHash] }).catch(() => null),
      pub.readContract({ address: nft.token, abi: ownerAbi, functionName: 'ownerOf', args: [BigInt(nft.identifierOrCriteria)] }).catch(() => null),
    ]);
    const bad = (st && (st[1] || (st[3] > 0n && st[2] >= st[3]))) || (owner && owner.toLowerCase() !== o.offerer.toLowerCase()) || Number(o.endTime) * 1000 < Date.now();
    if (bad) p.gone.push(x.item); else keep.push(x);
  }));
  p.native = keep;
}

/** atomic batch support (EIP-5792) on a chain */
async function canBatch(k: string): Promise<boolean> {
  try {
    const hex = '0x' + chains[k].chainId.toString(16);
    const c = await wallet.provider.request({ method: 'wallet_getCapabilities', params: [wallet.address, [hex]] });
    const v = c?.[hex] || c?.[chains[k].chainId] || {};
    return ['supported', 'ready'].includes(v.atomic?.status) || v.atomicBatch?.supported === true;
  } catch { return false; }
}

async function quote2(src: Src, k: string, amount: bigint, me: Hex, txs: any[] | undefined, permit: boolean, usdHint = 0) {
  const base = { user: me, originChainId: chains[src.chain].chainId, originCurrency: src.token, destinationChainId: chains[k].chainId, amount, txs, usePermit: permit };
  // App fee = $0.30 per route, expressed in bps of the input. Size it from the known USD value (one quote);
  // only fall back to an indicative quote when no price is known.
  const inUsd = usdHint > 0 ? usdHint : num((await relayQuote(base)).details?.currencyIn?.amountUsd);
  const feeBps = inUsd > 0 ? (Math.ceil((FLAT_FEE_USD / inUsd) * 10000 * 100) / 100).toFixed(2) : '0';
  try { return await relayQuote({ ...base, feeBps }); }
  catch (e: any) { if (/try again later|rate/i.test(e?.message || '')) { await sleep(2500); return relayQuote({ ...base, feeBps }); } throw e; }
}
const qIn = (q: any) => BigInt(q?.details?.currencyIn?.amount || 0);
const qCost = (q: any) => Math.max(num(q?.details?.currencyIn?.amountUsd) - num(q?.details?.currencyOut?.amountUsd), num(q?.fees?.relayer?.amountUsd) + num(q?.fees?.app?.amountUsd));
const qTxSteps = (q: any) => (q?.steps || []).filter((s: any) => s.kind === 'transaction').reduce((n: number, s: any) => n + s.items.length, 0);
const qSigSteps = (q: any) => (q?.steps || []).filter((s: any) => s.kind === 'signature').reduce((n: number, s: any) => n + s.items.length, 0);

export async function buildPlan(items: CartItem[], src: Src, status: (s: string) => void, preps?: Prep[]): Promise<Plan> {
  const me = wallet.address as Hex; const r: any = await usdRates();
  preps ??= await prepare(items, status);
  status('Re-validating listings on-chain…'); await Promise.all(preps.map(revalidate));
  const batch = await canBatch(src.chain);
  const permit = src.permit && !batch; // with atomic batching approve+deposit is already one confirmation
  const legs: Leg[] = [];
  for (const p of preps) {
    if (!p.native.length && !p.os.length) continue;
    const k = p.chain; const direct = k === src.chain && src.token === ZERO;
    const one = direct ? [] : p.native.filter(x => oneStepOk(x.order.parameters));
    const restN = p.native.filter(x => !one.includes(x));
    const restCalls: Leg['restCalls'] = [];
    if (restN.length) { const orders = restN.map(x => ({ parameters: x.order.parameters, signature: x.order.signature })); const c = orders.length === 1 ? { data: fulfillCalldata(orders[0].parameters, orders[0].signature), value: BigInt(restN[0].order.priceWei || orders[0].parameters.consideration.reduce((s: bigint, x: any) => s + BigInt(x.startAmount), 0n)) } : fulfillAvailableCalldata(orders); restCalls.push({ keys: restN.map(x => x.item.key), label: `${restN.length} MultiSea`, call: { to: restN[0].order.protocolAddress, data: c.data as Hex, value: c.value } }); }
    p.os.forEach(o => restCalls.push({ keys: [o.item.key], label: o.item.name + ' (OpenSea)', call: { to: o.tx.to, data: o.data, value: o.value } }));
    const oneCalls = one.map(x => advancedFulfillCalldata({ parameters: x.order.parameters, signature: x.order.signature }, me));
    const oneVal = oneCalls.reduce((s, c) => s + c.value, 0n); const restVal = restCalls.reduce((s, c) => s + c.call.value, 0n);
    const pub = readClient(k); const gp = await pub.getGasPrice().catch(() => 0n);
    const gasW = gp * gasUnits(k, restCalls.length); // per-chain gas units (Abstract's zkVM needs ~10x a normal EVM chain)
    const destGasUsd = +formatUnits(gasW, 18) * rateOf(r, k);
    const leg: Leg = { chain: k, prep: p, items: [...p.native.map(x => x.item), ...p.os.map(x => x.item)], one, oneVal, restCalls, restVal, direct, bridgeNeed: 0n, destGasUsd, itemsUsd: 0 };
    leg.itemsUsd = leg.items.reduce((s, i) => s + i.price * rateOf(r, k), 0);
    status(`Quoting Relay routes for ${esc(chains[k].name)}…`);
    if (one.length) leg.callQ = await quote2(src, k, oneVal, me, oneCalls.map(c => ({ to: CFG.seaport, value: c.value.toString(), data: c.data })), permit, +formatUnits(oneVal, 18) * rateOf(r, k));
    if (!direct && restCalls.length) {
      const bal = await pub.getBalance({ address: me }).catch(() => 0n);
      const want = restVal + gasW * 2n; leg.bridgeNeed = want > bal ? want - bal : 0n;
      if (leg.bridgeNeed > 0n) { if (leg.bridgeNeed < 10n ** 13n) leg.bridgeNeed = 10n ** 13n; leg.bridgeQ = await quote2(src, k, leg.bridgeNeed, me, undefined, permit, +formatUnits(leg.bridgeNeed, 18) * rateOf(r, k)); }
    }
    legs.push(leg);
  }
  const qs = legs.flatMap(l => [l.callQ, l.bridgeQ]).filter(Boolean);
  const directVal = legs.filter(l => l.direct).reduce((s, l) => s + l.restVal, 0n);
  const originGasUsd = qs.reduce((s, q) => s + num(q.fees?.gas?.amountUsd), 0);
  const destGasUsd = legs.reduce((s, l) => s + l.destGasUsd, 0);
  const subtotalUsd = legs.reduce((s, l) => s + l.itemsUsd, 0);
  const feeUsd = qs.reduce((s, q) => s + qCost(q), 0);
  const tokenTotal = qs.reduce((s, q) => s + qIn(q), 0n) + directVal;
  const totalUsd = qs.reduce((s, q) => s + num(q.details?.currencyIn?.amountUsd), 0) + +formatUnits(directVal, 18) * src.px + originGasUsd + destGasUsd;
  // wallet confirmations: origin txs (1 if batched) + permit signatures + buyer txs on other chains
  const originTx = qs.reduce((n, q) => n + qTxSteps(q), 0) + legs.filter(l => l.direct).reduce((n, l) => n + l.restCalls.length, 0);
  const sigs = qs.reduce((n, q) => n + qSigSteps(q), 0);
  const destTx = legs.filter(l => !l.direct && l.restCalls.length).reduce((n, l) => n + l.restCalls.length, 0);
  const destChains = legs.filter(l => !l.direct && l.restCalls.length).length;
  const confirmations = (batch ? Math.min(1, originTx) : originTx) + sigs + (batch ? destChains : destTx);
  return { src, legs, gone: preps.flatMap(p => p.gone), tokenTotal, totalUsd, subtotalUsd, feeUsd, routes: qs.length, gasUsd: originGasUsd + destGasUsd, confirmations, batch, at: Date.now() };
}

const legMode = (l: Leg) => l.direct ? ['direct', 'Direct · you pay on this chain'] : l.one.length && !l.restCalls.length ? ['one', '1 step · Relay buys for you'] : l.one.length ? ['mix', '1 step + 2 step'] : ['two', l.bridgeQ ? '2 step · Relay tops up, you confirm' : '2 step · your balance here'];

export function planHtml(p: Plan) {
  const s = p.src; const per = p.legs;
  return `${p.gone.length ? `<p class="err small">${p.gone.length} item(s) are no longer available and were left out: ${p.gone.map(g => esc(g.name)).join(', ')}.</p>` : ''}
    <div class="xlegs">${per.map(l => { const [cls, txt] = legMode(l); return `<div class="xleg"><div class="xlh">${logo(l.chain)} <b>${esc(chains[l.chain].name)}</b> <span class="mut small">${l.items.length} item(s)</span><i class="xm ${cls}">${txt}</i></div>
      <div class="xli">${l.items.map(i => `<span title="${esc(i.name)}">${i.img ? `<img src="${esc(i.img)}" alt="">` : ''}${esc(i.name)}</span>`).join('')}</div>
      <div class="xlp mut small" data-prog="${l.chain}">${usdTxt(l.itemsUsd)} · ${fmtU(l.oneVal + l.restVal, 18)} ${esc(chains[l.chain].native)}</div></div>`; }).join('')}</div>
    <div class="kv bkv">
      <span>NFT subtotal</span><b>${usdTxt(p.subtotalUsd)}</b>
      <span>MultiSea fee</span><b>${usdTxt(p.feeUsd)} <i class="usd">bridge/swap + $0.30 × ${p.routes} route${p.routes === 1 ? '' : 's'} · 0.5% on MultiSea listings is in the price</i></b>
      <span>Gas</span><b>${usdTxt(p.gasUsd)} <i class="usd">est.</i></b>
      <span>Total</span><b class="xtot">${fmtU(p.tokenTotal, s.decimals, s.decimals === 6 ? 2 : 6)} ${esc(s.symbol)} <i class="usd">${usdTxt(p.totalUsd)}</i></b></div>
    <p class="mut small">≈ ${p.confirmations} wallet confirmation${p.confirmations === 1 ? '' : 's'}${p.batch ? ' (your wallet batches the ' + esc(chains[s.chain].name) + ' transactions into one)' : ''}. Paying with ${esc(s.symbol)} on ${esc(chains[s.chain].name)}.</p>
    <details class="xpol"><summary>If a listing sells mid-route</summary><p class="small">1-step chains are all-or-nothing per chain: the purchase reverts and Relay refunds your payment on ${esc(chains[s.chain].name)} (minus refund gas). 2-step chains: funds arrive in your own wallet on that chain first; items that sold are skipped and unspent funds stay in your wallet there as credit. Listings are re-checked on-chain before every quote.</p></details>`;
}

export async function openUnifiedCheckout(items: CartItem[]) {
  if (!wallet.address) { openConnect(); return; }
  const me = wallet.address as Hex;
  const m = overlay(`<div class="bhead"><div><div class="mut">${items.length} item${items.length > 1 ? 's' : ''} · ${new Set(items.map(i => i.chain)).size} chain(s)</div><h3>One cart, any chain</h3></div></div><div class="bbody xco"><div class="spin"></div> Checking your balances on every chain…</div>`);
  m.querySelector('.wbox')!.classList.add('wide');
  const body = m.querySelector('.bbody') as HTMLElement;
  const status = (h: string) => { const st = body.querySelector('.xst'); if (st) st.innerHTML = `<div class="spin"></div> ${h}`; else body.innerHTML = `<div class="spin"></div> ${h}`; };
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const r: any = await usdRates();
    const [srcs, preps] = await Promise.all([detectSources(me), prepare(items, status)]);
    const legsInfo = preps.filter(p => p.native.length || p.os.length).map(p => ({ chain: p.chain, usd: [...p.native.map(x => x.item), ...p.os.map(x => x.item)].reduce((s, i) => s + i.price * rateOf(r, p.chain), 0), oneStep: p.native.some(x => oneStepOk(x.order.parameters)) }));
    if (!legsInfo.length) throw Object.assign(new Error('None of these listings are still available.'), { kind: 'stale' });
    const needUsd = legsInfo.reduce((s, l) => s + l.usd, 0);
    const ranked = rankSources(srcs.filter(s => s.bal > 0n || s.token === ZERO), legsInfo, needUsd);
    const pre = new URLSearchParams(location.search).get('pay'); // e.g. ?pay=base:USDC (testing / deep links)
    let sel = (pre && ranked.find(x => `${x.s.chain}:${x.s.symbol}`.toLowerCase() === pre.toLowerCase())) || ranked[0];
    const suggested = ranked.find(x => x.ok);
    let plan: Plan | null = null; let seq = 0;
    const tile = (x: typeof sel) => `<button class="xs ${x.ok ? '' : 'low'}" data-src="${esc(x.s.id)}">${logo(x.s.chain)}<span class="xt"><b>${esc(x.s.symbol)}</b><span class="mut">${esc(chains[x.s.chain].name)}</span></span><span class="xb">${fmtU(x.s.bal, x.s.decimals, 4)}<i class="usd">${usdTxt(x.s.usd)}</i></span>${x === suggested ? '<em class="xsug">Cheapest</em>' : ''}</button>`;
    const okL = ranked.filter(x => x.ok || x === sel); const lowL = ranked.filter(x => !x.ok && x !== sel && x.s.usd >= 0.5);
    body.innerHTML = `<div class="xpay"><div class="gh">Pay with</div><div class="xsrc">${okL.map(tile).join('') || '<p class="mut small">No single balance covers this cart. Top up any chain or remove items.</p>'}</div>
      ${lowL.length ? `<details class="xmore"><summary>Other balances (${lowL.length}) · not enough alone</summary><div class="xsrc">${lowL.map(tile).join('')}</div></details>` : ''}
      <p class="mut small">Balances read on ${Object.keys(chains).length} chains. MultiSea routes the payment with Relay; you never bridge by hand. <a href="#" class="xclassic">Pay on each chain instead</a></p></div>
      <div class="xplan"></div><div class="xst"></div><button class="bbtn go" disabled>Review</button>`;
    const planEl = body.querySelector('.xplan') as HTMLElement; const go = body.querySelector('.go') as HTMLButtonElement; const stEl = body.querySelector('.xst') as HTMLElement;
    const choose = async (x: typeof sel) => {
      sel = x; const my = ++seq; body.querySelectorAll('.xs').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.src === x.s.id));
      go.disabled = true; planEl.innerHTML = ''; stEl.innerHTML = `<div class="spin"></div> Quoting the route…`;
      try {
        const p = await buildPlan(items, x.s, h => { if (my === seq) stEl.innerHTML = `<div class="spin"></div> ${h}`; }, preps.map(p => ({ ...p, native: [...p.native], gone: [...p.gone] })));
        if (my !== seq) return; plan = p; (window as any).__xplan = p;
        planEl.innerHTML = planHtml(p); stEl.innerHTML = '';
        const enough = x.s.bal >= p.tokenTotal + (x.s.token === ZERO ? 0n : 0n);
        go.disabled = !enough; go.textContent = enough ? `Buy ${p.legs.reduce((n, l) => n + l.items.length, 0)} item(s) · ${p.confirmations} confirmation${p.confirmations === 1 ? '' : 's'}` : `Not enough ${x.s.symbol} on ${chains[x.s.chain].name}`;
      } catch (e: any) { if (my === seq) { stEl.innerHTML = `<p class="err small">${esc(friendly(e))}</p>`; (window as any).__xerr = String(e?.message || e); } }
    };
    body.addEventListener('click', e => {
      const t = e.target as HTMLElement; const b = t.closest('[data-src]') as HTMLElement;
      if (b) { const x = ranked.find(y => y.s.id === b.dataset.src); if (x) choose(x); }
      if (t.classList.contains('xclassic')) { e.preventDefault(); m.remove(); classicCheckout(items); }
    });
    await choose(sel);
    await Promise.race([new Promise<void>(res => go.addEventListener('click', () => res())), closed(m)]);
    await execute(plan!, items, body, m);
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e)); }
}

async function sendCalls(k: string, calls: Call[], batch: boolean, prog: (h: string) => void, afterBridge = false): Promise<boolean[]> {
  const me = wallet.address as Hex; const c = chains[k]; await ensureChain(k); const pub = readClient(k);
  if (batch && calls.length > 1) {
    try {
      const { id } = await wallet.provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: '0x' + c.chainId.toString(16), from: me, atomicRequired: true, calls: calls.map(x => ({ to: x.to, data: x.data, value: '0x' + x.value.toString(16) })) }] });
      prog(`Batched on ${esc(c.name)}, waiting…`);
      for (let i = 0; i < 120; i++) { await sleep(2500); const s = await wallet.provider.request({ method: 'wallet_getCallsStatus', params: [id] }).catch(() => null); const code = Number(s?.status); if (code === 200 || s?.status === 'CONFIRMED') return calls.map(() => (s.receipts || []).every((r: any) => r.status === '0x1' || r.status === 'success')); if (code >= 400) return calls.map(() => false); }
      throw new Error('Batch still pending; check your wallet.');
    } catch (e: any) { if (e?.code === 4001 || /rejected/i.test(e?.message || '')) throw e; /* wallet can't batch: fall through */ }
  }
  const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) }); const ok: boolean[] = [];
  for (const [i, x] of calls.entries()) {
    // Explicit gas limit: Relay's when it gave one, otherwise our own simulation (also catches a revert or a real shortfall here, with exact numbers).
    const gas = x.gas ?? (await gasFor(k, x, afterBridge));
    prog(`Confirm ${i + 1}/${calls.length} on ${esc(c.name)} in your wallet…`);
    const h = await wc.sendTransaction({ account: me, to: x.to, data: x.data, value: x.value, ...(gas ? { gas } : {}) });
    prog(`Pending on ${esc(c.name)}… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`);
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 240_000 }); ok.push(rc.status === 'success'); if (rc.status === 'success') reportFill(k, h);
  }
  return ok;
}
async function signPermits(q: any) {
  for (const step of q.steps || []) if (step.kind === 'signature') for (const it of step.items) {
    const s = it.data.sign; const types = { ...s.types }; delete (types as any).EIP712Domain;
    const typed = { domain: s.domain, types: { EIP712Domain: domainTypes(s.domain), ...types }, primaryType: s.primaryType, message: s.value };
    const sig = s.signatureKind === 'eip191' ? await wallet.provider.request({ method: 'personal_sign', params: [s.message, wallet.address] }) : await wallet.provider.request({ method: 'eth_signTypedData_v4', params: [wallet.address, JSON.stringify(typed)] });
    const r = await fetch(`${RELAY()}${it.data.post.endpoint}?signature=${sig}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(it.data.post.body) });
    if (!r.ok) throw Object.assign(new Error('Relay did not accept the signature. Please try again.'), { kind: 'stale' });
  }
}
const domainTypes = (d: any) => [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']].filter(([k]) => d[k] != null).map(([name, type]) => ({ name, type }));
async function waitRelay(requestId: string, prog: (h: string) => void) {
  const t0 = Date.now(); let st = '';
  while (Date.now() - t0 < 15 * 60_000) { await sleep(3000); const j = await (await fetch(`${RELAY()}/intents/status/v3?requestId=${requestId}`)).json().catch(() => ({})); st = j.status || st; prog(`Relay: ${esc(st || 'waiting')}… <a href="https://relay.link/transaction/${requestId}" target="_blank" rel="noopener">Track ↗</a>`); if (['success', 'refund', 'refunded', 'failure'].includes(st)) break; }
  return st;
}
const reqId = (q: any) => q.steps?.find((s: any) => s.requestId)?.requestId || q.requestId;

async function execute(old: Plan, items: CartItem[], body: HTMLElement, m: HTMLElement) {
  const me = wallet.address as Hex; const st = body.querySelector('.xst') as HTMLElement;
  const say = (h: string) => { st.innerHTML = `<div class="spin"></div> ${h}`; };
  // Fresh quotes right before paying (Relay quotes are short-lived); stop if the total moved > 3%.
  const plan = await buildPlan(items, old.src, say);
  if (plan.tokenTotal > (old.tokenTotal * 103n) / 100n || plan.gone.length > old.gone.length) { (body.querySelector('.xplan') as HTMLElement).innerHTML = planHtml(plan); st.innerHTML = '<p class="err small">Prices or availability changed. Review the updated total and try again.</p>'; return; }
  (body.querySelector('.go') as HTMLElement).remove(); body.querySelector('.xpay')?.remove();
  const prog = (k: string, h: string) => { const e = body.querySelector(`[data-prog="${k}"]`); if (e) e.innerHTML = h; };
  const src = plan.src; const done: string[] = []; const failed: string[] = [];
  const qs = plan.legs.flatMap(l => [l.callQ, l.bridgeQ]).filter(Boolean);
  // 1) origin chain: every Relay deposit (+approvals) and direct purchases, batched when the wallet supports it
  const originCalls: Call[] = [];
  for (const q of qs) for (const s of q.steps || []) if (s.kind === 'transaction') for (const it of s.items) { if (Number(it.data.chainId) !== chains[src.chain].chainId) throw new Error('Unexpected chain in Relay step'); originCalls.push({ to: it.data.to, data: it.data.data, value: BigInt(it.data.value || 0), ...(it.data.gas ? { gas: BigInt(it.data.gas) } : {}) }); }
  const directLegs = plan.legs.filter(l => l.direct);
  directLegs.forEach(l => l.restCalls.forEach(c => originCalls.push(c.call)));
  plan.legs.forEach(l => prog(l.chain, 'Waiting for your confirmation…'));
  if (originCalls.length) {
    const ok = await sendCalls(src.chain, originCalls, plan.batch, h => say(h));
    const offset = originCalls.length - directLegs.reduce((n, l) => n + l.restCalls.length, 0); let i = offset;
    for (const l of directLegs) for (const c of l.restCalls) { (ok[i++] ? done : failed).push(...c.keys); prog(l.chain, ok[i - 1] ? '✓ Bought' : '✗ Reverted (not charged beyond gas)'); }
  }
  for (const q of qs) await signPermits(q);
  say('Relay is executing on each chain…');
  // 2) Relay routes, in parallel
  await Promise.all(plan.legs.filter(l => !l.direct).map(async l => {
    const c = chains[l.chain];
    if (l.callQ) {
      const s = await waitRelay(reqId(l.callQ), h => prog(l.chain, h));
      if (s === 'success') { done.push(...l.one.map(x => x.item.key)); prog(l.chain, `✓ Relay bought ${l.one.length} item(s) on ${esc(c.name)}`); }
      else { failed.push(...l.one.map(x => x.item.key)); prog(l.chain, s.startsWith('refund') ? `↩ Listing changed mid-route; Relay refunded you on ${esc(chains[src.chain].name)}` : '✗ Relay could not complete; refund handled by Relay'); }
    }
    if (l.bridgeQ) { const s = await waitRelay(reqId(l.bridgeQ), h => prog(l.chain, h)); if (s !== 'success') { failed.push(...l.restCalls.flatMap(x => x.keys)); prog(l.chain, s.startsWith('refund') ? '↩ Top-up refunded' : '✗ Top-up failed'); l.restCalls = []; } }
  }));
  // 3) 2-step chains: buyer confirms on each chain (one batch per chain when supported)
  for (const l of plan.legs.filter(l => !l.direct && l.restCalls.length)) {
    try { const ok = await sendCalls(l.chain, l.restCalls.map(x => x.call), await canBatch(l.chain), h => prog(l.chain, h), !!l.bridgeQ); l.restCalls.forEach((x, i) => (ok[i] ? done : failed).push(...x.keys)); prog(l.chain, `✓ ${ok.filter(Boolean).length}/${ok.length} purchase(s) confirmed`); }
    catch (e: any) { failed.push(...l.restCalls.flatMap(x => x.keys)); prog(l.chain, `✗ ${esc(friendly(e, l.chain))}${l.bridgeQ ? ' · bridged funds stay in your wallet' : ''}`); }
  }
  clearCart([...done, ...plan.gone.map(g => g.key)]);
  st.innerHTML = `${done.length ? `<p class="ok">✓ Bought ${done.length} item(s).</p>` : ''}${failed.length ? `<p class="err">${failed.length} item(s) not bought (kept in your cart).</p>` : ''}<a class="bbtn" href="/cart">Back to cart</a>`;
  void me; void m;
}
