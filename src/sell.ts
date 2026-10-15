// Sell flow: list an owned NFT on OpenSea (Seaport 1.6, EIP-712) and cancel it. The OpenSea key lives only in the Worker.
import { createPublicClient, createWalletClient, custom, http, parseAbi, parseUnits, formatUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { API, readClient, wallet, openConnect, overlay, vchain, ensureChain, friendly, esc } from './wallet';
import { buildListing, orderTypedData, cancelTypedData, splitPrice, EXPIRY, ZERO32, type Fee } from './seaorder';

const chains = CFG.chains as Record<string, any>;
export type SellItem = { id: number; name: string; img: string; chain: string; contract: string; slug?: string };
export const canSellNative = (chainKey: string) => !!chains[chainKey];
export const canSell = (chainKey: string) => !!chains[chainKey]?.openseaSlug && !!chains[chainKey]?.conduit;
const ERC721 = parseAbi(['function ownerOf(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)', 'function setApprovalForAll(address,bool)']);
const SEAPORT = parseAbi(['function getCounter(address) view returns (uint256)', 'function incrementCounter() returns (uint256)', 'function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)[]) returns (bool)']);

function head(it: SellItem, title: string) {
  const c = chains[it.chain];
  return overlay(`<div class="bhead"><img src="${esc(it.img)}" alt=""><div><div class="mut">${esc(c.name)} · ${esc(title)}</div><h3>${esc(it.name)}</h3></div></div><div class="bbody"><div class="spin"></div> Loading fees from OpenSea…</div>`);
}
const closed = (m: HTMLElement) => new Promise<never>((_, rej) => m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) rej(Object.assign(new Error('closed'), { kind: 'closed' })); }));
const fmt = (x: bigint) => (+formatUnits(x, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });

