// A public address wallet, not an ERC-6551 account: every send comes directly from the connected owner.
import { createWalletClient, custom, encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { renderSVG } from 'uqr';
import { wallet, onWallet, readClient, ensureChain, vchain, friendly, openConnect, openKeyExport, API } from './wallet';
import { chains, esc, short, logo } from './gx';
import { loadProfile, profileAvatar, profileName } from './names';
import { FW_CHAINS, chainBalances, chainUsd, NATIVE, TOKENS, fmtUsd, rateOf, parseFootName, footTba, type ChainBal, type FwChain } from './footkit';
import { usdRates, type UsdRates } from './shell';
import CFG from '../config/collections.json';
import { ownedNfts, insightOn, type OwnedNft } from './insight';
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)']);
const ERC721 = parseAbi(['function safeTransferFrom(address,address,uint256)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address,address,uint256,uint256,bytes)', 'function balanceOf(address,uint256) view returns (uint256)']);
type Nft = OwnedNft & { quantity?: string };
type Bal = { k: string; bal: ChainBal; usd: number | null };
type Asset = { key: string; k: string; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
type Tx = { to: Hex; value: bigint; data: Hex };
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const imageUrl = (s: string | null) => !s ? '' : s.startsWith('ipfs://') ? 'https://ipfs.filebase.io/ipfs/' + s.slice(7) : /^(https:\/\/|\/img\/|\/media\/)/.test(s) ? (s.startsWith('/media/') ? API + s : s) : '';
// MultiSea's own collections use the site's thumbnails (animated for Island's), whatever image the indexer returned.
const OWN = new Map(CFG.collections.flatMap(c => c.deployments.map(d => [d.chain + ':' + d.address.toLowerCase(), c] as const)));
const ownCol = (n: Nft) => { const c = OWN.get(n.chain + ':' + String(n.contract).toLowerCase()); const id = Number(n.id); return c && Number.isInteger(id) && id >= c.idStart && id <= c.idEnd ? { c, id } : null; };
const own = (n: Nft): Nft => { const x = ownCol(n); return x ? { ...n, image: `/img/${x.c.slug}/s/${x.id}.webp` } : n; };
const itemHref = (n: Nft) => { const x = ownCol(n); return x ? `/c/${x.c.slug}?item=${x.id}` : ''; };
const nftKey = (n: Nft) => `${n.chain}|${n.contract.toLowerCase()}|${n.id}`;
const nftCard = (n: Nft, me: boolean) => {
  const href = itemHref(n);
  const send = me && /^(erc721|erc1155)$/.test(n.standard || '') ? `<button type="button" class="obtn sm" data-send="${esc(nftKey(n))}">Send</button>` : '';
  const inner = `${imageUrl(n.image) ? `<img src="${esc(imageUrl(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chains[n.chain]?.name || n.chain)}${send}</div>`;
  return href ? `<a class="nftc" href="${esc(href)}">${inner}</a>` : `<div class="nftc">${inner}</div>`;
};
export function mountUserWallet(root: HTMLElement, address: Hex) {
  const allChains = [...FW_CHAINS, 'abstract'];
  const S = { balances: [] as Bal[], rates: null as UsdRates | null, nfts: null as Nft[] | null, note: '', cursors: {} as Record<string, string>, insightPage: {} as Record<string, number>, busy: false, receive: false };
  const isMe = () => !!wallet.address && wallet.address.toLowerCase() === address.toLowerCase();
  const assets = (): Asset[] => {
    const out: Asset[] = [];
    S.balances.forEach(c => {
      if (c.bal.native) out.push({ key: c.k + '|native', k: c.k, kind: 'native', label: chains[c.k].native, bal: c.bal.native, decimals: 18 });
      (TOKENS[c.k as FwChain] || []).forEach((t, i) => { const b = c.bal.tokens[i]; if (b) out.push({ key: c.k + '|' + t.address, k: c.k, kind: 'erc20', label: t.symbol, bal: b, decimals: t.decimals, token: t.address }); });
    });
    (S.nfts || []).filter(n => chains[n.chain] && /^(erc721|erc1155)$/.test(n.standard || '')).forEach(n => out.push({ key: nftKey(n), k: n.chain, kind: 'nft', label: n.name || '#' + n.id, bal: BigInt(n.quantity || '1'), decimals: 0, nft: n }));
    return out;
  };
  const merge = (list: Nft[]) => { S.nfts = [...new Map([...(S.nfts || []), ...list.map(own)].map(n => [nftKey(n), n])).values()]; };
  async function nfts() {
    const r = await fetch(`${API}/wallet/${address}/nfts`); if (!r.ok) throw Error(`NFT list unavailable (API ${r.status}).`);
    const j = await r.json(); S.nfts = (j.nfts || []).map(own); S.cursors = j.cursors || {}; S.insightPage = {};
    const failures = new Set<string>(j.failed || []), unsupported: string[] = [];
    await Promise.all((j.unsupported || []).map(async (k: string) => {
      if (!insightOn(k)) { unsupported.push(k); return; }
      try { const x = await ownedNfts(k, address); merge(x.nfts); if (x.more) S.insightPage[k] = 1; } catch { failures.add(k); }
    }));
    S.note = [...(j.notes || []), failures.size ? `Couldn't load all NFTs on ${[...failures].map(k => chains[k]?.name || k).join(', ')}; refresh to retry.` : '', unsupported.length ? `NFT indexing unavailable on ${unsupported.map(k => chains[k]?.name || k).join(', ')}.` : ''].filter(Boolean).join(' ');
  }
  async function load() {
    if (S.busy) return; S.busy = true; draw();
    const nftTask = nfts().catch(e => { S.note = friendly(e); }).then(draw);
    const rates = await usdRates().catch(() => ({ ETH: null, APE: null, BNB: null } as UsdRates)); S.rates = rates;
    S.balances = await Promise.all(allChains.map(async k => {
      const bal: ChainBal = k === 'abstract' ? await readClient(k).getBalance({ address }).then((native: bigint) => ({ native, tokens: [], ok: true })).catch(() => ({ native: null, tokens: [], ok: false })) : (await chainBalances(k as FwChain, [address]))[0];
      const usd = k === 'abstract' ? !bal.ok || (bal.native && rates.ETH == null) ? null : Number(formatUnits(bal.native || 0n, 18)) * (rates.ETH || 0) : chainUsd(k as FwChain, bal, rates);
      // A missing token balance is a partial chain read, never a misleading zero.
      const missingPrice = k !== 'abstract' && (TOKENS[k as FwChain] || []).some((t, i) => bal.tokens[i] && t.px !== 'USD' && rates[t.px] == null);
      return { k, bal, usd: missingPrice || bal.tokens.some(v => v == null) ? null : usd };
    }));
    await nftTask; S.busy = false; draw();
  }
  function draw() {
    const me = isMe(), name = profileName(address) || short(address), avatar = imageUrl(profileAvatar(address) || null);
    const total = S.balances.length && S.balances.every(c => c.usd != null) ? S.balances.reduce((n, c) => n + c.usd!, 0) : null;
    root.innerHTML = `<div class="fw uw"><section class="fwcard fwid glow"><div class="fwtop"><div class="fwnftw">${avatar ? `<img class="fwnft" src="${esc(avatar)}" alt="Profile picture">` : `<div class="fwnft uwletter">${esc(name[0].toUpperCase())}</div>`}</div><div style="min-width:0"><span class="fwtag">MultiSea profile</span><h1>${esc(name)}</h1></div></div>
      <div class="fwaddr"><span class="mono fwfull">${address}</span><button class="fwcopy" data-uw="copy" aria-label="Copy address">⧉</button></div>
      <div class="fwacts">${me ? '<button class="fwbtn pri" data-uw="send">↗ Send</button>' : ''}<button class="fwbtn on" data-uw="receive">↙ Receive</button>${me ? `<a class="fwbtn" href="/me/profile">Edit profile</a><a class="fwbtn" href="/me">My activity</a><button class="fwbtn" data-uw="copy">Copy address</button>${wallet.provider?.isMultiSeaEmbedded ? '<button class="fwbtn" data-uw="export">🔑 Export private key</button>' : ''}` : ''}</div>
      ${!me ? `<div class="fwnote">View only.${!wallet.address ? ' <button class="lnk" data-uw="connect">Connect</button> your wallet to send from your own profile.' : ' Only the connected owner can send.'}</div>` : ''}
      ${S.receive ? `<div class="fwrecv"><div class="fwqr">${renderSVG(address, { border: 1, ecc: 'M' })}</div><div><h4>Receive NFTs and crypto</h4><div class="hint">Use this address on the supported chain. Transfers stay on the chain used by the sender.</div></div></div>` : ''}
      <p class="small"><a href="/me?as=${address}">NFT activity across chains →</a></p></section>
      <div class="fwright"><section class="fwcard fwtotal"><h3>Total value</h3><div class="v silver">${S.balances.length ? fmtUsd(total) : '…'}</div><div class="mut small">6 chains · coins and tokens priced live · NFTs not priced${S.balances.some(c => c.usd == null) ? ' · total unavailable: incomplete balances or prices' : ''}</div></section>
      <section class="fwcard fwsec"><div class="sechd"><h3>Balances by chain</h3></div><div class="fwgrid">${allChains.map(k => {
        const c = S.balances.find(c => c.k === k); const rows: string[] = [];
        if (c?.bal.native) rows.push(`<div class="fwtok"><b>${fmt(c.bal.native)} ${esc(chains[k].native)}</b></div>`);
        (TOKENS[k as FwChain] || []).forEach((t, i) => { const v = c?.bal.tokens[i]; if (v) rows.push(`<div class="fwtok"><b>${fmt(v, t.decimals)} ${esc(t.symbol)}</b></div>`); });
        return `<div class="fwch" data-chain="${k}"><div class="chh"><span class="chn">${logo(k)}${esc(chains[k].name)}</span><span class="chv">${c ? fmtUsd(c.usd) : '…'}</span></div>${rows.join('') || `<div class="mut small">${!c ? 'Loading…' : !c.bal.ok ? 'Couldn’t read this chain' : 'Empty'}</div>`}${c && c.bal.tokens.some(v => v == null) ? '<div class="mut small">Some token balances unavailable</div>' : ''}${k === 'abstract' ? '<div class="mut small">Native coin only</div>' : ''}</div>`;
      }).join('')}</div></section>
      <section class="fwcard fwsec"><div class="sechd"><h3>NFTs${S.nfts ? ' · ' + S.nfts.length : ''}</h3><button class="fwrbtn" data-uw="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Refresh'}</button></div>
      ${S.nfts?.length ? `<div class="fwnftg">${S.nfts.map(n => nftCard(n, me)).join('')}</div>` : `<p class="mut small">${S.nfts == null ? S.busy ? 'Loading NFTs…' : 'NFT list unavailable.' : 'No NFTs found.'}</p>`}
      ${Object.keys(S.cursors).map(k => `<button class="obtn sm" data-more="${k}">More on ${esc(chains[k].name)}</button>`).join('')}${Object.keys(S.insightPage).map(k => `<button class="obtn sm" data-insight="${k}">More on ${esc(chains[k].name)}</button>`).join('')}
      ${S.note ? `<p class="mut small">${esc(S.note)}</p>` : ''}</section></div></div>`;
  }
  async function resolveRecipient(raw: string): Promise<Hex> {
    const s = raw.trim(); if (isAddress(s)) return getAddress(s);
    const id = parseFootName(s); if (id) return footTba(id);
    if (s.toLowerCase().endsWith('.eth')) { const a = await readClient('ethereum').getEnsAddress({ name: normalize(s) }); if (a) return a; throw Error('ENS name has no address.'); }
    throw Error('Enter a 0x address, .eth name or LIL FOOT name.');
  }
  function txFor(a: Asset, to: Hex, amount: bigint): Tx {
    if (a.kind === 'native') return { to, value: amount, data: '0x' };
    if (a.kind === 'erc20') return { to: a.token!, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }) };
    const n = a.nft!;
    return { to: n.contract as Hex, value: 0n, data: n.standard === 'erc1155' ? encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [address, to, BigInt(n.id), amount, '0x'] }) : encodeFunctionData({ abi: ERC721, functionName: 'safeTransferFrom', args: [address, to, BigInt(n.id)] }) };
  }
  function openSend(pre?: string) {
    if (!isMe() || document.querySelector('.uwsend')) return;
    const screen = document.createElement('section');
    screen.className = 'uwsend'; screen.setAttribute('role', 'dialog'); screen.setAttribute('aria-modal', 'true'); screen.setAttribute('aria-labelledby', 'uwsend-title');
    screen.innerHTML = `<header class="uwsend-head"><button class="uwsend-back" aria-label="Back">←</button><h1 id="uwsend-title">Send</h1></header><main class="uwsend-body"></main>`;
    const back = screen.querySelector('button')!, body = screen.querySelector('main')!;
    const prev = document.activeElement as HTMLElement | null, scrollY = window.scrollY;
    const savedBody = document.body.style.cssText, savedOverflow = document.documentElement.style.overflow;
    document.body.style.position = 'fixed'; document.body.style.top = `-${scrollY}px`; document.body.style.width = '100%'; document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(screen);
    let inStep = false, busySending = false, disposeStep = () => {};
    const close = () => { disposeStep(); screen.remove(); document.removeEventListener('keydown', keys); document.body.style.cssText = savedBody; document.documentElement.style.overflow = savedOverflow; window.scrollTo(0, scrollY); prev?.focus({ preventScroll: true }); };
    const goBack = () => { if (busySending) return; if (inStep) showList(); else close(); };
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      if (e.key === 'Tab') {
        const focusable = [...screen.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keys); back.addEventListener('click', goBack);
    const icon = (a: Asset) => a.kind === 'nft' ? `<span class="uwsend-icon">${imageUrl(a.nft!.image) ? `<img class="uwsend-thumb" src="${esc(imageUrl(a.nft!.image))}" alt="">` : '<span>NFT</span>'}${logo(a.k, 'uwsend-badge')}</span>` : `<span class="uwsend-icon">${a.label === 'ETH' || a.label === 'WETH' ? logo('ethereum', 'uwsend-coin') : a.label === 'APE' || a.label === 'WAPE' ? logo('apechain', 'uwsend-coin') : a.label === 'BNB' ? logo('bnb', 'uwsend-coin') : `<span class="uwsend-symbol">${esc(a.label.slice(0, 4))}</span>`}${logo(a.k, 'uwsend-badge')}</span>`;
    const assetUsd = (a: Asset) => {
      if (!S.rates || a.kind === 'nft') return null;
      const px = a.kind === 'native' ? NATIVE[a.k as FwChain]?.px || 'ETH' : TOKENS[a.k as FwChain]?.find(t => t.address === a.token)?.px;
      const rate = px ? rateOf(px, S.rates) : null;
      return rate == null ? null : Number(formatUnits(a.bal, a.decimals)) * rate;
    };
    function showList() {
      disposeStep(); inStep = false; back.setAttribute('aria-label', 'Close Send');
      const list = assets(), tokens = list.filter(a => a.kind !== 'nft' && a.bal > 0n);
      // Same NFT collection as the profile, including any unsupported transfer standards (shown but disabled).
      const nfts = S.nfts || [];
      body.innerHTML = `<div class="uwsend-content"><h2>Tokens</h2><div class="uwsend-tokens">${tokens.map(a => `<button class="uwsend-token" data-pick="${esc(a.key)}">${icon(a)}<span class="uwsend-label"><b>${esc(a.label)}</b><small>${esc(chains[a.k].name)}</small></span><span class="uwsend-value"><b>${fmt(a.bal, a.decimals)}</b><small>${fmtUsd(assetUsd(a))}</small></span><span class="uwsend-chevron">›</span></button>`).join('') || '<p class="mut">No token balances.</p>'}</div><h2 class="uwsend-nfttitle">NFTs</h2><div class="uwsend-nfts">${nfts.map(n => `<button class="uwsend-nft" data-pick="${esc(nftKey(n))}" ${list.some(a => a.key === nftKey(n)) ? '' : 'disabled title="Transfer standard unavailable"'}><span class="uwsend-art">${imageUrl(n.image) ? `<img src="${esc(imageUrl(n.image))}" alt="" loading="lazy">` : '<span class="uwmissing">NFT</span>'}${logo(n.chain, 'uwsend-badge')}</span><b>${esc(n.name || '#' + n.id)}</b><small>${esc(chains[n.chain]?.name || n.chain)}</small></button>`).join('')}</div>${!nfts.length ? '<p class="mut">No NFTs found.</p>' : ''}${S.note ? `<p class="uwsend-note">${esc(S.note)}</p>` : ''}</div>`;
      body.scrollTop = 0;
      body.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach(b => b.addEventListener('click', () => { const a = list.find(a => a.key === b.dataset.pick); if (a) showStep(a); }));
      back.focus();
    }
    function showStep(a: Asset) {
      disposeStep(); inStep = true; back.setAttribute('aria-label', 'Back to assets');
      const single = a.kind === 'nft' && a.nft?.standard === 'erc721';
      body.innerHTML = `<div class="uwsend-content uwsend-step fwsend"><div class="uwsend-selected">${icon(a)}<div><b>${esc(a.label)}</b><small>${esc(chains[a.k].name)}</small></div><span class="uwsend-value"><b>${a.kind === 'nft' ? 'NFT' : fmt(a.bal, a.decimals)}</b>${a.kind !== 'nft' ? `<small>${fmtUsd(assetUsd(a))}</small>` : ''}</span></div><p class="uwsend-note">Direct transfer on ${esc(chains[a.k].name)}. You pay normal gas. No bridging.</p><div data-amount ${single ? 'hidden' : ''}><label class="lbl" for="uwamt">Amount <span data-k="balance"></span></label><div class="fld"><input id="uwamt" data-k="amount" placeholder="0.0" inputmode="decimal" autocomplete="off"><button type="button" class="uwsend-max" data-k="max">Max</button></div></div><label class="lbl" for="uwto">Recipient</label><div class="fld"><input id="uwto" data-k="to" placeholder="0x…, name.eth, LIL FOOT #N" autocomplete="off" spellcheck="false"></div><div class="fwsum" data-k="summary" aria-live="polite">Enter an amount and recipient to estimate gas.</div><button class="bbtn" data-k="go" disabled>Send</button><div class="fwmsg" data-k="msg" role="status"></div></div>`;
      body.scrollTop = 0;
      const m = body.querySelector<HTMLElement>('.uwsend-step')!;
      const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
      let seq = 0, sending = false, sent = false;
      let quote: { a: Asset; tx: Tx; gas: bigint; price: bigint; fingerprint: string } | null = null;
      const fingerprint = () => [a.key, q('amount').value, q('to').value].join('|');
      const update = async () => {
        if (sending || sent || !m.isConnected) return;
        const my = ++seq; quote = null; q('go').disabled = true;
        const single = a.kind === 'nft' && a.nft?.standard === 'erc721';
        (m.querySelector('[data-amount]') as HTMLElement).hidden = single;
        q('balance').textContent = a.kind === 'nft' && !single ? 'ERC-1155' : `Balance ${fmt(a.bal, a.decimals)}`;
        if (!q('to').value.trim()) { q('summary').textContent = 'Enter a recipient to estimate gas.'; return; }
        const fp = fingerprint(); q('summary').textContent = 'Estimating gas…';
        try {
          if (!isMe()) throw Error('Connect the profile owner wallet.');
          if (!single && !/^\d+(?:\.\d+)?$/.test(q('amount').value.trim())) throw Error('Enter a positive amount.');
          const amount = single ? 1n : parseUnits(q('amount').value.trim(), a.decimals);
          if (!single && (q('amount').value.split('.')[1]?.length || 0) > a.decimals) throw Error('Too many decimal places.');
          const to = await resolveRecipient(q('to').value);
          if (/^0x0{40}$/i.test(to) || to.toLowerCase() === address.toLowerCase()) throw Error('Enter a different, nonzero recipient.');
          const pc = readClient(a.k);
          const balance = a.nft?.standard === 'erc1155' ? await pc.readContract({ address: a.nft.contract as Hex, abi: ERC1155, functionName: 'balanceOf', args: [address, BigInt(a.nft.id)] }) as bigint : a.bal;
          if (amount <= 0n || amount > balance) throw Error('Amount exceeds balance or is zero.');
          const tx = txFor(a, to, amount);
          const [estimate, price, native] = await Promise.all([pc.estimateGas({ account: address, ...tx }), pc.getGasPrice(), pc.getBalance({ address })]);
          const gas = estimate * 120n / 100n;
          if (tx.value + gas * price > native) throw Error('Insufficient funds for amount + gas on this chain.');
          if (my !== seq || fp !== fingerprint() || !m.isConnected) return;
          quote = { a, tx, gas, price, fingerprint: fp };
          q('summary').innerHTML = `<div><span>Direct on</span><b>${esc(chains[a.k].name)}</b></div><div><span>Recipient</span><b class="mono" style="overflow-wrap:anywhere">${to}</b></div><div><span>Amount</span><b>${fmt(amount, a.decimals)} ${esc(a.label)}</b></div><div><span>Estimated gas</span><b>~${fmt(gas * price)} ${esc(chains[a.k].native)}</b></div>`;
          q('go').disabled = false;
        } catch (e) { if (my === seq) q('summary').innerHTML = `<span class="err">${esc(friendly(e, a.k))}</span>`; }
      };
      let timer: ReturnType<typeof setTimeout>;
      const changed = () => { if (sending || sent || !m.isConnected) return; ++seq; quote = null; q('go').disabled = true; clearTimeout(timer); timer = setTimeout(update, 400); };
      m.addEventListener('input', changed);
      disposeStep = () => { ++seq; clearTimeout(timer); };
      q('max').addEventListener('click', async () => {
        if (sending || sent) return;
        const my = ++seq; quote = null; q('go').disabled = true; q('max').disabled = true; clearTimeout(timer);
        try {
          const pc = readClient(a.k); let balance = a.bal;
          if (a.kind === 'native') {
            const to = await resolveRecipient(q('to').value);
            if (/^0x0{40}$/i.test(to) || to.toLowerCase() === address.toLowerCase()) throw Error('Enter a different, nonzero recipient.');
            const [native, estimate, price] = await Promise.all([pc.getBalance({ address }), pc.estimateGas({ account: address, to, value: 1n }), pc.getGasPrice()]);
            // Reserve buffered gas rather than offering the entire native balance.
            const reserve = estimate * 150n / 100n * price; balance = native > reserve ? native - reserve : 0n;
            if (!balance) throw Error('Not enough native coin to cover gas.');
          } else if (a.nft?.standard === 'erc1155') balance = await pc.readContract({ address: a.nft.contract as Hex, abi: ERC1155, functionName: 'balanceOf', args: [address, BigInt(a.nft.id)] }) as bigint;
          if (my !== seq || !m.isConnected) return;
          q('amount').value = formatUnits(balance, a.decimals); await update();
        } catch (e) { if (my === seq && m.isConnected) q('summary').innerHTML = `<span class="err">${esc(friendly(e, a.k))}</span>`; }
        finally { if (m.isConnected) q('max').disabled = false; }
      });
      q('go').addEventListener('click', async () => {
        if (sending || sent || !quote || quote.fingerprint !== fingerprint()) return;
        const plan = quote; sending = true; busySending = true; back.disabled = true; q('go').disabled = true; ++seq;
        q('max').disabled = true;
        m.querySelectorAll('input,select').forEach(e => (e as HTMLInputElement).disabled = true);
        let hash: Hex | null = null;
        try {
          if (!isMe()) throw Error('Connect the profile owner wallet.');
          await ensureChain(plan.a.k); if (!isMe()) throw Error('Wallet changed. Reconnect the profile owner.');
          q('msg').textContent = 'Confirm the transfer in your wallet…';
          hash = await createWalletClient({ chain: vchain(plan.a.k), transport: custom(wallet.provider) }).sendTransaction({ account: address, chain: vchain(plan.a.k), ...plan.tx, gas: plan.gas });
          sent = true;
          const link = `<a href="${chains[plan.a.k].explorer}/tx/${hash}" target="_blank" rel="noopener">View transaction ↗</a>`;
          q('msg').innerHTML = `Submitted. ${link}`;
          const receipt = await readClient(plan.a.k).waitForTransactionReceipt({ hash, timeout: 120000 });
          q('msg').innerHTML = `${receipt.status === 'success' ? '✓ Sent.' : 'Transaction reverted.'} ${link}`;
          load();
        } catch (e) {
          q('msg').innerHTML = `<span class="err">${esc(friendly(e, plan.a.k))}</span>${hash ? ` <a href="${chains[plan.a.k].explorer}/tx/${hash}" target="_blank" rel="noopener">View submitted transaction ↗</a>` : ''}`;
        } finally {
          sending = false; busySending = false; back.disabled = false;
          if (!sent) { q('max').disabled = false; m.querySelectorAll('input,select').forEach(e => (e as HTMLInputElement).disabled = false); update(); }
        }
      });
      update(); back.focus();
    }
    const selected = pre && assets().find(a => a.key === pre);
    if (selected) showStep(selected); else showList();
  }
  root.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-uw],[data-send],[data-more],[data-insight]'); if (!b || b.hasAttribute('disabled')) return;
    const action = b.dataset.uw;
    if (action === 'copy') navigator.clipboard?.writeText(address).then(() => { b.textContent = b.classList.contains('fwcopy') ? '✓' : 'Copied ✓'; }).catch(() => {});
    if (action === 'receive') { S.receive = !S.receive; draw(); }
    if (action === 'connect') openConnect();
    if (action === 'export' && isMe() && wallet.provider?.isMultiSeaEmbedded) openKeyExport();
    if (action === 'send' || b.dataset.send) { e.preventDefault(); openSend(b.dataset.send); }
    if (action === 'refresh') load();
    const k = b.dataset.more || b.dataset.insight;
    if (k) { b.setAttribute('disabled', ''); try {
      if (b.dataset.more) {
        const r = await fetch(`${API}/wallet/${address}/nfts?chain=${k}&next=${encodeURIComponent(S.cursors[k])}`); if (!r.ok) throw Error('NFT page unavailable');
        const j = await r.json(); if (j.failed?.length) throw Error('NFT page unavailable'); merge(j.nfts || []); delete S.cursors[k]; Object.assign(S.cursors, j.cursors || {});
      } else { const j = await ownedNfts(k, address, S.insightPage[k]); merge(j.nfts); if (j.more) S.insightPage[k]++; else delete S.insightPage[k]; }
    } catch (e) { S.note = `Couldn't load more NFTs on ${chains[k].name}: ${friendly(e)}`; } draw(); }
  });
  onWallet(() => draw()); loadProfile(address).then(draw); draw(); load();
}
