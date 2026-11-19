// /w/multi-islands/<id> once the IslandWalletFactory is live on all 5 chains (see islandkit iwLive): ONE wallet address
// per Island on Base, Ethereum, ApeChain, BNB Chain and Robinhood. Balances and NFTs from all 5 chains in one view.
// Control: the Island's holder on the chain where the Island is live (not locked in the bridge escrow).
// - Assets on the live chain: wallet.execute, signed directly (first use creates the wallet there: factory.deployWallet).
// - Assets on another chain: factory.remoteExecute on the live chain; LayerZero carries it (fee shown; ~1-3 min).
// The old per-chain ERC-6551 wallets are listed under "Legacy wallets" until they are empty, with "Move to new wallet".
import { createWalletClient, custom, encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Hex } from 'viem';
import { renderSVG } from 'uqr';
import CFG from '../config/collections.json';
import { wallet, onWallet, readClient, ensureChain, vchain, friendly, openConnect, overlay, API } from './wallet';
import { usdRates, type UsdRates } from './shell';
import { frame, chains, esc, short, logo } from './gx';
import { MC3, NATIVE, EID, chainBalances, chainUsd, fmtUsd, rateOf, footTba, footName, parseFootName, type ChainBal, type FwChain } from './footkit';
import { ISLAND_CHAINS, ISLAND_ADDR, ISLAND_MAX, ISLAND_TOKENS, IMPL_SLOT, islandTba, islandName, parseIslandName, chainIdOf, TB, IW2, IW2_FACTORY_ABI, IW2_WALLET_ABI, islandWallet2 } from './islandkit';

type Nft = { chain: string; contract: string; id: string; name?: string | null; image?: string | null; collection?: string; standard?: string | null };
type Leg = { tba: Hex; deployed: boolean | null; ready: boolean | null; bal: ChainBal | null; usd: number | null; nfts: Nft[] | null };
type Ch = { k: FwChain; owner: string | null; escrow: boolean; deployed: boolean | null; bal: ChainBal | null; usd: number | null; leg: Leg };
type Call = { to: Hex; value: bigint; data: Hex };
type Step = { label: string; fee: bigint | null; run: () => Promise<Hex>; lz?: boolean };
const ERC721 = parseAbi(['function ownerOf(uint256) view returns (address)', 'function safeTransferFrom(address from, address to, uint256 tokenId)', 'function transferFrom(address from, address to, uint256 tokenId)']);
const ERC1155 = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)']);
const ERC20T = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const TBA = parseAbi(['function initialize(address implementation)', 'function executeBatch((address to, uint256 value, bytes data, uint8 operation)[] operations) payable returns (bytes[])']);
const REG = parseAbi(['function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)']);
const MC3A = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const ESC = new Set((CFG.collections.find(c => c.slug === 'multi-islands')!.escrow || []).map(e => `${e.chain}:${e.address.toLowerCase()}`));
const id = +location.pathname.split('/')[3];
const W = islandWallet2(id);
const page = frame('', `${islandName(id)} wallet`, 'fwpage');
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const img = (s?: string | null) => !s ? '' : s.startsWith('ipfs://') ? 'https://ipfs.filebase.io/ipfs/' + s.slice(7) : /^(https:\/\/|\/img\/)/.test(s) ? s : s.startsWith('/media/') ? API + s : '';
const pad = (v: bigint, pct = 20n) => v + (v * pct) / 100n;
const SEND_IC = '<svg class="fi" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>';
const NAMES = 'Base, Ethereum, ApeChain, BNB, Robinhood';
const S = { cs: ISLAND_CHAINS.map(k => ({ k, owner: null, escrow: false, deployed: null, bal: null, usd: null, leg: { tba: islandTba(k, id), deployed: null, ready: null, bal: null, usd: null, nfts: null } } as Ch)), nfts: null as Nft[] | null, note: '', busy: false, rates: null as UsdRates | null };
const liveCh = () => S.cs.find(x => x.owner && !x.escrow) || null;
const isOwner = () => { const l = liveCh(); return !!(l && wallet.address && wallet.address.toLowerCase() === l.owner!.toLowerCase()); };
const nftsAt = async (a: Hex, k: FwChain) => { const r = await fetch(`${API}/wallet/${a}/nfts?chain=${k}`); if (!r.ok) throw Error(chains[k].name); const j = await r.json(); if (j.failed?.length) throw Error(chains[k].name); return (j.nfts || []) as Nft[]; };
const legEmpty = (l: Leg) => !!l.bal && l.bal.ok && !l.bal.native && !l.bal.tokens.some(Boolean) && l.nfts != null && !l.nfts.length;

