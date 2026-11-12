// Island's (multi-islands) token wallets: ERC-6551 accounts through the standard registry and the Tokenbound V3
// account proxy (already on all 5 chains), salt 0, bound to each chain's own drop contract and chain id. So every
// Island has a different wallet address on each chain; an undeployed address is shown as is (created on first use).
import { concat, encodeAbiParameters, getContractAddress, type Hex } from 'viem';
import CFG from '../config/collections.json';
import type { FwChain } from './footkit';

export const TB = {
  registry: '0x000000006551c19487814612e58FE06813775758' as Hex,
  proxy: '0x55266d75D1a14E4572138116aF39863Ed6596E7F' as Hex, // Tokenbound V3 AccountProxy (the registry implementation arg)
  salt: ('0x' + '0'.repeat(64)) as Hex,
};
const IS = CFG.collections.find(c => c.slug === 'multi-islands')!;
export const ISLAND_SLUG = IS.slug;
export const ISLAND_MAX = IS.idEnd;
export const ISLAND_CHAINS: readonly FwChain[] = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
export const ISLAND_ADDR = Object.fromEntries(IS.deployments.map(d => [d.chain, d.address as Hex])) as Record<FwChain, Hex>;
export const chainIdOf = (k: FwChain) => BigInt((CFG.chains as any)[k].chainId);
export const islandName = (id: number) => `Island #${id}`;
/** Same as registry.account(proxy, 0, chainId, drop, id) on chain k (checked against mainnet). */
export function islandTba(k: FwChain, id: number | bigint): Hex {
  return getContractAddress({ opcode: 'CREATE2', from: TB.registry, salt: TB.salt, bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', TB.proxy, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [TB.salt, chainIdOf(k), ISLAND_ADDR[k], BigInt(id)])]) });
}
export const islandWalletUrl = (id: number, k?: string) => `/w/${ISLAND_SLUG}/${id}${k ? '?chain=' + k : ''}`;
