// /w/multi-islands/<id>?chain=<k>: an Island's token wallet (ERC-6551, Tokenbound V3, salt 0). Each chain has its own
// account address (bound to that chain's drop contract). Balances via RPC multicall, NFTs via the Worker. The Island's
// holder can send from the wallet on the chain where the Island is right now (account.execute, signed in their wallet);
// on chains where the Island sits in the bridge escrow the wallet is receive-only.
import { createWalletClient, custom, encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Hex } from 'viem';
import { renderSVG } from 'uqr';
import CFG from '../config/collections.json';
import { wallet, onWallet, readClient, ensureChain, vchain, friendly, openConnect, overlay, API } from './wallet';
import { usdRates, type UsdRates } from './shell';
import { frame, chains, esc, short, logo } from './gx';
import { MC3, NATIVE, chainBalances, chainUsd, fmtUsd, rateOf, footTba, footName, parseFootName, type ChainBal, type FwChain } from './footkit';
import { ISLAND_CHAINS, ISLAND_ADDR, ISLAND_MAX, ISLAND_TOKENS, IMPL_SLOT, islandTba, islandName, islandWalletUrl, parseIslandName, chainIdOf, TB } from './islandkit';

type Nft = { chain: string; contract: string; id: string; name?: string | null; image?: string | null; collection?: string; standard?: string | null };
type Ch = { k: FwChain; tba: Hex; deployed: boolean | null; ready: boolean | null; owner: string | null; escrow: boolean; bal: ChainBal | null; usd: number | null };
type Call = { to: Hex; value: bigint; data: Hex };
const ERC721 = parseAbi(['function ownerOf(uint256) view returns (address)', 'function safeTransferFrom(address from, address to, uint256 tokenId)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)']);
const ERC20T = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const ACC = parseAbi(['function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)', 'function initialize(address implementation)']);
const REG = parseAbi(['function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)']);
const MC3A = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const ESC = new Set((CFG.collections.find(c => c.slug === 'multi-islands')!.escrow || []).map(e => `${e.chain}:${e.address.toLowerCase()}`));
const id = +location.pathname.split('/')[3];
const page = frame('', `${islandName(id)} wallet`, 'fwpage');
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const img = (s?: string | null) => !s ? '' : s.startsWith('ipfs://') ? 'https://ipfs.filebase.io/ipfs/' + s.slice(7) : /^(https:\/\/|\/img\/)/.test(s) ? s : s.startsWith('/media/') ? API + s : '';
const pad = (v: bigint, pct = 20n) => v + (v * pct) / 100n;
const SEND_IC = '<svg class="fi" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>';
let sel = (new URLSearchParams(location.search).get('chain') || '') as FwChain;
if (!ISLAND_CHAINS.includes(sel)) sel = 'base';
const S = { cs: ISLAND_CHAINS.map(k => ({ k, tba: islandTba(k, id), deployed: null, ready: null, owner: null, escrow: false, bal: null, usd: null } as Ch)), nfts: null as Nft[] | null, note: '', busy: false, rates: null as UsdRates | null };

// The chain where the Island is held by a person (not a bridge escrow). Only that holder controls that chain's wallet.
const liveCh = () => S.cs.find(x => x.owner && !x.escrow) || null;
const isOwner = () => { const l = liveCh(); return !!(l && wallet.address && wallet.address.toLowerCase() === l.owner!.toLowerCase()); };

