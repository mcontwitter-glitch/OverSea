// Post-deploy on-chain art upload (creator-signed batched writes + finalize) and cost estimates.
import { encodeFunctionData, formatUnits, type Address, type Hex } from 'viem';
import { createWalletClient, custom } from 'viem';
import CFG from '../config/collections.json';
import LP from '../config/launchpad.json';
import { wallet, ensureChain, readClient, vchain } from './wallet';
import { gasPrice } from './txgas';
import { esc } from './shell';

export const ONCHAIN_MAX = 24 * 1024;
export const ONCHAIN_ACCEPT = 'image/png,image/gif,image/webp,image/svg+xml,.svg,.png,.webp,.gif';
export const MIME = { 'image/svg+xml': 0, 'image/png': 1, 'image/webp': 2, 'image/gif': 3 } as const;
const ABI = [
  { type: 'function', name: 'writeArtBatch', stateMutability: 'nonpayable', inputs: [
    { name: 'ids', type: 'uint256[]' }, { name: 'mime', type: 'uint8[]' }, { name: 'image', type: 'bytes[]' },
    { name: 'name', type: 'string[]' }, { name: 'description', type: 'string[]' }, { name: 'attributes', type: 'string[]' }] },
  { type: 'function', name: 'finalizeArt', stateMutability: 'nonpayable', inputs: [] },
  { type: 'function', name: 'artFinalized', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'artWritten', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'artStoreLocal', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'writtenFlags', stateMutability: 'view', inputs: [{ name: 'start', type: 'uint256' }, { name: 'n', type: 'uint256' }], outputs: [{ type: 'bool[]' }] },
] as const;

export type ArtRow = { id: number; name: string; description: string; attributes: string; mime: number; bytes: Uint8Array; size: number; fileName: string };

export function mimeOf(file: File): number | null {
  const t = (file.type || '').toLowerCase();
  if (t in MIME) return MIME[t as keyof typeof MIME];
  const ext = (file.name.match(/\.(svg|png|webp|gif)$/i) || [])[1]?.toLowerCase();
  return ext === 'svg' ? 0 : ext === 'png' ? 1 : ext === 'webp' ? 2 : ext === 'gif' ? 3 : null;
}

export function fmtBytes(n: number) {
  return n >= 1024 ? (n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1) + ' KB' : n + ' B';
}

/** ~200 gas/byte plus per-image overhead (matches measured SSTORE2 writes: ~2.31M for 10 KiB, ~5.33M for 24 KiB). */
export function estimateGas(totalBytes: number, images: number) {
  const chunks = Math.max(images, Math.ceil(totalBytes / 24_000) || 0);
  return 200n * BigInt(totalBytes) + 80_000n * BigInt(images) + 32_000n * BigInt(chunks);
}

export async function estimateCosts(chainKeys: string[], totalBytes: number, images: number) {
  const gas = estimateGas(totalBytes, images);
  const chains = CFG.chains as Record<string, { name: string; native: string }>;
  const rows = await Promise.all(chainKeys.map(async k => {
    const gp = await gasPrice(k);
    const wei = gas * gp;
    return { k, name: chains[k]?.name || k, native: chains[k]?.native || 'ETH', gas, wei, gp, fmt: gp ? `${(+formatUnits(wei, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${chains[k]?.native || 'ETH'}` : 'gas price unavailable' };
  }));
  return { gas, rows };
}

export function costHtml(rows: Awaited<ReturnType<typeof estimateCosts>>['rows'], mode: 'home' | 'every', homeName: string) {
  if (!rows.length) return '';
  const note = mode === 'every'
    ? 'A full copy of every image is stored on each selected chain (you pay storage gas on each).'
    : `Art is stored on ${esc(homeName)} only. Other chains use a MultiSea HTTPS renderer, so they are not fully on-chain; MultiSea pages and marketplaces that fetch the renderer will still show the art.`;
  return `<div class="fcard"><div class="gh">On-chain storage cost (estimate)</div>
    <p class="mut small">${note} About 200 gas/byte plus overhead, using live gas prices. You pay from your wallet; MultiSea does not fund this.</p>
    <div class="kv">${rows.map(r => `<span>${esc(r.name)}</span><b>${esc(r.fmt)}</b>`).join('')}</div>
    <p class="mut small">Actual gas is shown in your wallet when you upload after deploy.</p></div>`;
}

