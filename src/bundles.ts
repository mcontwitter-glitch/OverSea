// Bundles: sell several NFTs as one item. Same chain = one Seaport order with multiple offer items (atomic).
// Cross-chain (EXPERIMENTAL) = one MultiSea listing made of one Seaport order per chain, coordinated by the Worker:
// signatures stay server-side until a buyer takes an exclusive checkout lock; legs fill highest-value first.
import { createWalletClient, custom, parseAbi, parseEther, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect, checkApi, API, overlay, ensureChain, readClient, vchain, friendly } from './wallet';
import { usdRates } from './shell';
import { api, signIn } from './auth';
import { frame, getJ, esc, short, logo, chains, fmtWei, usdTxt, thumbFor, nameFor, connectCta, reportFill, balances, topUpQuote, runRelay, closed } from './gx';
import { buildBundleOrder, orderTypedData, fulfillCalldata, EXPIRY, type Fee } from './seaorder';
const el = frame('bundles', 'Bundles');
const FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0';
const SEAPORT = CFG.seaport as Hex;
const NFT = parseAbi(['function isApprovedForAll(address,address) view returns (bool)', 'function setApprovalForAll(address,bool)']);
const SEA = parseAbi(['function getCounter(address) view returns (uint256)']);
type Sel = { chain: string; token: string; id: string; slug?: string };
const q = new URLSearchParams(location.search);
const st = { view: q.get('id') ? 'detail' : q.get('new') ? 'create' : 'list', id: q.get('id') || '', list: [] as any[], one: null as any, err: '', mine: [] as Sel[], sel: [] as Sel[], prices: {} as Record<string, string>, title: '', exp: '7d' as keyof typeof EXPIRY, msg: '' };
let rates: any = {}; usdRates().then(r => { rates = r; draw(); });
const usdOf = (k: string, w: string) => +fmtWei(w).replace(/,/g, '') * (rates[chains[k]?.native] || 0);
const total = (b: any) => b.legs.reduce((s: number, l: any) => s + usdOf(l.chain, l.priceWei), 0);
const itemsOf = (b: any) => b.legs.flatMap((l: any) => l.items.map((i: any) => ({ ...i, chain: l.chain })));
async function load() {
  st.err = '';
  try { if (st.view === 'detail') st.one = (await getJ('/bundles/' + st.id)).bundle; else st.list = (await getJ('/bundles')).bundles; } catch (e: any) { st.err = e.message; }
  if (st.view === 'create') await loadMine(); draw();
}
async function loadMine() {
  const mine: Sel[] = []; if (!wallet.address) { st.mine = mine; return; } const me = wallet.address.toLowerCase();
  for (const c of CFG.collections) {
    const m = await fetch(`/data/${c.slug}/owners.min.json`).then(r => r.json()).catch(() => null); if (!m) continue;
    for (const [id, a] of Object.entries(m.d as Record<string, number[]>)) for (let k = 0; k < a.length; k += 2) if ((m.addrs[a[k + 1]] || '').toLowerCase() === me) { const ch = m.chains[a[k]]; const dep = c.deployments.find(d => d.chain === ch); if (dep) mine.push({ chain: ch, token: dep.address.toLowerCase(), id, slug: c.slug }); }
  }
  st.mine = mine;
}
const card = (b: any) => `<a class="bcard" href="/bundles?id=${esc(b.id)}"><div class="bthumbs">${itemsOf(b).slice(0, 4).map((i: any) => `<span>${thumbFor(i.chain, i.token, i.id) ? `<img src="${esc(thumbFor(i.chain, i.token, i.id))}" alt="" loading="lazy">` : `<em>#${esc(i.id)}</em>`}${logo(i.chain)}</span>`).join('')}</div>
  <div class="cb"><div class="cn">${esc(b.title)}</div><div class="mut small">${itemsOf(b).length} items · ${b.legs.map((l: any) => logo(l.chain)).join('')} ${b.kind === 'cross-chain' ? '<i class="tag exp">Cross-chain · Experimental</i>' : '<i class="tag">Same chain</i>'}</div>
  <div class="cp"><b>${b.legs.map((l: any) => `${fmtWei(l.priceWei)} ${esc(chains[l.chain].native)}`).join(' + ')}</b> <span class="usd">≈ ${usdTxt(total(b))}</span></div>${b.status !== 'open' ? `<span class="tag">${esc(b.status)}</span>` : ''}</div></a>`;
