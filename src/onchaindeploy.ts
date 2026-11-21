// /deploy-onchain-factories — MC deploys MultiSeaOnchainFactory + implementations on each EVM chain from his own wallet.
// Never uses a server key. Reuses the live OmniEscrowV2 addresses. After every chain is live, record addresses in
// config/launchpad.json onchainDrops and rebuild. Existing IPFS launchpad factories are not touched.
import { createWalletClient, custom, encodeAbiParameters, encodeFunctionData, type Hex, type Address } from 'viem';
import ART from '../config/onchain-artifact.json';
import LP from '../config/launchpad.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';

const OWNER = (LP.mainnet as any)?.approver || LP.approver;
const FEE = (LP.mainnet as any)?.feeWallet || '0x25411039F77529A543344603bD8acdd65fABA4d0';
const APPROVER = (LP.mainnet as any)?.approver || LP.approver;
const FEE_BPS = LP.platformFeeBps || 50;
const CHAINS = (LP.chains || []) as string[];
const chains = (LP as any).mainnet?.chains || {};
const v2escrow = (k: string) => ((LP as any).solana?.v2?.escrows?.[k] || (LP as any).omniEscrows?.[k]) as Address | undefined;
const logo = (k: string) => `<img class="cl" src="/logos/${k}.svg" alt="">`;
const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === String(OWNER).toLowerCase();

type Row = { k: string; factory?: string; impl?: string; omniImpl?: string; escrow?: string; busy?: string; err?: string };
const app = document.getElementById('app')!;
document.title = 'Deploy on-chain art factories · MultiSea';
let log = '';
let rows: Row[] = CHAINS.map(k => ({
  k,
  factory: (LP as any).onchainDrops?.factories?.[k],
  impl: (LP as any).onchainDrops?.impls?.[k],
  omniImpl: (LP as any).onchainDrops?.omniImpls?.[k],
  escrow: v2escrow(k),
}));

function draw() {
  app.innerHTML = `${navHtml('launchpad')}<main class="page ld"><h1>Deploy on-chain art factories</h1>
    <p class="mut">Optional fully on-chain art for launchpad drops uses a <b>new</b> factory on each EVM chain (existing IPFS factories stay as they are). You pay the gas. Omni drops reuse the live OmniEscrowV2. After every chain has a factory, record the addresses in <span class="mono">config/launchpad.json</span> under <span class="mono">onchainDrops</span> and rebuild the site.</p>
    ${wallet.address ? `<p class="small">Connected: <span class="mono">${esc(wallet.address)}</span>${isOwner() ? ' · owner wallet' : ' · connect the MultiSea owner wallet to deploy'}</p>` : '<p><button class="bbtn sm" data-act="connect">Connect wallet</button></p>'}
    <div class="fcard">${rows.map(r => `<div class="ldchrow" style="align-items:flex-start">
      <div>${logo(r.k)} <b>${esc(r.k)}</b></div>
      <div class="small" style="flex:1">${r.factory ? `Factory <span class="mono">${esc(r.factory)}</span><br>Drop impl <span class="mono">${esc(r.impl || '—')}</span><br>Omni impl <span class="mono">${esc(r.omniImpl || '—')}</span><br>Escrow (existing V2) <span class="mono">${esc(r.escrow || 'missing')}</span>` : r.escrow ? `Ready to deploy · will setOmni with existing escrow <span class="mono">${esc(r.escrow)}</span>` : '<span class="err">No OmniEscrowV2 address in config for this chain</span>'}
        ${r.busy ? `<div class="mut">${esc(r.busy)}</div>` : ''}
        ${r.err ? `<div class="err">${esc(r.err)}</div>` : ''}
      </div>
      ${!r.factory && wallet.address ? `<button class="bbtn sm" data-deploy="${r.k}" ${r.busy ? 'disabled' : ''}>Deploy</button>` : ''}
    </div>`).join('')}</div>
    ${log ? `<pre class="fcard small" style="white-space:pre-wrap">${esc(log)}</pre>` : ''}
    <p class="mut small">Creators cannot use “Fully on-chain” until these addresses are recorded and the site is rebuilt. The IPFS path is unchanged.</p>
  </main>`;
  bindNav();
}

async function deploy(k: string) {
  const row = rows.find(r => r.k === k)!;
  try {
    if (!v2escrow(k)) throw new Error('No OmniEscrowV2 address configured for ' + k);
    row.busy = 'Switching chain…'; row.err = ''; draw();
    await ensureChain(k);
    const acc = wallet.address as Address;
    const w = createWalletClient({ account: acc, chain: vchain(k), transport: custom((window as any).ethereum) });
    const pub = readClient(k);
    const send = async (label: string, data: Hex) => {
      row.busy = label; draw();
      const hash = await w.sendTransaction({ account: acc, chain: vchain(k), data });
      log += `${k} ${label}: ${hash}\n`; draw();
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(label + ' reverted');
      if (!r.contractAddress) throw new Error(label + ' produced no contract address');
      return r.contractAddress as Address;
    };
    const impl = await send('On-chain drop implementation', ART.dropBytecode as Hex);
    const omniImpl = await send('On-chain omni implementation', ART.omniBytecode as Hex);
    const facArgs = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint16' }],
      [acc, impl, FEE as Address, APPROVER as Address, FEE_BPS],
    );
    const factory = await send('On-chain factory', (ART.factoryBytecode + facArgs.slice(2)) as Hex);
    row.busy = 'setOmni(existing OmniEscrowV2)…'; draw();
    const data = encodeFunctionData({ abi: ART.factoryAbi as any, functionName: 'setOmni', args: [omniImpl, v2escrow(k)] });
    const h = await w.sendTransaction({ account: acc, chain: vchain(k), to: factory, data });
    const rec = await pub.waitForTransactionReceipt({ hash: h });
    if (rec.status !== 'success') throw new Error('setOmni reverted');
    log += `${k} setOmni: ${h}\n`;
    row.factory = factory; row.impl = impl; row.omniImpl = omniImpl; row.escrow = v2escrow(k); row.busy = '';
    log += `${k}: factory ${factory}\n${k}: drop impl ${impl}\n${k}: omni impl ${omniImpl}\nAdd these to config/launchpad.json onchainDrops and rebuild.\n`;
    draw();
  } catch (e: any) {
    row.err = friendly(e) || e?.message || String(e);
    row.busy = '';
    draw();
  }
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-act="connect"]')) { openConnect(); return; }
  const d = t.closest('[data-deploy]') as HTMLElement | null;
  if (d?.dataset.deploy) deploy(d.dataset.deploy);
});
onWallet(draw);
draw();
