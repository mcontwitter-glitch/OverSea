// /w/multi-islands/<id>?chain=<k>: an Island's token wallet (ERC-6551, Tokenbound V3, salt 0). Each chain has its own
// account address (bound to that chain's drop contract). View only: balances via RPC multicall, NFTs via the Worker.
import { formatUnits, parseAbi, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { readClient, API } from './wallet';
import { usdRates, type UsdRates } from './shell';
import { frame, chains, esc, short, logo } from './gx';
import { TOKENS, chainBalances, chainUsd, fmtUsd, rateOf, type ChainBal, type FwChain } from './footkit';
import { ISLAND_CHAINS, ISLAND_ADDR, ISLAND_MAX, islandTba, islandName, islandWalletUrl, TB } from './islandkit';

type Nft = { chain: string; contract: string; id: string; name?: string | null; image?: string | null; collection?: string };
type Ch = { k: FwChain; tba: Hex; deployed: boolean | null; owner: string | null; escrow: boolean; bal: ChainBal | null; usd: number | null };
const ERC721 = parseAbi(['function ownerOf(uint256) view returns (address)']);
const ESC = new Set((CFG.collections.find(c => c.slug === 'multi-islands')!.escrow || []).map(e => `${e.chain}:${e.address.toLowerCase()}`));
const id = +location.pathname.split('/')[3];
const page = frame('', `${islandName(id)} wallet`, 'fwpage');
const fmt = (n: bigint, d = 18) => Number(formatUnits(n, d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const img = (s?: string | null) => !s ? '' : s.startsWith('ipfs://') ? 'https://ipfs.filebase.io/ipfs/' + s.slice(7) : /^(https:\/\/|\/img\/)/.test(s) ? s : s.startsWith('/media/') ? API + s : '';
let sel = (new URLSearchParams(location.search).get('chain') || '') as FwChain;
if (!ISLAND_CHAINS.includes(sel)) sel = 'base';
const S = { cs: ISLAND_CHAINS.map(k => ({ k, tba: islandTba(k, id), deployed: null, owner: null, escrow: false, bal: null, usd: null } as Ch)), nfts: null as Nft[] | null, note: '', busy: false, rates: null as UsdRates | null };

async function load() {
  if (S.busy) return; S.busy = true; draw();
  const nft = Promise.all(S.cs.map(async c => {
    const r = await fetch(`${API}/wallet/${c.tba}/nfts?chain=${c.k}`); if (!r.ok) throw Error(chains[c.k].name);
    const j = await r.json(); if (j.failed?.length) throw Error(chains[c.k].name); return (j.nfts || []) as Nft[];
  }).map(p => p.catch((e: Error) => { S.note = `Couldn't load NFTs on ${e.message}; refresh to retry.`; return [] as Nft[]; }))).then(l => { S.nfts = l.flat(); draw(); });
  const rates = S.rates = await usdRates().catch(() => ({ ETH: null, APE: null, BNB: null } as UsdRates));
  await Promise.all(S.cs.map(async c => {
    const pc = readClient(c.k);
    const [code, owner, bal] = await Promise.all([
      pc.getCode({ address: c.tba }).then((x: Hex | undefined) => !!x && x !== '0x').catch(() => null),
      pc.readContract({ address: ISLAND_ADDR[c.k], abi: ERC721, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null) as Promise<string | null>,
      chainBalances(c.k, [c.tba]).then(r => r[0]),
    ]);
    const missing = TOKENS[c.k].some((t, i) => bal.tokens[i] && t.px !== 'USD' && rateOf(t.px, rates) == null);
    Object.assign(c, { deployed: code, owner, escrow: !!owner && ESC.has(`${c.k}:${owner.toLowerCase()}`), bal, usd: missing || bal.tokens.some(v => v == null) ? null : chainUsd(c.k, bal, rates) });
    draw();
  }));
  await nft; S.busy = false; draw();
}

function draw() {
  if (!(Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX)) { page.innerHTML = `<div class="fwcard fwsec"><h3>Not an Island</h3><p class="mut">Island's token IDs run from 1 to ${ISLAND_MAX}.</p></div>`; return; }
  const c = S.cs.find(x => x.k === sel)!, ex = chains[c.k].explorer;
  const total = S.cs.every(x => x.usd != null) ? S.cs.reduce((n, x) => n + x.usd!, 0) : null;
  const here = S.cs.find(x => x.owner && !x.escrow);
  const status = c.owner == null ? '…' : c.escrow ? `This Island is not on ${esc(chains[c.k].name)} right now (held by the bridge escrow). Only the holder on this chain controls this wallet, so wait until it is back here before using it.` : `Controlled by the holder of ${islandName(id)} on ${esc(chains[c.k].name)}: <a href="/u/${esc(c.owner)}">${esc(short(c.owner))}</a>`;
  page.innerHTML = `<div class="fw uw"><section class="fwcard fwid glow"><div class="fwtop"><div class="fwnftw"><img class="fwnft" src="/img/multi-islands/m/${id}.webp" alt="${esc(islandName(id))}" onerror="this.onerror=null;this.src='/img/multi-islands/s/${id}.webp'"></div><div style="min-width:0"><span class="fwtag">Island's token wallet</span><h1>${esc(islandName(id))}</h1><a class="small" href="/c/multi-islands?item=${id}">View the NFT →</a></div></div>
    <div class="fwacts">${S.cs.map(x => `<button class="fwbtn ${x.k === sel ? 'on' : ''}" data-iw-chain="${x.k}">${logo(x.k)} ${esc(chains[x.k].name)}</button>`).join('')}</div>
    <div class="fwaddr"><span class="mono fwfull">${c.tba}</span><button class="fwcopy" data-iw="copy" aria-label="Copy address">⧉</button></div>
    <p class="small">${logo(c.k)} ${esc(chains[c.k].name)} · ${c.deployed == null ? 'checking…' : c.deployed ? 'Account created' : 'Not created yet (the address already works; the account is created on first use)'} · <a href="${ex}/address/${c.tba}" target="_blank" rel="noopener">Explorer ↗</a></p>
    <p class="small">${status}</p>
    <div class="fwnote">Each chain has its own wallet address for this Island. Send to the address for the chain you're using.${here ? ` The Island is on ${esc(chains[here.k].name)} now.` : ''} View only.</div>
    <section class="fwsec"><div class="sechd"><h3>Address per chain</h3></div>${S.cs.map(x => `<div class="orow" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0"><span>${logo(x.k)} ${esc(chains[x.k].name)}</span><a class="mono" href="${islandWalletUrl(id, x.k)}" data-iw-chain="${x.k}">${short(x.tba)}</a></div>`).join('')}
    <p class="mut small">ERC-6551 · Tokenbound V3 (<span class="mono">${short(TB.proxy)}</span>) · registry <span class="mono">${short(TB.registry)}</span> · salt 0</p></section></section>
    <div class="fwright"><section class="fwcard fwtotal"><h3>Total value</h3><div class="v silver">${S.cs.some(x => x.bal) ? fmtUsd(total) : '…'}</div><div class="mut small">5 chains, one address each · coins and tokens priced live · NFTs not priced</div></section>
    <section class="fwcard fwsec"><div class="sechd"><h3>Balances by chain</h3></div><div class="fwgrid">${S.cs.map(x => {
      const rows: string[] = [];
      if (x.bal?.native) rows.push(`<div class="fwtok"><b>${fmt(x.bal.native)} ${esc(chains[x.k].native)}</b></div>`);
      TOKENS[x.k].forEach((t, i) => { const v = x.bal?.tokens[i]; if (v) rows.push(`<div class="fwtok"><b>${fmt(v, t.decimals)} ${esc(t.symbol)}</b></div>`); });
      return `<div class="fwch" data-chain="${x.k}"><div class="chh"><span class="chn">${logo(x.k)}${esc(chains[x.k].name)}</span><span class="chv">${x.bal ? fmtUsd(x.usd) : '…'}</span></div><div class="mut small mono">${short(x.tba)}</div>${rows.join('') || `<div class="mut small">${!x.bal ? 'Loading…' : !x.bal.ok ? 'Couldn’t read this chain' : 'Empty'}</div>`}</div>`;
    }).join('')}</div></section>
    <section class="fwcard fwsec"><div class="sechd"><h3>NFTs${S.nfts ? ' · ' + S.nfts.length : ''}</h3><button class="fwrbtn" data-iw="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Checking…' : 'Refresh'}</button></div>
    ${S.nfts?.length ? `<div class="fwnftg">${S.nfts.map(n => `<div class="nftc">${img(n.image) ? `<img src="${esc(img(n.image))}" alt="${esc(n.name || '#' + n.id)}" loading="lazy">` : '<div class="uwmissing">NFT</div>'}<div><b>${esc(n.name || '#' + n.id)}</b>${logo(n.chain)}</div><div class="mut small">${esc(chains[n.chain]?.name || n.chain)}</div></div>`).join('')}</div>` : `<p class="mut small">${S.nfts == null ? 'Loading NFTs…' : 'No NFTs found.'}</p>`}
    ${S.note ? `<p class="mut small">${esc(S.note)}</p>` : ''}</section></div></div>`;
}
page.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-iw],[data-iw-chain]'); if (!b) return;
  if (b.dataset.iwChain) { e.preventDefault(); sel = b.dataset.iwChain as FwChain; history.replaceState(null, '', islandWalletUrl(id, sel)); draw(); return; }
  if (b.dataset.iw === 'copy') navigator.clipboard?.writeText(S.cs.find(x => x.k === sel)!.tba).then(() => { b.textContent = '✓'; }).catch(() => {});
  if (b.dataset.iw === 'refresh') load();
});
draw(); if (Number.isInteger(id) && id >= 1 && id <= ISLAND_MAX) load();