async function load() {
  if (S.busy) return; S.busy = true; draw();
  const nft = Promise.all(S.cs.map(c => nftsAt(W, c.k).catch((e: Error) => { S.note = `Couldn't load NFTs on ${e.message}; refresh to retry.`; return [] as Nft[]; }))).then(l => { S.nfts = l.flat(); draw(); });
  const legN = Promise.all(S.cs.map(c => nftsAt(c.leg.tba, c.k).then(n => { c.leg.nfts = n; }).catch(() => { c.leg.nfts = null; })));
  const rates = S.rates = await usdRates().catch(() => ({ ETH: null, APE: null, BNB: null } as UsdRates));
  await Promise.all(S.cs.map(async c => {
    const pc = readClient(c.k);
    const usdOf = (b: ChainBal) => (ISLAND_TOKENS[c.k].some((t, i) => b.tokens[i] && t.px !== 'USD' && rateOf(t.px, rates) == null) || b.tokens.some(v => v == null) ? null : chainUsd(c.k, b, rates, ISLAND_TOKENS[c.k]));
    const [code, owner, bals, lcode, lslot] = await Promise.all([
      pc.getCode({ address: W }).then((x: Hex | undefined) => !!x && x !== '0x').catch(() => null),
      pc.readContract({ address: ISLAND_ADDR[c.k], abi: ERC721, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null) as Promise<string | null>,
      chainBalances(c.k, [W, c.leg.tba], ISLAND_TOKENS[c.k]),
      pc.getCode({ address: c.leg.tba }).then((x: Hex | undefined) => !!x && x !== '0x').catch(() => null),
      pc.getStorageAt({ address: c.leg.tba, slot: IMPL_SLOT }).then((x: Hex | undefined) => !!x && BigInt(x) !== 0n).catch(() => null),
    ]);
    Object.assign(c, { deployed: code, owner, escrow: !!owner && ESC.has(`${c.k}:${owner.toLowerCase()}`), bal: bals[0], usd: usdOf(bals[0]) });
    Object.assign(c.leg, { deployed: lcode, ready: lcode === false ? false : lslot, bal: bals[1], usd: usdOf(bals[1]) });
    draw();
  }));
  await Promise.all([nft, legN]); S.busy = false; draw();
}

function balRows(b: ChainBal | null, k: FwChain) {
  const rows: string[] = []; const r = S.rates; const usd = (v: bigint, d: number, px: any) => { const u = r ? rateOf(px, r) : null; return u != null ? fmtUsd(+formatUnits(v, d) * u) : ''; };
  if (b?.native) rows.push(`<div class="fwtok"><b>${logo(k)} ${fmt(b.native)} ${esc(NATIVE[k].symbol)}</b><span class="mut mono">${usd(b.native, 18, NATIVE[k].px)}</span></div>`);
  ISLAND_TOKENS[k].forEach((t, i) => { const v = b?.tokens[i]; if (v) rows.push(`<div class="fwtok"><b>${logo(k)} ${fmt(v, t.decimals)} ${esc(t.symbol)}</b><span class="mut mono">${usd(v, t.decimals, t.px)}</span></div>`); });
  return rows.join('');
}
const nftCard = (n: Nft) => `<div class="nftc">${img(n.image) ? `<img src="${esc(img(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chains[n.chain]?.name || n.chain)}</div></div>`;

function legacyHtml() {
  const here = liveCh(); const me = isOwner();
  const show = S.cs.filter(c => c.leg.bal && !legEmpty(c.leg));
  if (!show.length) return '';
  return `<section class="fwcard fwsec"><div class="sechd"><h3>Legacy wallets</h3></div>
    <p class="mut small">Before the one-address wallet, each chain had its own ERC-6551 wallet for this Island. These still hold something; they keep working and nothing is lost. Move the contents to the new address when you like. This list disappears once they're empty.</p>
    ${show.map(c => { const l = c.leg; const n = l.nfts?.length || 0; return `<div class="fwch" style="margin-top:8px"><div class="chh"><span class="chn">${logo(c.k)}${esc(chains[c.k].name)}</span><span class="chv">${fmtUsd(l.usd)}</span></div>
      <div class="mut small mono"><a href="${chains[c.k].explorer}/address/${l.tba}" target="_blank" rel="noopener">${short(l.tba)} ↗</a></div>${balRows(l.bal, c.k)}${n ? `<div class="fwtok"><b>${n} NFT${n > 1 ? 's' : ''}</b><span class="mut small">${esc((l.nfts || []).slice(0, 3).map(x => x.name || '#' + x.id).join(', '))}${n > 3 ? '…' : ''}</span></div>` : ''}
      <div class="fwchs">${here?.k === c.k ? (me ? `<button class="obtn sm" data-iw="move" data-k="${c.k}">Move to new wallet</button>` : `<i>Only the holder of ${esc(islandName(id))} can move these</i>`) : `<i>To move these, bridge ${esc(islandName(id))} to ${esc(chains[c.k].name)} first (the old wallet only obeys the holder on ${esc(chains[c.k].name)}).</i>`}</div></div>`; }).join('')}</section>`;
}

function draw() {
  if (!(Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX)) { page.innerHTML = `<div class="fwcard fwsec"><h3>Not an Island</h3><p class="mut">Island's token IDs run from 1 to ${ISLAND_MAX}.</p></div>`; return; }
  const here = liveCh(); const me = isOwner();
  const total = S.cs.every(x => x.usd != null) ? S.cs.reduce((n, x) => n + x.usd!, 0) : null;
  const status = !S.cs.some(x => x.owner) ? 'Checking where the Island is…' : here ? `Controlled by the holder of ${islandName(id)} (on ${esc(chains[here.k].name)} now): <a href="/u/${esc(here.owner!)}">${esc(short(here.owner))}</a>${me ? ' (you)' : ''}. Assets on ${esc(chains[here.k].name)} move directly; assets on the other chains move through LayerZero (small fee, ~1-3 min).` : `${islandName(id)} isn't live on any of the 5 EVM chains right now (it may be on Solana), so the wallet is receive-only until it comes back.`;
  const note = here && !wallet.address ? `<a href="" data-iw="connect">Connect</a> the wallet that holds ${esc(islandName(id))} to send from this wallet.` : here && wallet.address && !me ? `View only: you don't hold ${esc(islandName(id))}.` : '';
  const allBal = S.cs.map(x => balRows(x.bal, x.k)).join('');
  page.innerHTML = `<div class="fw uw"><section class="fwcard fwid glow"><div class="fwtop"><div class="fwnftw"><img class="fwnft" src="/img/multi-islands/m/${id}.webp" alt="${esc(islandName(id))}" onerror="this.onerror=null;this.src='/img/multi-islands/s/${id}.webp'"></div><div style="min-width:0"><span class="fwtag">Island's token wallet</span><h1>${esc(islandName(id))}</h1><a class="small" href="/c/multi-islands?item=${id}">View the NFT →</a></div></div>
    <div class="fwaddr"><span class="mono fwfull">${W}</span><button class="fwcopy" data-iw="copy" aria-label="Copy address">⧉</button></div>
    <p class="small"><b>Works on ${NAMES}.</b> ${ISLAND_CHAINS.map(k => logo(k)).join(' ')}</p>
    ${me ? `<div class="fwacts"><button class="fwbtn pri" data-iw="send"><span class="ic">${SEND_IC}</span>Send</button></div>` : ''}
    <p class="small">${status}</p>
    ${note ? `<div class="fwnote">${note}</div>` : ''}
    <div class="fwrecv"><div class="fwqr">${renderSVG(W, { border: 1, ecc: 'M' })}<img class="c" src="/img/multi-islands/s/${id}.webp" alt=""></div><div><h4>Receive</h4><div class="hint">Send coins, tokens or NFTs to this address on any of ${NAMES}. It's the same address on all five, and it works before anything is created on a chain.</div><span class="fwpill mono">${short(W)}</span></div></div>
    <section class="fwsec"><div class="sechd"><h3>On each chain</h3></div>${S.cs.map(x => `<div class="orow" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0"><span>${logo(x.k)} ${esc(chains[x.k].name)}${x === here ? ' <span class="ok small">· Island here</span>' : ''}</span><span class="small mut">${x.deployed == null ? '…' : x.deployed ? 'created' : 'not created yet (receives anyway)'} · <a href="${chains[x.k].explorer}/address/${W}" target="_blank" rel="noopener">Explorer ↗</a></span></div>`).join('')}
    <p class="mut small">IslandWalletFactory <span class="mono">${short(IW2.factory)}</span> (same address on all 5 chains) · remote actions via LayerZero, checked against the Island's live holder.</p></section></section>
    <div class="fwright"><section class="fwcard fwtotal"><h3>Total value</h3><div class="v silver">${S.cs.some(x => x.bal) ? fmtUsd(total) : '…'}</div><div class="mut small">One address, 5 chains · coins and tokens priced live · NFTs not priced</div></section>
    <section class="fwcard fwsec"><div class="sechd"><h3>Coins and tokens</h3></div>${allBal || `<div class="mut small">${S.cs.some(x => !x.bal) ? 'Loading…' : 'Empty on all 5 chains'}</div>`}${S.cs.some(x => x.bal && !x.bal.ok) ? `<p class="mut small">Couldn't read ${S.cs.filter(x => x.bal && !x.bal.ok).map(x => esc(chains[x.k].name)).join(', ')}; refresh to retry.</p>` : ''}</section>
    <section class="fwcard fwsec"><div class="sechd"><h3>NFTs${S.nfts ? ' · ' + S.nfts.length : ''}</h3><button class="fwrbtn" data-iw="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Refresh'}</button></div>
    ${S.nfts?.length ? `<div class="fwnftg">${S.nfts.map(nftCard).join('')}</div>` : `<p class="mut small">${S.nfts == null ? 'Loading NFTs…' : 'No NFTs found.'}</p>`}
    ${S.note ? `<p class="mut small">${esc(S.note)}</p>` : ''}</section>
    ${legacyHtml()}</div></div>`;
}

// ---------------------------------------------------------------- send
type Asset = { key: string; k: FwChain; kind: 'native' | 'erc20' | 'nft'; label: string; bal: bigint; decimals: number; token?: Hex; nft?: Nft };
function assets(): Asset[] {
  const out: Asset[] = [];
  for (const c of S.cs) {
    if (c.bal?.native) out.push({ key: `${c.k}|n`, k: c.k, kind: 'native', label: NATIVE[c.k].symbol, bal: c.bal.native, decimals: 18 });
    ISLAND_TOKENS[c.k].forEach((t, i) => { const v = c.bal?.tokens[i]; if (v) out.push({ key: `${c.k}|${t.address}`, k: c.k, kind: 'erc20', label: t.symbol, bal: v, decimals: t.decimals, token: t.address }); });
  }
  (S.nfts || []).forEach(n => out.push({ key: `${n.chain}|${n.contract}|${n.id}`, k: n.chain as FwChain, kind: 'nft', label: n.name || `#${n.id}`, bal: 1n, decimals: 0, nft: n }));
  return out;
}
function resolveRecipient(s: string): { address: Hex; label: string | null } | null {
  const t = s.trim(); if (isAddress(t)) return { address: getAddress(t), label: null };
  const f = parseFootName(t); if (f) return { address: footTba(f), label: footName(f) };
  const i = parseIslandName(t); return i ? { address: islandWallet2(i), label: `${islandName(i)}'s wallet` } : null;
}
function callFor(a: Asset, to: Hex, amt: bigint): Call {
  if (a.kind === 'native') return { to, value: amt, data: '0x' };
  if (a.kind === 'erc20') return { to: a.token!, value: 0n, data: encodeFunctionData({ abi: ERC20T, functionName: 'transfer', args: [to, amt] }) };
  const n = a.nft!; const big = BigInt(n.id);
  return n.standard === 'erc1155' ? { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [W, to, big, amt || 1n, '0x'] }) }
    : { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC721, functionName: 'safeTransferFrom', args: [W, to, big] }) };
}
const wc = (k: string) => createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
async function gasCost(k: FwChain, est: () => Promise<bigint>) { try { const [g, p] = await Promise.all([est(), readClient(k).getGasPrice()]); return pad(g * p, 20n); } catch { return null; } }
const feeTxt = (k: FwChain, v: bigint | null) => (v == null ? '-' : `${Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${esc(NATIVE[k].symbol)}${S.rates ? (() => { const r = rateOf(NATIVE[k].px, S.rates!); return r ? ` (~${fmtUsd(+formatUnits(v, 18) * r)})` : ''; })() : ''}`);
/** LayerZero type-3 options: executor lzReceive gas. */
export const lzOpts = (gas: bigint) => ('0x0003' + '01' + '0011' + '01' + gas.toString(16).padStart(32, '0')) as Hex;
/** Destination gas for the factory's lzReceive: wallet creation (~125k) if needed + overhead + the calls themselves. */
async function dstGas(k: FwChain, calls: Call[], deployed: boolean) {
  let g = deployed ? 90_000n : 220_000n;
  for (const c of calls) { const e = await readClient(k).estimateGas({ account: W, to: c.to, data: c.data, value: c.value }).catch(() => 120_000n); g += pad(e > 21_000n ? e - 21_000n : 0n, 30n) + 15_000n; }
  return g < 150_000n ? 150_000n : g;
}

