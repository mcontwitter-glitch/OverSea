// MultiSea Bitcoin: Ordinals browse (mainnet data, read-only) + non-custodial PSBT marketplace (signet/testnet by default).
// Routes: /btc  /btc/c/<slug>  /btc/i/<inscriptionId>  /btc/me
import { navHtml, bindNav, esc } from './shell';
import { overlay, checkApi, API } from './wallet';
import * as D from './btc/data';
import { demoOn, demoHoldings, demoPayUtxos, demoListings, demoBanner } from './btc/demo';
import { PROVIDERS, prov, btc, onBtc, setAcct, type Acct } from './btc/wallets';
const app = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '');
const lib = () => import('./btc/lib');
const isMobile = () => matchMedia('(max-width:700px)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
let usd: number | null = null; let fee: D.Fees | null = null;
const net = () => D.getNet();
const demo = () => demoOn(net());
const err = (e: any) => `<p class="err">${esc(e?.message || e)}</p>`;
const spin = (t = 'Loading…') => `<p class="mut"><span class="spin"></span> ${esc(t)}</p>`;
const thumb = (id: string, ct = 'image/png', cls = 'pix') => /^image\//.test(ct) ? `<img class="${cls}" src="${esc(D.contentUrl(id))}" loading="lazy" alt="">` : `<iframe class="${cls}" sandbox="allow-scripts" loading="lazy" src="${esc(D.previewUrl(id))}" title="inscription"></iframe>`;

// ---- shared chrome ----
function bar() {
  const n = net();
  return `<div class="btcbar"><div class="btcnet" role="group" aria-label="Bitcoin network">${(D.CFG.networks as D.Net[]).map(k => `<button class="chip ${n === k ? 'on' : ''}" data-net="${k}"><img class="cl" src="/logos/bitcoin.svg" alt="">${D.netLabel(k)}${k === 'mainnet' && !D.mainnetOn() ? '<em>browse only</em>' : ''}</button>`).join('')}</div>
   <a class="btcfee" href="${D.explorer(n)}" target="_blank" rel="noopener" title="mempool.space recommended fee rates (${D.netLabel(n)})">⛽ ${fee ? `<b>${fee.halfHourFee}</b> sat/vB <em>· fast ${fee.fastestFee} · eco ${fee.economyFee}</em>` : '…'}</a></div>
   ${!D.canTrade(n) ? '<div class="soon small">Mainnet trading is OFF (config <code>btc.json → mainnetTrading</code>). Browsing only. Switch to Signet or Testnet to try listing and buying.</div>' : ''}${demo() ? demoBanner : ''}`;
}
function shell(active: string, body: string) {
  app.innerHTML = `${navHtml('btc')}<main class="btc">${bar()}${body}</main>`;
  const nr = app.querySelector('.navr'); if (nr) nr.insertAdjacentHTML('afterbegin', btcBtn());
  app.querySelectorAll('[data-net]').forEach(b => b.addEventListener('click', () => { D.setNet((b as HTMLElement).dataset.net as D.Net); location.reload(); }));
  void active;
}
const btcBtn = () => btc.acct ? `<button class="wbtn btcw on" data-act="btcw"><img src="/logos/bitcoin.svg" alt="" width="16" height="16">${esc(D.short(btc.acct.ordAddress))}</button>` : `<button class="wbtn btcw" data-act="btcw"><img src="/logos/bitcoin.svg" alt="" width="16" height="16">Connect BTC</button>`;
document.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-act="btcw"]')) { e.preventDefault(); e.stopPropagation(); btc.acct ? acctModal() : openBtcConnect(); } }, true);

