// /deploy-island-wallets — MC deploys and configures the IslandWalletFactory on each of the 5 chains himself, from his
// own wallet. Never uses a server key. Two transactions per chain:
//   1. Deploy: the deterministic deployer 0x4e59…956C with the same salt + bytecode -> same factory address everywhere.
//   2. Configure (once, can't be changed later): Island contract + LayerZero endpoint + the other 4 chains, and the
//      LayerZero DVN/executor settings copied from the Island bridge escrow on that chain (same DVNs as the bridge).
// The Island wallet page switches to the one-address wallet only after all 5 chains show "configured".
import { createWalletClient, custom, decodeAbiParameters, encodeAbiParameters, parseAbi, formatEther, formatGwei, type Hex } from 'viem';
import CFG from '../config/collections.json';
import ART from '../config/island-wallet-artifact.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, friendly, esc } from './wallet';
import { navHtml, bindNav } from './shell';
import { preflight } from './txgas';
import { EID, type FwChain } from './footkit';
import { ISLAND_CHAINS, ISLAND_ADDR, islandWallet2 } from './islandkit';
const logo = (k: string, cls = 'cl') => `<img class="${cls}" src="/logos/${k}.svg" alt="">`;

const A = ART as any;
const DEPLOYER = A.create2Factory as Hex, OWNER = A.owner as Hex, FACTORY = A.factory as Hex, SALT = A.salt as Hex;
const INIT = (A.bytecode + encodeAbiParameters([{ type: 'address' }], [OWNER]).slice(2)) as Hex;
const DEPLOY_DATA = (SALT + INIT.slice(2)) as Hex;
const FABI = A.factoryAbi;
const ESCROW = Object.fromEntries((CFG.collections.find(c => c.slug === 'multi-islands')!.escrow || []).map(e => [e.chain, e.address as Hex])) as Record<FwChain, Hex>;
const chains = CFG.chains as Record<string, { name: string; native: string; explorer: string }>;
const EP = parseAbi([
  'function endpoint() view returns (address)',
  'function getSendLibrary(address sender, uint32 eid) view returns (address)',
  'function getReceiveLibrary(address receiver, uint32 eid) view returns (address lib, bool isDefault)',
  'function isDefaultSendLibrary(address sender, uint32 eid) view returns (bool)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)',
]);
const ULN = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }] as const;
/** Resolved config read back from the endpoint uses 0 for "none"; written config needs NIL (255) for that. */
function norm(b: Hex): Hex {
  const [u] = decodeAbiParameters(ULN, b) as any;
  const v = { ...u, requiredDVNCount: u.requiredDVNCount === 0 ? 255 : u.requiredDVNCount, optionalDVNCount: u.optionalDVNCount === 0 ? 255 : u.optionalDVNCount, optionalDVNThreshold: u.optionalDVNCount === 0 ? 0 : u.optionalDVNThreshold };
  return encodeAbiParameters(ULN, [v]);
}

type Row = { k: FwChain; deployer: boolean; deployed: boolean; configured: boolean; owner?: Hex; endpoint?: Hex; island?: Hex; gas?: bigint; gp?: bigint; args?: any[]; verify?: string; err?: string };
let rows: Row[] = []; let log = ''; let loading = true;
const isOwner = () => !!wallet.address && wallet.address.toLowerCase() === OWNER.toLowerCase();
const app = document.getElementById('app')!;
document.title = 'Deploy Island wallets · MultiSea';

async function configArgs(k: FwChain, endpoint: Hex) {
  const pc = readClient(k); const esc0 = ESCROW[k];
  const remotes = ISLAND_CHAINS.filter(x => x !== k).map(x => EID[x]);
  const lz: { lib: Hex; params: { eid: number; configType: number; config: Hex }[] }[] = [];
  for (const eid of remotes) {
    const [def, sl, [rl]] = await Promise.all([
      pc.readContract({ address: endpoint, abi: EP, functionName: 'isDefaultSendLibrary', args: [esc0, eid] }),
      pc.readContract({ address: endpoint, abi: EP, functionName: 'getSendLibrary', args: [esc0, eid] }),
      pc.readContract({ address: endpoint, abi: EP, functionName: 'getReceiveLibrary', args: [esc0, eid] }),
    ]);
    if (!def) throw new Error(`The bridge escrow uses a custom send library to eid ${eid}; stop and ask MultiSea.`);
    const [ex, us, ur] = await Promise.all([
      pc.readContract({ address: endpoint, abi: EP, functionName: 'getConfig', args: [esc0, sl, eid, 1] }),
      pc.readContract({ address: endpoint, abi: EP, functionName: 'getConfig', args: [esc0, sl, eid, 2] }),
      pc.readContract({ address: endpoint, abi: EP, functionName: 'getConfig', args: [esc0, rl, eid, 2] }),
    ]);
    lz.push({ lib: sl, params: [{ eid, configType: 1, config: ex }, { eid, configType: 2, config: norm(us) }] });
    lz.push({ lib: rl, params: [{ eid, configType: 2, config: norm(ur) }] });
  }
  return [ISLAND_ADDR[k], endpoint, remotes, OWNER, lz];
}