async function plan(a: Asset, call: Call): Promise<Step[]> {
  const live = liveCh()!; const me = wallet.address as Hex; const steps: Step[] = [];
  const dst = S.cs.find(x => x.k === a.k)!;
  if (a.k === live.k) {
    const pc = readClient(live.k);
    if (!live.deployed) {
      const dep = { address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'deployWallet' as const, args: [BigInt(id)] as const };
      steps.push({ label: `Create the wallet on ${chains[live.k].name} (one time)`, fee: await gasCost(live.k, () => pc.estimateContractGas({ ...dep, account: me })), run: () => wc(live.k).writeContract({ ...dep, account: me, chain: vchain(live.k) }) });
    }
    const exec = { address: W, abi: IW2_WALLET_ABI, functionName: 'execute' as const, args: [call.to, call.value, call.data] as const };
    steps.push({ label: `Send from the wallet on ${chains[live.k].name}`, fee: live.deployed ? await gasCost(live.k, () => pc.estimateContractGas({ ...exec, account: me })) : null, run: () => wc(live.k).writeContract({ ...exec, account: me, chain: vchain(live.k) }) });
    return steps;
  }
  // Remote: one transaction on the live chain; LayerZero runs it on the asset's chain.
  const pc = readClient(live.k);
  const gas = await dstGas(a.k, [call], !!dst.deployed);
  const opts = lzOpts(gas); const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const calls = [{ to: call.to, value: call.value, data: call.data }] as const;
  const lzFee = await pc.readContract({ address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'quoteRemote', args: [BigInt(id), EID[a.k], calls, deadline, opts], account: me });
  const value = pad(lzFee, 5n);
  const tx = { address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'remoteExecute' as const, args: [BigInt(id), EID[a.k], calls, deadline, opts] as const, value };
  const g = await gasCost(live.k, () => pc.estimateContractGas({ ...tx, account: me }));
  steps.push({ label: `Send via LayerZero from ${chains[live.k].name} to ${chains[a.k].name}`, lz: true, fee: g == null ? null : g + value, run: () => wc(live.k).writeContract({ ...tx, account: me, chain: vchain(live.k) }) });
  return steps;
}