// ---- wallet connect + BIP-322 sign-in ----
export function openBtcConnect(after?: () => void) {
  const n = net(); const here = location.href;
  const opts = PROVIDERS.map(p => ({ p, on: p.detect() })).sort((a, b) => +b.on - +a.on);
  const m = overlay(`<div class="btcconn"><h3><img src="/logos/bitcoin.svg" width="22" height="22" alt=""> Connect a Bitcoin wallet</h3>
   <p class="mut small">Network: <b>${D.netLabel(n)}</b>. MultiSea asks for your <b>Ordinals (taproot)</b> and <b>payment</b> addresses, then a free BIP-322 sign-in message. No transaction, no fee.</p>
   ${opts.map(({ p, on }) => { const netOk = p.nets.includes(n);
     return on ? `<button class="wopt" data-w="${p.id}" ${netOk ? '' : 'disabled'}><img src="${p.icon}" alt="">${esc(p.name)}<em class="wtag ok">${netOk ? 'Detected' : 'Mainnet only'}</em></button>`
      : isMobile() && p.mobile ? `<a class="wopt" href="${esc(p.mobile(here))}"><img src="${p.icon}" alt="">${esc(p.name)}<em class="wtag">Open in app</em></a>`
      : `<a class="wopt dim" href="${p.install}" target="_blank" rel="noopener"><img src="${p.icon}" alt="">${esc(p.name)}<em class="wtag">${netOk ? 'Install' : 'Mainnet only'}</em></a>`; }).join('')}
   <p class="mut small">${isMobile() ? 'On a phone, open MultiSea inside your wallet app\'s browser (Xverse, UniSat, OKX) and tap Connect.' : 'Desktop: use the browser extension. Phone: open this page in your wallet app\'s built-in browser.'}</p><div class="cmsg"></div></div>`);
  m.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', async () => {
    const p = prov((b as HTMLElement).dataset.w as any); const out = m.querySelector('.cmsg')!;
    try { out.innerHTML = spin('Waiting for ' + p.name + '…'); const a = await p.connect(n);
      if (!a.ordAddress.startsWith(n === 'mainnet' ? 'bc1' : 'tb1')) throw new Error(`${p.name} is on a different network. Switch it to ${D.netLabel(n)}.`);
      out.innerHTML = spin('Sign the MultiSea sign-in message (BIP-322, free)…');
      const v = await signIn(a); setAcct(a, v); m.remove(); after ? after() : acctModal();
    } catch (e: any) { out.innerHTML = err(e?.code === 4001 || /reject|cancel/i.test(e?.message) ? 'Request rejected in wallet.' : e); }
  }));
}
async function signIn(a: Acct): Promise<'worker' | 'local'> {
  const p = prov(a.wallet); let nonce = crypto.getRandomValues(new Uint32Array(2)).join('');
  const w = D.workerStore(); if (w) nonce = (await (await fetch(`${API}/btc/auth/nonce`, { method: 'POST' })).json()).nonce;
  const message = `MultiSea wants you to sign in with your Bitcoin account:\n${a.ordAddress}\n\nNetwork: ${a.net}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signature = await p.signMessage(a, a.ordAddress, message);
  if (w) { const r = await fetch(`${API}/btc/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: a.ordAddress, message, signature, net: a.net }) }); if (!r.ok) throw new Error('sign-in rejected: ' + (await r.text())); D.setToken((await r.json()).token); return 'worker'; }
  const { B } = await lib(); if (!B.verifyBip322({ address: a.ordAddress, message, signature, network: a.net })) throw new Error('BIP-322 signature did not verify'); return 'local';
}
async function balanceOf(a: Acct) { if (demoOn(a.net)) return (await demoHoldings(a.ordAddress)).balance; try { return await D.addrBalance(a.payAddress, a.net) + (a.payAddress !== a.ordAddress ? await D.addrBalance(a.ordAddress, a.net) : 0); } catch { return null; } }
async function acctModal() {
  const a = btc.acct!; const p = prov(a.wallet);
  const m = overlay(`<div class="btcconn"><h3><img src="${p.icon}" width="24" height="24" alt=""> ${esc(p.name)} <span class="tag ok">${D.netLabel(a.net)}</span></h3>
   <div class="bkv"><span>Ordinals (taproot)</span><a class="mono" href="${D.addrUrl(a.ordAddress, a.net)}" target="_blank" rel="noopener">${esc(a.ordAddress)}</a>
   <span>Payment</span><a class="mono" href="${D.addrUrl(a.payAddress, a.net)}" target="_blank" rel="noopener">${esc(a.payAddress)}</a>
   <span>Balance</span><b class="bal">…</b><span>Sign-in</span><b>${btc.verified === 'worker' ? '✓ BIP-322 verified by MultiSea' : btc.verified === 'local' ? '✓ BIP-322 verified (in browser; preview has no Worker)' : 'not signed'}</b></div>
   <a class="bbtn" href="/btc/me">My Ordinals</a><button class="obtn" style="width:100%;margin-top:8px" data-x>Disconnect</button></div>`);
  m.querySelector('[data-x]')!.addEventListener('click', () => { setAcct(null); m.remove(); location.reload(); });
  const b = await balanceOf(a); const el = m.querySelector('.bal'); if (el) el.innerHTML = b == null ? '-' : `${D.fmtBtc(b)} <small class="mut">${D.fmtSats(b)}${usd ? ' · ' + D.fmtUsd(b, usd) : ''}${demo() ? ' · demo' : ''}</small>`;
}