/** After configure: the factory's LayerZero settings must equal the escrow's on every pathway. */
async function verify(k: FwChain, endpoint: Hex): Promise<string> {
  const pc = readClient(k); const bad: string[] = [];
  for (const x of ISLAND_CHAINS.filter(y => y !== k)) {
    const eid = EID[x];
    const sl = await pc.readContract({ address: endpoint, abi: EP, functionName: 'getSendLibrary', args: [ESCROW[k], eid] });
    const [rl] = await pc.readContract({ address: endpoint, abi: EP, functionName: 'getReceiveLibrary', args: [ESCROW[k], eid] });
    const g = (o: Hex, lib: Hex, t: number) => pc.readContract({ address: endpoint, abi: EP, functionName: 'getConfig', args: [o, lib, eid, t] });
    const [a, b, c, d, e, f] = await Promise.all([g(FACTORY, sl, 1), g(ESCROW[k], sl, 1), g(FACTORY, sl, 2), g(ESCROW[k], sl, 2), g(FACTORY, rl, 2), g(ESCROW[k], rl, 2)]);
    if (a !== b || c !== d || e !== f) bad.push(chains[x].name);
  }
  return bad.length ? `LayerZero settings differ from the bridge for: ${bad.join(', ')}` : 'LayerZero settings match the bridge escrow on all 4 pathways ✓';
}

async function probe(): Promise<Row[]> {
  return Promise.all(ISLAND_CHAINS.map(async (k): Promise<Row> => {
    const pc = readClient(k);
    try {
      const [dc, fc, gp, endpoint] = await Promise.all([pc.getCode({ address: DEPLOYER }), pc.getCode({ address: FACTORY }), pc.getGasPrice(), pc.readContract({ address: ESCROW[k], abi: EP, functionName: 'endpoint' })]);
      const deployer = !!dc && dc !== '0x', deployed = !!fc && fc !== '0x';
      const r: Row = { k, deployer, deployed, configured: false, gp, endpoint };
      if (!deployed) {
        if (deployer) r.gas = await pc.estimateGas({ account: OWNER, to: DEPLOYER, data: DEPLOY_DATA }).catch((e: any) => { r.err = e.shortMessage || e.message; return undefined; });
        return r;
      }
      const [configured, owner, island] = await Promise.all(['configured', 'owner', 'island'].map(fn => pc.readContract({ address: FACTORY, abi: FABI, functionName: fn }))) as [boolean, Hex, Hex];
      Object.assign(r, { configured, owner, island });
      if (!configured) {
        r.args = await configArgs(k, endpoint);
        r.gas = await pc.estimateContractGas({ address: FACTORY, abi: FABI, functionName: 'setChainConfig', args: r.args, account: OWNER }).catch((e: any) => { r.err = e.shortMessage || e.message; return undefined; });
      } else r.verify = await verify(k, endpoint).catch(e => 'Could not verify: ' + (e?.shortMessage || e?.message));
      return r;
    } catch (e: any) { return { k, deployer: false, deployed: false, configured: false, err: e.shortMessage || e.message }; }
  }));
}
const fmt = (w?: bigint | null) => (w == null ? '—' : (+formatEther(w)).toLocaleString(undefined, { maximumFractionDigits: 8 }));