async function runSteps(k: FwChain, steps: Step[], msg: HTMLElement, after: () => void) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]; msg.innerHTML = `Step ${i + 1}/${steps.length}: ${esc(s.label)}. Confirm in your wallet…`;
    await ensureChain(k); const h = await s.run();
    msg.innerHTML = `Waiting for ${esc(chains[k].name)}… <a href="${chains[k].explorer}/tx/${h}" target="_blank" rel="noopener">View ↗</a>`;
    const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 240_000 });
    if (rc.status !== 'success') throw new Error('The transaction reverted.');
    if (s.lz) { msg.innerHTML = `<span class="ok">✓ Sent to LayerZero.</span> It usually arrives in 1-3 minutes. <a href="https://layerzeroscan.com/tx/${h}" target="_blank" rel="noopener">Track on LayerZero Scan ↗</a>`; setTimeout(load, 90_000); return; }
  }
  msg.innerHTML = '<span class="ok">✓ Done.</span>'; after();
}

function openSend() {
  const live = liveCh(); if (!live || !isOwner()) return; const list = assets();
  const m = overlay(`<div class="fwsend"><h2>Send from ${esc(islandName(id))}</h2>
    <div class="lbl">From <span>Island wallet · controlled by you</span></div>
    <div class="fld"><img src="/img/multi-islands/s/${id}.webp" class="av" alt=""><span class="mono">${short(W)}</span><span class="grow"></span><span class="mut small">You sign on ${logo(live.k)} ${esc(chains[live.k].name)}</span></div>
    <div class="lbl">Asset</div>
    <select class="fld sel" data-k="asset">${list.length ? list.map(a => `<option value="${esc(a.key)}">${esc(a.label)}${a.kind === 'nft' ? ' (NFT)' : ` · ${fmt(a.bal, a.decimals)}`} · ${esc(chains[a.k].name)}</option>`).join('') : '<option value="">This wallet is empty on all 5 chains</option>'}</select>
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
  const sync = () => { const a = asset(); const nft = a?.kind === 'nft' && a.nft?.standard !== 'erc1155'; (m.querySelector('[data-amtl]') as HTMLElement).hidden = !!nft; (q('amt').parentElement as HTMLElement).hidden = !!nft; q('bal').textContent = a && !nft ? `Balance ${fmt(a.bal, a.decimals)} ${a.label} on ${chains[a.k].name}` : ''; };
  const update = async () => {
    const my = ++seq; cur = null; q('go').setAttribute('disabled', ''); sync();
    const a = asset(); const raw = q('to').value.trim(); const r = resolveRecipient(raw);
    q('res').innerHTML = !raw ? '' : !r ? '<div class="fwres bad">Not a 0x address, a LIL FOOT name or an Island name.</div>' : r.label ? `<div class="fwres"><div style="flex:1;min-width:0"><b>${esc(r.label)} ✓</b><div class="mono">${r.address}</div></div></div>` : '';
    if (!a || !r) { q('sum').innerHTML = '<div class="mut small">Pick an asset, amount and recipient to see the fees.</div>'; return; }
    if (r.address.toLowerCase() === W.toLowerCase()) { q('sum').innerHTML = '<div class="err small">That is this Island\'s own wallet (same address on every chain).</div>'; return; }
    if (a.kind === 'nft' && a.nft!.contract.toLowerCase() === ISLAND_ADDR[a.k].toLowerCase() && r.address.toLowerCase() === islandWallet2(+a.nft!.id).toLowerCase()) { q('sum').innerHTML = '<div class="err small">An Island can\'t be sent into its own wallet (it would be locked forever).</div>'; return; }
    let amt = 1n; if (a.kind !== 'nft' || a.nft?.standard === 'erc1155') { try { amt = parseUnits(q('amt').value.trim() || '0', a.decimals); } catch { amt = 0n; } if (amt <= 0n) { q('sum').innerHTML = '<div class="mut small">Enter an amount.</div>'; return; } if (amt > a.bal) { q('sum').innerHTML = '<div class="err small">More than the wallet holds on that chain.</div>'; return; } }
    q('sum').innerHTML = '<div class="mut small">Checking fees…</div>';
    try {
      const steps = await plan(a, callFor(a, r.address, amt)); if (my !== seq) return; cur = steps;
      const tot = steps.reduce((s, x) => s + (x.fee || 0n), 0n); const remote = a.k !== live.k;
      q('sum').innerHTML = `${steps.map((s, i) => `<div><span class="mut">${i + 1}. ${esc(s.label)}</span><b>${s.fee == null ? 'gas (est. after step 1)' : (s.lz ? 'LayerZero fee + gas ~' : 'gas ~') + feeTxt(live.k, s.fee)}</b></div>`).join('')}
        <div><span class="mut">You pay</span><b>${feeTxt(live.k, tot)} on ${esc(chains[live.k].name)}</b></div>
        <div><span class="mut">Recipient gets</span><b>${a.kind === 'nft' ? esc(a.label) : `${fmt(amt, a.decimals)} ${esc(a.label)}`} on ${esc(chains[a.k].name)}</b></div>
        <ul class="fwnotes">${remote ? `<li>${esc(islandName(id))} is on ${esc(chains[live.k].name)}, the asset is on ${esc(chains[a.k].name)}: you sign once on ${esc(chains[live.k].name)} and LayerZero runs the send on ${esc(chains[a.k].name)} (usually 1-3 minutes). Any unused fee is refunded.</li>${!S.cs.find(x => x.k === a.k)!.deployed ? `<li>The wallet is created on ${esc(chains[a.k].name)} as part of this (included in the fee).</li>` : ''}` : `<li>Runs directly on ${esc(chains[live.k].name)}.</li>${steps.length > 1 ? '<li>First use: the wallet is created on this chain. You pay that gas once.</li>' : ''}`}</ul>`;
      q('go').removeAttribute('disabled'); q('go').textContent = steps.length > 1 ? `Send (${steps.length} steps)` : 'Send';
    } catch (e) { if (my === seq) q('sum').innerHTML = `<div class="err small">Couldn't check fees: ${esc(friendly(e, live.k))}</div>`; }
  };
  let t: any; const deb = () => { clearTimeout(t); t = setTimeout(update, 350); };
  m.addEventListener('input', deb); m.addEventListener('change', deb);
  m.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest('[data-k]') as HTMLElement | null; if (!b) return;
    if (b.dataset.k === 'max') { const a = asset(); if (a) { q('amt').value = formatUnits(a.bal, a.decimals); deb(); } }
    if (b.dataset.k === 'go' && cur) {
      const msg = q('msg'); b.setAttribute('disabled', '');
      try { await runSteps(live.k, cur, msg, () => setTimeout(load, 4000)); } catch (err) { msg.innerHTML = `<span class="err">${esc(friendly(err, live.k))}</span>`; b.removeAttribute('disabled'); }
    }
  });
  sync();
}

