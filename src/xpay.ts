// Cross-chain checkout: pay for a listing with native funds from another chain via Relay (relay.link).
import { createPublicClient, createWalletClient, custom, http, formatUnits, parseAbi, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, overlay, vchain, ensureChain, friendly, esc } from './wallet';
import { usdRates } from './shell';
import { RELAY, advancedFulfillCalldata, oneStepOk, quoteWithFlatFee, summarize } from './xpaycore';

const chains = CFG.chains as Record<string, any>;
const SEAPORT = CFG.seaport;
export type XPayCtx = { it: { id: number; name: string; img: string; chain: string; contract: string }; price: bigint; currency: string; tx: any; orders: any[]; onSold: (id: number) => void; restart: () => void };
const f6 = (x: bigint) => (+formatUnits(x, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const usd = (v: number) => '≈ $' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const closed = (m: HTMLElement) => new Promise<never>((_, rej) => m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) rej(Object.assign(new Error('closed'), { kind: 'closed' })); }));

export async function openXPay(ctx: XPayCtx) {
  const { it } = ctx; const dest = chains[it.chain]; const me = wallet.address as Hex;
  const m = overlay(`<div class="bhead"><img src="${esc(it.img)}" alt=""><div><div class="mut">${esc(dest.name)} · Pay from another chain</div><h3>${esc(it.name)}</h3></div></div><div class="bbody"><div class="spin"></div> Checking your balances on other chains…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string, extra = '') => { body.innerHTML = `<p class="err">${esc(msg)}</p>${extra}<button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const rates = await usdRates();
    const order = ctx.orders?.[0]; const oneStep = oneStepOk(order?.parameters);
    const destPub = createPublicClient({ chain: vchain(it.chain), transport: http() });
    const priceUsd = (+formatUnits(ctx.price, 18)) * ((rates as any)[dest.native] || 0);
    // How much must land on the destination chain.
    let need: bigint; let call: { data: Hex; value: bigint } | null = null;
    if (oneStep) { call = advancedFulfillCalldata(order, me); need = call.value; }
    else {
      const [bal, gp] = await Promise.all([destPub.getBalance({ address: me }), destPub.getGasPrice().catch(() => 0n)]);
      const gasBuf = gp * 400_000n * 2n; const want = BigInt(ctx.tx.value || 0) + gasBuf;
      need = want > bal ? want - bal : 0n; if (need < 10n ** 13n) need = 10n ** 13n;
    }
    // Balances on every other chain (native), valued in USD.
    const srcs = (await Promise.all(Object.entries(chains).filter(([k]) => k !== it.chain).map(async ([k, c]) => {
      const b = await createPublicClient({ chain: vchain(k), transport: http() }).getBalance({ address: me }).catch(() => null);
      const u = b == null ? 0 : (+formatUnits(b, 18)) * ((rates as any)[c.native] || 0);
      return { k, c, b, u };
    }))).filter(s => s.b != null && s.b > 0n);
    const needUsd = priceUsd + 1.5;
    srcs.sort((a, b) => b.u - a.u);
    const pick0 = srcs.find(s => s.u >= needUsd) || srcs[0];
    let pick = pick0?.k;
    const list = () => srcs.map(s => `<label class="xsrc ${s.u >= needUsd ? '' : 'low'}"><input type="radio" name="xsrc" value="${s.k}" ${s.k === pick ? 'checked' : ''}><img class="cl" src="/logos/${s.k}.svg" alt=""><span><b>${esc(s.c.name)}</b><em>${f6(s.b!)} ${esc(s.c.native)} <i>${usd(s.u)}</i></em></span><small>${s.u >= needUsd ? 'enough' : 'low'}</small></label>`).join('');
    body.innerHTML = `<div class="gh">Pay with funds from</div><div class="xsrcs">${list()}</div><div class="xq"></div>`;
    const xq = body.querySelector('.xq') as HTMLElement;
    let current: any = null; let seq = 0;
    const quote = async () => {
      const my = ++seq; current = null; xq.innerHTML = '<div class="spin"></div> Getting a quote from Relay…';
      const src = chains[pick!];
      try {
        const q = await quoteWithFlatFee({ user: me, originChainId: src.chainId, destinationChainId: dest.chainId, amount: need, ...(call ? { txs: [{ to: SEAPORT, value: call.value.toString(), data: call.data }] } : {}) });
        if (my !== seq) return; const s = summarize(q.quote); current = { ...q, s, src };
        const bal = srcs.find(x => x.k === pick)!.b!; const enough = bal >= s.totalWei;
        xq.innerHTML = `<div class="kv bkv"><span>NFT price</span><b>${f6(ctx.price)} ${esc(ctx.currency)} <i class="usd">${usd(priceUsd)}</i></b>
          <span>MultiSea fee</span><b>${f6(s.feeWei)} ${esc(src.native)} <i class="usd">${usd(s.feeUsd)}</i></b>
          <span>Network gas (est.)</span><b>${f6(s.gasWei)} ${esc(src.native)} <i class="usd">${usd(s.gasUsd)}</i></b>
          <span>Total</span><b class="xtot">${f6(s.totalWei)} ${esc(src.native)} <i class="usd">${usd(s.totalUsd)}</i></b></div>
          ${enough ? '' : `<p class="err">Not enough ${esc(src.native)} on ${esc(src.name)} for this total.</p>`}
          <p class="mut small">${oneStep ? `One step: Relay moves your funds and buys on ${esc(dest.name)} in a single transaction.` : `Two steps: Relay moves the funds to your wallet on ${esc(dest.name)}, then you confirm the purchase there${need > 0n ? ' (includes a little extra for gas)' : ''}.`} If anything fails, Relay refunds to your wallet. ${s.timeSec ? `ETA ~${s.timeSec < 60 ? s.timeSec + 's' : Math.round(s.timeSec / 60) + 'min'}.` : ''}</p>
          <button class="bbtn go" ${enough ? '' : 'disabled'}>${oneStep ? 'Pay & buy' : 'Bridge & continue'}</button>`;
      } catch (e: any) { if (my === seq) xq.innerHTML = `<p class="err">${esc(friendly(e))}</p>`; }
    };
    body.addEventListener('change', e => { const t = e.target as HTMLInputElement; if (t.name === 'xsrc') { pick = t.value; quote(); } });
    if (!pick) throw Object.assign(new Error('You have no funds on the other supported chains.'), { kind: 'stale' });
    quote();
    await Promise.race([new Promise<void>(res => xq.addEventListener('click', e => { if ((e.target as HTMLElement).closest('.go') && current) res(); })), closed(m)]);
    const { src } = current; const srcKey = pick!;
    body.innerHTML = `<div class="spin"></div> Refreshing quote…`;
    const fresh = await quoteWithFlatFee({ user: me, originChainId: src.chainId, destinationChainId: dest.chainId, amount: need, ...(call ? { txs: [{ to: SEAPORT, value: call.value.toString(), data: call.data }] } : {}) });
    const fs = summarize(fresh.quote);
    if (fs.totalWei > (current.s.totalWei * 103n) / 100n) throw Object.assign(new Error('The quote moved more than 3%. Please review the new price and try again.'), { kind: 'stale' });
    body.innerHTML = `<div class="spin"></div> Switching wallet to ${esc(src.name)}…`; await ensureChain(srcKey);
    const wc = createWalletClient({ chain: vchain(srcKey), transport: custom(wallet.provider) });
    const srcPub = createPublicClient({ chain: vchain(srcKey), transport: http() });
    let requestId = fresh.quote.requestId as string; let txh = '';
    for (const step of fresh.quote.steps) for (const item of step.items) {
      if (step.kind !== 'transaction') throw new Error('Unsupported Relay step: ' + step.kind);
      const d = item.data; body.innerHTML = `<div class="spin"></div> ${esc(step.action || 'Confirm in your wallet')}…`;
      if (Number(d.chainId) !== src.chainId) throw new Error('Unexpected chain in Relay step');
      txh = await wc.sendTransaction({ account: me, to: d.to, data: d.data, value: BigInt(d.value || 0), ...(d.gas ? { gas: BigInt(d.gas) } : {}) });
      body.innerHTML = `<div class="spin"></div> Waiting for ${esc(src.name)}… <a href="${src.explorer}/tx/${txh}" target="_blank" rel="noopener">View ↗</a>`;
      await srcPub.waitForTransactionReceipt({ hash: txh as Hex, timeout: 240_000 });
      requestId = step.requestId || requestId;
    }
    const track = `<a href="https://relay.link/transaction/${requestId}" target="_blank" rel="noopener">Track on Relay ↗</a>`;
    body.innerHTML = `<div class="spin"></div> Relay is ${oneStep ? 'buying on' : 'moving funds to'} ${esc(dest.name)}… ${track}`;
    const t0 = Date.now(); let st = '';
    while (Date.now() - t0 < 15 * 60_000) {
      await sleep(3000);
      const j = await (await fetch(`${RELAY()}/intents/status/v3?requestId=${requestId}`)).json().catch(() => ({}));
      st = j.status || st;
      if (['success', 'refund', 'refunded', 'failure'].includes(st)) break;
    }
    if (st === 'refund' || st === 'refunded') throw Object.assign(new Error(`The purchase couldn't complete (the listing may have sold). Relay refunded your funds on ${src.name}.`), { kind: 'stale', track });
    if (st !== 'success') throw Object.assign(new Error(st === 'failure' ? 'Relay reported a failure. Your funds are handled by Relay’s refund process.' : 'Still processing. Check the status on Relay.'), { kind: 'stale', track });
    if (oneStep) {
      const owner = await destPub.readContract({ address: it.contract as Hex, abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [BigInt(it.id)] }).catch(() => null);
      if (owner && owner.toLowerCase() !== me.toLowerCase()) throw Object.assign(new Error('Relay finished, but the NFT is not in your wallet yet. Check the Relay status.'), { kind: 'stale', track });
      ctx.onSold(it.id);
      body.innerHTML = `<p class="ok">✓ Purchased with ${esc(src.native)} from ${esc(src.name)}! ${esc(it.name)} is yours.</p>${track}`;
    } else {
      body.innerHTML = `<p class="ok">✓ Funds arrived on ${esc(dest.name)}. Continuing to the purchase…</p>`;
      await sleep(1200); m.remove(); ctx.restart();
    }
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e), e?.track ? `<p class="small">${e.track}</p>` : ''); }
}