function draw() {
  if (st.view === 'detail') return drawDetail();
  if (st.view === 'create') return drawCreate();
  el.innerHTML = `<div class="ghero"><h1>Bundles</h1><p class="lpsub">Sell several NFTs as one item, even across chains. Same-chain bundles are a single Seaport order (all-or-nothing). Cross-chain bundles are coordinated by MultiSea and are experimental.</p><a class="bbtn sm" href="/bundles?new=1">Create a bundle</a></div>
   ${st.err ? `<p class="err">${esc(st.err)}</p>` : ''}<div class="bgrid">${st.list.map(card).join('') || '<div class="empty">No bundles yet. Be the first to create one.</div>'}</div>`;
}
function drawDetail() {
  const b = st.one;
  el.innerHTML = `<p><a href="/bundles">← All bundles</a></p>${st.err ? `<p class="err">${esc(st.err)}</p>` : !b ? '<div class="spin"></div>' : `
  <div class="bdet"><div class="bthumbs big">${itemsOf(b).map((i: any) => `<span title="${esc(nameFor(i.chain, i.token, i.id))}">${thumbFor(i.chain, i.token, i.id) ? `<img src="${esc(thumbFor(i.chain, i.token, i.id))}" alt="">` : `<em>#${esc(i.id)}</em>`}${logo(i.chain)}</span>`).join('')}</div>
  <div><h1>${esc(b.title)}</h1><p class="mut small">by <a class="mono" href="/u/${esc(b.seller)}">${short(b.seller)}</a> · ${itemsOf(b).length} items · ${b.kind === 'cross-chain' ? '<i class="tag exp">Cross-chain · Experimental</i>' : '<i class="tag">Same chain · atomic</i>'} · status <b>${esc(b.status)}</b></p>
   <div class="kv bkv">${b.legs.map((l: any) => `<span>${logo(l.chain)} ${esc(chains[l.chain].name)} leg · ${l.items.length} item(s) ${l.status !== 'open' ? `<i class="tag">${esc(l.status)}</i>` : ''}</span><b>${fmtWei(l.priceWei)} ${esc(chains[l.chain].native)} <i class="usd">${usdTxt(usdOf(l.chain, l.priceWei))}</i></b>`).join('')}
    <span>MultiSea fee</span><b>0.5% <i class="usd">included</i></b><span>Total</span><b class="xtot">≈ ${usdTxt(total(b))}</b></div>
   ${b.kind === 'cross-chain' ? `<div class="legal small"><b>Partial-fill policy:</b> ${esc(b.policy)}</div>` : ''}
   ${b.status === 'open' || b.status === 'checkout' ? (wallet.address?.toLowerCase() === b.seller ? '<button class="bbtn ghost" data-act="cancel">Remove bundle</button>' : '<button class="bbtn" data-act="buy">Buy bundle</button>') : ''}
   ${st.msg}</div></div>
  <div class="fcard"><div class="gh">Items</div>${itemsOf(b).map((i: any) => `<div class="frow">${logo(i.chain)}<span><b>${esc(nameFor(i.chain, i.token, i.id))}</b><em class="mono">${esc(i.token)}</em></span></div>`).join('')}</div>`}`;
}
function drawCreate() {
  const per: Record<string, Sel[]> = {}; st.sel.forEach(s => (per[s.chain] ??= []).push(s));
  const key = (s: Sel) => `${s.chain}:${s.token}:${s.id}`; const on = new Set(st.sel.map(key));
  el.innerHTML = `<p><a href="/bundles">← All bundles</a></p><h2>Create a bundle</h2>
  ${!wallet.address ? connectCta('Connect the wallet that holds the NFTs.') : `
  <div class="fcard"><div class="gh">Your MultiSea items <span class="mut small">${st.mine.length}</span></div>
   <div class="pickgrid">${st.mine.slice(0, 120).map(s => `<button class="pick ${on.has(key(s)) ? 'on' : ''}" data-pick="${esc(key(s))}">${thumbFor(s.chain, s.token, s.id) ? `<img src="${esc(thumbFor(s.chain, s.token, s.id))}" alt="">` : ''}<span>#${esc(s.id)}</span>${logo(s.chain)}</button>`).join('') || '<p class="mut small">No items found automatically. Add by contract below.</p>'}</div>
   <div class="addrow"><select class="ac">${Object.keys(chains).map(k => `<option value="${k}">${esc(chains[k].name)}</option>`).join('')}</select><input class="at" placeholder="Contract 0x…"><input class="ai" placeholder="Token ID"><button class="obtn sm" data-act="add">Add</button></div></div>
  <div class="fcard"><div class="gh">Bundle ${Object.keys(per).length > 1 ? '<i class="tag exp">Cross-chain · Experimental</i>' : ''}</div>
   <label>Title<input class="bt" value="${esc(st.title)}" placeholder="e.g. LIL FOOTS starter pack"></label>
   ${Object.entries(per).map(([k, l]) => `<div class="legrow">${logo(k)}<b>${esc(chains[k].name)}</b><span class="mut small">${l.map(s => '#' + s.id).join(', ')}</span><label class="pin"><input data-price="${k}" inputmode="decimal" placeholder="0.00" value="${esc(st.prices[k] || '')}"><b>${esc(chains[k].native)}</b></label></div>`).join('') || '<p class="mut small">Pick at least 2 items.</p>'}
   <label>Expires<select class="be">${Object.keys(EXPIRY).map(x => `<option ${x === st.exp ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
   ${Object.keys(per).length > 1 ? `<p class="legal small">Cross-chain bundles are experimental. You sign one order per chain; MultiSea only reveals them to a buyer holding a checkout lock. If a buyer completes only some chains, they keep those legs at your per-chain prices and the rest is withdrawn.</p>` : '<p class="mut small">One Seaport order with all items: the buyer gets everything or nothing.</p>'}
   <button class="bbtn" data-act="sign" ${st.sel.length >= 2 ? '' : 'disabled'}>Approve & sign ${Object.keys(per).length || ''} order(s)</button>${st.msg}</div>`}`;
}
async function royaltyFees(items: Sel[]): Promise<Fee[]> {
  const by: Record<string, number> = {};
  for (const s of items) { const slug = s.slug || CFG.collections.find(c => c.deployments.some(d => d.chain === s.chain && d.address.toLowerCase() === s.token))?.slug; if (!slug) continue;
    const cfg = await getJ('/native/config/' + slug).catch(() => null); const r = cfg?.royalty; if (r?.bps) by[r.recipient] = (by[r.recipient] || 0) + r.bps / items.length; }
  return Object.entries(by).map(([recipient, bps]) => ({ recipient, bps: Math.ceil(bps), required: true, kind: 'creator', ceil: true }));
}
async function sign() {
  const me = wallet.address as Hex; const per: Record<string, Sel[]> = {}; st.sel.forEach(s => (per[s.chain] ??= []).push(s));
  const legs: any[] = []; const msg = (s: string) => { st.msg = `<p class="mut small"><span class="spin"></span> ${s}</p>`; draw(); };
  try {
    for (const [k, items] of Object.entries(per)) {
      const price = parseEther(st.prices[k] || '0'); if (price <= 0n) throw new Error(`Set a price for the ${chains[k].name} leg`);
      msg(`Switching to ${esc(chains[k].name)}…`); await ensureChain(k);
      const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) }); const pub = readClient(k);
      for (const t of [...new Set(items.map(i => i.token))]) {
        if (!(await pub.readContract({ address: t as Hex, abi: NFT, functionName: 'isApprovedForAll', args: [me, SEAPORT] }))) { msg('Approve Seaport for this collection in your wallet…'); const h = await wc.writeContract({ account: me, address: t as Hex, abi: NFT, functionName: 'setApprovalForAll', args: [SEAPORT, true] }); await pub.waitForTransactionReceipt({ hash: h }); }
      }
      const counter = await pub.readContract({ address: SEAPORT, abi: SEA, functionName: 'getCounter', args: [me] });
      const fees: Fee[] = [{ recipient: FEE, bps: 50, required: true, kind: 'multisea', ceil: true }, ...(await royaltyFees(items))];
      const o = buildBundleOrder({ offerer: me, items: items.map(i => ({ token: i.token, id: i.id })), priceWei: price, fees, counter, duration: EXPIRY[st.exp] });
      msg(`Sign the ${esc(chains[k].name)} order in your wallet…`);
      const signature = await wc.signTypedData({ account: me, ...orderTypedData(chains[k].chainId, SEAPORT, o) } as any);
      legs.push({ chain: k, parameters: o, signature });
    }
    msg('Publishing bundle…');
    const r = await fetch(`${API}/bundles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: st.title, legs }) }); const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not create bundle');
    location.href = '/bundles?id=' + j.id;
  } catch (e: any) { st.msg = `<p class="err">${esc(friendly(e))}</p>`; draw(); }
}
async function buy() {
  const b = st.one; const me = wallet.address as Hex; if (!me) { openConnect(); return; }
  const m = overlay(`<div class="bhead"><div><div class="mut">${b.kind === 'cross-chain' ? 'Cross-chain bundle · Experimental' : 'Bundle'}</div><h3>${esc(b.title)}</h3></div></div><div class="bbody"><div class="spin"></div> Reserving checkout…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement; const status = (s: string) => { body.innerHTML = `<div class="spin"></div> ${s}`; };
  const done: string[] = [];
  try {
    await signIn('Sign in to buy this MultiSea bundle');
    const co = await api(`/bundles/${b.id}/checkout`, { auth: true, method: 'POST' });
    const bal = await balances();
    body.innerHTML = `<div class="kv bkv">${co.legs.map((l: any, i: number) => `<span>${i + 1}. ${logo(l.chain)} ${esc(chains[l.chain].name)}</span><b>${fmtWei(l.priceWei)} ${esc(chains[l.chain].native)}${(bal[l.chain] ?? 0n) < BigInt(l.priceWei) ? ' <i class="errc">top-up via Relay</i>' : ''}</b>`).join('')}<span>Total</span><b class="xtot">≈ ${usdTxt(total(b))}</b></div>
      ${co.legs.length > 1 ? `<p class="legal small">You have a 15-minute exclusive lock. ${esc(co.policy)}</p>` : ''}<button class="bbtn go">Buy (${co.legs.length} transaction${co.legs.length > 1 ? 's' : ''})</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    for (const l of co.legs) {
      const c = chains[l.chain]; const value = BigInt(l.priceWei);
      const have = bal[l.chain] ?? 0n; const need = value + 10n ** 15n / 2n;
      if (have < need) { const src = Object.entries(bal).filter(([k, x]) => k !== l.chain && x && chains[k].native === c.native).sort((a, z) => (z[1]! > a[1]! ? 1 : -1))[0]?.[0]; if (!src) throw new Error(`Not enough ${c.native} on ${c.name}.`); status(`Quoting Relay top-up to ${esc(c.name)}…`); const qq = await topUpQuote(src, l.chain, need - have); await runRelay(qq.quote, src, status); }
      status(`Switching to ${esc(c.name)}…`); await ensureChain(l.chain);
      const wc = createWalletClient({ chain: vchain(l.chain), transport: custom(wallet.provider) });
      status(`Confirm the ${esc(c.name)} leg in your wallet…`);
      const data = fulfillCalldata(l.parameters, l.signature); const gas = await (await import('./txgas')).gasFor(l.chain, { to: l.protocolAddress, data, value }, have < need);
      const h = await wc.sendTransaction({ account: me, to: l.protocolAddress, value, data, ...(gas ? { gas } : {}) });
      status(`Pending on ${esc(c.name)}… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`);
      const rc = await readClient(l.chain).waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error(`${c.name} leg reverted`);
      await fetch(`${API}/native/filled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: l.chain, txHash: h }) }).catch(() => reportFill(l.chain, h));
      done.push(c.name);
    }
    body.innerHTML = `<p class="ok">✓ Bundle purchased${done.length > 1 ? ` (${done.join(' + ')})` : ''}.</p>`; load();
  } catch (e: any) { if (e?.kind === 'closed') return; body.innerHTML = `<p class="err">${esc(friendly(e))}</p>${done.length ? `<p class="warn small">Partial fill: ${esc(done.join(', '))} completed. Per the policy you keep those legs; you can retry the rest while your lock lasts.</p>` : ''}`; }
}
el.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.dataset.act;
  if (a === 'connect') openConnect();
  const p = t.closest('[data-pick]') as HTMLElement;
  if (p) { const [c, tk, id] = p.dataset.pick!.split(':'); const i = st.sel.findIndex(s => s.chain === c && s.token === tk && s.id === id); if (i >= 0) st.sel.splice(i, 1); else st.sel.push(st.mine.find(s => s.chain === c && s.token === tk && s.id === id)!); draw(); }
  if (a === 'add') { const c = (el.querySelector('.ac') as HTMLSelectElement).value, tk = (el.querySelector('.at') as HTMLInputElement).value.trim().toLowerCase(), id = (el.querySelector('.ai') as HTMLInputElement).value.trim(); if (/^0x[0-9a-f]{40}$/.test(tk) && /^\d+$/.test(id)) { const s = { chain: c, token: tk, id }; st.mine.unshift(s); st.sel.push(s); draw(); } }
  if (a === 'sign') sign();
  if (a === 'buy') buy();
  if (a === 'cancel') { try { await api(`/bundles/${st.id}/cancel`, { auth: true, method: 'POST' }); location.href = '/bundles'; } catch (x: any) { st.msg = `<p class="err">${esc(x.message)}</p>`; draw(); } }
});
el.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.dataset.price) st.prices[t.dataset.price] = t.value; if (t.classList.contains('bt')) st.title = t.value; });
el.addEventListener('change', e => { const t = e.target as HTMLSelectElement; if (t.classList.contains('be')) st.exp = t.value as any; });
onWallet(load); checkApi().then(load); draw();
