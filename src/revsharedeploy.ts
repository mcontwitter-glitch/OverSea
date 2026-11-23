// /deploy-revshare-factory — MC deploys RevShareVaultFactory on each EVM chain from his own wallet (no server key, no admin powers in the factory).
// Each transaction is simulated first; if it would fail the wallet is not prompted. After deploying, add the addresses to
// config/collections.json -> revshareVaults.factories and rebuild; founders can then deploy their own vaults from the Founder box.
import { createWalletClient, custom, type Hex, type Address } from 'viem';
import ART from '../config/revshare-artifact.json';
import LP from '../config/launchpad.json';
import CFG from '../config/collections.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';

const OWNER = (LP.mainnet as any)?.approver || (LP as any).approver;
const CHAINS = ((LP as any).chains || []) as string[];
const chains = CFG.chains as Record<string, { name: string; explorer: string }>;
const logo = (k: string) => `<img class="cl" src="/logos/${k}.svg" alt="">`;
const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === String(OWNER).toLowerCase();
const app = document.getElementById('app')!;
document.title = 'Deploy revenue-share factory · MultiSea';
let log = '';
type Row = { k: string; factory?: string; err?: string; busy?: string };
const rows: Row[] = CHAINS.map(k => ({ k, factory: (CFG as any).revshareVaults?.factories?.[k] }));

function snippet() {
  const done = rows.filter(r => r.factory); if (!done.length) return '';
  return `<p class="mut small">Add to <span class="mono">config/collections.json</span> and rebuild:</p><pre class="fcard small" style="white-space:pre-wrap">${esc(JSON.stringify({ revshareVaults: { factories: Object.fromEntries(done.map(r => [r.k, r.factory])) } }, null, 2))}</pre>`;
}
function draw() {
  app.innerHTML = `${navHtml('launchpad')}<main class="page ld"><h1>Deploy revenue-share factory</h1>
    <p class="mut">One small factory per EVM chain. Founders then create their collection's <b>RevShareVault</b> (an EIP-1167 clone) from the Founder box in a single transaction from their own wallet. The factory has no owner and no admin functions. Each transaction here is simulated on-chain first; if it would fail you see the error and the wallet is not prompted. You pay the gas. Size: factory ${ART.sizes.factory.init} B initcode (includes the vault implementation), vault ${ART.sizes.vault.runtime} B runtime — both far below EIP-170/3860.</p>
    ${!wallet.address ? `<div class="fcard cta"><button class="bbtn" data-act="connect">Connect wallet</button></div>`
      : !isOwner() ? `<p class="err">Connect the MultiSea owner wallet (${esc(String(OWNER).slice(0, 6))}…${esc(String(OWNER).slice(-4))}) to deploy.</p>` : ''}
    <div class="ldchgrid">${rows.map(r => {
      const c = chains[r.k] || { name: r.k, explorer: '' };
      return `<div class="fcard ldchrow ${r.factory ? 'on' : ''}">${logo(r.k)}<b>${esc(c.name)}</b>
        <div class="mut small">${r.factory ? `Factory <a class="mono" href="${esc(c.explorer)}/address/${esc(r.factory)}" target="_blank" rel="noopener">${esc(r.factory)}</a>` : 'Not deployed yet'}</div>
        ${r.err ? `<p class="err small">${esc(r.err)}</p>` : ''}${r.busy ? `<p class="mut small"><span class="spin"></span> ${esc(r.busy)}</p>` : ''}
        ${isOwner() && !r.factory ? `<button class="pill sm" data-dep="${r.k}">Deploy on ${esc(c.name)}</button>` : ''}</div>`;
    }).join('')}</div>
    ${snippet()}${log ? `<pre class="fcard small" style="white-space:pre-wrap">${esc(log)}</pre>` : ''}</main>`;
  bindNav();
}
async function deploy(k: string) {
  const row = rows.find(r => r.k === k)!;
  try {
    row.busy = 'Switching chain…'; row.err = ''; draw();
    await ensureChain(k);
    const acc = wallet.address as Address; const pub = readClient(k);
    const data = (ART as any).factoryBytecode as Hex;
    row.busy = 'Simulating the deployment on-chain…'; draw();
    try { await pub.estimateGas({ account: acc, data }); }
    catch (e: any) { throw new Error(`The factory deployment would fail on this chain (${String(friendly(e) || e?.shortMessage || e?.details || e?.message || 'simulation failed').split('\n')[0].slice(0, 200)}). No transaction was sent.`); }
    row.busy = 'Confirm the deployment in your wallet…'; draw();
    const w = createWalletClient({ account: acc, chain: vchain(k), transport: custom((window as any).ethereum || wallet.provider) });
    const hash = await w.sendTransaction({ account: acc, chain: vchain(k), data });
    log += `${k} factory tx: ${hash}\n`; row.busy = 'Waiting for confirmation…'; draw();
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success' || !r.contractAddress) throw new Error('Deployment reverted.');
    row.factory = r.contractAddress; row.busy = ''; log += `${k} factory: ${r.contractAddress}\n`; draw();
  } catch (e: any) { row.err = friendly(e) || e?.message || String(e); row.busy = ''; draw(); }
}
app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-act="connect"]')) openConnect();
  const d = t.closest<HTMLElement>('[data-dep]'); if (d) deploy(d.dataset.dep!);
});
onWallet(draw);
draw();