async function load() {
  if (S.busy) return; S.busy = true; draw();
  const nft = Promise.all(S.cs.map(async c => {
    const r = await fetch(`${API}/wallet/${c.tba}/nfts?chain=${c.k}`); if (!r.ok) throw Error(chains[c.k].name);
    const j = await r.json(); if (j.failed?.length) throw Error(chains[c.k].name); return (j.nfts || []) as Nft[];
  }).map(p => p.catch((e: Error) => { S.note = `Couldn't load NFTs on ${e.message}; refresh to retry.`; return [] as Nft[]; }))).then(l => { S.nfts = l.flat(); draw(); });
  const rates = S.rates = await usdRates().catch(() => ({ ETH: null, APE: null, BNB: null } as UsdRates));
  await Promise.all(S.cs.map(async c => {
    const pc = readClient(c.k);
    const [code, slot, owner, bal] = await Promise.all([
      pc.getCode({ address: c.tba }).then((x: Hex | undefined) => !!x && x !== '0x').catch(() => null),
      pc.getStorageAt({ address: c.tba, slot: IMPL_SLOT }).then((x: Hex | undefined) => !!x && BigInt(x) !== 0n).catch(() => null),
      pc.readContract({ address: ISLAND_ADDR[c.k], abi: ERC721, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null) as Promise<string | null>,
      chainBalances(c.k, [c.tba], ISLAND_TOKENS[c.k]).then(r => r[0]),
    ]);
    const missing = ISLAND_TOKENS[c.k].some((t, i) => bal.tokens[i] && t.px !== 'USD' && rateOf(t.px, rates) == null);
    Object.assign(c, { deployed: code, ready: code === false ? false : slot, owner, escrow: !!owner && ESC.has(`${c.k}:${owner.toLowerCase()}`), bal, usd: missing || bal.tokens.some(v => v == null) ? null : chainUsd(c.k, bal, rates, ISLAND_TOKENS[c.k]) });
    draw();
  }));
  await nft; S.busy = false; draw();
}

function balRows(x: Ch) {
  const rows: string[] = []; const r = S.rates; const usd = (v: bigint, d: number, px: any) => { const u = r ? rateOf(px, r) : null; return u != null ? fmtUsd(+formatUnits(v, d) * u) : ''; };
  if (x.bal?.native) rows.push(`<div class="fwtok"><b>${fmt(x.bal.native)} ${esc(NATIVE[x.k].symbol)}</b><span class="mut mono">${usd(x.bal.native, 18, NATIVE[x.k].px)}</span></div>`);
  ISLAND_TOKENS[x.k].forEach((t, i) => { const v = x.bal?.tokens[i]; if (v) rows.push(`<div class="fwtok"><b>${fmt(v, t.decimals)} ${esc(t.symbol)}</b><span class="mut mono">${usd(v, t.decimals, t.px)}</span></div>`); });
  return rows.join('');
}

function draw() {
  if (!(Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX)) { page.innerHTML = `<div class="fwcard fwsec"><h3>Not an Island</h3><p class="mut">Island's token IDs run from 1 to ${ISLAND_MAX}.</p></div>`; return; }
  const c = S.cs.find(x => x.k === sel)!, ex = chains[c.k].explorer;
  const total = S.cs.every(x => x.usd != null) ? S.cs.reduce((n, x) => n + x.usd!, 0) : null;
  const here = liveCh(); const me = isOwner(); const canSend = me && here?.k === c.k;
  const status = c.owner == null ? '…' : c.escrow ? `The Island isn't on ${esc(chains[c.k].name)} right now (held by the bridge escrow), so this wallet is receive-only. Bridge the Island to ${esc(chains[c.k].name)} to send from this wallet. <a href="/bridge">Bridge →</a>` : `Controlled by the holder of ${islandName(id)} on ${esc(chains[c.k].name)}: <a href="/u/${esc(c.owner)}">${esc(short(c.owner))}</a>${me && here?.k === c.k ? ' (you)' : ''}`;
  const note = !wallet.address && here?.k === c.k ? `<a href="" data-iw="connect">Connect</a> the wallet that holds ${esc(islandName(id))} to send from this wallet.` : wallet.address && here?.k === c.k && !me ? `View only: you don't hold ${esc(islandName(id))}.` : '';
  page.innerHTML = `<div class="fw uw"><section class="fwcard fwid glow"><div class="fwtop"><div class="fwnftw"><img class="fwnft" src="/img/multi-islands/m/${id}.webp" alt="${esc(islandName(id))}" onerror="this.onerror=null;this.src='/img/multi-islands/s/${id}.webp'"></div><div style="min-width:0"><span class="fwtag">Island's token wallet</span><h1>${esc(islandName(id))}</h1><a class="small" href="/c/multi-islands?item=${id}">View the NFT →</a></div></div>
    <div class="fwacts">${S.cs.map(x => `<button class="fwbtn ${x.k === sel ? 'on' : ''}" data-iw-chain="${x.k}">${logo(x.k)} ${esc(chains[x.k].name)}</button>`).join('')}</div>
    <div class="fwaddr"><span class="mono fwfull">${c.tba}</span><button class="fwcopy" data-iw="copy" aria-label="Copy address">⧉</button></div>
    ${canSend ? `<div class="fwacts"><button class="fwbtn pri" data-iw="send"><span class="ic">${SEND_IC}</span>Send</button></div>` : ''}
    <p class="small">${logo(c.k)} ${esc(chains[c.k].name)} · ${c.deployed == null ? 'checking…' : c.deployed ? 'Account created' : 'Not created yet (the address already works; the account is created on first send)'} · <a href="${ex}/address/${c.tba}" target="_blank" rel="noopener">Explorer ↗</a></p>
    <p class="small">${status}</p>
    ${note ? `<div class="fwnote">${note}</div>` : ''}
    <div class="fwrecv" id="fwrecv"><div class="fwqr">${renderSVG(c.tba, { border: 1, ecc: 'M' })}<img class="c" src="/img/multi-islands/s/${id}.webp" alt=""></div><div><h4>Receive on ${esc(chains[c.k].name)}</h4><div class="hint">This address is for ${esc(chains[c.k].name)} only. Each chain has its own wallet address for this Island.${here ? ` The Island is on ${esc(chains[here.k].name)} now.` : ''}</div><span class="fwpill mono">${short(c.tba)}</span></div></div>
    <section class="fwsec"><div class="sechd"><h3>Address per chain</h3></div>${S.cs.map(x => `<div class="orow" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0"><span>${logo(x.k)} ${esc(chains[x.k].name)}${x === here ? ' <span class="ok small">· Island here</span>' : ''}</span><a class="mono" href="${islandWalletUrl(id, x.k)}" data-iw-chain="${x.k}">${short(x.tba)}</a></div>`).join('')}
    <p class="mut small">ERC-6551 · Tokenbound V3 (<span class="mono">${short(TB.proxy)}</span>) · registry <span class="mono">${short(TB.registry)}</span> · salt 0</p></section></section>
    <div class="fwright"><section class="fwcard fwtotal"><h3>Total value</h3><div class="v silver">${S.cs.some(x => x.bal) ? fmtUsd(total) : '…'}</div><div class="mut small">5 chains, one address each · coins and tokens priced live · NFTs not priced</div></section>
    <section class="fwcard fwsec"><div class="sechd"><h3>Balances by chain</h3></div><div class="fwgrid">${S.cs.map(x => `<div class="fwch ${x === here ? 'here' : ''}" data-chain="${x.k}"><div class="chh"><span class="chn">${logo(x.k)}${esc(chains[x.k].name)}</span><span class="chv">${x.bal ? fmtUsd(x.usd) : '…'}</span></div><div class="mut small mono">${short(x.tba)}</div>${balRows(x) || `<div class="mut small">${!x.bal ? 'Loading…' : !x.bal.ok ? 'Couldn’t read this chain' : 'Empty'}</div>`}<div class="fwchs">${x === here ? '<i class="g">Island here · can send</i>' : x.escrow ? '<i>Receive-only</i>' : ''}</div></div>`).join('')}</div></section>
    <section class="fwcard fwsec"><div class="sechd"><h3>NFTs${S.nfts ? ' · ' + S.nfts.length : ''}</h3><button class="fwrbtn" data-iw="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Refresh'}</button></div>
    ${S.nfts?.length ? `<div class="fwnftg">${S.nfts.map(n => `<div class="nftc">${img(n.image) ? `<img src="${esc(img(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chains[n.chain]?.name || n.chain)}</div></div>`).join('')}</div>` : `<p class="mut small">${S.nfts == null ? 'Loading NFTs…' : 'No NFTs found.'}</p>`}
    ${S.note ? `<p class="mut small">${esc(S.note)}</p>` : ''}</section></div></div>`;
}

// ---------------------------------------------------------------- send (only on the chain where the Island is, by its holder)
type Asset = { key: string; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
function assets(c: Ch): Asset[] {
  const out: Asset[] = [];
  if (c.bal?.native) out.push({ key: 'n', kind: 'native', label: NATIVE[c.k].symbol, bal: c.bal.native, decimals: 18 });
  ISLAND_TOKENS[c.k].forEach((t, i) => { const v = c.bal?.tokens[i]; if (v) out.push({ key: t.address, kind: 'erc20', label: t.symbol, bal: v, decimals: t.decimals, token: t.address }); });
  (S.nfts || []).filter(n => n.chain === c.k).forEach(n => out.push({ key: `${n.contract}|${n.id}`, kind: 'nft', label: n.name || `#${n.id}`, bal: 1n, decimals: 0, nft: n }));
  return out;
}
/** Recipient: 0x address, "LIL FOOT #n" / "footN.multisea" (that foot's wallet) or "Island #n" (that Island's wallet on chain k). */
function resolveRecipient(s: string, k: FwChain): { address: Hex; label: string | null } | null {
  const t = s.trim(); if (isAddress(t)) return { address: getAddress(t), label: null };
  const f = parseFootName(t); if (f) return { address: footTba(f), label: footName(f) };
  const i = parseIslandName(t); return i ? { address: islandTba(k, i), label: `${islandName(i)}'s wallet on ${chains[k].name}` } : null;
}
function callFor(a: Asset, from: Hex, to: Hex, amt: bigint): Call {
  if (a.kind === 'native') return { to, value: amt, data: '0x' };
  if (a.kind === 'erc20') return { to: a.token!, value: 0n, data: encodeFunctionData({ abi: ERC20T, functionName: 'transfer', args: [to, amt] }) };
  const n = a.nft!; const big = BigInt(n.id);
  return n.standard === 'erc1155' ? { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [from, to, big, amt || 1n, '0x'] }) }
    : { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC721, functionName: 'safeTransferFrom', args: [from, to, big] }) };
}
const wc = (k: string) => createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
async function gasCost(k: FwChain, est: () => Promise<bigint>) { try { const [g, p] = await Promise.all([est(), readClient(k).getGasPrice()]); return pad(g * p, 20n); } catch { return null; } }
const feeTxt = (k: FwChain, v: bigint | null) => (v == null ? '-' : `${Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${esc(NATIVE[k].symbol)}${S.rates ? (() => { const r = rateOf(NATIVE[k].px, S.rates!); return r ? ` (~${fmtUsd(+formatUnits(v, 18) * r)})` : ''; })() : ''}`);
type Step = { label: string; fee: bigint | null; run: () => Promise<Hex> };
// Tokenbound V3: the registry deploys an AccountProxy clone that must be initialized (initialize(impl), anyone may call it)
// before execute works; an uninitialized proxy silently does nothing. Create + initialize go in one Multicall3 tx.
async function plan(c: Ch, call: Call): Promise<Step[]> {
  const pc = readClient(c.k); const me = wallet.address as Hex; const steps: Step[] = [];
  const exec = { address: c.tba, abi: ACC, functionName: 'execute' as const, args: [call.to, call.value, call.data, 0] as const };
  if (!c.ready) {
    const calls: { target: Hex; allowFailure: boolean; callData: Hex }[] = [];
    if (!c.deployed) calls.push({ target: TB.registry, allowFailure: false, callData: encodeFunctionData({ abi: REG, functionName: 'createAccount', args: [TB.proxy, TB.salt, chainIdOf(c.k), ISLAND_ADDR[c.k], BigInt(id)] }) });
    calls.push({ target: c.tba, allowFailure: false, callData: encodeFunctionData({ abi: ACC, functionName: 'initialize', args: [TB.impl] }) });
    const mc = { address: MC3, abi: MC3A, functionName: 'aggregate3' as const, args: [calls] as const };
    steps.push({ label: `Create this Island's wallet on ${chains[c.k].name} (one time)`, fee: await gasCost(c.k, () => pc.estimateContractGas({ ...mc, account: me })), run: () => wc(c.k).writeContract({ ...mc, account: me, chain: vchain(c.k) }) });
  }
  steps.push({ label: `Send from the Island's wallet on ${chains[c.k].name}`, fee: c.ready ? await gasCost(c.k, () => pc.estimateContractGas({ ...exec, account: me })) : null, run: async () => {
    const slot = await pc.getStorageAt({ address: c.tba, slot: IMPL_SLOT }); if (!slot || BigInt(slot) === 0n) throw Object.assign(new Error("The Island's wallet isn't set up on this chain yet. Try again in a moment."), { kind: 'stale' });
    return wc(c.k).writeContract({ ...exec, account: me, chain: vchain(c.k) });
  } });
  return steps;
}
function openSend() {
  const c = liveCh(); if (!c || !isOwner()) return; const list = assets(c);
  const m = overlay(`<div class="fwsend"><h2>Send from ${esc(islandName(id))}</h2>
    <div class="lbl">From <span>Island wallet · controlled by you</span></div>
    <div class="fld"><img src="/img/multi-islands/s/${id}.webp" class="av" alt=""><span class="mono">${short(c.tba)}</span><span class="grow"></span><span class="mut small">On ${logo(c.k)} ${esc(chains[c.k].name)}</span></div>
    <div class="lbl">Asset</div>
    <select class="fld sel" data-k="asset">${list.length ? list.map(a => `<option value="${esc(a.key)}">${esc(a.label)}${a.kind === 'nft' ? ' (NFT)' : ` · ${fmt(a.bal, a.decimals)}`}</option>`).join('') : '<option value="">This wallet is empty on ' + esc(chains[c.k].name) + '</option>'}</select>
    <div class="lbl" data-amtl>Amount <span data-k="bal"></span></div>
    <div class="fld"><input data-k="amt" inputmode="decimal" placeholder="0.0" autocomplete="off"><button class="obtn sm" data-k="max">Max</button></div>
    <div class="lbl">To <span>NFT name, .multisea name or 0x address</span></div>
    <div class="fld"><input data-k="to" placeholder="0x…, LIL FOOT #1204 or Island #12" autocomplete="off" spellcheck="false"></div>
    <div data-k="res"></div>
    <div class="fwsum" data-k="sum"><div class="mut small">Pick an asset, amount and recipient to see the fees.</div></div>
    <button class="bbtn" data-k="go" disabled>Send</button><div class="fwmsg" data-k="msg"></div></div>`);
  const q = (k: string) => m.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
  let cur: Step[] | null = null; let seq = 0;
  const asset = () => list.find(a => a.key === q('asset').value) || null;
  const sync = () => { const a = asset(); const nft = a?.kind === 'nft' && a.nft?.standard !== 'erc1155'; (m.querySelector('[data-amtl]') as HTMLElement).hidden = !!nft; (q('amt').parentElement as HTMLElement).hidden = !!nft; q('bal').textContent = a && !nft ? `Balance ${fmt(a.bal, a.decimals)} ${a.label}` : ''; };
  const update = async () => {
    const my = ++seq; cur = null; q('go').setAttribute('disabled', ''); sync();
    const a = asset(); const raw = q('to').value.trim(); const r = resolveRecipient(raw, c.k);
    q('res').innerHTML = !raw ? '' : !r ? '<div class="fwres bad">Not a 0x address, a LIL FOOT name or an Island name.</div>' : r.label ? `<div class="fwres"><div style="flex:1;min-width:0"><b>${esc(r.label)} ✓</b><div class="mono">${r.address}</div></div></div>` : '';
    if (!a || !r) { q('sum').innerHTML = '<div class="mut small">Pick an asset, amount and recipient to see the fees.</div>'; return; }
    if (r.address.toLowerCase() === c.tba.toLowerCase()) { q('sum').innerHTML = '<div class="err small">That is this Island\'s own wallet.</div>'; return; }
    // An Island inside its own wallet could never be moved again: block that recipient.
    if (a.kind === 'nft' && a.nft!.contract.toLowerCase() === ISLAND_ADDR[c.k].toLowerCase() && r.address.toLowerCase() === islandTba(c.k, +a.nft!.id).toLowerCase()) { q('sum').innerHTML = '<div class="err small">An Island can\'t be sent into its own wallet (it would be locked forever).</div>'; return; }
    let amt = 1n; if (a.kind !== 'nft' || a.nft?.standard === 'erc1155') { try { amt = parseUnits(q('amt').value.trim() || '0', a.decimals); } catch { amt = 0n; } if (amt <= 0n) { q('sum').innerHTML = '<div class="mut small">Enter an amount.</div>'; return; } if (amt > a.bal) { q('sum').innerHTML = '<div class="err small">More than the wallet holds.</div>'; return; } }
    q('sum').innerHTML = '<div class="mut small">Checking fees…</div>';
    try {
      const steps = await plan(c, callFor(a, c.tba, r.address, amt)); if (my !== seq) return; cur = steps;
      const tot = steps.reduce((s, x) => s + (x.fee || 0n), 0n);
      q('sum').innerHTML = `${steps.map((s, i) => `<div><span class="mut">${i + 1}. ${esc(s.label)}</span><b>${s.fee == null ? 'gas (est. after step 1)' : 'gas ~' + feeTxt(c.k, s.fee)}</b></div>`).join('')}
        <div><span class="mut">You pay</span><b>${feeTxt(c.k, tot)} on ${esc(chains[c.k].name)}</b></div>
        <div><span class="mut">Recipient gets</span><b>${a.kind === 'nft' ? esc(a.label) : `${fmt(amt, a.decimals)} ${esc(a.label)}`} on ${esc(chains[c.k].name)}</b></div>
        <ul class="fwnotes"><li>Runs directly on ${esc(chains[c.k].name)}: your wallet calls the Island's wallet (execute).</li>${steps.length > 1 ? '<li>First use: the wallet is created on this chain. You pay that gas once.</li>' : ''}</ul>`;
      q('go').removeAttribute('disabled'); q('go').textContent = steps.length > 1 ? `Send (${steps.length} steps)` : 'Send';
    } catch (e) { if (my === seq) q('sum').innerHTML = `<div class="err small">Couldn't check fees: ${esc(friendly(e, c.k))}</div>`; }
  };
  let t: any; const deb = () => { clearTimeout(t); t = setTimeout(update, 350); };
  m.addEventListener('input', deb); m.addEventListener('change', deb);
  m.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null; if (!b) return;
    if (b.dataset.k === 'max') { const a = asset(); if (a) { q('amt').value = formatUnits(a.bal, a.decimals); deb(); } }
    if (b.dataset.k === 'go' && cur) {
      const msg = q('msg'); b.setAttribute('disabled', '');
      try {
        for (let i = 0; i < cur.length; i++) {
          const s = cur[i]; msg.innerHTML = `Step ${i + 1}/${cur.length}: ${esc(s.label)}. Confirm in your wallet…`;
          await ensureChain(c.k); const h = await s.run();
          msg.innerHTML = `Waiting for ${esc(chains[c.k].name)}… <a href="${chains[c.k].explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
          await readClient(c.k).waitForTransactionReceipt({ hash: h, timeout: 240_000 });
          if (i === 0 && cur.length > 1) { c.deployed = true; c.ready = true; }
        }
        msg.innerHTML = '<span class="ok">✓ Sent.</span>'; setTimeout(load, 4000);
      } catch (err) { msg.innerHTML = `<span class="err">${esc(friendly(err, c.k))}</span>`; b.removeAttribute('disabled'); }
    }
  });
  sync();
}

page.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-iw],[data-iw-chain]'); if (!b) return;
  if (b.dataset.iwChain) { e.preventDefault(); sel = b.dataset.iwChain as FwChain; history.replaceState(null, '', islandWalletUrl(id, sel)); draw(); return; }
  if (b.dataset.iw === 'copy') navigator.clipboard?.writeText(S.cs.find(x => x.k === sel)!.tba).then(() => { b.textContent = '✓'; }).catch(() => {});
  if (b.dataset.iw === 'refresh') load();
  if (b.dataset.iw === 'connect') { e.preventDefault(); openConnect(); }
  if (b.dataset.iw === 'send') openSend();
});
onWallet(() => draw());
draw(); if (Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX) load();
// Read-only test hook (quotes only; never signs): enabled with localStorage multisea-debug=1.
if (localStorage.getItem('multisea-debug') === '1') (window as any).__iw = { S, plan, callFor, assets, resolveRecipient, liveCh, isOwner };
