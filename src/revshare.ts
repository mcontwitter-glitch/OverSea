// Revenue-sharing NFTs: collections opt in; a % of MultiSea's fee + a pledged % of creator royalties accrues per tokenId
// in the Worker ledger; holders claim, paid in a chosen token on a chosen chain via Relay from the payout wallet.
import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect, checkApi, API } from './wallet';
import { usdRates } from './shell';
import { api } from './auth';
import { frame, getJ, esc, logo, fmtWei, usdTxt, chains, connectCta } from './gx';
const el = frame('revshare', 'Revenue share');
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKENS: Record<string, { sym: string; addr: string }[]> = { base: [{ sym: 'USDC', addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }], ethereum: [{ sym: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }] };
const q = new URLSearchParams(location.search);
const st = { slug: q.get('c') || CFG.default, info: null as any, list: [] as any[], mine: [] as string[], manual: '', claim: null as any, canEdit: false, err: '', res: '', payChain: 'base', payCur: ZERO, busy: false };
async function myTokens(slug: string) {
  if (!wallet.address) return [];
  const me = wallet.address.toLowerCase();
  if (CFG.collections.some(c => c.slug === slug)) {
    const m = await fetch(`/data/${slug}/owners.min.json`).then(r => r.json()).catch(() => null); if (!m) return [];
    return Object.entries(m.d as Record<string, number[]>).filter(([, a]) => { for (let k = 1; k < a.length; k += 2) if ((m.addrs[a[k]] || '').toLowerCase() === me) return true; return false; }).map(([id]) => id).slice(0, 200);
  }
  return [];
}
async function load() {
  st.err = ''; st.claim = null;
  try { const [l, i] = await Promise.all([getJ('/revshare'), getJ('/revshare/' + st.slug)]); st.list = l.collections; st.info = i; } catch (e: any) { st.err = e.message; }
  st.mine = await myTokens(st.slug);
  if (wallet.address) st.canEdit = !!(await fetch(`${API}/collections/${st.slug}/can-edit?address=${wallet.address}`).then(r => r.json()).catch(() => ({}))).ok;
  await refreshClaim(); draw();
}
const ids = () => [...new Set([...st.mine, ...st.manual.split(/[\s,]+/).filter(x => /^\d{1,9}$/.test(x))])];
async function refreshClaim() { const i = ids(); st.claim = i.length ? await getJ(`/revshare/${st.slug}/claimable?ids=${i.join(',')}`).catch(() => null) : null; }
async function draw() {
  const r = await usdRates(); const u = (k: string, w: string) => +fmtWei(w).replace(/,/g, '') * ((r as any)[chains[k]?.native] || 0);
  const i = st.info; const cfg = i?.config || { enabled: false };
  const accUsd = i ? Object.entries(i.acc.perChain || {}).reduce((s, [k, c]: any) => s + u(k, c.total), 0) : 0;
  const claimUsd = st.claim ? Object.entries(st.claim.total || {}).reduce((s, [k, w]) => s + u(k, w as string), 0) : 0;
  const cols = [...new Map([...CFG.collections.map(c => [c.slug, c.name]), ...st.list.map((c: any) => [c.slug, c.name])] as [string, string][]).entries()];
  el.innerHTML = `<div class="ghero"><h1>Revenue share</h1><p class="lpsub">Collections can share MultiSea marketplace revenue with their holders. When enabled, a % of MultiSea's 0.5% fee (and optionally a % of the creator royalty) from every sale MultiSea sees accrues to <b>each token</b> equally. Holders claim in the token and chain they choose.</p></div>
  <div class="legal small"><b>Important:</b> revenue-sharing NFTs can be treated as securities or investment contracts in some jurisdictions. Collections enabling this should get legal advice first. Nothing here is an offer of securities or a promise of returns.</div>
  <div class="bar2"><label>Collection <select data-k="slug">${cols.map(([s, n]) => `<option value="${esc(s)}" ${s === st.slug ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
   ${i?.payouts?.enabled ? '<span class="tag ok">Payouts live</span>' : `<span class="tag warn" title="${esc(i?.payouts?.reason || '')}">Mainnet payouts disabled until funded</span>`}</div>
  ${st.err ? `<p class="err">${esc(st.err)}</p>` : ''}
  ${i ? `<div class="gstats"><div class="gstat"><b>${cfg.enabled ? 'On' : 'Off'}</b><span>Revenue share</span></div><div class="gstat"><b>${cfg.enabled ? (cfg.feeShareBps / 100) + '%' : '-'}</b><span>of MultiSea fee</span></div><div class="gstat"><b>${cfg.enabled ? (cfg.royaltyShareBps / 100) + '%' : '-'}</b><span>of royalty (creator-funded)</span></div><div class="gstat"><b>${usdTxt(accUsd) || '$0.00'}</b><span>Accrued to holders · ${i.acc.sales || 0} sales</span></div></div>` : '<div class="spin"></div>'}
  <div class="fcard"><div class="gh">Claim</div>
   ${!wallet.address ? connectCta('Connect the wallet that holds your NFTs.') : `
   <p class="mut small">${st.mine.length ? `Found ${st.mine.length} token(s) in your wallet.` : 'No tokens found automatically.'} Add token IDs:</p>
   <input class="ids" placeholder="e.g. 12, 845, 2001" value="${esc(st.manual)}">
   ${st.claim && Object.keys(st.claim.total || {}).length ? `<div class="kv bkv">${Object.entries(st.claim.total).map(([k, w]) => `<span>${logo(k)} accrued from ${esc(chains[k]?.name)} sales</span><b>${fmtWei(w as string, 18, 8)} ${esc(chains[k]?.native)} <i class="usd">${usdTxt(u(k, w as string))}</i></b>`).join('')}<span>Total claimable</span><b class="xtot">${usdTxt(claimUsd)}</b></div>` : `<p class="mut">${ids().length ? 'Nothing claimable yet for these tokens.' : ''}</p>`}
   <div class="two"><label>Payout chain<select data-k="payChain">${Object.keys(chains).map(k => `<option value="${k}" ${k === st.payChain ? 'selected' : ''}>${esc(chains[k].name)}</option>`).join('')}</select></label>
     <label>Payout token<select data-k="payCur"><option value="${ZERO}">${esc(chains[st.payChain].native)} (native)</option>${(TOKENS[st.payChain] || []).map(t => `<option value="${t.addr}" ${t.addr === st.payCur ? 'selected' : ''}>${t.sym}</option>`).join('')}</select></label></div>
   <button class="bbtn" data-act="claim" ${st.claim && Object.keys(st.claim.total || {}).length && !st.busy ? '' : 'disabled'}>${st.busy ? 'Claiming…' : 'Claim via Relay'}</button>
   ${st.res}`}</div>
  ${st.canEdit ? optinHtml(cfg) : ''}
  <div class="fcard"><div class="gh">How it works</div><ol class="small mut"><li>A collection owner opts in and sets the shares (MultiSea fee share is capped at ${i ? i.capBps / 100 : 50}% of the 0.5% fee).</li><li>Every MultiSea sale the Worker sees adds <i>pool ÷ supply</i> to each token's balance (remainders carry over). Balances follow the token, so a buyer inherits unclaimed revenue.</li><li>Holders claim; MultiSea's payout wallet pays via Relay in the chosen token/chain. An on-chain pull-based splitter contract option exists for collections that prefer trustless payouts.</li></ol></div>`;
}
function optinHtml(cfg: any) {
  return `<div class="fcard admin"><div class="gh">Collection settings (owner/admin)</div>
   <label class="chk"><input type="checkbox" data-o="enabled" ${cfg.enabled ? 'checked' : ''}> Enable revenue share for holders</label>
   <div class="two"><label>% of MultiSea fee<input data-o="fee" type="number" min="0" max="${(st.info?.capBps || 5000) / 100}" value="${(cfg.feeShareBps || 2500) / 100}"></label><label>% of your royalty (you fund this)<input data-o="roy" type="number" min="0" max="100" value="${(cfg.royaltyShareBps || 0) / 100}"></label></div>
   <label>Supply (tokens sharing the pool)<input data-o="supply" type="number" min="1" value="${cfg.supply || (CFG.collections.find(c => c.slug === st.slug) as any)?.supply || ''}"></label>
   <label class="chk"><input type="checkbox" data-o="terms" ${cfg.acceptedTerms ? 'checked' : ''}> I understand revenue-sharing may have securities/legal implications and I've taken advice where needed. The royalty share is funded by me.</label>
   <button class="bbtn sm" data-act="optin">Save</button></div>`;
}
el.addEventListener('change', async e => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.k === 'slug') { st.slug = t.value; history.replaceState(null, '', '?c=' + t.value); load(); }
  if (t.dataset.k === 'payChain') { st.payChain = t.value; st.payCur = ZERO; draw(); }
  if (t.dataset.k === 'payCur') st.payCur = t.value;
  if (t.classList.contains('ids')) { st.manual = t.value; await refreshClaim(); draw(); }
});
el.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.dataset.act;
  if (a === 'connect') openConnect();
  if (a === 'claim') { st.busy = true; st.res = ''; draw();
    try { const r = await api(`/revshare/${st.slug}/claim`, { auth: true, body: { tokenIds: ids(), chain: st.payChain, currency: st.payCur } });
      st.res = r.executed ? `<p class="ok">✓ Paid. ${r.txs.map((h: string) => `<span class="mono">${h.slice(0, 10)}…</span>`).join(' ')}</p>` : `<p class="warn small">Claim recorded (request ${esc(r.requestId)}), not paid: ${esc(r.reason)} Your balance stays claimable.</p>${(r.quotes || []).filter((x: any) => x.out).map((x: any) => `<p class="mut small">Relay estimate: ${esc(x.out.amountFormatted)} ${esc(x.out.currency?.symbol)} (${usdTxt(+x.out.amountUsd)})</p>`).join('')}`;
    } catch (x: any) { st.res = `<p class="err">${esc(x.message)}</p>`; }
    st.busy = false; await refreshClaim(); draw(); }
  if (a === 'optin') { const v = (k: string) => el.querySelector(`[data-o=${k}]`) as HTMLInputElement;
    try { await api(`/revshare/${st.slug}/optin`, { auth: true, body: { enabled: v('enabled').checked, feeShareBps: Math.round(+v('fee').value * 100), royaltyShareBps: Math.round(+v('roy').value * 100), supply: +v('supply').value, acceptedTerms: v('terms').checked } }); await load(); }
    catch (x: any) { st.err = x.message; draw(); } }
});
onWallet(load); checkApi().then(load); draw();