export async function readProgress(k: string, drop: Address, maxSupply: number) {
  const pub = readClient(k);
  const [finalized, written, storeLocal] = await Promise.all([
    pub.readContract({ address: drop, abi: ABI, functionName: 'artFinalized' }) as Promise<boolean>,
    pub.readContract({ address: drop, abi: ABI, functionName: 'artWritten' }) as Promise<number>,
    pub.readContract({ address: drop, abi: ABI, functionName: 'artStoreLocal' }) as Promise<boolean>,
  ]);
  let flags: boolean[] = [];
  if (storeLocal && maxSupply > 0) {
    flags = [...(await pub.readContract({ address: drop, abi: ABI, functionName: 'writtenFlags', args: [1n, BigInt(maxSupply)] }) as boolean[])];
  }
  return { finalized: !!finalized, written: Number(written), storeLocal: !!storeLocal, flags };
}

async function walletOn(k: string) {
  if (!wallet.address || !wallet.provider) throw new Error('Connect your wallet first.');
  await ensureChain(k);
  return createWalletClient({ chain: vchain(k), transport: custom(wallet.provider), account: wallet.address as Address });
}

export async function writeBatch(k: string, drop: Address, rows: ArtRow[], onTx: (h: string) => void) {
  const pub = readClient(k); const w = await walletOn(k);
  const ids = rows.map(r => BigInt(r.id));
  const mime = rows.map(r => r.mime);
  const image = rows.map(r => ('0x' + [...r.bytes].map(b => b.toString(16).padStart(2, '0')).join('')) as Hex);
  const name = rows.map(r => r.name);
  const description = rows.map(r => r.description);
  const attributes = rows.map(r => r.attributes);
  const args = [ids, mime, image, name, description, attributes] as const;
  const sim = await pub.simulateContract({ address: drop, abi: ABI, functionName: 'writeArtBatch', args, account: wallet.address as Address });
  const gas = await pub.estimateContractGas({ address: drop, abi: ABI, functionName: 'writeArtBatch', args, account: wallet.address as Address });
  const hash = await w.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: wallet.address as Address });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('art upload transaction reverted');
  return hash;
}

export async function finalizeOn(k: string, drop: Address, onTx: (h: string) => void) {
  const pub = readClient(k); const w = await walletOn(k);
  const sim = await pub.simulateContract({ address: drop, abi: ABI, functionName: 'finalizeArt', args: [], account: wallet.address as Address });
  const hash = await w.writeContract({ ...sim.request, chain: vchain(k), account: wallet.address as Address });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('finalize transaction reverted');
  return hash;
}

/** Pack rows into batches that stay under ~8M gas. */
export function planBatches(rows: ArtRow[]): ArtRow[][] {
  const out: ArtRow[][] = [];
  let cur: ArtRow[] = [];
  let gas = 0n;
  const cap = 8_000_000n;
  for (const r of rows) {
    const g = estimateGas(r.size, 1);
    if (cur.length && gas + g > cap) { out.push(cur); cur = []; gas = 0n; }
    cur.push(r); gas += g;
    if (cur.length >= 8) { out.push(cur); cur = []; gas = 0n; }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function hubChain() { return (LP as any).hubChain || 'base'; }
export const onchainFactoryOn = (k: string): Address | null => ((LP as any).onchainDrops?.factories?.[k] || null);

export function attrsJson(attrs: { trait_type: string; value: string }[]) {
  if (!attrs?.length) return '';
  return JSON.stringify(attrs.map(a => ({ trait_type: a.trait_type, value: a.value })));
}
