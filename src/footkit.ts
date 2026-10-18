// LIL FOOTS foot wallets: shared constants and read helpers (no UI). Every foot has one ERC-6551 token-bound
// account, bound to the Base FOOT contract + Base chain id, so its address is the same on all 5 in-scope chains.
import { concat, encodeAbiParameters, getContractAddress, parseAbi, formatUnits, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { readClient } from './wallet';
import { usdRates, type UsdRates } from './shell';

export const FW = {
  hub: '0xD6f1aEF8c8BFe9Bd9b2219374330c275Bb9BBD6A' as Hex, // FootController on Base, FootHub elsewhere (same address)
  impl: '0x02e9fE944e1604160dac0fF5f35b8cE581D1e9b3' as Hex,
  registry: '0x000000006551c19487814612e58FE06813775758' as Hex,
  zone: '0xA3BEF95d1eb1D767c9Fc93F0BADB8cAbfaaE393d' as Hex,
  baseFoot: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' as Hex,
  baseChainId: 8453n,
};
export const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex;
export const FW_CHAINS = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'] as const;
export type FwChain = (typeof FW_CHAINS)[number];
export const EID: Record<FwChain, number> = { base: 30184, ethereum: 30101, apechain: 30312, bnb: 30102, robinhood: 30416 };
export const chainOfEid = (e: number) => (Object.keys(EID) as FwChain[]).find(k => EID[k] === e) || null;
const LF = CFG.collections.find(c => c.slug === 'lil-foots')!;
export const FOOT_ADDR: Record<string, Hex> = Object.fromEntries(LF.deployments.map(d => [d.chain, d.address as Hex]));
export const FOOT_SUPPLY = LF.idEnd;
export const ABSTRACT_VAULT = (LF.escrow.find(e => e.chain === 'abstract')?.address || '') as Hex;
export const footName = (id: number) => `LIL FOOT #${id}`;
export const footEns = (id: number) => `foot${id}.multisea`;

/** ERC-6551 v0.3.1 address (same as registry.account(impl, 0, 8453, BASE_FOOT, id), checked against mainnet). */
export function footTba(id: number | bigint): Hex {
  const z = ('0x' + '0'.repeat(64)) as Hex;
  return getContractAddress({ opcode: 'CREATE2', from: FW.registry, salt: z, bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', FW.impl, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [z, FW.baseChainId, FW.baseFoot, BigInt(id)])]) });
}
/** "LIL FOOT #3958", "lil foot 3958", "foot3958.multisea", "foot3958" -> 3958 (null if not a foot name). */
export function parseFootName(s: string): number | null {
  const t = String(s || '').trim().toLowerCase();
  const m = t.match(/^lil\s*foots?\s*#?\s*(\d{1,5})$/) || t.match(/^foot(\d{1,5})(\.multisea)?$/);
  if (!m) return null; const id = +m[1]; return id >= 1 && id <= FOOT_SUPPLY ? id : null;
}

// ---- token lists (native + common ERC-20s) ----
export type Px = 'USD' | 'ETH' | 'APE' | 'BNB';
export type Tok = { symbol: string; address: Hex; decimals: number; px: Px };
export const NATIVE: Record<FwChain, { symbol: string; px: Px }> = { base: { symbol: 'ETH', px: 'ETH' }, ethereum: { symbol: 'ETH', px: 'ETH' }, apechain: { symbol: 'APE', px: 'APE' }, bnb: { symbol: 'BNB', px: 'BNB' }, robinhood: { symbol: 'ETH', px: 'ETH' } };
export const TOKENS: Record<FwChain, Tok[]> = {
  base: [{ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, px: 'USD' }, { symbol: 'USDT', address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', decimals: 6, px: 'USD' }, { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, px: 'ETH' }],
  ethereum: [{ symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, px: 'USD' }, { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, px: 'USD' }, { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, px: 'ETH' }, { symbol: 'APE', address: '0x4d224452801aced8b2f0aebe155379bb5d594381', decimals: 18, px: 'APE' }],
  apechain: [{ symbol: 'WAPE', address: '0x48b62137EdfA95a428D35C09E44256a739F6B557', decimals: 18, px: 'APE' }, { symbol: 'ApeUSD', address: '0xA2235d059F80e176D931Ef76b6C51953Eb3fBEf4', decimals: 18, px: 'USD' }, { symbol: 'ApeETH', address: '0xcF800F4948D16F23333508191B1B1591daF70438', decimals: 18, px: 'ETH' }],
  bnb: [{ symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, px: 'USD' }, { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, px: 'USD' }, { symbol: 'ETH', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, px: 'ETH' }],
  robinhood: [{ symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, px: 'USD' }],
};
const MC_ABI = parseAbi(['function getEthBalance(address) view returns (uint256)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
export type ChainBal = { native: bigint | null; tokens: (bigint | null)[]; ok: boolean };
/** Native + ERC-20 balances of many foot accounts on one chain, one multicall. */
export async function chainBalances(k: FwChain, addrs: Hex[]): Promise<ChainBal[]> {
  const contracts = addrs.flatMap(a => [{ address: MC3, abi: MC_ABI, functionName: 'getEthBalance', args: [a] }, ...TOKENS[k].map(t => ({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [a] }))]);
  try {
    const r: any[] = await readClient(k).multicall({ contracts, multicallAddress: MC3, allowFailure: true, batchSize: 4096 });
    const n = 1 + TOKENS[k].length;
    return addrs.map((_, i) => { const s = r.slice(i * n, i * n + n).map(x => (x.status === 'success' ? (x.result as bigint) : null)); return { native: s[0], tokens: s.slice(1), ok: s[0] != null }; });
  } catch { return addrs.map(() => ({ native: null, tokens: TOKENS[k].map(() => null), ok: false })); }
}
export const rateOf = (px: Px, r: UsdRates) => (px === 'USD' ? 1 : r[px]);
export function chainUsd(k: FwChain, b: ChainBal, r: UsdRates): number | null {
  if (!b.ok) return null; let v = 0; const nr = rateOf(NATIVE[k].px, r);
  if (b.native) { if (nr == null) return null; v += +formatUnits(b.native, 18) * nr; }
  TOKENS[k].forEach((t, i) => { const x = b.tokens[i]; if (x) { const tr = rateOf(t.px, r); if (tr != null) v += +formatUnits(x, t.decimals) * tr; } });
  return v;
}
/** USD value of tokens in each foot's wallet across the 5 chains (NFTs not priced). Cached 5 min per session. */
export async function walletUsd(ids: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>(); const need: number[] = []; const now = Date.now();
  let cache: Record<string, [number, number | null]> = {}; try { cache = JSON.parse(sessionStorage.getItem('multisea-fw') || '{}'); } catch {}
  ids.forEach(id => { const c = cache[id]; if (c && now - c[0] < 300_000) out.set(id, c[1]); else need.push(id); });
  if (!need.length) return out;
  const [rates, per] = await Promise.all([usdRates(), Promise.all(FW_CHAINS.map(k => chainBalances(k, need.map(footTba))))]);
  need.forEach((id, i) => { let tot = 0, ok = true; FW_CHAINS.forEach((k, ci) => { const v = chainUsd(k, per[ci][i], rates); if (v == null) ok = false; else tot += v; }); const v = ok ? tot : null; out.set(id, v); cache[id] = [now, v]; });
  try { const ks = Object.keys(cache); if (ks.length > 3000) cache = {}; sessionStorage.setItem('multisea-fw', JSON.stringify(cache)); } catch {}
  return out;
}
export const fmtUsd = (v: number | null | undefined) => (v == null || !isFinite(v) ? '-' : '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** "Wallet: $X" badge (empty string for an empty or unknown wallet unless `always`). */
export const walletBadge = (id: number, v: number | null | undefined, always = false) => (v || always ? `<a class="fwbadge" href="/w/${id}" title="Assets inside this foot's wallet (all 5 chains)">Wallet: ${v == null ? '…' : fmtUsd(v)}</a>` : '');
