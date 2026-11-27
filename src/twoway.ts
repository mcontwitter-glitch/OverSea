// Two-way check before a creator pays to list a collection on the bridge. ERC721-C collections (Limit Break transfer
// validator) can block contract-initiated transfers; then a MultiSea escrow could take NFTs in but never send them back.
// We ask the validator whether a non-whitelisted contract (the factory stands in for the future escrow) may send a token
// back to the owner. Refused -> one-way -> don't charge. MultiSeaFactoryV3 enforces the same rule on-chain (OneWayCollection).
import { parseAbi, type Address } from 'viem';
const HAS = parseAbi(['function getTransferValidator() view returns (address)']);
const SIM = parseAbi(['function validateTransferSim(address collection, address caller, address from, address to, uint256 tokenId) view returns (bool, bytes4)']);
export async function oneWayReason(pub: any, nft: Address, owner: Address, probe: Address): Promise<string> {
  const v = await pub.readContract({ address: nft, abi: HAS, functionName: 'getTransferValidator' }).catch(() => null) as Address | null;
  if (!v || /^0x0{40}$/i.test(v)) return '';
  try {
    const [ok] = await pub.readContract({ address: v, abi: SIM, functionName: 'validateTransferSim', args: [nft, probe, probe, owner, 0n] }) as [boolean, string];
    if (ok) return '';
  } catch { /* validator can't be asked: treat as one-way, same as the escrow does */ }
  return `This collection's creator transfer rules (validator ${v.slice(0, 6)}…${v.slice(-4)}) block contracts from sending NFTs, so a MultiSea escrow could take NFTs in but never send them back. Nothing was charged. To bridge it, the contract owner has to allow MultiSea's escrow on the collection's transfer whitelist (or allow OTC transfers for smart wallets) first.`;
}
