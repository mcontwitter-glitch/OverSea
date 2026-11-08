// A public address wallet, not an ERC-6551 account: every send comes directly from the connected owner.
import { createWalletClient, custom, encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { renderSVG } from 'uqr';
import { wallet, onWallet, readClient, ensureChain, vchain, friendly, openConnect, overlay, API } from './wallet';
import { chains, esc, short, logo } from './gx';
import { loadProfile, profileAvatar, profileName } from './names';
import { FW_CHAINS, chainBalances, chainUsd, NATIVE, TOKENS, fmtUsd, parseFootName, footTba, type ChainBal, type FwChain } from './footkit';
import { usdRates, type UsdRates } from './shell';
import { ownedNfts, insightOn, type OwnedNft } from './insight';
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)']);
const ERC721 = parseAbi(['function safeTransferFrom(address,address,uint256)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address,address,uint256,uint256,bytes)', 'function balanceOf(address,uint256) view returns (uint256)']);
type Nft = OwnedNft & { quantity?: string };
type Bal = { k: string; bal: ChainBal; usd: number | null };
type Asset = { key: string; k: string; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
type Tx = { to: Hex; value: bigint; data: Hex };
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const imageUrl = (s: string | null) => !s ? '' : s.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + s.slice(7) : /^(https:\/\/|\/img\/|\/media\/)/.test(s) ? (s.startsWith('/media/') ? API + s : s) : '';
const nftKey = (n: Nft) => `${n.chain}|${n.contract.toLowerCase()}|${n.id}`;
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
  const merge = (list: Nft[]) => { S.nfts = [...new Map([...(S.nfts || []), ...list].map(n => [nftKey(n), n])).values()]; };
  async function nfts() {
    const r = await fetch(`${API}/wallet/${address}/nfts`); if (!r.ok) throw Error(`NFT list unavailable (API ${r.status}).`);
    const j = await r.json(); S.nfts = j.nfts || []; S.cursors = j.cursors || {}; S.insightPage = {};
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
      <div class="fwacts">${me ? '<button class="fwbtn pri" data-uw="send">↗ Send</button>' : ''}<button class="fwbtn on" data-uw="receive">↙ Receive</button>${me ? '<a class="fwbtn" href="/me/profile">Edit profile</a>' : ''}</div>
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
      ${S.nfts?.length ? `<div class="fwnftg">${S.nfts.map(n => `<div class="nftc" data-nft-chain="${esc(n.chain)}">${imageUrl(n.image) ? `<img src="${esc(imageUrl(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chains[n.chain]?.name || n.chain)}${me && /^(erc721|erc1155)$/.test(n.standard || '') ? `<button class="obtn sm" data-send="${esc(nftKey(n))}">Send</button>` : ''}</div></div>`).join('')}</div>` : `<p class="mut small">${S.nfts == null ? S.busy ? 'Loading NFTs…' : 'NFT list unavailable.' : 'No NFTs found.'}</p>`}
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
    if (!isMe()) return;
    const list = assets();
    const m = overlay(`<div class="fwsend"><h2>Send from your wallet</h2><p class="mut small">Direct transfer on the selected chain. You pay normal gas. No bridging.</p><label class="lbl" for="uwasset">Asset</label><select id="uwasset" class="fld" data-k="asset">${list.length ? list.map(a => `<option value="${esc(a.key)}" ${a.key === pre ? 'selected' : ''}>${esc(chains[a.k].name)} · ${esc(a.label)}</option>`).join('') : '<option value="">No assets available</option>'}</select><div data-amount><label class="lbl" for="uwamt">Amount <span data-k="balance"></span></label><div class="fld"><input id="uwamt" data-k="amount" placeholder="0.0" inputmode="decimal"></div></div><label class="lbl" for="uwto">Recipient</label><div class="fld"><input id="uwto" data-k="to" placeholder="0x…, name.eth, or LIL FOOT #1204" autocomplete="off"></div><div class="fwsum" data-k="summary">Choose an asset, amount and recipient to estimate gas.</div><button class="bbtn" data-k="go" disabled>Review and send</button><div class="fwmsg" data-k="msg"></div></div>`);
    const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
    let seq = 0, sending = false, sent = false;
    let quote: { a: Asset; tx: Tx; gas: bigint; price: bigint; fingerprint: string } | null = null;
    const fingerprint = () => [q('asset').value, q('amount').value, q('to').value].join('|');
    const update = async () => {
      if (sending || sent) return;
      const my = ++seq; quote = null; q('go').disabled = true;
      const a = list.find(a => a.key === q('asset').value); if (!a) return;
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
    const changed = () => { if (sending || sent) return; ++seq; quote = null; q('go').disabled = true; clearTimeout(timer); timer = setTimeout(update, 400); };
    m.addEventListener('input', changed); m.addEventListener('change', () => { (m.querySelector('[data-amount]') as HTMLElement).hidden = list.find(a => a.key === q('asset').value)?.nft?.standard === 'erc721'; changed(); });
    q('go').addEventListener('click', async () => {
      if (sending || sent || !quote || quote.fingerprint !== fingerprint()) return;
      const plan = quote; sending = true; q('go').disabled = true; ++seq;
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
        sending = false;
        if (!sent) { m.querySelectorAll('input,select').forEach(e => (e as HTMLInputElement).disabled = false); update(); }
      }
    });
    update();
  }
  root.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-uw],[data-send],[data-more],[data-insight]'); if (!b || b.hasAttribute('disabled')) return;
    const action = b.dataset.uw;
    if (action === 'copy') navigator.clipboard?.writeText(address).then(() => { b.textContent = '✓'; }).catch(() => {});
    if (action === 'receive') { S.receive = !S.receive; draw(); }
    if (action === 'connect') openConnect();
    if (action === 'send' || b.dataset.send) openSend(b.dataset.send);
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
