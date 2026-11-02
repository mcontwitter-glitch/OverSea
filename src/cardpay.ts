// Pay with card: a thirdweb Bridge onramp (Coinbase / Transak / Stripe) tops up the buyer's own wallet
// with exactly the missing native coin on the listing's chain, then the normal buy flow resumes.
// Client-side only (public client ID); no secret key, no gas sponsorship, no smart accounts.
// thirdweb is lazy-loaded so the main bundle is unaffected.
import CFG from '../config/collections.json';
import { THIRDWEB_CLIENT_ID } from './embedded';
import { overlay, esc } from './wallet';
import { formatUnits } from 'viem';

export const cardPayEnabled = !!THIRDWEB_CLIENT_ID;
const chains = CFG.chains as Record<string, { name: string; chainId: number; native: string }>;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;
type Provider = 'coinbase' | 'transak' | 'stripe';
const PROVIDERS: { id: Provider; name: string; note: string }[] = [
  { id: 'coinbase', name: 'Coinbase', note: 'Debit card, Apple Pay. No ID check under $500 (debit).' },
  { id: 'transak', name: 'Transak', note: 'Cards, Apple Pay, Google Pay. Wide country coverage.' },
  { id: 'stripe', name: 'Stripe', note: 'Cards, Apple Pay. US only.' },
];
const country = () => (navigator.language.split('-')[1] || 'US').toUpperCase();

export type CardCtx = { chain: string; receiver: string; shortWei: bigint; title: string; img?: string; restart: () => void };

/** Button markup for buy modals. */
export const cardButton = () => (cardPayEnabled ? '<button class="bbtn ghost cardpay">💳 Pay with card / Apple Pay</button>' : '');

export async function openCardPay(ctx: CardCtx) {
  const c = chains[ctx.chain];
  // ~3% buffer for price movement between the quote and the buy (provider minimum is $1).
  const amount = ctx.shortWei + ctx.shortWei / 33n;
  const m = overlay(`<div class="bhead">${ctx.img ? `<img src="${esc(ctx.img)}" alt="">` : ''}<div><div class="mut">${esc(c.name)} · Pay with card</div><h3>${esc(ctx.title)}</h3></div></div><div class="bbody cardpay-body"></div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  const { Bridge, createThirdwebClient } = await import('thirdweb');
  const client = createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID });
  let prov: Provider = 'coinbase'; let alive = true;
  new MutationObserver(() => { if (!document.body.contains(m)) alive = false; }).observe(document.body, { childList: true });
  const amt = (+formatUnits(amount, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const quote = async () => {
    body.innerHTML = `<div class="spin"></div> Getting a card quote for ${amt} ${esc(c.native)} on ${esc(c.name)}…`;
    try {
      const q = await Bridge.Onramp.prepare({ client, onramp: prov, chainId: c.chainId, tokenAddress: NATIVE, receiver: ctx.receiver as `0x${string}`, amount, country: country(), currency: 'USD' });
      const usd = q.currencyAmount.toLocaleString(undefined, { style: 'currency', currency: q.currency || 'USD' });
      body.innerHTML = `<div class="pills">${PROVIDERS.map(p => `<button class="pill ${p.id === prov ? 'on' : ''}" data-prov="${p.id}">${p.name}</button>`).join('')}</div>
        <p class="mut small">${esc(PROVIDERS.find(p => p.id === prov)!.note)}</p>
        <div class="kv bkv"><span>You receive</span><b>${amt} ${esc(c.native)} on ${esc(c.name)}</b><span>Card total</span><b class="xtot">${esc(usd)}</b><span>Delivered to</span><b class="mono">${esc(ctx.receiver.slice(0, 6))}…${esc(ctx.receiver.slice(-4))} (your wallet)</b>${q.steps.length ? `<span>Route</span><b>${q.steps.length} extra swap/bridge step(s)</b>` : ''}</div>
        <p class="mut small">Card total includes the provider's fees (thirdweb adds no onramp fee). First purchase may ask for ID (KYC). You still confirm the purchase in your wallet and pay network gas. Min $1, new-user limit ~$1,500/week.</p>
        <a class="bbtn go cardgo" href="${esc(q.link)}" target="_blank" rel="noopener">Continue to ${esc(PROVIDERS.find(p => p.id === prov)!.name)} →</a><div class="cardst mut small"></div>`;
      body.querySelector('.cardgo')!.addEventListener('click', () => poll(q.id));
    } catch (e: any) {
      body.innerHTML = `<div class="pills">${PROVIDERS.map(p => `<button class="pill ${p.id === prov ? 'on' : ''}" data-prov="${p.id}">${p.name}</button>`).join('')}</div><p class="err">${esc(PROVIDERS.find(p => p.id === prov)!.name)} can't do this purchase: ${esc((e?.message || String(e)).slice(0, 200))}</p><p class="mut small">Try another provider, or fund your wallet another way.</p>`;
    }
  };
  let polling = false;
  const poll = async (id: string) => {
    if (polling) return; polling = true;
    const st = body.querySelector('.cardst') as HTMLElement;
    while (alive) {
      try {
        const s: any = await Bridge.Onramp.status({ id, client });
        if (s.status === 'COMPLETED') { st.innerHTML = '✓ Funds arrived. Resuming your purchase…'; setTimeout(() => { m.remove(); ctx.restart(); }, 1200); return; }
        if (s.status === 'FAILED') { st.innerHTML = '<span class="errc">The card payment failed or was cancelled.</span>'; polling = false; return; }
        st.textContent = s.status === 'PENDING' ? 'Payment received, delivering funds to your wallet…' : 'Waiting for you to finish paying in the provider window…';
      } catch { /* transient */ }
      await new Promise(r => setTimeout(r, 5000));
    }
  };
  body.addEventListener('click', e => { const p = (e.target as HTMLElement).closest('[data-prov]') as HTMLElement; if (p && !polling) { prov = p.dataset.prov as Provider; quote(); } });
  quote();
}
