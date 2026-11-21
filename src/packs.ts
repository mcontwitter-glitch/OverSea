// EVM card packs: create-flow fields, drop mint, and the My packs / open-reveal page.
import { decodeEventLog, formatEther, zeroAddress, type Address, type Abi } from 'viem';
import LP from '../config/launchpad.json';
import CFG from '../config/collections.json';
import { wallet, onWallet, openConnect, ensureChain, vchain, readClient, friendly, API } from './wallet';
import { navHtml, bindNav, esc } from './shell';
import { type Drop } from './launchdata';

export const isPackDrop = (d: { nftType?: string } | null | undefined) => d?.nftType === 'packs';

export type PackRarityIn = { name: string; weight: string; cap: string };
export type PackTierIn = { name: string; cardsPerPack: string; guaranteedRarity: string; maxPacks: string; price: string; usd?: string };
export type PackState = { packName: string; packSymbol: string; rarities: PackRarityIn[]; tiers: PackTierIn[]; cardRarity: string[] };

export const defaultPacks = (): PackState => ({
  packName: '', packSymbol: '',
  rarities: [
    { name: 'Common', weight: '70', cap: '' },
    { name: 'Rare', weight: '25', cap: '' },
    { name: 'Legendary', weight: '5', cap: '' },
  ],
  tiers: [{ name: 'Standard', cardsPerPack: '5', guaranteedRarity: '0', maxPacks: '0', price: '0.01', usd: '' }],
  cardRarity: [],
});

export const packCapSum = (p: PackState) => p.rarities.reduce((a, r) => a + (parseInt(r.cap) || 0), 0);

export function packProblem(p: PackState, fileCount: number, ownUri: boolean): string {
  if (p.rarities.length < 1 || p.rarities.length > 16) return 'Card packs: add 1–16 rarity tiers.';
  let w = 0, cap = 0;
  for (const r of p.rarities) {
    const ww = +r.weight, cc = parseInt(r.cap);
    if (!r.name.trim()) return 'Each rarity needs a name.';
    if (!(Number.isInteger(ww) && ww > 0 && ww <= 1_000_000)) return `Rarity “${r.name}”: weight must be a positive integer.`;
    if (!(Number.isInteger(cc) && cc > 0 && cc <= 1_000_000)) return `Rarity “${r.name}”: set a supply cap (how many of this rarity can ever be pulled).`;
    w += ww; cap += cc;
  }
  if (cap < 1) return 'Rarity caps must add up to at least 1 card.';
  if (!ownUri && fileCount < 1) return 'Upload at least one card image (or use your own card metadata base URI).';
  if (!ownUri) {
    for (let i = 0; i < fileCount; i++) {
      const id = parseInt(p.cardRarity[i] || '1');
      if (!(id >= 1 && id <= p.rarities.length)) return `Card ${i + 1}: pick a rarity.`;
    }
    const used = new Set((p.cardRarity.slice(0, fileCount).map(x => parseInt(x) || 1)));
    for (let i = 1; i <= p.rarities.length; i++) if (!used.has(i)) return `Every rarity with a cap needs at least one card. Assign one to “${p.rarities[i - 1].name}”.`;
  }
  if (p.tiers.length < 1 || p.tiers.length > 8) return 'Add 1–8 pack tiers.';
  for (const t of p.tiers) {
    const n = parseInt(t.cardsPerPack), g = parseInt(t.guaranteedRarity || '0'), m = parseInt(t.maxPacks || '0');
    if (!t.name.trim()) return 'Each pack tier needs a name.';
    if (!(n >= 1 && n <= 20)) return `Pack “${t.name}”: cards per pack must be 1–20.`;
    if (g < 0 || g > p.rarities.length) return `Pack “${t.name}”: guaranteed rarity is out of range.`;
    if (m < 0 || m > 1_000_000) return `Pack “${t.name}”: max packs is too large.`;
    if (!(+t.price >= 0) && !t.usd) return `Pack “${t.name}”: set a price.`;
  }
  return '';
}

