// Local-only (/offer-test). Bundled only when VITE_OFFERS_TEST=1. Talks to an anvil injected by the e2e script.
import './style.css';
import { navHtml, bindNav, esc } from './shell';
import ART from '../config/collection-offers-artifact.json';
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type Cfg = { rpc: string; offers: Hex; nft: Hex; buyerKey: Hex; sellerKey: Hex; chainName?: string; native?: string; tokenId?: number };
const cfg = () => (window as any).__MS_OFFERS_TEST as Cfg | undefined;
const ABI = (ART as any).abi;
const ERC721 = [
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const;
const fmt = (w: bigint) => (+formatUnits(w, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });

const app = document.getElementById('app')!;
document.title = 'Offers test · MultiSea';
let log = '';
let offerId: string | null = null;

function clients(c: Cfg) {
  const pub = createPublicClient({ transport: http(c.rpc) });
  const buyer = privateKeyToAccount(c.buyerKey);
  const seller = privateKeyToAccount(c.sellerKey);
  const buyWc = createWalletClient({ account: buyer, transport: http(c.rpc) });
  const sellWc = createWalletClient({ account: seller, transport: http(c.rpc) });
  return { pub, buyer, seller, buyWc, sellWc };
}

function render(msg = '') {
  const c = cfg();
  app.innerHTML = `${navHtml()}<section class="page"><h2>Collection offers (local test)</h2>
    ${!c ? '<p class="err">No test config. This page is only for a local anvil run.</p>' : `
    <p class="mut">Contract <span class="mono">${c.offers}</span> · NFT <span class="mono">${c.nft}</span> · ${esc(c.chainName || 'Anvil')}</p>
    <div class="bbody" style="max-width:520px">
      <div class="sl"><span>Price per item</span><div class="prow"><input id="price" type="text" value="0.01" inputmode="decimal"><span>${esc(c.native || 'ETH')}</span></div></div>
      <div class="sl"><span>Quantity</span><input id="qty" type="number" min="1" value="2" style="width:120px"></div>
      <div class="qa" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="bbtn" id="make">Make collection offer</button>
        <button class="bbtn" id="accept">Accept offer</button>
        <button class="bbtn ghost" id="cancel">Cancel remainder</button>
      </div>
    </div>
    <pre class="small" id="log">${esc(log)}</pre>`}
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
  </section>`;
  bindNav();
  if (!c) return;
  document.getElementById('make')!.onclick = () => run('make');
  document.getElementById('accept')!.onclick = () => run('accept');
  document.getElementById('cancel')!.onclick = () => run('cancel');
}

async function run(act: 'make' | 'accept' | 'cancel') {
  const c = cfg()!; const { pub, buyer, seller, buyWc, sellWc } = clients(c);
  const native = c.native || 'ETH';
  try {
    if (act === 'make') {
      const price = parseUnits((document.getElementById('price') as HTMLInputElement).value || '0', 18);
      const qty = BigInt((document.getElementById('qty') as HTMLInputElement).value || '1');
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
      const value = price * qty;
      log += `Make offer ${fmt(price)} ${native} × ${qty} (deposit ${fmt(value)})\n`; render();
      const h = await buyWc.writeContract({ address: c.offers, abi: ABI, functionName: 'makeOffer', args: [c.nft, price, qty, expiry, '0x0000000000000000000000000000000000000000', 0], value, account: buyer, chain: null });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      const ev = rc.logs.find(l => l.address.toLowerCase() === c.offers.toLowerCase());
      offerId = ev ? BigInt(ev.topics[1]!).toString() : '1';
      log += `  ok tx ${h}  offer id ${offerId}\n`;
    } else if (act === 'accept') {
      const tokenId = BigInt(c.tokenId || 1);
      if (!offerId) throw new Error('Make an offer first.');
      const approved = await pub.readContract({ address: c.nft, abi: ERC721, functionName: 'isApprovedForAll', args: [seller.address, c.offers] });
      if (!approved) {
        log += 'Approve offers contract…\n'; render();
        const h1 = await sellWc.writeContract({ address: c.nft, abi: ERC721, functionName: 'setApprovalForAll', args: [c.offers, true], account: seller, chain: null });
        await pub.waitForTransactionReceipt({ hash: h1 });
      }
      log += `Accept offer #${offerId} with token ${tokenId}\n`; render();
      const h = await sellWc.writeContract({ address: c.offers, abi: ABI, functionName: 'accept', args: [BigInt(offerId), tokenId], account: seller, chain: null });
      await pub.waitForTransactionReceipt({ hash: h });
      const owner = await pub.readContract({ address: c.nft, abi: ERC721, functionName: 'ownerOf', args: [tokenId] });
      log += `  ok  token now ${owner}\n`;
    } else {
      if (!offerId) throw new Error('Make an offer first.');
      log += `Cancel offer #${offerId}\n`; render();
      const h = await buyWc.writeContract({ address: c.offers, abi: ABI, functionName: 'cancel', args: [BigInt(offerId)], account: buyer, chain: null });
      await pub.waitForTransactionReceipt({ hash: h });
      log += `  ok refunded remainder\n`;
    }
  } catch (e: any) { log += '  error: ' + (e?.shortMessage || e?.message || e) + '\n'; }
  render();
}

render();