export async function openSell(it: SellItem, onListed: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const osOk = canSell(it.chain);
  const m = head(it, 'List for sale'); const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    // MultiSea native config (0.5% fee + optional collection royalty) and, where supported, OpenSea's fees.
    const [nr, or] = await Promise.all([
      fetch(`${API}/native/config/${it.slug || CFG.default}`).then(r => r.json()).catch(() => null),
      osOk ? fetch(`${API}/sell/config/${c.openseaSlug}/${it.contract}`).then(async r => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null),
    ]);
    if (!nr?.seaport && !or) throw Object.assign(new Error('Could not load marketplace fees'), { kind: 'stale' });
    const nFees: Fee[] = nr?.seaport ? [{ recipient: nr.feeRecipient, bps: nr.feeBps, required: true, kind: 'multisea', ceil: true }, ...(nr.royalty ? [{ recipient: nr.royalty.recipient, bps: nr.royalty.bps, required: true, kind: 'creator' as const }] : [])] : [];
    let market: 'multisea' | 'opensea' = nr?.seaport ? 'multisea' : 'opensea';
    const oFees: Fee[] = or?.fees || []; const optional = oFees.filter(f => !f.required && f.bps > 0);
    body.innerHTML = `<div class="sl"><span>Marketplace</span><div class="pills mk">
        <button type="button" class="pill${market === 'multisea' ? ' on' : ''}" data-mk="multisea" ${nr?.seaport ? '' : 'disabled'}>MultiSea (0.5% fee)</button>
        <button type="button" class="pill${market === 'opensea' ? ' on' : ''}" data-mk="opensea" ${or ? '' : 'disabled title="OpenSea does not support this chain"'}>OpenSea${or ? '' : ' (n/a)'}</button></div></div>
      <label class="sl"><span>Price</span><span class="pin"><input class="sprice" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00"><b>${esc(c.native)}</b></span></label>
      <div class="sl"><span>Expires in</span><div class="pills">${Object.keys(EXPIRY).map((k, i) => `<button type="button" class="pill${i === 1 ? ' on' : ''}" data-exp="${k}">${k.replace('d', ' day' + (k === '1d' ? '' : 's'))}</button>`).join('')}</div></div>
      <label class="chk osonly" ${optional.length ? '' : 'hidden'}><input type="checkbox" class="sroy"> Pay optional creator royalty (${optional.reduce((a, f) => a + f.bps, 0) / 100}%)</label>
      <div class="kv bkv sfees"></div>
      <p class="mut small snote"></p>
      <button class="bbtn go" disabled>List for sale</button>`;
    const $ = (s: string) => body.querySelector(s) as HTMLInputElement;
    let exp: keyof typeof EXPIRY = '7d';
    const active = () => market === 'multisea' ? nFees : oFees.filter(f => f.required || ($('.sroy')?.checked ?? false));
    const priceWei = () => { try { const v = $('.sprice').value.trim(); return v && +v > 0 ? parseUnits(v, 18) : 0n; } catch { return 0n; } };
    const label = (f: Fee) => f.kind === 'opensea' ? 'OpenSea fee' : f.kind === 'multisea' ? 'MultiSea fee' : 'Creator royalty';
    const render = () => {
      const p = priceWei(); const { seller, parts } = splitPrice(p, active());
      $('.sfees').innerHTML = `<span>Listing price</span><b>${fmt(p)} ${esc(c.native)}</b>` +
        parts.map(f => `<span>${label(f)} (${f.bps / 100}%)${f.required ? '' : ' · optional'}</span><b>−${fmt(f.amount)}</b>`).join('') +
        `<span>You receive</span><b>${fmt(seller > 0n ? seller : 0n)} ${esc(c.native)}</b>`;
      ($('.osonly') as any).hidden = market !== 'opensea' || !optional.length;
      $('.snote').textContent = market === 'multisea'
        ? `Listed on MultiSea via Seaport 1.6 (no zone, no conduit). First listing on ${c.name} needs a one-time Seaport approval (gas); the listing itself is a free signature.`
        : `Listed on OpenSea via Seaport 1.6. First listing on ${c.name} needs a one-time approval transaction (gas); the listing itself is a free signature.`;
      ($('.go') as any).disabled = !(p > 0n && seller > 0n);
    };
    body.addEventListener('input', render);
    body.querySelectorAll('[data-exp]').forEach(b => b.addEventListener('click', () => { body.querySelectorAll('[data-exp]').forEach(x => x.classList.remove('on')); b.classList.add('on'); exp = (b as HTMLElement).dataset.exp as any; }));
    body.querySelectorAll('[data-mk]').forEach(b => b.addEventListener('click', () => { if ((b as HTMLButtonElement).disabled) return; body.querySelectorAll('[data-mk]').forEach(x => x.classList.remove('on')); b.classList.add('on'); market = (b as HTMLElement).dataset.mk as any; render(); }));
    render();
    await Promise.race([new Promise<void>(res => $('.go').addEventListener('click', () => res())), closed(m)]);
    const price = priceWei(); const useFees = active();
    const step = (t: string) => { body.innerHTML = `<div class="spin"></div> ${t}`; };
    step(`Switching wallet to ${esc(c.name)}…`); await ensureChain(it.chain);
    const me = wallet.address as Hex; const pub = readClient(it.chain);
    const wc = createWalletClient({ chain: vchain(it.chain), transport: custom(wallet.provider) });
    step('Checking ownership…');
    const owner = await pub.readContract({ address: it.contract as Hex, abi: ERC721, functionName: 'ownerOf', args: [BigInt(it.id)] });
    if (owner.toLowerCase() !== me.toLowerCase()) throw Object.assign(new Error('This wallet no longer owns this NFT.'), { kind: 'stale' });
    const seaport = (market === 'multisea' ? nr.seaport : or.seaport) as Hex;
    const operator = (market === 'multisea' ? seaport : or.conduit) as Hex; // MultiSea: approve Seaport directly (no conduit)
    if (!(await pub.readContract({ address: it.contract as Hex, abi: ERC721, functionName: 'isApprovedForAll', args: [me, operator] }))) {
      step(market === 'multisea' ? 'Approve Seaport in your wallet (one-time per collection)…' : 'Approve OpenSea’s conduit in your wallet (one-time per collection)…');
      const h = await wc.writeContract({ account: me, address: it.contract as Hex, abi: ERC721, functionName: 'setApprovalForAll', args: [operator, true] });
      step(`Waiting for approval… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`);
      const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error('Approval transaction failed.');
    }
    const counter = await pub.readContract({ address: seaport, abi: SEAPORT, functionName: 'getCounter', args: [me] });
    const order = market === 'multisea'
      ? buildListing({ offerer: me, token: it.contract, id: it.id, priceWei: price, fees: useFees, conduitKey: ZERO32, counter, duration: EXPIRY[exp] })
      : buildListing({ offerer: me, token: it.contract, id: it.id, priceWei: price, fees: useFees, conduitKey: or.conduitKey, zone: or.zone, counter, duration: EXPIRY[exp] });
    step('Sign the listing in your wallet (free, no gas)…');
    const signature = await wc.signTypedData({ account: me, ...orderTypedData(c.chainId, seaport, order) });
    step(market === 'multisea' ? 'Saving your MultiSea listing…' : 'Submitting to OpenSea…');
    const pr = market === 'multisea'
      ? await fetch(`${API}/native/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: it.chain, parameters: order, signature }) })
      : await fetch(`${API}/sell/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: c.openseaSlug, protocolAddress: seaport, parameters: order, signature }) });
    const pj = await pr.json();
    if (!pr.ok) { console.error('[MultiSea] list rejected', pr.status, pj); throw Object.assign(new Error(pr.status === 503 || pr.status === 502 ? String(pj.error || 'Network busy, please try again.') : `${market === 'multisea' ? 'MultiSea' : 'OpenSea'}: ${String(pj.message || pj.error || 'listing rejected').split('\n')[0].slice(0, 160)}`), { kind: 'stale' }); }
    onListed();
    body.innerHTML = market === 'multisea'
      ? `<p class="ok">✓ Listed on MultiSea for ${fmt(price)} ${esc(c.native)}. It shows after a refresh.</p>`
      : `<p class="ok">✓ Listed for ${fmt(price)} ${esc(c.native)}. It shows on MultiSea after a refresh.</p><a class="bbtn" href="https://opensea.io/item/${c.openseaSlug}/${it.contract}/${it.id}" target="_blank" rel="noopener">View on OpenSea ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, it?.chain)); }
}

export async function cancelListing(it: SellItem, orderHash: string, onCancelled: () => void, source: 'opensea' | 'multisea' = 'opensea') {
  if (source === 'multisea') return cancelNative(it, orderHash, onCancelled);
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const m = head(it, 'Cancel listing'); const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const r = await fetch(`${API}/sell/order/${c.openseaSlug}/${orderHash}`); const o = await r.json();
    if (!r.ok) throw Object.assign(new Error('Listing not found on OpenSea (already sold, cancelled or expired?).'), { kind: 'stale' });
    const prm = o.parameters; const me = wallet.address as Hex;
    if (prm.offerer.toLowerCase() !== me.toLowerCase()) throw Object.assign(new Error('Only the seller can cancel this listing.'), { kind: 'stale' });
    const offchain = prm.zone.toLowerCase() === String(CFG.seaportZone).toLowerCase();
    body.innerHTML = `<p>${offchain ? 'This listing can be cancelled off-chain with a free signature.' : 'This listing must be cancelled on-chain through Seaport (costs gas).'}</p><button class="bbtn go">${offchain ? 'Sign to cancel' : 'Cancel on-chain'}</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    body.innerHTML = `<div class="spin"></div> Switching wallet to ${esc(c.name)}…`; await ensureChain(it.chain);
    const wc = createWalletClient({ chain: vchain(it.chain), transport: custom(wallet.provider) });
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    if (offchain) {
      const signature = await wc.signTypedData({ account: me, ...cancelTypedData(c.chainId, o.protocolAddress, orderHash) });
      const cr = await fetch(`${API}/sell/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: c.openseaSlug, protocolAddress: o.protocolAddress, orderHash, signature, contract: it.contract }) });
      const cj = await cr.json(); if (!cr.ok) throw Object.assign(new Error(`OpenSea: ${cj.message || cj.error}`), { kind: 'stale' });
    } else {
      const pub = readClient(it.chain);
      const comp = { ...prm, offer: prm.offer.map((x: any) => ({ ...x, identifierOrCriteria: BigInt(x.identifierOrCriteria), startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount) })), consideration: prm.consideration.map((x: any) => ({ ...x, identifierOrCriteria: BigInt(x.identifierOrCriteria), startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount) })), startTime: BigInt(prm.startTime), endTime: BigInt(prm.endTime), salt: BigInt(prm.salt), counter: BigInt(prm.counter) };
      delete comp.totalOriginalConsiderationItems;
      const h = await wc.writeContract({ account: me, address: o.protocolAddress, abi: SEAPORT, functionName: 'cancel', args: [[comp]] });
      body.innerHTML = `<div class="spin"></div> Pending… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
      const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error('Cancel transaction failed.');
    }
    onCancelled();
    body.innerHTML = `<p class="ok">✓ Listing cancelled. MultiSea updates after a refresh.</p>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, it?.chain)); }
}

// MultiSea native listing: cancel on-chain via Seaport, or remove from MultiSea only (order stays valid until expiry).
async function cancelNative(it: SellItem, orderHash: string, onCancelled: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const m = head(it, 'Cancel MultiSea listing'); const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    const r = await fetch(`${API}/native/order/${it.chain}/${orderHash}`); const o = await r.json();
    if (!r.ok) throw Object.assign(new Error(o.error || 'Listing not found (already sold, cancelled or expired?).'), { kind: 'stale' });
    const me = wallet.address as Hex; const prm = o.parameters;
    if (prm.offerer.toLowerCase() !== me.toLowerCase()) throw Object.assign(new Error('Only the seller can cancel this listing.'), { kind: 'stale' });
    body.innerHTML = `<p>Cancel on-chain to make the signed order permanently unusable (costs a little gas on ${esc(c.name)}).</p>
      <button class="bbtn go" data-how="chain">Cancel on-chain</button>
      <button class="bbtn ghost" data-how="off">Remove from MultiSea only (free)</button>
      <p class="mut small">“Remove only” hides it on MultiSea, but the signed order stays valid until it expires. To invalidate all your open orders on this chain at once, use “Cancel all” in My items.</p>`;
    const how = await Promise.race([new Promise<string>(res => body.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-how]') as HTMLElement; if (b) res(b.dataset.how!); })), closed(m)]);
    if (how === 'off') {
      body.innerHTML = '<div class="spin"></div> Sign in to prove you are the seller…';
      const { api } = await import('./auth'); await api('/native/remove', { auth: true, body: { chain: it.chain, orderHash } });
      onCancelled(); body.innerHTML = '<p class="ok">✓ Removed from MultiSea. The signed order is still valid on-chain until it expires.</p>'; return;
    }
    body.innerHTML = `<div class="spin"></div> Switching wallet to ${esc(c.name)}…`; await ensureChain(it.chain);
    const wc = createWalletClient({ chain: vchain(it.chain), transport: custom(wallet.provider) }); const pub = readClient(it.chain);
    const n = (x: any) => BigInt(x);
    const comp: any = { ...prm, offer: prm.offer.map((x: any) => ({ ...x, identifierOrCriteria: n(x.identifierOrCriteria), startAmount: n(x.startAmount), endAmount: n(x.endAmount) })), consideration: prm.consideration.map((x: any) => ({ ...x, identifierOrCriteria: n(x.identifierOrCriteria), startAmount: n(x.startAmount), endAmount: n(x.endAmount) })), startTime: n(prm.startTime), endTime: n(prm.endTime), salt: n(prm.salt), counter: n(prm.counter) };
    delete comp.totalOriginalConsiderationItems;
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    const h = await wc.writeContract({ account: me, address: o.protocolAddress, abi: SEAPORT, functionName: 'cancel', args: [[comp]] });
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error('Cancel transaction failed.');
    onCancelled(); body.innerHTML = '<div class="spin"></div> Cancelled on-chain. Removing from MultiSea…';
    const cr = await fetch(`${API}/native/cancelled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: it.chain, orderHash, txHash: h }) }).catch(() => null);
    body.innerHTML = cr?.ok ? '<p class="ok">✓ Listing cancelled on-chain and removed from MultiSea.</p>' : '<p class="ok">✓ Listing cancelled on-chain.</p><p class="mut small">MultiSea will drop it within 15 minutes.</p>';
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, it?.chain)); }
}