// ---- pages ----
const collCard = (c: D.Coll) => `<a class="ccard2 btcc" href="/btc/c/${esc(c.slug)}"><div class="cc2img">${c.icon ? `<img class="pix" src="${esc(c.icon)}" alt="" loading="lazy" onerror="this.onerror=null;this.outerHTML='&lt;iframe class=&quot;pix&quot; sandbox=&quot;allow-scripts&quot; scrolling=&quot;no&quot; src=&quot;'+this.src.replace('/content/','/preview/')+'&quot;&gt;&lt;/iframe&gt;'">` : ''}<span class="ftag btctag"><img src="/logos/bitcoin.svg" width="12" height="12" alt=""> Ordinals</span></div>
  <div class="cc2body"><div class="ccname">${esc(c.name)}</div><div class="ccchains"><img class="cl" src="/logos/bitcoin.svg" alt="Bitcoin" title="Bitcoin"></div>
  <div class="cc2stats"><div><span>Floor</span><b>${c.floor ? D.fmtBtc(c.floor) : '-'}</b></div><div><span>Floor USD</span><b>${c.floor && usd ? D.fmtUsd(c.floor, usd) : '-'}</b></div><div><span>Supply</span><b>${c.supply.toLocaleString()}</b></div><div><span>Listed</span><b>${c.listed.toLocaleString()}</b></div></div></div></a>`;
async function pageHome() {
  shell('home', `<section class="btchero"><h1><img src="/logos/bitcoin.svg" width="34" height="34" alt=""> Bitcoin Ordinals</h1><p class="mut">Non-custodial: you keep your inscriptions until a buyer pays. Listings are signed PSBTs (SIGHASH_SINGLE|ANYONECANPAY); every purchase is checked against the indexer so the inscription lands at offset 0 in your wallet.</p></section><div class="content" id="bl">${spin()}</div>`);
  try { const l = await D.featured(); document.getElementById('bl')!.innerHTML = `<div class="cgrid2">${l.map(collCard).join('')}</div><p class="mut small src">Collections, floors and supply: Ordinals Wallet public API (Bitcoin mainnet, read-only). USD: mempool.space.</p>`; }
  catch (e) { document.getElementById('bl')!.innerHTML = err(e); }
}
async function mineListings() { const n = net(); return [...(demo() ? demoListings(n) : []), ...await D.listings(n).catch(() => [])]; }
async function pageColl(slug: string) {
  shell('coll', `<div class="content" id="bc">${spin()}</div>`);
  const el = document.getElementById('bc')!;
  try {
    const c = await D.collection(slug); const L = (await mineListings()).filter(l => l.collection === slug);
    el.innerHTML = `<div class="btchead"><img class="pix av" src="${esc(c.icon)}" alt=""><div><h1>${esc(c.name)} <img class="cl" src="/logos/bitcoin.svg" alt="" title="Bitcoin"></h1><p class="mut small">${esc(c.description || 'Bitcoin Ordinals collection')}</p></div></div>
     <div class="stats btcstats"><div class="stat">${c.floor ? D.price3(c.floor, usd) : '<b>-</b>'}<span>Market floor</span></div><div class="stat"><b>${c.volume ? D.fmtBtc(c.volume) : '-'}</b><small class="usd">${c.volume && usd ? D.fmtUsd(c.volume, usd) : ''}</small><span>Total volume</span></div><div class="stat"><b>${c.supply.toLocaleString()}</b><span>Supply</span></div><div class="stat"><b>${L.length}</b><span>MultiSea listings (${D.netLabel(net())})</span></div><div class="stat"><b>${c.listed}</b><span>Listed elsewhere</span></div></div>
     ${L.length ? `<h3 class="btch3">Listed on MultiSea · ${D.netLabel(net())}${demo() ? ' <span class="tag">demo</span>' : ''}</h3><div class="grid">${L.map(l => itemCard(l.inscriptionId, l.name || '', 'image/png', l.priceSats)).join('')}</div>` : ''}
     <h3 class="btch3">Items</h3><div class="grid" id="bitems">${spin('Loading items from the indexer…')}</div>`;
    const items = c.supply <= 12000 ? await D.collItems(slug) : [];
    document.getElementById('bitems')!.innerHTML = items.length ? items.slice(0, 48).map((x: any) => itemCard(x.id, x.meta?.name || '#' + x.num, x.content_type, null, x.meta?.rank)).join('') : '<p class="mut">This collection is too large for the static preview; the Worker pages it (/btc/ord/…).</p>';
  } catch (e) { el.innerHTML = err(e); }
}
const itemCard = (id: string, name: string, ct: string, price: number | null, rank?: number) => `<a class="card btci" href="/btc/i/${esc(id)}"><div class="ci">${thumb(id, ct)}<span class="badge"><img class="cl" src="/logos/bitcoin.svg" alt=""></span></div><div class="cb"><div class="cn">${esc(name)}</div><div class="cp">${price ? `<b>${D.fmtBtc(price)}</b><small class="mut"> ${usd ? D.fmtUsd(price, usd) : ''}</small>` : `<span class="mut">${rank ? 'Rank ' + rank.toLocaleString() : 'Not listed here'}</span>`}</div></div></a>`;