// ---------------------------------------------------------------- legacy -> new ("Move to new wallet")
/** Steps on the live chain: create + initialize the old Tokenbound account if needed (anyone may), then ONE holder
 *  signature: old account executeBatch moving every coin, listed token and NFT to the new address. */
async function migratePlan(c: Ch): Promise<{ steps: Step[]; ops: { to: Hex; value: bigint; data: Hex; operation: number }[] }> {
  const l = c.leg; const me = wallet.address as Hex; const pc = readClient(c.k); const steps: Step[] = [];
  const ops: { to: Hex; value: bigint; data: Hex; operation: number }[] = [];
  ISLAND_TOKENS[c.k].forEach((t, i) => { const v = l.bal?.tokens[i]; if (v) ops.push({ to: t.address, value: 0n, data: encodeFunctionData({ abi: ERC20T, functionName: 'transfer', args: [W, v] }), operation: 0 }); });
  const has1155 = (l.nfts || []).some(n => n.standard === 'erc1155');
  for (const n of l.nfts || []) ops.push(n.standard === 'erc1155'
    ? { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC1155, functionName: 'safeTransferFrom', args: [l.tba, W, BigInt(n.id), BigInt((n as any).quantity || 1), '0x'] }), operation: 0 }
    : { to: n.contract as Hex, value: 0n, data: encodeFunctionData({ abi: ERC721, functionName: 'transferFrom', args: [l.tba, W, BigInt(n.id)] }), operation: 0 });
  if (l.bal?.native) ops.push({ to: W, value: l.bal.native, data: '0x', operation: 0 });
  if (!ops.length) throw new Error('The old wallet is empty.');
  if (!l.ready) {
    const calls: { target: Hex; allowFailure: boolean; callData: Hex }[] = [];
    if (!l.deployed) calls.push({ target: TB.registry, allowFailure: false, callData: encodeFunctionData({ abi: REG, functionName: 'createAccount', args: [TB.proxy, TB.salt, chainIdOf(c.k), ISLAND_ADDR[c.k], BigInt(id)] }) });
    calls.push({ target: l.tba, allowFailure: false, callData: encodeFunctionData({ abi: TBA, functionName: 'initialize', args: [TB.impl] }) });
    const mc = { address: MC3, abi: MC3A, functionName: 'aggregate3' as const, args: [calls] as const };
    steps.push({ label: `Open the old wallet on ${chains[c.k].name} (one time)`, fee: await gasCost(c.k, () => pc.estimateContractGas({ ...mc, account: me })), run: () => wc(c.k).writeContract({ ...mc, account: me, chain: vchain(c.k) }) });
  }
  if (has1155 && !c.deployed) {
    const dep = { address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'deployWallet' as const, args: [BigInt(id)] as const };
    steps.push({ label: `Create the new wallet on ${chains[c.k].name} (needed for ERC-1155 items)`, fee: await gasCost(c.k, () => pc.estimateContractGas({ ...dep, account: me })), run: () => wc(c.k).writeContract({ ...dep, account: me, chain: vchain(c.k) }) });
  }
  const batch = { address: l.tba, abi: TBA, functionName: 'executeBatch' as const, args: [ops] as const };
  steps.push({ label: `Move ${ops.length} item${ops.length > 1 ? 's' : ''} to the new address`, fee: steps.length ? null : await gasCost(c.k, () => pc.estimateContractGas({ ...batch, account: me })), run: async () => {
    const slot = await pc.getStorageAt({ address: l.tba, slot: IMPL_SLOT }); if (!slot || BigInt(slot) === 0n) throw new Error("The old wallet isn't open yet. Try again in a moment.");
    return wc(c.k).writeContract({ ...batch, account: me, chain: vchain(c.k) });
  } });
  return { steps, ops };
}

