// Admin "Fees" panel: Relay app-fee balances + claim (fee wallet only), fee wallet native balances, claim history.
import { createWalletClient, custom, formatUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, vchain, ensureChain, friendly, esc } from './wallet';
import { usdRates } from './shell';
import { api } from './auth';
const chains = CFG.chains as Record<string, any>;
const byId = (id: number) => Object.keys(chains).find(k => chains[k].chainId === id);
const usd = (v: number) => '$' + (v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
let data: any = null; let err = ''; let msg = ''; let busy = '';

export async function loadFees(rerender: () => void) {
  err = ''; try { data = await api('/fees/summary', { auth: true }); data.rates = await usdRates(); } catch (e: any) { err = e.message; } rerender();
}
export function feesHtml() {
  if (err && !data) return `<div class="fees"><h2>Fees</h2><p class="err">${esc(err)}</p></div>`;
  if (!data) return `<div class="fees"><h2>Fees</h2><div class="spin"></div> Loading…</div>`;
  const R = data.relay || {}; const fee = data.feeWallet;
  const nat = (data.natives || []).map((n: any) => { const amt = n.balance == null ? null : +formatUnits(BigInt(n.balance), 18); return { ...n, amt, usd: amt == null ? 0 : amt * (data.rates?.[n.native] || 0) }; });
  const natTotal = nat.reduce((a: number, n: any) => a + n.usd, 0);
  const bal = (R.balances || []) as any[];
  const canClaim = data.canClaim;
  return `<div class="fees"><div class="fh"><h2>Fees</h2><span class="mut small">Fee wallet <a class="mono" href="https://debank.com/profile/${fee}" target="_blank" rel="noopener">${short(fee)}</a></span></div>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
  <div class="fgrid">
   <div class="fcard"><div class="gh">Relay app fees</div>
     <div class="fbig">${usd(R.availableBalanceUsd)}<span class="mut small"> available</span></div>
     <div class="kv"><span>Total accrued</span><b>${usd(R.totalBalanceUsd)}</b><span>Reserved for fast fills</span><b>${usd(R.outstandingFastFillBalanceUsd)}</b></div>
     ${R.error ? `<p class="err small">Relay: ${esc(R.error)}</p>` : ''}
     ${bal.length ? bal.map((b: any, i: number) => `<div class="frow"><img class="cl" src="/logos/${byId(b.currency?.chainId) || 'base'}.svg" alt=""><span><b>${esc(b.amountFormatted)} ${esc(b.currency?.symbol)}</b><em>${esc(chains[byId(b.currency?.chainId) || '']?.name || 'chain ' + b.currency?.chainId)} · ${usd(+b.amountUsd)}</em></span><button class="bbtn sm" data-claim="${i}" ${canClaim && !busy ? '' : 'disabled'}>${busy === String(i) ? 'Claiming…' : 'Claim'}</button></div>`).join('') : '<p class="mut small">No app fees accrued yet. Fees from cross-chain checkout accrue here in USDC.</p>'}
     ${canClaim ? '<p class="mut small">Claims are signed by the fee wallet. Relay deducts claim gas from the amount.</p>' : `<p class="need small">To claim, connect and sign in with the fee wallet ${short(fee)}. You are ${short(data.you)}.</p>`}
     ${data.relayKey ? '' : '<p class="mut small">Relay API key not set (RELAY_API_KEY Worker secret). Not required today; add it if Relay starts requiring keys.</p>'}
   </div>
   <div class="fcard"><div class="gh">Fee wallet balances</div>
     <div class="fbig">${usd(natTotal)}<span class="mut small"> across ${nat.length} chains</span></div>
     ${nat.map((n: any) => `<div class="frow"><img class="cl" src="/logos/${n.chain}.svg" alt=""><span><b>${esc(chains[n.chain]?.name)}</b><em>${n.amt == null ? 'RPC unavailable' : (+n.amt.toFixed(6)).toString() + ' ' + esc(n.native)}</em></span><b class="fusd">${usd(n.usd)}</b></div>`).join('')}
   </div>
   <div class="fcard"><div class="gh">Claim history</div>
     ${(data.claims || []).length ? data.claims.map((c: any) => `<div class="frow"><span><b>${c.amountUsd ? usd(c.amountUsd) : 'Claim'}</b><em>${new Date(c.at).toLocaleString()} · ${esc(chains[byId(c.chainId) || '']?.name || '')}</em></span></div>`).join('') : '<p class="mut small">No claims made from MultiSea yet.</p>'}
     <p class="mut small"><a href="https://relay.link/claim-app-fees" target="_blank" rel="noopener">Relay app balance page ↗</a></p>
   </div>
  </div></div>`;
}
export async function claim(i: number, rerender: () => void) {
  const b = data?.relay?.balances?.[i]; if (!b) return;
  if (!confirm(`Claim ${b.amountFormatted} ${b.currency?.symbol} (${usd(+b.amountUsd)}) to ${data.feeWallet}?`)) return;
  busy = String(i); err = ''; msg = ''; rerender();
  try {
    const q = await api('/fees/claim', { auth: true, body: { chainId: b.currency.chainId, currency: b.currency.address } });
    const item = q.steps?.[0]?.items?.[0]; const sign = item?.data?.sign; const post = item?.data?.post;
    if (!sign || !post) throw new Error('Unexpected claim response from Relay');
    const me = wallet.address as Hex; let signature: string;
    if (sign.signatureKind === 'eip712') {
      const k = byId(Number(sign.domain?.chainId)); if (k) await ensureChain(k);
      const wc = createWalletClient({ chain: k ? vchain(k) : undefined, transport: custom(wallet.provider) });
      signature = await wc.signTypedData({ account: me, domain: sign.domain, types: sign.types, primaryType: sign.primaryType, message: sign.value });
    } else {
      const wc = createWalletClient({ transport: custom(wallet.provider) });
      signature = await wc.signMessage({ account: me, message: /^0x[0-9a-fA-F]{64}$/.test(sign.message) ? { raw: sign.message as Hex } : sign.message });
    }
    await api('/fees/claim/submit', { auth: true, body: { endpoint: post.endpoint, method: post.method, body: post.body, signature, chainId: b.currency.chainId, currency: b.currency.address, amountUsd: +b.amountUsd } });
    msg = 'Claim submitted to Relay. Funds arrive in the fee wallet shortly.';
  } catch (e: any) { err = friendly(e); }
  busy = ''; await loadFees(rerender);
}