async function pageIns(id: string) {
  shell('ins', `<div class="content" id="bi">${spin()}</div>`);
  const el = document.getElementById('bi')!;
  try {
    const n = net(); const ins = await D.inscription(id); const L = (await mineListings()).find(l => l.inscriptionId === id) || null;
    const held = btc.acct ? await myHeld() : []; const mine = held.find(h => h.id === id);
    const tradable = (await import('./btc/psbtcore.js')).inscriptionTradable(ins);
    const ord = D.ordExplorer('mainnet'); const [otx, ovout] = (ins.satpoint || '').split(':');
    el.innerHTML = `<div class="btcdet"><div class="btcart">${/^image\//.test(ins.contentType) ? `<img class="pix" src="${esc(D.contentUrl(id))}" alt="">` : `<iframe sandbox="allow-scripts" src="${esc(D.previewUrl(id))}" title="content"></iframe>`}</div>
     <div class="btcinfo">${ins.collection ? `<a class="mut" href="/btc/c/${esc(ins.collection.slug)}">${esc(ins.collection.name)} ›</a>` : '<span class="mut">Inscription</span>'}<h1>${esc(ins.name)}</h1>
      <div class="act" id="bact"></div>
      <div class="fcard"><h3>Details</h3><div class="bkv"><span>Inscription</span><b>#${ins.num?.toLocaleString()}</b><span>Sat</span><b class="mono">${ins.sat != null ? ins.sat.toLocaleString() : '-'}</b>
       <span>Owner (mainnet)</span><a class="mono" href="${D.addrUrl(ins.address, 'mainnet')}" target="_blank" rel="noopener">${esc(D.short(ins.address))}</a>
       ${L ? `<span>Seller (${D.netLabel(n)})</span><a class="mono" href="${D.addrUrl(L.seller)}" target="_blank" rel="noopener">${esc(D.short(L.seller))}</a>` : ''}
       <span>Content</span><b>${esc(ins.contentType)}</b><span>Output value</span><b>${ins.value?.toLocaleString()} sats</b><span>Satpoint</span><b class="mono">${esc(D.short(ins.satpoint))} <span class="tag ${tradable.ok ? 'ok' : ''}">offset ${tradable.offset ?? '?'}</span></b>
       <span>Genesis block</span><b>${ins.height?.toLocaleString() ?? '-'}</b><span>ID</span><b class="mono">${esc(D.short(id))}</b></div>
       <div class="exlinks"><a class="obtn sm" href="${ord}/inscription/${esc(id)}" target="_blank" rel="noopener">ordinals.com ↗</a><a class="obtn sm" href="${D.explorer('mainnet')}/tx/${esc(otx)}#vout=${esc(ovout)}" target="_blank" rel="noopener">mempool.space ↗</a></div></div>
      ${ins.attributes.length ? `<div class="fcard"><h3>Traits${ins.rank ? ` <span class="tag">Rank ${ins.rank.toLocaleString()}</span>` : ''}</h3><div class="traits">${ins.attributes.map(t => `<div class="trait"><span>${esc(t.trait_type)}</span><b>${esc(t.value)}</b>${t.percent ? `<em>${esc(t.percent)}</em>` : ''}</div>`).join('')}</div></div>` : ''}
     </div></div>`;
    renderAct(ins, L, mine, tradable);
  } catch (e) { el.innerHTML = err(e); }
}
async function myHeld() { const a = btc.acct!; if (demoOn(a.net)) return (await demoHoldings(a.ordAddress)).items; try { return (await D.holdings(a.ordAddress, a.net)).items; } catch { return []; } }
function renderAct(ins: D.Ins, L: D.Listing | null, mine: any, tradable: any) {
  const el = document.getElementById('bact')!; const n = net();
  if (L) {
    const own = btc.acct && btc.acct.ordAddress === L.seller;
    el.innerHTML = `<div class="fcard buyc"><span class="mut small">Price · ${D.netLabel(n)}</span><div class="bprice">${D.price3(L.priceSats, usd)}</div><div class="stale"></div>
     ${own ? '<button class="obtn" data-act="cancel" style="width:100%">Cancel listing</button>' : `<button class="bbtn" data-act="buy" ${D.canTrade(n) ? '' : 'disabled'}>Buy now</button>`}
     <p class="mut small">+ ${D.feeBps() / 100}% marketplace fee and the Bitcoin network fee, shown before you sign.</p></div>`;
    D.staleCheck(L, demo() ? null : ins).then(s => { if (s) { el.querySelector('.stale')!.innerHTML = `<p class="err">Stale listing: ${esc(s)}</p>`; el.querySelector<HTMLButtonElement>('[data-act="buy"]')?.setAttribute('disabled', ''); } });
    el.querySelector('[data-act="buy"]')?.addEventListener('click', () => (btc.acct ? buyFlow(ins, L) : openBtcConnect(() => buyFlow(ins, L))));
    el.querySelector('[data-act="cancel"]')?.addEventListener('click', () => cancelFlow(ins, L, mine));
  } else if (mine) {
    el.innerHTML = `<div class="fcard buyc"><span class="mut small">You own this · ${D.netLabel(n)}</span><button class="bbtn" data-act="list" ${D.canTrade(n) && mine.offset === 0 ? '' : 'disabled'}>List for sale</button>${mine.offset ? '<p class="err small">Not at offset 0 of its UTXO: split it out before listing.</p>' : ''}</div>`;
    el.querySelector('[data-act="list"]')!.addEventListener('click', () => listFlow(ins, mine));
  } else el.innerHTML = `<div class="fcard buyc"><span class="mut small">Not listed on MultiSea (${D.netLabel(n)})</span>${tradable.ok ? '' : `<p class="err small">${esc(tradable.why)}</p>`}${btc.acct ? '' : '<button class="obtn" data-act="btcw" style="width:100%;margin-top:8px">Connect BTC wallet</button>'}</div>`;
}
// Spendable payment UTXOs, never one that carries an inscription (single-address taproot wallets keep both on one address).
async function payUtxos(a: Acct) {
  if (demoOn(a.net)) return demoPayUtxos(a.payAddress);
  const u = await D.utxos(a.payAddress, a.net);
  let held: Set<string> | null = null; try { held = new Set((await D.holdings(a.payAddress, a.net)).items.map(h => h.outpoint)); } catch {}
  if (!held && (a.payAddress === a.ordAddress || a.net !== 'mainnet')) throw new Error('Cannot verify which UTXOs carry inscriptions (no indexer for this network), so nothing is spent.');
  return u.filter(x => !held!.has(`${x.txid}:${x.vout}`));
}
function ladder(steps: [string, string][]) { return `<ol class="bsteps">${steps.map(([s, t]) => `<li class="${s}">${t}</li>`).join('')}</ol>`; }

