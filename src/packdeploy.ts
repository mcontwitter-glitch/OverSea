// /deploy-pack-factories — MC deploys MultiSeaPackFactory + escrow on each of the 5 EVM chains from his own wallet.
// Never uses a server key. After all 5 are live, set peers and put the addresses in config/launchpad.json packDrops.
import { createWalletClient, custom, type Hex, type Address } from 'viem';
import ART from '../config/pack-artifact.json';
import LP from '../config/launchpad.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';

const OWNER = (LP.mainnet as any)?.approver || LP.approver;
const FEE = (LP.mainnet as any)?.feeWallet || '0x25411039F77529A543344603bD8acdd65fABA4d0';
const APPROVER = (LP.mainnet as any)?.approver || LP.approver;
const FEE_BPS = LP.platformFeeBps || 50;
const CHAINS = (LP.chains || []) as string[];
const chains = (LP as any).mainnet?.chains || {};
const logo = (k: string) => `<img class="cl" src="/logos/${k}.svg" alt="">`;
const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === String(OWNER).toLowerCase();

const app = document.getElementById('app')!;
document.title = 'Deploy pack factories · MultiSea';
let log = '';
type Row = { k: string; factory?: string; escrow?: string; err?: string; busy?: string };
let rows: Row[] = CHAINS.map(k => ({ k, factory: (LP as any).packDrops?.factories?.[k], escrow: (LP as any).packDrops?.escrows?.[k] }));

function draw() {
  app.innerHTML = `${navHtml('launchpad')}<main class="page ld"><h1>Deploy pack factories</h1>
    <p class="mut">Card packs use a new factory and LayerZero escrow on each EVM chain (existing launchpad factories are not touched). You pay the gas. After every chain has a factory, set peers so packs and cards can move. Then record the addresses in <span class="mono">config/launchpad.json</span> under <span class="mono">packDrops</span> and rebuild the site.</p>
    ${!wallet.address ? `<div class="fcard cta"><button class="bbtn" data-act="connect">Connect wallet</button></div>`
      : !isOwner() ? `<p class="err">Connect the MultiSea owner wallet (${esc(String(OWNER).slice(0, 6))}…${esc(String(OWNER).slice(-4))}) to deploy.</p>`
      : ''}
    <div class="ldchgrid">${rows.map(r => {
      const c = chains[r.k] || {};
      return `<div class="fcard ldchrow ${r.factory ? 'on' : ''}">${logo(r.k)}<b>${esc(c.name || r.k)}</b>
        <div class="mut small">${r.factory ? `Factory <span class="mono">${esc(r.factory)}</span><br>Escrow <span class="mono">${esc(r.escrow || '')}</span>` : 'Not in config yet'}</div>
        ${r.err ? `<p class="err small">${esc(r.err)}</p>` : ''}
        ${r.busy ? `<p class="mut small"><span class="spin"></span> ${esc(r.busy)}</p>` : ''}
        ${isOwner() && !r.factory ? `<button class="pill sm" data-dep="${r.k}">Deploy on ${esc(c.name || r.k)}</button>` : ''}
      </div>`;
    }).join('')}</div>
    ${isOwner() ? `<p class="mut small">Peers: after all five factories exist, <button class="pill sm" data-act="peers">Set escrow peers</button> (one tx per direction per chain pair).</p>` : ''}
    ${log ? `<pre class="fcard small" style="white-space:pre-wrap">${esc(log)}</pre>` : ''}
  </main>`;
  bindNav();
}

async function deploy(k: string) {
  const row = rows.find(r => r.k === k)!;
  try {
    row.busy = 'Switching chain…'; row.err = ''; draw();
    await ensureChain(k);
    const acc = wallet.address as Address;
    const w = createWalletClient({ account: acc, chain: vchain(k), transport: custom((window as any).ethereum) });
    const pub = readClient(k);
    const endpoint = chains[k].endpoint as Address;
    const moveFee = BigInt((LP as any).moveFeeWei?.[k] || '0');
    const send = async (label: string, data: Hex, value = 0n) => {
      row.busy = label; draw();
      const hash = await w.sendTransaction({ account: acc, chain: vchain(k), data, value });
      log += `${k} ${label}: ${hash}\n`; draw();
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(label + ' reverted');
      return r.contractAddress as Address;
    };
    const packImpl = await send('Packs implementation', ART.packBytecode as Hex);
    const cardImpl = await send('Cards implementation', ART.cardBytecode as Hex);
    // escrow constructor(address endpoint, address owner, address feeWallet, uint256 moveFee)
    const { encodeAbiParameters, encodeFunctionData, keccak256, toBytes } = await import('viem');
    const escArgs = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [endpoint, acc, FEE as Address, moveFee]
    );
    const escrow = await send('Pack escrow', (ART.escrowBytecode + escArgs.slice(2)) as Hex);
    const facArgs = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint16' }],
      [acc, packImpl, cardImpl, FEE as Address, APPROVER as Address, FEE_BPS]
    );
    const factory = await send('Pack factory', (ART.factoryBytecode + facArgs.slice(2)) as Hex);
    row.busy = 'Linking factory ↔ escrow…'; draw();
    const setFac = encodeFunctionData({ abi: ART.escrowAbi as any, functionName: 'setFactory', args: [factory] });
    const h1 = await w.sendTransaction({ account: acc, chain: vchain(k), to: escrow, data: setFac });
    await pub.waitForTransactionReceipt({ hash: h1 });
    const setEsc = encodeFunctionData({ abi: ART.factoryAbi as any, functionName: 'setEscrow', args: [escrow] });
    const h2 = await w.sendTransaction({ account: acc, chain: vchain(k), to: factory, data: setEsc });
    await pub.waitForTransactionReceipt({ hash: h2 });
    row.factory = factory; row.escrow = escrow; row.busy = '';
    log += `${k}: factory ${factory}\n${k}: escrow ${escrow}\n`;
    draw();
  } catch (e: any) {
    row.err = friendly(e) || e?.message || String(e);
    row.busy = '';
    draw();
  }
}

async function setPeers() {
  try {
    const ready = rows.filter(r => r.factory && r.escrow);
    if (ready.length < 2) { log += 'Need at least two deployed escrows to set peers.\n'; draw(); return; }
    const { encodeFunctionData, pad, isAddress } = await import('viem');
    for (const a of ready) {
      await ensureChain(a.k);
      const acc = wallet.address as Address;
      const w = createWalletClient({ account: acc, chain: vchain(a.k), transport: custom((window as any).ethereum) });
      const pub = readClient(a.k);
      for (const b of ready) {
        if (a.k === b.k) continue;
        const eid = chains[b.k].eid;
        const peer = pad(b.escrow as Address, { size: 32 });
        const data = encodeFunctionData({ abi: ART.escrowAbi as any, functionName: 'setPeer', args: [eid, peer] });
        log += `${a.k} setPeer ${b.k}…\n`; draw();
        const hash = await w.sendTransaction({ account: acc, chain: vchain(a.k), to: a.escrow as Address, data });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error('setPeer reverted');
        log += `  ${hash}\n`;
      }
    }
    log += 'Peers set. Add the factory and escrow addresses to config/launchpad.json packDrops and rebuild.\n';
    draw();
  } catch (e: any) {
    log += 'Peer setup failed: ' + (friendly(e) || e?.message || e) + '\n';
    draw();
  }
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-act="connect"]')) openConnect();
  const d = t.closest<HTMLElement>('[data-dep]'); if (d) deploy(d.dataset.dep!);
  if (t.closest('[data-act="peers"]')) setPeers();
});
onWallet(draw);
draw();