async function openMove(k: FwChain) {
  const c = S.cs.find(x => x.k === k)!; const live = liveCh(); if (!live || live.k !== k || !isOwner()) return;
  const m = overlay(`<div class="fwsend"><h2>Move to new wallet</h2><p class="mut small">Everything in ${esc(islandName(id))}'s old ${esc(chains[k].name)} wallet <span class="mono">${short(c.leg.tba)}</span> goes to the new address <span class="mono">${short(W)}</span> on ${esc(chains[k].name)}.</p><div class="fwsum" data-k="sum"><div class="mut small">Checking…</div></div><button class="bbtn" data-k="go" disabled>Move</button><div class="fwmsg" data-k="msg"></div></div>`);
  const q = (s: string) => m.querySelector(`[data-k="${s}"]`) as HTMLElement;
  try {
    const { steps, ops } = await migratePlan(c);
    const tot = steps.reduce((s, x) => s + (x.fee || 0n), 0n);
    q('sum').innerHTML = `${steps.map((s, i) => `<div><span class="mut">${i + 1}. ${esc(s.label)}</span><b>${s.fee == null ? 'gas (est. after step 1)' : 'gas ~' + feeTxt(k, s.fee)}</b></div>`).join('')}<div><span class="mut">You pay</span><b>${feeTxt(k, tot)}${steps.some(s => s.fee == null) ? ' + the last step' : ''}</b></div><div><span class="mut">Items</span><b>${ops.length}</b></div>`;
    q('go').removeAttribute('disabled'); if (steps.length > 1) q('go').textContent = `Move (${steps.length} steps)`;
    q('go').addEventListener('click', async () => { q('go').setAttribute('disabled', ''); try { await runSteps(k, steps, q('msg'), () => setTimeout(load, 4000)); } catch (err) { q('msg').innerHTML = `<span class="err">${esc(friendly(err, k))}</span>`; q('go').removeAttribute('disabled'); } });
  } catch (e) { q('sum').innerHTML = `<div class="err small">${esc(friendly(e, k))}</div>`; }
}

page.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-iw]'); if (!b) return;
  if (b.dataset.iw === 'copy') navigator.clipboard?.writeText(W).then(() => { b.textContent = '✓'; }).catch(() => {});
  if (b.dataset.iw === 'refresh') load();
  if (b.dataset.iw === 'connect') { e.preventDefault(); openConnect(); }
  if (b.dataset.iw === 'send') openSend();
  if (b.dataset.iw === 'move') openMove(b.dataset.k as FwChain);
});
onWallet(() => draw());
draw(); if (Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX) load();
// Read-only test hook (quotes only; never signs): enabled with localStorage multisea-debug=1.
if (localStorage.getItem('multisea-debug') === '1') (window as any).__iw2 = { S, W, plan, callFor, assets, resolveRecipient, liveCh, isOwner, migratePlan, dstGas, lzOpts };