async function listFlow(ins: D.Ins, held: any) {
  const a = btc.acct!; const n = net();
  const m = overlay(`<div class="btcflow"><h3>List for sale</h3><div class="bsum">${thumb(ins.id, ins.contentType, 'pix sm')}<div><b>${esc(ins.name)}</b><span class="mut small">#${ins.num?.toLocaleString()} · ${D.netLabel(n)}</span></div></div>
   <label class="blabel">Price<div class="bin"><input id="lp" type="number" inputmode="decimal" min="0.00000546" step="0.0001" value="0.0015"><span>BTC</span></div><small class="mut" id="lpu"></small></label>
   <div class="bkv small"><span>You receive</span><b id="lrx"></b><span>Marketplace fee</span><b>${D.feeBps() / 100}%, paid by the buyer</b><span>Payout address</span><b class="mono">${esc(D.short(a.payAddress))}</b><span>Inscription UTXO</span><b class="mono">${esc(D.short(held.outpoint))} <span class="tag ok">offset 0 ✓</span></b></div>
   ${ladder([['on', '1. Sign a PSBT in your wallet (SIGHASH_SINGLE|ANYONECANPAY): it only lets a buyer spend this UTXO if your payout output is paid.'], ['', '2. MultiSea checks the signature and the indexer location, then publishes the listing.'], ['', '3. Your inscription stays in your wallet. Cancel any time.']])}
   <button class="bbtn" data-go>Sign &amp; list</button><div class="lmsg"></div></div>`);
  const ip = m.querySelector('#lp') as HTMLInputElement; const upd = () => { const s = Math.round(+ip.value * 1e8); m.querySelector('#lpu')!.textContent = `${D.fmtSats(s)}${usd ? ' · ' + D.fmtUsd(s, usd) : ''}`; m.querySelector('#lrx')!.textContent = D.fmtBtc(s); }; ip.addEventListener('input', upd); upd();
  m.querySelector('[data-go]')!.addEventListener('click', async () => {
    const out = m.querySelector('.lmsg')!; const priceSats = Math.round(+ip.value * 1e8);
    try { const { B } = await lib(); const [txid, vout] = held.outpoint.split(':');
      const psbt = B.createListing({ network: n, ins: { txid, vout: +vout, value: held.value, address: a.ordAddress, pubkey: a.ordPubkey, offset: held.offset }, priceSats, sellerPayAddress: a.payAddress });
      out.innerHTML = spin('Confirm in ' + prov(a.wallet).name + '…');
      const signed = await prov(a.wallet).signPsbt(a, psbt, [{ address: a.ordAddress, index: 0 }], 0x83);
      const v = B.validateListing(signed, n, { txid, vout: +vout, value: held.value, address: a.ordAddress, priceSats, sellerPayAddress: a.payAddress });
      if (!v.ok) throw new Error(v.errs.join('; '));
      const r: any = await D.putListing({ inscriptionId: ins.id, net: n, psbt: signed, priceSats, seller: a.ordAddress, payout: a.payAddress, txid, vout: +vout, value: held.value, createdAt: Date.now(), name: ins.name, collection: ins.collection?.slug });
      m.querySelector('.bsteps')!.outerHTML = ladder([['ok', '1. PSBT signed (SIGHASH_SINGLE|ANYONECANPAY) ✓'], ['ok', '2. Signature + UTXO verified ✓'], ['ok', `3. Listed at ${D.fmtBtc(priceSats)} ✓`]]);
      out.innerHTML = `<p class="ok">Listed on ${D.netLabel(n)}${r.local ? ' (preview: saved in this browser; the Worker KV store is not deployed)' : ''}.</p><a class="obtn sm" href="">View listing</a>`;
      (m.querySelector('[data-go]') as HTMLButtonElement).disabled = true;
    } catch (e) { out.innerHTML = err(e); }
  });
}
async function buyFlow(ins: D.Ins, L: D.Listing) {
  const a = btc.acct!; const n = net(); const m = overlay(`<div class="btcflow"><h3>Confirm purchase</h3><div class="bsum">${thumb(ins.id, ins.contentType, 'pix sm')}<div><b>${esc(ins.name)}</b><span class="mut small">#${ins.num?.toLocaleString()} · ${D.netLabel(n)}</span></div></div><div class="bq">${spin('Checking listing, UTXOs and fee rate…')}</div></div>`);
  m.querySelector('.wbox')?.classList.add('wide');
  const q = m.querySelector('.bq')!; let rate = fee?.halfHourFee || 2;
  const draw = async () => {
    try { const { B } = await lib();
      const v = B.validateListing(L.psbt, n, { txid: L.txid, vout: L.vout, priceSats: L.priceSats }); if (!v.ok) throw new Error('listing failed validation: ' + v.errs.join('; '));
      const stale = await D.staleCheck(L, demo() ? null : ins); if (stale) throw new Error(stale);
      const u = await payUtxos(a); const dummies = u.filter(x => x.value >= 546 && x.value <= 1000).slice(0, 2); const pay = u.filter(x => !dummies.includes(x) && x.value > 1000);
      const fa = D.feeAddress(n); const buyer = { ordAddress: a.ordAddress, payAddress: a.payAddress, payPubkey: a.payPubkey };
      if (dummies.length < 2) { q.innerHTML = `<p class="soon small">Your payment address needs two small padding UTXOs (600 sats each) so the inscription lands at offset 0. One-time.</p><button class="bbtn" data-pad>Prepare wallet</button>`; q.querySelector('[data-pad]')!.addEventListener('click', () => padFlow(a)); return; }
      const r = B.buildPurchase({ network: n, listingPsbt: L.psbt, buyer, dummies, payUtxos: pay, feeRate: rate, feeAddress: fa, feeBps: D.feeBps(), quoteOnly: !fa });
      const b = r.breakdown; const row = (k: string, s: number, note = '') => `<span>${k}${note ? ` <em class="mut">${note}</em>` : ''}</span><b>${D.fmtBtc(s)} <small class="mut">${D.fmtSats(s)}${usd ? ' · ' + D.fmtUsd(s, usd) : ''}</small></b>`;
      q.innerHTML = `<div class="frates">${(['economyFee', 'hourFee', 'halfHourFee', 'fastestFee'] as const).map(k => fee ? `<button class="chip ${fee[k] === rate ? 'on' : ''}" data-rate="${fee[k]}">${{ economyFee: 'Economy', hourFee: '~1 h', halfHourFee: '~30 min', fastestFee: 'Fast' }[k]} <em>${fee[k]} sat/vB</em></button>` : '').join('')}</div>
       <div class="bkv fees">${row('Price (to seller)', b.price)}${row('Marketplace fee', b.marketFee, `${b.feeBps / 100}%${b.marketFee === 546 && b.price * b.feeBps / 1e4 < 546 ? ', dust minimum' : ''}`)}${row('Network fee', b.networkFee, `${b.feeRate} sat/vB · ${b.inputs} in / ${b.outputs} out`)}
        <span class="tot">Total</span><b class="tot">${D.fmtBtc(b.totalSpent)} <small class="mut">${D.fmtSats(b.totalSpent)}${usd ? ' · ' + D.fmtUsd(b.totalSpent, usd) : ''}</small></b></div>
       <p class="mut small">Also moves ${D.fmtSats(b.newDummies)} into two new padding UTXOs in your own wallet (not a cost). The inscription (${b.inscriptionValue} sats) goes to <span class="mono">${esc(D.short(a.ordAddress))}</span> at offset 0.</p>
       ${ladder([['ok', 'Listing signature valid (SIGHASH_SINGLE|ANYONECANPAY) ✓'], ['ok', demo() ? 'UTXO unspent (demo: mocked) ✓' : 'Seller UTXO unspent + matches indexer ✓'], ['ok', 'Inscription at offset 0 ✓']])}
       ${fa ? '' : '<p class="err small"><b>Buying disabled:</b> no BTC fee address configured yet (config/btc.json → feeAddress, TODO). The fee output above is a preview; MultiSea never sends fees to a placeholder.</p>'}
       <button class="bbtn" data-buy ${fa && D.canTrade(n) ? '' : 'disabled'}>Sign &amp; buy</button><div class="bmsg"></div>`;
      q.querySelectorAll('[data-rate]').forEach(c => c.addEventListener('click', () => { rate = +(c as HTMLElement).dataset.rate!; draw(); }));
      q.querySelector('[data-buy]')?.addEventListener('click', async () => {
        const o = q.querySelector('.bmsg')!; try { o.innerHTML = spin('Confirm in ' + prov(a.wallet).name + '…');
          const signed = await prov(a.wallet).signPsbt(a, r.psbt, r.signIndexes.map((i: number) => ({ address: a.payAddress, index: i })));
          const f = B.finalizePurchase(signed, n, { ordAddress: a.ordAddress, sellerPayout: L.payout, priceSats: L.priceSats });
          if (demo()) { o.innerHTML = `<p class="ok">Demo: signed ${f.vsize} vB tx ${esc(f.txid.slice(0, 12))}…, not broadcast.</p>`; return; }
          const txid = await D.broadcast(f.hex, n); await D.removeListing(n, L.inscriptionId, undefined, 'sold').catch(() => {});
          o.innerHTML = `<p class="ok">Broadcast ✓ <a href="${D.txUrl(txid, n)}" target="_blank" rel="noopener">${esc(txid.slice(0, 14))}… ↗</a></p>`;
        } catch (e) { o.innerHTML = err(e); } });
    } catch (e) { q.innerHTML = err(e); }
  };
  draw();
}
async function padFlow(a: Acct) {
  const n = net(); const m = overlay(`<div class="btcflow"><h3>Prepare wallet</h3><div class="pq">${spin()}</div></div>`); const q = m.querySelector('.pq')!;
  try { const { B } = await lib(); const r = B.buildPadding({ network: n, payAddress: a.payAddress, payPubkey: a.payPubkey, payUtxos: (await payUtxos(a)).filter(u => u.value > 1000), feeRate: fee?.halfHourFee || 2 });
    q.innerHTML = `<p>Creates 2 × 600-sat padding outputs in your payment address. Network fee ${D.fmtSats(r.fee)}.</p><button class="bbtn" data-go>Sign &amp; broadcast</button><div class="pm"></div>`;
    q.querySelector('[data-go]')!.addEventListener('click', async () => { try { const s = await prov(a.wallet).signPsbt(a, r.psbt, r.signIndexes.map((i: number) => ({ address: a.payAddress, index: i })));
      const p = (await lib()).bitcoin.Psbt.fromBase64(s); p.finalizeAllInputs(); const hex = p.extractTransaction().toHex(); const t = await D.broadcast(hex, n); q.querySelector('.pm')!.innerHTML = `<p class="ok">Broadcast ✓ <a href="${D.txUrl(t, n)}" target="_blank">${t.slice(0, 12)}…</a></p>`; } catch (e) { q.querySelector('.pm')!.innerHTML = err(e); } });
  } catch (e) { q.innerHTML = err(e); }
}
async function cancelFlow(ins: D.Ins, L: D.Listing, held: any) {
  const a = btc.acct!; const n = net();
  const m = overlay(`<div class="btcflow"><h3>Cancel listing</h3><p class="mut small">Removing it from MultiSea hides it right away, but a signed listing PSBT stays technically valid until its UTXO is spent. For a hard cancel, move the inscription to yourself (small network fee).</p>
   <button class="obtn" style="width:100%" data-off>Remove from MultiSea (free)</button><button class="bbtn" data-on>Cancel on-chain (spend to self)</button><div class="cm"></div></div>`);
  const o = m.querySelector('.cm')!;
  m.querySelector('[data-off]')!.addEventListener('click', async () => { try { await D.removeListing(n, L.inscriptionId); o.innerHTML = '<p class="ok">Removed from MultiSea.</p>'; setTimeout(() => location.reload(), 800); } catch (e) { o.innerHTML = err(e); } });
  m.querySelector('[data-on]')!.addEventListener('click', async () => { try { const { B, bitcoin } = await lib();
    const r = B.buildCancel({ network: n, ins: { txid: L.txid, vout: L.vout, value: L.value, address: a.ordAddress, offset: 0 }, ordPubkey: a.ordPubkey, payAddress: a.payAddress, payPubkey: a.payPubkey, payUtxos: (await payUtxos(a)).filter(u => u.value > 1000), feeRate: fee?.halfHourFee || 2 });
    const s = await prov(a.wallet).signPsbt(a, r.psbt, r.signIndexes.map((i: number) => ({ address: i ? a.payAddress : a.ordAddress, index: i })));
    const p = bitcoin.Psbt.fromBase64(s); p.finalizeAllInputs(); const hex = p.extractTransaction().toHex();
    if (demo()) { await D.removeListing(n, L.inscriptionId); o.innerHTML = '<p class="ok">Demo: cancel tx signed, not broadcast. Listing removed.</p>'; return; }
    const t = await D.broadcast(hex, n); await D.removeListing(n, L.inscriptionId); o.innerHTML = `<p class="ok">Cancel broadcast ✓ <a href="${D.txUrl(t, n)}" target="_blank">${t.slice(0, 12)}…</a></p>`; } catch (e) { o.innerHTML = err(e); } });
  void ins; void held;
}
async function pageMe() {
  shell('me', `<div class="content" id="bm">${spin()}</div>`); const el = document.getElementById('bm')!;
  if (!btc.acct) { el.innerHTML = `<div class="fcard btcempty"><h2>My Ordinals</h2><p class="mut">Connect a Bitcoin wallet to see your inscriptions and listings.</p><button class="bbtn" data-act="btcw">Connect BTC wallet</button></div>`; return; }
  const a = btc.acct; const p = prov(a.wallet);
  try { const items = await myHeld(); const L = (await mineListings()).filter(l => l.seller === a.ordAddress); const bal = await balanceOf(a);
    el.innerHTML = `<div class="btchead me"><img src="${p.icon}" class="av" alt=""><div><h1>My Ordinals</h1><div class="bkv small"><span>Ordinals</span><a class="mono" href="${D.addrUrl(a.ordAddress, a.net)}" target="_blank" rel="noopener">${esc(a.ordAddress)}</a><span>Payment</span><a class="mono" href="${D.addrUrl(a.payAddress, a.net)}" target="_blank" rel="noopener">${esc(a.payAddress)}</a></div></div></div>
     <div class="stats btcstats"><div class="stat">${bal != null ? D.price3(bal, usd) : '<b>-</b>'}<span>Balance</span></div><div class="stat"><b>${items.length}</b><span>Inscriptions</span></div><div class="stat"><b>${L.length}</b><span>Listed on MultiSea</span></div><div class="stat"><b>${D.netLabel(a.net)}</b><span>Network</span></div></div>
     <h3 class="btch3">Inscriptions</h3><div class="grid">${items.length ? items.map(h => { const l = L.find(x => x.inscriptionId === h.id); return itemCard(h.id, h.name, h.contentType, l ? l.priceSats : null); }).join('') : `<p class="mut">No inscriptions found${a.net !== 'mainnet' ? ' (signet/testnet holdings need the Worker ord proxy)' : ''}.</p>`}</div>`;
  } catch (e) { el.innerHTML = err(e); }
}

// ---- boot ----
bindNav(); onBtc(() => { document.querySelector('.btcw')?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: btcBtn() }).firstElementChild!); });
checkApi();
[usd, fee] = await Promise.all([D.btcUsd(), D.fees().catch(() => null)]);
const mm = path.match(/^\/btc(?:\/(c|i)\/([A-Za-z0-9_-]+)|\/(me))?$/);
if (!mm) location.replace('/btc');
else if (mm[1] === 'c') pageColl(mm[2]);
else if (mm[1] === 'i') pageIns(mm[2]);
else if (mm[3]) pageMe();
else pageHome();
if (new URLSearchParams(location.search).get('connect') === '1' && !btc.acct) setTimeout(() => openBtcConnect(), 300);
