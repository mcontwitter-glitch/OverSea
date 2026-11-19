// Island's (multi-islands) token wallets: ERC-6551 accounts through the standard registry and the Tokenbound V3
// account proxy (already on all 5 chains), salt 0, bound to each chain's own drop contract and chain id. So every
// Island has a different wallet address on each chain; an undeployed address is shown as is (created on first use).
import { concat, encodeAbiParameters, getContractAddress, keccak256, parseAbi, type Hex } from 'viem';
import CFG from '../config/collections.json';
import IW from '../config/island-wallet.json';
import { readClient } from './wallet';
import { TOKENS, type FwChain, type Tok } from './footkit';

export const TB = {
  registry: '0x000000006551c19487814612e58FE06813775758' as Hex,
  proxy: '0x55266d75D1a14E4572138116aF39863Ed6596E7F' as Hex, // Tokenbound V3 AccountProxy (the registry implementation arg)
  salt: ('0x' + '0'.repeat(64)) as Hex,
  impl: '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC' as Hex, // AccountV3Upgradable: the proxy's initialImplementation (initialize(impl))
};
/** EIP-1967 implementation slot. An AccountProxy with this slot empty is not initialized: calls to it do nothing. */
export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
/** Coins shown in an Island's wallet: the LIL FOOTS list plus ERC-20 forms of the other chains' coins (checked on-chain). */
export const ISLAND_TOKENS: Record<FwChain, Tok[]> = {
  base: TOKENS.base,
  ethereum: [...TOKENS.ethereum, { symbol: 'BNB', address: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52', decimals: 18, px: 'BNB' }],
  apechain: [...TOKENS.apechain, { symbol: 'WETH', address: '0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949', decimals: 18, px: 'ETH' }],
  bnb: [...TOKENS.bnb, { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, px: 'BNB' }],
  robinhood: TOKENS.robinhood,
};
const IS = CFG.collections.find(c => c.slug === 'multi-islands')!;
export const ISLAND_SLUG = IS.slug;
export const ISLAND_MAX = IS.idEnd;
export const ISLAND_CHAINS: readonly FwChain[] = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
export const ISLAND_ADDR = Object.fromEntries(IS.deployments.map(d => [d.chain, d.address as Hex])) as Record<FwChain, Hex>;
export const chainIdOf = (k: FwChain) => BigInt((CFG.chains as any)[k].chainId);
export const islandName = (id: number) => `Island #${id}`;
/** "Island #12", "Island's #12", "island 12" -> 12 (null if not an Island name). */
export function parseIslandName(s: string): number | null {
  const m = String(s || '').trim().toLowerCase().match(/^island(?:'?s)?\s*#?\s*(\d{1,4})$/);
  if (!m) return null; const id = +m[1]; return id >= 1 && id <= ISLAND_MAX ? id : null;
}
/** Same as registry.account(proxy, 0, chainId, drop, id) on chain k (checked against mainnet). */
export function islandTba(k: FwChain, id: number | bigint): Hex {
  return getContractAddress({ opcode: 'CREATE2', from: TB.registry, salt: TB.salt, bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', TB.proxy, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [TB.salt, chainIdOf(k), ISLAND_ADDR[k], BigInt(id)])]) });
}
export const islandWalletUrl = (id: number, k?: string) => `/w/${ISLAND_SLUG}/${id}${k ? '?chain=' + k : ''}`;

// ---- One Island wallet address on all 5 chains (IslandWalletFactory, contracts/src/island). Same factory address on
// every chain (deterministic deployer), wallet = CREATE2 clone keyed by the token id only. Until MC has deployed AND
// configured the factory on all 5 chains, the site keeps the per-chain ERC-6551 wallets above (iwLive() is false).
export const IW2 = { factory: IW.factory as Hex, impl: IW.implementation as Hex, saltTag: IW.saltTag as Hex };
export const IW2_FACTORY_ABI = parseAbi([
  'function walletOf(uint256) view returns (address)', 'function isDeployed(uint256) view returns (bool)', 'function deployWallet(uint256) returns (address)',
  'function liveOwner(uint256) view returns (address)', 'function configured() view returns (bool)', 'function island() view returns (address)', 'function localEid() view returns (uint32)',
  'function remoteEnabled(uint32) view returns (bool)', 'function owner() view returns (address)',
  'function quoteRemote(uint256 tokenId, uint32 dstEid, (address to, uint256 value, bytes data)[] calls, uint64 deadline, bytes options) view returns (uint256)',
  'function remoteExecute(uint256 tokenId, uint32 dstEid, (address to, uint256 value, bytes data)[] calls, uint64 deadline, bytes options) payable returns (bytes32 guid, uint64 nonce)',
]);
export const IW2_WALLET_ABI = parseAbi([
  'function execute(address to, uint256 value, bytes data) payable returns (bytes)',
  'function executeBatch((address to, uint256 value, bytes data)[] calls) payable returns (bytes[])',
  'function owner() view returns (address)',
]);
/** Island #id's wallet: the same address on Base, Ethereum, ApeChain, BNB Chain and Robinhood. */
export function islandWallet2(id: number | bigint): Hex {
  return getContractAddress({ opcode: 'CREATE2', from: IW2.factory, salt: keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [IW2.saltTag, BigInt(id)])), bytecode: concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', IW2.impl, '0x5af43d82803e903d91602b57fd5bf3']) });
}
const IWK = 'multisea-iw2-live';
/** Last probe result (sync, for list/collection renders); null if never probed. */
export function iwLiveCached(): boolean | null { try { const j = JSON.parse(localStorage.getItem(IWK) || 'null'); return j && Date.now() - j.t < 3600_000 ? !!j.v : null; } catch { return null; } }
let iwP: Promise<boolean> | null = null;
/** True only when the factory has code AND is configured (Island contract set) on all 5 chains. One RPC call on Base
 *  answers "no" while nothing is deployed, so the live site stays as fast as today. */
export function iwLive(): Promise<boolean> {
  if (localStorage.getItem('multisea-iw2-force') === '0') return Promise.resolve(false);
  return iwP ??= (async () => {
    const cfgd = async (k: FwChain) => {
      const pc = readClient(k);
      const code = await pc.getCode({ address: IW2.factory }).catch(() => undefined);
      if (!code || code === '0x') return false;
      const [c, isl] = await Promise.all([pc.readContract({ address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'configured' }), pc.readContract({ address: IW2.factory, abi: IW2_FACTORY_ABI, functionName: 'island' })]).catch(() => [false, null] as const);
      return !!c && String(isl).toLowerCase() === ISLAND_ADDR[k].toLowerCase();
    };
    let v = false;
    try { v = (await cfgd('base')) && (await Promise.all(ISLAND_CHAINS.filter(k => k !== 'base').map(cfgd))).every(Boolean); } catch { v = false; }
    try { localStorage.setItem(IWK, JSON.stringify({ t: Date.now(), v })); } catch {}
    return v;
  })();
}