// Buy a MultiSea native listing: Seaport fulfillOrder from the buyer's wallet (or cross-chain via Relay).
export async function buyNative(it: SellItem, orderHash: string, onSold: (id: number) => void, onGone: (id: number) => void) {
  if (!wallet.address) { openConnect(); return; }
  const c = chains[it.chain]; const m = head(it, 'Buy on MultiSea'); const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    body.innerHTML = '<div class="spin"></div> Checking listing…';
    const r = await fetch(`${API}/native/order/${it.chain}/${orderHash}`); const o = await r.json();
    if (!r.ok) { onGone(it.id); throw Object.assign(new Error('This listing is no longer valid (sold, cancelled, transferred or expired).'), { kind: 'stale' }); }
    const me = wallet.address as Hex; const prm = o.parameters;
    const value: bigint = prm.consideration.reduce((s: bigint, x: any) => s + BigInt(x.startAmount), 0n);
    const fees: bigint = prm.consideration.slice(1).reduce((s: bigint, x: any) => s + BigInt(x.startAmount), 0n);
    const pub = readClient(it.chain);
    const bal = await pub.getBalance({ address: me }); const enough = bal >= value;
    body.innerHTML = `<div class="kv bkv"><span>Price</span><b>${fmt(value)} ${esc(c.native)}</b><span>Includes fees</span><b>${fmt(fees)} ${esc(c.native)}</b><span>Seller receives</span><b>${fmt(value - fees)} ${esc(c.native)}</b>
      <span>Chain</span><b><img class="cl" src="/logos/${it.chain}.svg" alt=""> ${esc(c.name)}</b><span>Your balance</span><b class="${enough ? '' : 'errc'}">${fmt(bal)} ${esc(c.native)}</b></div>
      ${enough ? '' : `<p class="err">Insufficient funds for this purchase on ${esc(c.name)}.</p><button class="bbtn ghost xpay">Pay with ETH from another chain</button>`}
      <p class="mut small">MultiSea listing, filled directly through Seaport 1.6 (fulfillOrder). You'll confirm in ${esc(wallet.name || 'your wallet')}.</p>
      <button class="bbtn go" ${enough ? '' : 'disabled'}>Confirm purchase</button>`;
    await Promise.race([new Promise<void>((res, rej) => {
      body.querySelector('.go')!.addEventListener('click', () => res());
      body.querySelector('.xpay')?.addEventListener('click', () => { m.remove(); import('./xpay').then(x => x.openXPay({ it, price: value, currency: c.native, tx: { value: value.toString() }, orders: [{ parameters: prm, signature: o.signature }], onSold, restart: () => buyNative(it, orderHash, onSold, onGone) })); rej(Object.assign(new Error('closed'), { kind: 'closed' })); });
    }), closed(m)]);
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…'; await ensureChain(it.chain);
    const wc = createWalletClient({ chain: vchain(it.chain), transport: custom(wallet.provider) });
    const { fulfillCalldata } = await import('./seaorder');
    const h = await wc.sendTransaction({ account: me, to: o.protocolAddress, value, data: fulfillCalldata(prm, o.signature) });
    const link = `${c.explorer}/tx/${h}`; body.innerHTML = `<div class="spin"></div> Pending… <a href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error('Transaction reverted. The listing may have been filled or cancelled.');
    onSold(it.id); body.innerHTML = `<p class="ok">✓ Purchased! ${esc(it.name)} is yours.</p><a class="bbtn" href="${link}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, it?.chain)); }
}

