// /deploy-offers — MC signs CollectionOffers deploys himself. Never uses a server key.
import { createWalletClient, custom, encodeDeployData, getContractAddress, keccak256, toBytes, formatEther, formatGwei, type Hex } from 'viem';
import CFG from '../config/collections.json';
import ART from '../config/collection-offers-artifact.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';
const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="/logos/${k}.svg" alt="">`;
import { preflight } from './txgas';

const FACTORY = ((ART as any).create2Factory || '0x4e59b44847b379578588920cA78FbF26c0B4956C') as Hex;
const OWNER = ((ART as any).owner || '0xb19F00e095B1387061d73751C772bbA848D196b1') as Hex;
const FEE = ((ART as any).feeRecipient || '0x25411039F77529A543344603bD8acdd65fABA4d0') as Hex;
const SALT = ((ART as any).salt || keccak256(toBytes('MultiSea.CollectionOffers.v1'))) as Hex;
const CHAINS = ['ethereum', 'base', 'apechain', 'bnb', 'robinhood'] as const;
const chains = CFG.chains as Record<string, { name: string; native: string; explorer: string; rpc: string }>;

const init = encodeDeployData({ abi: (ART as any).abi, bytecode: (ART as any).bytecode as Hex, args: [OWNER, FEE] });
const predicted = getContractAddress({ opcode: 'CREATE2', from: FACTORY, salt: SALT, bytecode: init });
const calldata = (SALT + init.slice(2)) as Hex;

const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === OWNER.toLowerCase();
const app = document.getElementById('app')!;
document.title = 'Deploy collection offers · MultiSea';

type Row = { k: string; factory: boolean; deployed: boolean; gas?: bigint; gp?: bigint; err?: string };
let rows: Row[] = [];
let log = '';
let loading = true;

async function probe(): Promise<Row[]> {
  return Promise.all(CHAINS.map(async k => {
    const pub = readClient(k);
    try {
      const [fc, code, gp] = await Promise.all([
        pub.getCode({ address: FACTORY }),
        pub.getCode({ address: predicted }),
        pub.getGasPrice(),
      ]);
      const factory = !!(fc && fc !== '0x');
      const deployed = !!(code && code !== '0x');
      let gas: bigint | undefined; let err: string | undefined;
      if (factory && !deployed) {
        try { gas = await pub.estimateGas({ account: OWNER, to: FACTORY, data: calldata, value: 0n }); }
        catch (e: any) { err = e.shortMessage || e.message; }
      }
      return { k, factory, deployed, gas, gp, err };
    } catch (e: any) { return { k, factory: false, deployed: false, err: e.shortMessage || e.message }; }
  }));
}

function fmt(w?: bigint) { return w == null ? '—' : (+formatEther(w)).toLocaleString(undefined, { maximumFractionDigits: 8 }); }

function render() {
  const can = isOwner();
  app.innerHTML = `${navHtml('admin')}<section class="page"><h2>Deploy collection offers</h2>
    <p class="mut">One <span class="mono">CollectionOffers</span> contract per chain, same bytecode, same address via the deterministic deployer <span class="mono">${FACTORY}</span>. You sign and pay gas from <span class="mono">${OWNER}</span>. Nothing is sent until you confirm in your wallet. There is no server wallet.</p>
    <div class="kv bkv"><span>Predicted address</span><b class="mono">${predicted}</b><span>Owner</span><b class="mono">${OWNER}</b><span>Fee recipient (0.5%)</span><b class="mono">${FEE}</b><span>Salt</span><b class="mono">${SALT}</b></div>
    ${!wallet.address ? '<p>Connect the owner wallet to deploy.</p><button class="bbtn sm" data-act="connect">Connect wallet</button>' : can ? '<p class="ok">Owner wallet connected. Deploy only on chains that still show “not deployed”.</p>' : `<p class="err">Connect ${OWNER.slice(0, 6)}…${OWNER.slice(-4)} to sign. This page will not send a transaction from another wallet.</p>`}
    ${loading ? '<p class="mut">Checking chains…</p>' : ''}
    <div class="ctab">${rows.map(r => {
      const c = chains[r.k]; const cost = r.gas != null && r.gp != null ? r.gas * (r.gp * 12n / 10n) : null;
      const st = r.deployed ? '<b class="ok">deployed</b>' : !r.factory ? '<b class="err">factory missing</b>' : '<b>not deployed</b>';
      return `<div class="cc">${logo(r.k, 'cl lg')}<div><h3>${esc(c.name)}</h3>
        <div class="kv"><span>Status</span>${st}<span>Gas (est.)</span><b>${r.gas ? r.gas.toLocaleString() : '—'}</b><span>Gas price</span><b>${r.gp != null ? formatGwei(r.gp) + ' gwei' : '—'}</b><span>Est. cost (~20% headroom)</span><b>${cost != null ? fmt(cost) + ' ' + esc(c.native) : esc(r.err || '—')}</b></div>
        ${r.deployed ? `<a class="os" href="${c.explorer}/address/${predicted}" target="_blank" rel="noopener">View contract ↗</a>` : can && r.factory ? `<button class="bbtn sm" data-deploy="${r.k}">Deploy on ${esc(c.name)}</button>` : ''}
      </div></div>`;
    }).join('')}</div>
    <p class="mut small">After a chain confirms, tell MultiSea so the address can be added to <span class="mono">config/collections.json</span> under <span class="mono">collectionOffers.&lt;chain&gt;</span>. The site hides offer buttons on any chain that is not in that config. Do not add an address until the explorer shows code at the predicted address.</p>
    ${log ? `<pre class="small">${esc(log)}</pre>` : ''}
  </section>`;
  bindNav();
}

async function deploy(k: string) {
  if (!isOwner()) return;
  const c = chains[k];
  log += `Deploy ${c.name}…\n`; render();
  try {
    await ensureChain(k);
    const pre = await preflight(k, { to: FACTORY, data: calldata, value: 0n });
    if (!pre.enough) throw new Error(`Not enough ${c.native} on ${c.name} to pay gas (need about ${fmt(pre.costWei)} ${c.native}).`);
    if (pre.reverted) throw new Error(pre.reverted);
    const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
    const h = await wc.sendTransaction({ account: wallet.address as Hex, to: FACTORY, data: calldata, value: 0n, ...(pre.gas ? { gas: pre.gas } : {}) });
    log += `  tx ${h}\n`; render();
    const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 180_000 });
    if (rc.status !== 'success') throw new Error('Deploy transaction reverted.');
    const code = await readClient(k).getCode({ address: predicted });
    if (!code || code === '0x') throw new Error('Transaction succeeded but no code at the predicted address. Stop and check the explorer before retrying.');
    log += `  ok ${predicted} on ${c.name}\n`;
  } catch (e: any) { log += '  error: ' + (friendly(e, k) || e?.shortMessage || e?.message || e) + '\n'; }
  rows = await probe(); render();
}

app.addEventListener('click', async e => {
  const t = e.target as HTMLElement;
  if (t.dataset.act === 'connect') openConnect();
  if (t.dataset.deploy) await deploy(t.dataset.deploy);
});
bindNav(); render();
onWallet(() => render());
probe().then(r => { rows = r; loading = false; render(); }).catch(e => { loading = false; log += String(e?.message || e) + '\n'; render(); });