function render() {
  const can = isOwner(); const done = rows.length === 5 && rows.every(r => r.configured);
  app.innerHTML = `${navHtml('admin')}<section class="page"><h2>Deploy Island wallets</h2>
    <p class="mut">One <span class="mono">IslandWalletFactory</span> per chain, same bytecode and salt through the deterministic deployer <span class="mono">${DEPLOYER}</span>, so it has the same address on all 5 chains and every Island gets one wallet address. You sign and pay gas from <span class="mono">${OWNER}</span>. Nothing is sent until you confirm in your wallet; there is no server wallet.</p>
    <div class="kv bkv"><span>Factory (all 5 chains)</span><b class="mono">${FACTORY}</b><span>Wallet implementation</span><b class="mono">${A.implementation}</b><span>Owner</span><b class="mono">${OWNER}</b><span>Salt</span><b class="mono">${SALT}</b><span>Example: Island #31's wallet</span><b class="mono">${islandWallet2(31)}</b></div>
    <p class="small">Per chain: <b>1. Deploy</b> the factory, then <b>2. Configure</b> it (Island contract, LayerZero endpoint, the other 4 chains, and the bridge escrow's DVN settings, copied on-chain). Configure can only run once. The Island wallet page keeps the old per-chain wallets until all 5 chains show <b>configured</b>.</p>
    ${!wallet.address ? '<p>Connect the owner wallet to deploy.</p><button class="bbtn sm" data-act="connect">Connect wallet</button>' : can ? '<p class="ok">Owner wallet connected.</p>' : `<p class="err">Connect ${OWNER.slice(0, 6)}…${OWNER.slice(-4)} to sign. This page will not send a transaction from another wallet.</p>`}
    ${loading ? '<p class="mut">Checking chains…</p>' : done ? '<p class="ok">All 5 chains are configured. The one-address Island wallet is live on the site.</p>' : ''}
    <div class="ctab">${rows.map(r => {
      const c = chains[r.k]; const cost = r.gas != null && r.gp != null ? r.gas * (r.gp * 12n / 10n) : null;
      const st = r.configured ? '<b class="ok">deployed + configured</b>' : r.deployed ? '<b>deployed · needs configure</b>' : !r.deployer ? '<b class="err">deterministic deployer missing</b>' : '<b>not deployed</b>';
      const next = r.configured ? '' : r.deployed ? 'Configure' : 'Deploy';
      return `<div class="cc">${logo(r.k, 'cl lg')}<div><h3>${esc(c.name)}</h3>
        <div class="kv"><span>Status</span>${st}${next ? `<span>Next</span><b>${next}</b><span>Gas (est.)</span><b>${r.gas ? r.gas.toLocaleString() : '—'}</b><span>Gas price</span><b>${r.gp != null ? formatGwei(r.gp) + ' gwei' : '—'}</b><span>Est. cost (~20% headroom)</span><b>${cost != null ? fmt(cost) + ' ' + esc(c.native) : esc(r.err || '—')}</b>` : ''}${r.endpoint ? `<span>LayerZero endpoint</span><b class="mono small" style="overflow-wrap:anywhere">${r.endpoint}</b>` : ''}</div>
        ${r.verify ? `<p class="small ${r.verify.includes('✓') ? 'ok' : 'err'}">${esc(r.verify)}</p>` : ''}
        ${r.deployed ? `<a class="os" href="${c.explorer}/address/${FACTORY}" target="_blank" rel="noopener">View contract ↗</a> ` : ''}
        ${can && next === 'Deploy' && r.deployer ? `<button class="bbtn sm" data-deploy="${r.k}">1. Deploy on ${esc(c.name)}</button>` : ''}
        ${can && next === 'Configure' && r.args ? `<button class="bbtn sm" data-config="${r.k}">2. Configure ${esc(c.name)}</button>` : ''}
      </div></div>`;
    }).join('')}</div>
    <p class="mut small">Optional, later: the factory owner can only add chains or change LayerZero settings (the Island contract and endpoint are fixed after configure). To match the bridge escrows, ownership can be moved to the timelock with <span class="mono">transferOwnership</span> + <span class="mono">acceptOwnership</span>.</p>
    ${log ? `<pre class="small">${esc(log)}</pre>` : ''}
  </section>`;
  bindNav();
}

async function send(k: FwChain, to: Hex, data: Hex, what: string) {
  const c = chains[k];
  await ensureChain(k);
  const pre = await preflight(k, { to, data, value: 0n });
  if (!pre.enough) throw new Error(`Not enough ${c.native} on ${c.name} to pay gas (need about ${fmt(pre.costWei)} ${c.native}).`);
  if (pre.reverted) throw new Error(pre.reverted);
  const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
  const h = await wc.sendTransaction({ account: wallet.address as Hex, to, data, value: 0n, ...(pre.gas ? { gas: pre.gas } : {}) });
  log += `  ${what} tx ${h}\n`; render();
  const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 240_000 });
  if (rc.status !== 'success') throw new Error(`${what} transaction reverted.`);
}

async function deploy(k: FwChain) {
  if (!isOwner()) return; log += `Deploy ${chains[k].name}…\n`; render();
  try {
    await send(k, DEPLOYER, DEPLOY_DATA, 'deploy');
    const code = await readClient(k).getCode({ address: FACTORY });
    if (!code || code === '0x') throw new Error('Transaction succeeded but no code at the factory address. Stop and check the explorer before retrying.');
    log += `  ok ${FACTORY} on ${chains[k].name}. Next: Configure.\n`;
  } catch (e: any) { log += '  error: ' + (friendly(e, k) || e?.shortMessage || e?.message || e) + '\n'; }
  rows = await probe(); render();
}

async function configure(k: FwChain) {
  if (!isOwner()) return; const r = rows.find(x => x.k === k); if (!r?.args) return;
  log += `Configure ${chains[k].name}…\n`; render();
  try {
    const { encodeFunctionData } = await import('viem');
    const args = await configArgs(k, r.endpoint!); // re-read the escrow settings right before signing
    await send(k, FACTORY, encodeFunctionData({ abi: FABI, functionName: 'setChainConfig', args }), 'configure');
    log += `  ok. ${await verify(k, r.endpoint!)}\n`;
  } catch (e: any) { log += '  error: ' + (friendly(e, k) || e?.shortMessage || e?.message || e) + '\n'; }
  try { localStorage.removeItem('multisea-iw2-live'); } catch {}
  rows = await probe(); render();
}

app.addEventListener('click', async e => {
  const t = e.target as HTMLElement;
  if (t.dataset.act === 'connect') openConnect();
  if (t.dataset.deploy) await deploy(t.dataset.deploy as FwChain);
  if (t.dataset.config) await configure(t.dataset.config as FwChain);
});
bindNav(); render();
onWallet(() => render());
probe().then(r => { rows = r; loading = false; render(); }).catch(e => { loading = false; log += String(e?.message || e) + '\n'; render(); });