export function packPayload(p: PackState, fileCount: number, ownUri: boolean, cardBaseURI: string) {
  const rarities = p.rarities.map(r => ({ name: r.name.trim(), weight: parseInt(r.weight), cap: parseInt(r.cap) }));
  const cards = ownUri
    ? rarities.map((_, i) => ({ rarityId: i + 1, weight: 0 }))
    : Array.from({ length: fileCount }, (_, i) => ({ rarityId: parseInt(p.cardRarity[i] || '1'), weight: 0 }));
  const tiers = p.tiers.map(t => ({
    name: t.name.trim(),
    cardsPerPack: parseInt(t.cardsPerPack),
    guaranteedRarity: parseInt(t.guaranteedRarity || '0'),
    maxPacks: parseInt(t.maxPacks || '0'),
    price: t.price,
    priceUsd: t.usd !== undefined && t.usd !== '' ? +t.usd : undefined,
  }));
  return {
    packName: p.packName.trim(), packSymbol: p.packSymbol.trim(),
    rarities, cards, tiers, cardBaseURI, packBaseURI: cardBaseURI.replace(/\/cards\/?$/, '/packs/'),
  };
}

export function packBox(p: PackState, fileNames: string[], isMc: boolean, inpTierPrice: (i: number, t: PackTierIn) => string): string {
  const rar = p.rarities.map((r, i) => `<div class="ldphin ldpackr"><div class="ldphinh"><b>Rarity ${i + 1}</b>${p.rarities.length > 1 ? `<button class="x" data-rmrar="${i}" aria-label="Remove rarity">✕</button>` : ''}</div>
    <div class="two"><label>Name<input data-pr="${i}" data-f="name" value="${esc(r.name)}" maxlength="24"></label><label>Weight <span class="mut small">e.g. 70 / 25 / 5</span><input type="number" min="1" data-pr="${i}" data-f="weight" value="${esc(r.weight)}"></label></div>
    <label>Supply cap <span class="mut small">max cards of this rarity, all packs, every chain</span><input type="number" min="1" data-pr="${i}" data-f="cap" value="${esc(r.cap)}" placeholder="700"></label></div>`).join('');
  const cards = fileNames.length ? `<div class="gh pad">Card set</div><p class="mut small">Each uploaded image is one card. Assign a rarity; pulls of that rarity pick uniformly among its cards. Caps are per rarity, not per card.</p>
    <div class="ldpackcards">${fileNames.map((n, i) => `<label class="ldpackcard"><span class="mut small">${esc(n)}</span><select data-pcr="${i}">${p.rarities.map((r, j) => `<option value="${j + 1}" ${(p.cardRarity[i] || '1') === String(j + 1) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`).join('')}</div>` : `<p class="mut small">Upload the card art in the Art step. You’ll assign each image a rarity here.</p>`;
  const tiers = p.tiers.map((t, i) => `<div class="ldphin"><div class="ldphinh"><b>Pack tier ${i + 1}</b>${p.tiers.length > 1 ? `<button class="x" data-rmtier="${i}" aria-label="Remove tier">✕</button>` : ''}</div>
    <div class="two"><label>Name<input data-pt="${i}" data-f="name" value="${esc(t.name)}" maxlength="32"></label><label>Cards per pack<input type="number" min="1" max="20" data-pt="${i}" data-f="cardsPerPack" value="${esc(t.cardsPerPack)}"></label></div>
    <div class="two"><label>Guaranteed slot<select data-pt="${i}" data-f="guaranteedRarity"><option value="0" ${t.guaranteedRarity === '0' ? 'selected' : ''}>None</option>${p.rarities.map((r, j) => `<option value="${j + 1}" ${t.guaranteedRarity === String(j + 1) ? 'selected' : ''}>At least 1 ${esc(r.name)}</option>`).join('')}</select></label><label>Max packs <span class="mut small">0 = only limited by card caps</span><input type="number" min="0" data-pt="${i}" data-f="maxPacks" value="${esc(t.maxPacks)}"></label></div>
    ${inpTierPrice(i, t)}</div>`).join('');
  return `<div class="ldpack">
    <div class="ldnote small">🃏 <b>Card packs:</b> you upload a card set and set rarity weights (e.g. common 70 / rare 25 / legendary 5) plus a supply cap per rarity. Collectors buy sealed ERC-1155 packs (tradable on MultiSea and OpenSea). Opening burns the pack and, a few blocks later, reveals the ERC-721 cards using a future blockhash (no Chainlink VRF). If they wait more than 256 blocks they can safely recommit. ${isMc ? 'Sold on every selected EVM chain with a shared card supply (Base is the hub). Sealed packs and opened cards can be moved with LayerZero, same pattern as omni drops. ' : ''}Solana is not in this release.</div>
    <div class="two">${label('packName', 'Pack collection name', p.packName, 'placeholder="Island Packs"')}${label('packSymbol', 'Pack symbol', p.packSymbol, 'placeholder="IPACK" maxlength="12"')}</div>
    <div class="gh pad">Rarity tiers</div>${rar}<button type="button" class="pill sm" data-act="addrar">+ Rarity</button>
    ${cards}
    <div class="gh pad">Pack tiers</div>${tiers}<button type="button" class="pill sm" data-act="addtier">+ Pack tier</button>
    <p class="mut small">Total card supply (sum of rarity caps): <b>${packCapSum(p).toLocaleString() || '—'}</b>. Sale windows and allowlists are set in the next (phases) step; each pack tier has its own price above.</p>
  </div>`;
}

function label(k: string, title: string, v: string, extra = '') {
  return `<label>${title}<input data-pk="${k}" value="${esc(v)}" ${extra}></label>`;
}

export function applyPackInput(p: PackState, t: HTMLInputElement | HTMLSelectElement): boolean {
  if (t.dataset.pk) { (p as any)[t.dataset.pk] = t.value; return true; }
  if (t.dataset.pr) { (p.rarities[+t.dataset.pr] as any)[t.dataset.f!] = t.value; return true; }
  if (t.dataset.pt) { (p.tiers[+t.dataset.pt] as any)[t.dataset.f!] = t.value; return true; }
  if (t.dataset.pcr) { p.cardRarity[+t.dataset.pcr] = t.value; return true; }
  return false;
}

export function applyPackClick(p: PackState, act: string, rm?: string): boolean {
  if (act === 'addrar' && p.rarities.length < 16) { p.rarities.push({ name: '', weight: '10', cap: '' }); return true; }
  if (act === 'addtier' && p.tiers.length < 8) { p.tiers.push({ name: '', cardsPerPack: '5', guaranteedRarity: '0', maxPacks: '0', price: '0.01', usd: '' }); return true; }
  if (rm === 'rmrar') { const i = +act; if (p.rarities.length > 1) p.rarities.splice(i, 1); return true; }
  return false;
}

// ---- on-chain ABI (subset) ----
const PACKS_ABI = [
  { type: 'function', name: 'quoteMint', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint16' }, { type: 'uint32' }, { type: 'uint128' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'payable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'uint32' }, { type: 'bytes32[]' }, { type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'open', stateMutability: 'nonpayable', inputs: [{ type: 'uint16' }, { type: 'uint16' }], outputs: [] },
  { type: 'function', name: 'quoteReveal', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint128' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'reveal', stateMutability: 'payable', inputs: [{ type: 'uint256' }, { type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'isHub', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'collectionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hubEid', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'localEid', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'escrow', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cardsInPack', stateMutability: 'view', inputs: [{ type: 'uint16' }, { type: 'uint32' }], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'recommit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tierCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tiers', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple[]', components: [{ name: 'name', type: 'string' }, { name: 'cardsPerPack', type: 'uint8' }, { name: 'guaranteedRarity', type: 'uint8' }, { name: 'maxPacks', type: 'uint32' }, { name: 'price', type: 'uint128' }] }] },
  { type: 'function', name: 'rarities', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple[]', components: [{ name: 'name', type: 'string' }, { name: 'weight', type: 'uint32' }, { name: 'cap', type: 'uint32' }] }] },
  { type: 'function', name: 'nextCommitId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'commits', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }, { name: 'revealBlock', type: 'uint32' }, { name: 'tierId', type: 'uint16' }, { name: 'qty', type: 'uint16' }, { name: 'status', type: 'uint8' }, { name: 'seed', type: 'bytes32' }] },
  { type: 'function', name: 'cards', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'Opened', inputs: [{ name: 'commitId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'tierId', type: 'uint16' }, { name: 'qty', type: 'uint16' }, { name: 'revealBlock', type: 'uint32' }] },
  { type: 'event', name: 'Revealed', inputs: [{ name: 'commitId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'firstId', type: 'uint256' }, { name: 'cards', type: 'uint16' }] },
] as const satisfies Abi;

const CARDS_ABI = [
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'cardTypeOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const satisfies Abi;

const FACTORY_ABI = [
  { type: 'function', name: 'createPackDrop', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: [] }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [{ type: 'address' }, { type: 'address' }] },
  { type: 'event', name: 'PackDropCreated', inputs: [{ name: 'packs', type: 'address', indexed: true }, { name: 'cards', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'collectionId', type: 'bytes32', indexed: false }, { name: 'feeBps', type: 'uint16', indexed: false }] },
  { type: 'function', name: 'usedSalt', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'predictPacks', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'predictCards', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;

export function packFactoryOn(k: string): Address | null {
  return (LP as any).packDrops?.factories?.[k] || null;
}

const HUB = (LP as any).hubChain || 'base';
const LZ_BUF_NUM = 13n;
const LZ_BUF_DEN = 10n; // +30% safety buffer on the hub return-path drop, same as omni mints
const ESCROW_ABI = [
  { type: 'function', name: 'quoteMintReturn', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quoteRevealReturn', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'refundOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimRefund', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
] as const satisfies Abi;

function packEscrowOn(k: string): Address | null {
  const a = (LP as any).packDrops?.escrows?.[k];
  return a && a !== zeroAddress ? a as Address : null;
}
function natOf(k: string) { return (CFG.chains as any)?.[k]?.native || 'ETH'; }
function fmtAmt(w: bigint) { const s = formatEther(w); return s.replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, ''); }

async function hubValueFor(kind: 'mint' | 'reveal', origin: string, drop: Address, qtyOrCards: number): Promise<bigint> {
  const pub = readClient(origin);
  const [isHub, escrow] = await Promise.all([
    pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'isHub' }) as Promise<boolean>,
    pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'escrow' }) as Promise<Address>,
  ]);
  if (isHub || !escrow || escrow === zeroAddress) return 0n;
  const [cid, localEid] = await Promise.all([
    pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'collectionId' }) as Promise<`0x${string}`>,
    pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'localEid' }) as Promise<number>,
  ]);
  const hubEsc = packEscrowOn(HUB);
  if (!hubEsc) throw new Error('No pack escrow on the hub chain yet. Pack factories have not been recorded.');
  const fn = kind === 'mint' ? 'quoteMintReturn' : 'quoteRevealReturn';
  const raw = await readClient(HUB).readContract({ address: hubEsc, abi: ESCROW_ABI, functionName: fn, args: [cid, localEid, qtyOrCards] }) as bigint;
  return (raw * LZ_BUF_NUM) / LZ_BUF_DEN;
}

export async function packMintQuote(k: string, drop: Address, phaseId: number, tierId: number, qty: number) {
  const hubValue = await hubValueFor('mint', k, drop, qty);
  const [price, lz] = await readClient(k).readContract({ address: drop, abi: PACKS_ABI, functionName: 'quoteMint', args: [BigInt(phaseId), tierId, qty, hubValue] }) as [bigint, bigint];
  return { price, lz, hubValue, value: price + lz };
}

export async function packRevealQuote(k: string, drop: Address, commitId: bigint) {
  const pub = readClient(k);
  const c: any = await pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'commits', args: [commitId] });
  const nCards = Number(await pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'cardsInPack', args: [c[2], c[3]] }));
  const hubValue = await hubValueFor('reveal', k, drop, nCards || 1);
  const lz = await pub.readContract({ address: drop, abi: PACKS_ABI, functionName: 'quoteReveal', args: [commitId, hubValue] }) as bigint;
  return { lz, hubValue, value: lz, cards: nCards };
}

export async function fillPackMintQuote(d: Drop, chain: string, phaseId: number) {
  const box = document.querySelector<HTMLElement>('.ldpackmint');
  const el = document.querySelector<HTMLElement>('[data-packprice]');
  if (!box || !el) return;
  const addr = (d as any).addresses?.[chain] as Address | undefined;
  const run = async () => {
    if (!addr) { el.innerHTML = ''; return; }
    const tier = +((box.querySelector('[data-tier]') as HTMLSelectElement)?.value || 1);
    const qty = Math.max(1, Math.min(20, parseInt((box.querySelector('[data-qty]') as HTMLInputElement)?.value || '1') || 1));
    el.innerHTML = '<span class="spin"></span> Quoting…';
    try {
      const q = await packMintQuote(chain, addr, phaseId, tier, qty);
      const nat = natOf(chain);
      el.innerHTML = q.lz
        ? `<div>Packs <b>${fmtAmt(q.price)} ${esc(nat)}</b></div><div>LayerZero (round trip) <b>${fmtAmt(q.lz)} ${esc(nat)}</b><i class="usd">Your payment funds the confirm (and card copies on reveal) with a 30% buffer. Leftover is claimable on the hub chain.</i></div><div>Total <b>${fmtAmt(q.value)} ${esc(nat)}</b></div>`
        : `<div>Total <b>${fmtAmt(q.price)} ${esc(nat)}</b></div>`;
    } catch (e: any) {
      el.innerHTML = `<span class="err">${esc(friendly(e) || e?.shortMessage || e?.message || 'Could not quote')}</span>`;
    }
  };
  await run();
  if (box.dataset.qbound) return;
  box.dataset.qbound = '1';
  box.addEventListener('change', () => { run(); });
  box.addEventListener('input', ev => { if ((ev.target as HTMLElement)?.hasAttribute?.('data-qty')) run(); });
}

export async function mintPack(k: string, drop: Address, to: Address, phaseId: number, tierId: number, qty: number, proof: `0x${string}`[], onTx: (h: string) => void) {
  const pub = readClient(k);
  const q = await packMintQuote(k, drop, phaseId, tierId, qty);
  const { walletOn } = await import('./lpchain') as any;
  const ww = await walletOn(k);
  const args = [to, BigInt(phaseId), tierId, qty, proof, q.hubValue] as const;
  const sim = await pub.simulateContract({ address: drop, abi: PACKS_ABI, functionName: 'mint', args, account: wallet.address as Address, value: q.value });
  const gas = await pub.estimateContractGas({ address: drop, abi: PACKS_ABI, functionName: 'mint', args, account: wallet.address as Address, value: q.value });
  const hash = await ww.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: wallet.address as Address, value: q.value });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('mint reverted');
  return hash;
}

export async function openPack(k: string, drop: Address, tierId: number, qty: number, onTx: (h: string) => void): Promise<bigint> {
  const { walletOn } = await import('./lpchain') as any;
  const ww = await walletOn(k);
  const pub = readClient(k);
  const sim = await pub.simulateContract({ address: drop, abi: PACKS_ABI, functionName: 'open', args: [tierId, qty], account: wallet.address as Address });
  const gas = await pub.estimateContractGas({ address: drop, abi: PACKS_ABI, functionName: 'open', args: [tierId, qty], account: wallet.address as Address });
  const hash = await ww.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: wallet.address as Address });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('open reverted');
  let commitId = 0n;
  for (const l of r.logs) {
    try { const e: any = decodeEventLog({ abi: PACKS_ABI, data: l.data, topics: l.topics }); if (e.eventName === 'Opened') commitId = e.args.commitId; } catch {}
  }
  return commitId;
}

export async function revealPack(k: string, drop: Address, commitId: bigint, onTx: (h: string) => void, fn: 'reveal' | 'recommit' = 'reveal') {
  const { walletOn } = await import('./lpchain') as any;
  const ww = await walletOn(k);
  const pub = readClient(k);
  let value = 0n;
  let hubValue = 0n;
  if (fn === 'reveal') {
    const q = await packRevealQuote(k, drop, commitId);
    value = q.value;
    hubValue = q.hubValue;
  }
  const args = { address: drop, abi: PACKS_ABI, functionName: fn, args: fn === 'reveal' ? [commitId, hubValue] : [commitId], account: wallet.address as Address, ...(fn === 'reveal' ? { value } : {}) } as any;
  const sim = await pub.simulateContract(args);
  const gas = await pub.estimateContractGas(args);
  const hash = await ww.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: wallet.address as Address, ...(fn === 'reveal' ? { value } : {}) });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(fn + ' reverted');
  return r;
}

export function packMintBox(d: Drop, chain: string, _phaseId: number, qty: number, busy: boolean): string {
  const tiers = d.packs?.tiers || [];
  if (!tiers.length) return '<p class="mut">This pack drop has no tiers yet.</p>';
  const opts = tiers.map((t: any, i: number) => `<option value="${i + 1}">${esc(t.name)} · ${t.cardsPerPack} cards${t.guaranteedRarity ? ` · guaranteed ${esc((d.packs?.rarities?.[t.guaranteedRarity - 1]?.name) || 'rare')}` : ''}</option>`).join('');
  const addrs = d.addresses || {};
  const live = !!addrs[chain];
  return `<div class="fcard ldmintbox ldpackmint"><div class="gh">Buy a pack</div>
    <p class="mut small">Sealed packs are ERC-1155 and tradable. Open them from <a href="/my-packs">My packs</a> — a later transaction reveals the cards with a short animation. On a non-hub chain the mint total includes the LayerZero round-trip fee so the confirm is paid from your payment, not a pre-funded escrow.</p>
    <label>Pack tier<select data-tier>${opts}</select></label>
    <div class="two"><label>Quantity<input type="number" min="1" max="20" data-qty value="${qty}"></label><div class="mut small" data-packprice></div></div>
    ${live ? (wallet.address ? `<button class="bbtn ldmint" data-act="mintpack" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span> Minting…' : 'Mint packs'}</button>` : '<button class="bbtn ldmint" data-act="connect">Connect wallet to mint</button>')
      : '<button class="bbtn" disabled>Minting opens once this drop is deployed</button>'}
  </div>`;
}

/** /my-packs — sealed packs in the connected wallet, open + reveal with a pull animation. */
export async function myPacksPage() {
  const app = document.getElementById('app')!;
  document.title = 'My packs · MultiSea';
  let busy = '';
  let pulled: { name?: string; image?: string; rarity?: string }[] = [];
  let msg = '';

  async function drops(): Promise<Drop[]> {
    try {
      const j = await fetch(API + '/launchpad/drops').then(r => r.ok ? r.json() : { drops: [] });
      const list = (j.drops || []) as any[];
      return list.filter((d: any) => d.nftType === 'packs' || d.packs).map((d: any) => ({
        ...d,
        addresses: Object.fromEntries((d.deployments || d.addresses && Object.entries(d.addresses) || []).map((x: any) => Array.isArray(x) ? x : [x.chain, x.address])),
      }));
    } catch { return []; }
  }

  async function render() {
    app.innerHTML = `${navHtml('launchpad')}<main class="page ld"><h1>My packs</h1>
      <p class="mut">Open a sealed pack, wait a few blocks, then reveal. The pull uses a future blockhash — if you wait more than 256 blocks, recommit and try again. Your cards land in this wallet and show in your collection.</p>
      ${!wallet.address ? `<div class="fcard cta"><p>Connect a wallet to see packs you hold.</p><button class="bbtn" data-act="connect">Connect wallet</button></div>` : `<div id="packlist"><span class="spin"></span> Loading…</div>`}
      ${pulled.length ? `<div class="ldpulls">${pulled.map((c, i) => `<div class="ldpull ${c.rarity ? 'r-' + esc(c.rarity.toLowerCase()) : ''}" style="animation-delay:${i * 120}ms"><div class="ldpullin">${c.image ? `<img src="${esc(c.image)}" alt="">` : '<div class="nftgalph">★</div>'}<b>${esc(c.name || 'Card')}</b><span class="mut small">${esc(c.rarity || '')}</span></div></div>`).join('')}</div>` : ''}
      ${msg ? `<p class="${/fail|error|revert/i.test(msg) ? 'err' : 'mut'}">${esc(msg)}</p>` : ''}
      ${busy ? `<p class="mut"><span class="spin"></span> ${esc(busy)}</p>` : ''}
    </main>`;
    bindNav();
    if (!wallet.address) return;
    const list = document.getElementById('packlist');
    if (!list) return;
    const ds = await drops();
    const me = wallet.address as Address;
    const rows: string[] = [];
    for (const d of ds) {
      const addrs = d.addresses || {};
      for (const [chain, addr] of Object.entries(addrs)) {
        if (!addr) continue;
        try {
          const pub = readClient(chain);
          const nT = Number(await pub.readContract({ address: addr as Address, abi: PACKS_ABI, functionName: 'tierCount' }));
          const tiers = d.packs?.tiers || [];
          for (let t = 1; t <= nT; t++) {
            const bal = await pub.readContract({ address: addr as Address, abi: PACKS_ABI, functionName: 'balanceOf', args: [me, BigInt(t)] }) as bigint;
            if (!bal) continue;
            const name = tiers[t - 1]?.name || `Tier ${t}`;
            rows.push(`<div class="fcard ldpackrow"><div><b>${esc(d.name)}</b> · ${esc(name)} × ${bal.toString()} <span class="mut small">${esc(chain)}</span></div>
              <div class="row"><input type="number" min="1" max="${bal}" value="1" data-qty="${d.slug}:${chain}:${t}"><button class="bbtn sm" data-open="${d.slug}:${chain}:${addr}:${t}" ${busy ? 'disabled' : ''}>Open</button></div></div>`);
          }
        } catch {}
      }
    }
    let claimHtml = '';
    const hubEsc = packEscrowOn(HUB);
    if (hubEsc && wallet.address) {
      try {
        const due = await readClient(HUB).readContract({ address: hubEsc, abi: ESCROW_ABI, functionName: 'refundOf', args: [me] }) as bigint;
        if (due > 0n) claimHtml = `<div class="fcard"><p>Unspent LayerZero buffer on the hub: <b>${fmtAmt(due)} ${esc(natOf(HUB))}</b>.</p><button class="bbtn sm" data-claimhub ${busy ? 'disabled' : ''}>Claim leftover</button></div>`;
      } catch {}
    }
    list.innerHTML = (rows.join('') || '<p class="mut">No sealed packs in this wallet. Mint one from a <a href="/launchpad">Card packs</a> drop.</p>') + claimHtml;
  }

  app.addEventListener('click', async e => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="connect"]')) { openConnect(); return; }
    const cl = t.closest<HTMLElement>('[data-claimhub]');
    if (cl && !busy) {
      const hubEsc = packEscrowOn(HUB);
      if (!hubEsc || !wallet.address) return;
      busy = 'Claiming leftover…'; msg = ''; render();
      try {
        const { walletOn } = await import('./lpchain') as any;
        const ww = await walletOn(HUB);
        const pub = readClient(HUB);
        const sim = await pub.simulateContract({ address: hubEsc, abi: ESCROW_ABI, functionName: 'claimRefund', args: [wallet.address as Address], account: wallet.address as Address });
        const gas = await pub.estimateContractGas({ ...sim.request });
        const hash = await ww.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(HUB), account: wallet.address as Address });
        busy = 'Claim sent ' + hash.slice(0, 10) + '…'; render();
        await pub.waitForTransactionReceipt({ hash });
        busy = ''; msg = 'Claimed leftover LayerZero buffer on the hub.'; render();
      } catch (er: any) { msg = friendly(er) || er?.message || String(er); busy = ''; render(); }
      return;
    }
    const o = t.closest<HTMLElement>('[data-open]');
    if (!o || busy) return;
    const [slug, chain, addr, tier] = o.dataset.open!.split(':');
    const qel = app.querySelector<HTMLInputElement>(`[data-qty="${slug}:${chain}:${tier}"]`);
    const qty = Math.max(1, Math.min(20, parseInt(qel?.value || '1') || 1));
    busy = 'Opening…'; msg = ''; pulled = []; render();
    try {
      const id = await openPack(chain, addr as Address, +tier, qty, h => { busy = 'Open sent ' + h.slice(0, 10) + '…'; render(); });
      busy = 'Waiting a few blocks to reveal…'; render();
      // poll until we can reveal
      const pub = readClient(chain);
      for (let i = 0; i < 40; i++) {
        const c: any = await pub.readContract({ address: addr as Address, abi: PACKS_ABI, functionName: 'commits', args: [id] });
        const bn = await pub.getBlockNumber();
        if (bn > BigInt(c[1])) {
          let feeNote = '';
          try {
            const q = await packRevealQuote(chain, addr as Address, id);
            if (q.value) feeNote = ` LayerZero ${fmtAmt(q.value)} ${natOf(chain)}.`;
          } catch {}
          busy = 'Revealing…' + feeNote; render();
          const rec = await revealPack(chain, addr as Address, id, h => { busy = 'Reveal sent ' + h.slice(0, 10) + '…'; render(); });
          let first = 0n, n = 0;
          for (const l of rec.logs) {
            try { const ev: any = decodeEventLog({ abi: PACKS_ABI, data: l.data, topics: l.topics }); if (ev.eventName === 'Revealed') { first = ev.args.firstId; n = Number(ev.args.cards); } } catch {}
          }
          const cardsAddr = await pub.readContract({ address: addr as Address, abi: PACKS_ABI, functionName: 'cards' }) as Address;
          const items: typeof pulled = [];
          for (let k = 0; k < n; k++) {
            try {
              const uri = await pub.readContract({ address: cardsAddr, abi: CARDS_ABI, functionName: 'tokenURI', args: [first + BigInt(k)] }) as string;
              const u = uri.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + uri.slice(7) : uri;
              const meta = await fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
              const img = meta?.image ? String(meta.image).replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : '';
              items.push({ name: meta?.name || `Card #${first + BigInt(k)}`, image: img, rarity: meta?.attributes?.find((a: any) => /rarity/i.test(a.trait_type || ''))?.value });
            } catch { items.push({ name: `Card #${first + BigInt(k)}` }); }
          }
          pulled = items; busy = ''; msg = n ? `You pulled ${n} card${n === 1 ? '' : 's'}.` : 'Revealed.'; render();
          return;
        }
        await new Promise(r => setTimeout(r, 4000));
      }
      msg = 'The reveal block is taking longer than expected. You can come back and reveal this pack from this page.'; busy = ''; render();
    } catch (er: any) {
      msg = friendly(er) || er?.message || String(er); busy = ''; render();
    }
  });
  onWallet(render);
  render();
}

export { PACKS_ABI, FACTORY_ABI };
