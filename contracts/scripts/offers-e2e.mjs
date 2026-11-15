// Local anvil UI test for collection offers. Uses Anvil's well-known test accounts only. Never touches owner keys or mainnet.
import { createPublicClient, createWalletClient, http, encodeDeployData, parseAbi, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ART = JSON.parse(readFileSync(join(root, 'config/collection-offers-artifact.json'), 'utf8'));
const NFT_ART = JSON.parse(readFileSync(join(root, 'contracts/out/MockERC721.sol/MockERC721.json'), 'utf8'));
const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const buyer = privateKeyToAccount(ANVIL_0);
const seller = privateKeyToAccount(ANVIL_1);
const OWNER = ART.owner;
const FEE = ART.feeRecipient;
const RPC = process.env.ANVIL_RPC || 'http://127.0.0.1:8545';

const pub = createPublicClient({ transport: http(RPC) });
const wc = (account) => createWalletClient({ account, transport: http(RPC) });

async function deploy() {
  const buyWc = wc(buyer);
  const offerBytecode = encodeDeployData({ abi: ART.abi, bytecode: ART.bytecode, args: [OWNER, FEE] });
  const nftBytecode = encodeDeployData({ abi: NFT_ART.abi, bytecode: NFT_ART.bytecode.object || NFT_ART.bytecode, args: [] });
  const h1 = await buyWc.sendTransaction({ data: offerBytecode });
  const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
  const h2 = await buyWc.sendTransaction({ data: nftBytecode });
  const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
  const offers = r1.contractAddress;
  const nft = r2.contractAddress;
  const mintAbi = parseAbi(['function mint(address,uint256)']);
  const h3 = await buyWc.writeContract({ address: nft, abi: mintAbi, functionName: 'mint', args: [seller.address, 1n] });
  await pub.waitForTransactionReceipt({ hash: h3 });
  const h4 = await buyWc.writeContract({ address: nft, abi: mintAbi, functionName: 'mint', args: [seller.address, 2n] });
  await pub.waitForTransactionReceipt({ hash: h4 });
  const cfg = { rpc: RPC, offers, nft, buyerKey: ANVIL_0, sellerKey: ANVIL_1, buyer: buyer.address, seller: seller.address, chainName: 'Anvil (Base fork)', native: 'ETH' };
  writeFileSync('/tmp/offers-test.json', JSON.stringify(cfg, null, 2));
  console.log(JSON.stringify(cfg, null, 2));
  return cfg;
}

if (process.argv[1] && process.argv[1].endsWith('offers-e2e.mjs') && process.argv[2] !== 'no-deploy') {
  await deploy();
}
export { deploy };
