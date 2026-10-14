// Shared helpers for the LIL FOOTS mainnet cutover scripts. DRY-RUN by default: nothing is sent unless EXECUTE=1.
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

export const EXECUTE = process.env.EXECUTE === '1';
export const CHAINS = {
  abstract: { id: 2741, rpc: 'https://api.mainnet.abs.xyz', nft: '0x22Fc5BB9810Ef92db35acCea463693331bcD0A8A' },
  base: { id: 8453, rpc: 'https://mainnet.base.org', nft: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' },
  ethereum: { id: 1, rpc: 'https://ethereum-rpc.publicnode.com', nft: '0xf12476842cCbE4c7e6847eb67777f29f25419738' },
  apechain: { id: 33139, rpc: 'https://rpc.apechain.com', nft: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' },
  bnb: { id: 56, rpc: 'https://bsc-rpc.publicnode.com', nft: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' },
  robinhood: { id: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', nft: '0x1Ec054906b4A45DeBa936Aa88492D725cb06508e' },
};
export const OLD_VAULT = '0xe81DdAB112137112B8FeeB853e22BC4c38F999e5';
export const URI = 'ipfs://QmeY3guj7YMSDLbByqhU7ESDCXSsXenJtUAaxKKtkerChd/';
export const SUPPLY = 4404;
export const NFT_ABI = parseAbi(['function ownerOf(uint256) view returns (address)']);

export const pub = (k) => createPublicClient({ transport: http(process.env[`RPC_${k.toUpperCase()}`] || CHAINS[k].rpc, { batch: { batchSize: 40 }, retryCount: 6, timeout: 60000 }) });

/** id -> owner (lowercase) for every existing id on chain k. */
export async function snapshot(k) {
  const c = pub(k), own = {};
  for (let s = 1; s <= SUPPLY; s += 80) {
    const r = await Promise.all(Array.from({ length: Math.min(80, SUPPLY + 1 - s) }, (_, j) =>
      c.readContract({ address: CHAINS[k].nft, abi: NFT_ABI, functionName: 'ownerOf', args: [BigInt(s + j)] }).then(o => [s + j, o.toLowerCase()]).catch(() => null)));
    for (const x of r) if (x) own[x[0]] = x[1];
  }
  return own;
}

/** Wallet only when EXECUTE=1; key read from KEY_FILE (never printed). */
export function wallet(k) {
  if (!EXECUTE) return null;
  const f = process.env.KEY_FILE; if (!f) throw new Error('EXECUTE=1 needs KEY_FILE');
  const account = privateKeyToAccount(fs.readFileSync(f, 'utf8').trim());
  const chain = { id: CHAINS[k].id, name: k, nativeCurrency: { name: 'N', symbol: 'N', decimals: 18 }, rpcUrls: { default: { http: [CHAINS[k].rpc] } } };
  return createWalletClient({ account, chain, transport: http(CHAINS[k].rpc) });
}
export const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