// "Cancel all my listings" on one chain: Seaport.incrementCounter invalidates every open Seaport order of this wallet on that chain
// (MultiSea and OpenSea alike); the Worker then purges MultiSea orders with the old counter right away.
export async function cancelAllNative(chain: string, count: number, onDone: () => void) {
  if (!wallet.address) { openConnect(); return; }
  const c = chains[chain]; const me = wallet.address as Hex;
  const m = overlay(`<div class="bhead"><div><div class="mut">${esc(c.name)} · Seaport</div><h3>Cancel all my listings</h3></div></div><div class="bbody"></div>`); const body = m.querySelector('.bbody') as HTMLElement;
  const fail = (msg: string) => { body.innerHTML = `<p class="err">${esc(msg)}</p><button class="bbtn ghost mx2">Close</button>`; body.querySelector('.mx2')!.addEventListener('click', () => m.remove()); };
  try {
    body.innerHTML = `<p>This cancels <b>every</b> open Seaport listing from your wallet on ${esc(c.name)} in one transaction (${count} on MultiSea${c.openseaSlug ? ', plus any on OpenSea' : ''}).</p>
      <p class="mut small">Calls Seaport incrementCounter(). Costs a little gas. Your NFTs stay in your wallet; you can list again afterwards.</p>
      <button class="bbtn go danger">Cancel all on ${esc(c.name)}</button>`;
    await Promise.race([new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res())), closed(m)]);
    body.innerHTML = `<div class="spin"></div> Switching wallet to ${esc(c.name)}…`; await ensureChain(chain);
    const wc = createWalletClient({ chain: vchain(chain), transport: custom(wallet.provider) }); const pub = readClient(chain);
    body.innerHTML = '<div class="spin"></div> Confirm in your wallet…';
    const h = await wc.writeContract({ account: me, address: CFG.seaport as Hex, abi: SEAPORT, functionName: 'incrementCounter' });
    body.innerHTML = `<div class="spin"></div> Pending… <a href="${c.explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
    const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 }); if (rc.status !== 'success') throw new Error('Transaction failed.');
    body.innerHTML = '<div class="spin"></div> Removing your listings from MultiSea…';
    const r = await fetch(`${API}/native/counter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain, seller: me, txHash: h }) }).catch(() => null);
    const j = r?.ok ? await r.json() : null; onDone();
    body.innerHTML = `<p class="ok">✓ All your Seaport listings on ${esc(c.name)} are cancelled${j ? ` (${j.removed} removed from MultiSea)` : ''}.</p>${j ? '' : '<p class="mut small">MultiSea will finish removing them within 15 minutes.</p>'}`;
  } catch (e: any) { if (e?.kind !== 'closed') fail(friendly(e, chain)); }
}
