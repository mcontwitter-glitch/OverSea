// /deploy-solana: MC wires up Solana for NEW multichain drops with his own wallets. Never uses a server key.
// Order: (1) CLI: solana/deploy/deploy-program.sh (program deploy, MC's keypair) -> program id.
// (2) node scripts/lp-solana-plan.mjs --i-will-sign-myself --deployer <MC> --solana-program <id> -> plan JSON.
// (3) This page: load the plan, send the EVM txs (EVM wallet, chain by chain) and the Solana steps (Phantom / Solflare).
// (4) After the timelock delay: send each chain's timelock.execute(setOmni) from the plan here.
// (5) Only then put the program id + V2 escrows into config/launchpad.json (that is what un-hides Solana on the site).
import './btc/polyfill';
import { createWalletClient, custom, type Hex } from 'viem';
import { PublicKey } from '@solana/web3.js';
import CFG from '../config/collections.json';
import LP from '../config/launchpad.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, esc } from './wallet';
import { navHtml, bindNav } from './shell';
import { solWallet, solConn, sendSol, SOL_RPC } from './solwallet';
import * as O from './solanaomni';

const SL: any = (LP as any).solana; const M: any = (LP as any).mainnet;
const FEE_RECIPIENT = SL.feeRecipient || '85W3XVZqLs15MUEKZE3wRHE3gL1tEiwzkBYLQgrbbZSS';
// Solana-side DVNs (LayerZero metadata, Nov 2026): the same 2-of-2 policy as the EVM chains (LayerZero Labs + Horizen).
const SOL_DVNS = ['4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb', 'HR9NQKK1ynW9NzgdM37dU5CBtqRHTukmbMKS7qkwSkHX'];
const ULN302 = new PublicKey(SL.sendLib || '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH');
const chains = CFG.chains as Record<string, { name: string; explorer: string }>;
const app = document.getElementById('app')!; document.title = 'Deploy Solana · MultiSea';
let programId = new URLSearchParams(location.search).get('program') || SL.programId || '';
let plan: any = null; let log = ''; let busy = ''; const done: Record<string, boolean> = {};
const pid = () => new PublicKey(programId);
const lg = (s: string) => { log += s + '\n'; render(); };

async function refresh() {
  if (!programId) return render();
  try { const st = await solConn.getAccountInfo(O.storePda(pid())); done.store = !!st;
    for (const k of Object.keys(plan?.chains || {})) done['sol:' + k] = !!(await solConn.getAccountInfo(O.peerPda(plan.chains[k].eid, pid()))); } catch (e: any) { lg('RPC: ' + (e?.message || e)); }
  render();
}
async function lz() { const m = await import('@layerzerolabs/lz-solana-sdk-v2'); return { ep: new m.EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID), uln: new m.UlnProgram.Uln(ULN302), T: m.SetConfigType }; }
async function initStore() {
  const { ep } = await lz(); const admin = solWallet.pubkey!; const store = O.storePda(pid());
  lg(`init_store: admin ${admin.toBase58()}, approver ${M.approver}, fee ${FEE_RECIPIENT} 50 bps, move fee 0.001 SOL`);
  const sig = await sendSol([O.initStoreIx({ payer: admin, admin, localEid: SL.eid, approver: M.approver, feeRecipient: new PublicKey(FEE_RECIPIENT), feeBps: SL.feeBps ?? 50, moveFee: BigInt(SL.moveFeeLamports ?? 1_000_000),
    registerAccounts: ep.getRegisterOappIxAccountMetaForCPI(admin, store) as any }, pid())], 400_000);
  lg('  ✓ ' + sig);
}
async function wireChain(k: string) {
  const { ep, uln, T } = await lz(); const admin = solWallet.pubkey!; const store = O.storePda(pid()); const c = plan.chains[k]; const eid = c.eid;
  const peer = O.evmTo32(c.predicted.omniEscrowV2);
  lg(`${k}: set_peer -> ${c.predicted.omniEscrowV2}, LayerZero libraries, nonce, ULN config`);
  lg('  ✓ ' + await sendSol([O.setPeerIx(admin, eid, peer, pid()), ep.initSendLibrary(admin, store, eid), ep.initReceiveLibrary(admin, store, eid), ep.initOAppNonce(admin, eid, store, peer), ep.initOAppConfig(admin, uln as any, admin, store, eid)], 400_000));
  const dvns = SOL_DVNS.map(a => new PublicKey(a)).sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const cfg = (conf: number) => ({ confirmations: conf, requiredDvnCount: 2, optionalDvnCount: 0, optionalDvnThreshold: 0, requiredDvns: dvns, optionalDvns: [] });
  lg('  ✓ ' + await sendSol([await ep.setOappConfig(solConn as any, admin, store, ULN302, eid, { configType: T.SEND_ULN, value: cfg(32) } as any), await ep.setOappConfig(solConn as any, admin, store, ULN302, eid, { configType: T.RECEIVE_ULN, value: cfg(M.chains[k].confirmations) } as any)], 400_000));
}
async function sendEvm(k: string, i: number) {
  const t = plan.chains[k].txs[i]; if (!wallet.address) { openConnect(); throw new Error('Connect your EVM wallet.'); }
  if (t.from.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`Step ${t.step} must be sent from ${t.from}.`);
  await ensureChain(k); const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
  const h = await wc.sendTransaction({ account: wallet.address as Hex, to: (t.to || undefined) as Hex | undefined, data: t.data as Hex, value: BigInt(t.value) } as any);
  lg(`${k} step ${t.step}: ${h}`); const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 300_000 });
  if (rc.status !== 'success') throw new Error(`${k} step ${t.step} reverted.`); done[`evm:${k}:${i}`] = true; lg('  ✓ confirmed');
}
const run = (key: string, f: () => Promise<void>) => { busy = key; render(); f().catch(e => lg('✗ ' + (e?.shortMessage || e?.message || e))).finally(() => { busy = ''; refresh(); }); };

function render() {
  const sw = solWallet.pubkey?.toBase58();
  const evm = plan ? Object.entries(plan.chains).map(([k, c]: any) => `<div class="fcard"><div class="gh">${esc(chains[k]?.name || k)} <span class="mut small">EVM · ${c.txs.length} txs · V2 escrow ${esc(c.predicted.omniEscrowV2)}</span></div>
     <ol class="small">${c.txs.map((t: any, i: number) => `<li>${esc(t.note)} ${done[`evm:${k}:${i}`] ? '<b class="ok">✓</b>' : `<button class="obtn sm" data-evm="${k}:${i}" ${busy ? 'disabled' : ''}>Send</button>`}</li>`).join('')}</ol></div>`).join('') : '';
  const solRows = plan ? Object.keys(plan.chains).map(k => `<li>${esc(chains[k]?.name || k)} (eid ${plan.chains[k].eid}): peer + LayerZero config ${done['sol:' + k] ? '<b class="ok">✓ peer set</b>' : `<button class="obtn sm" data-sol="${k}" ${busy || !done.store ? 'disabled' : ''}>Sign</button>`}</li>`).join('') : '<li class="mut">Load the plan first.</li>';
  app.innerHTML = `${navHtml('admin')}<section class="page"><h2>Deploy Solana (new multichain drops)</h2>
   <p class="mut">You sign everything with your own wallets. Live drops are not touched: only drops created after <span class="mono">factory.setOmni</span> use the V2 escrows. Solana stays hidden on the site until the program id is put in <span class="mono">config/launchpad.json</span> at the very end.</p>
   <div class="fcard"><div class="gh">1 · Program</div><p class="small">Deploy with <span class="mono">solana/deploy/deploy-program.sh</span> (your keypair; ~4.6 SOL rent, ~9.2 SOL needed during the deploy), then paste the program id.</p>
    <label>Program id<input data-pid value="${esc(programId)}" placeholder="from deploy-program.sh"></label><p class="mut small">RPC ${esc(SOL_RPC)}</p></div>
   <div class="fcard"><div class="gh">2 · EVM plan</div><p class="small">Run <span class="mono">node scripts/lp-solana-plan.mjs --i-will-sign-myself --deployer ${esc(M.approver)} --solana-program ${esc(programId || '&lt;id&gt;')}</span> and load the JSON.</p>
    <input type="file" accept=".json,application/json" data-plan>${plan ? `<p class="small ok">Plan loaded: ${Object.keys(plan.chains).length} chains, Store PDA ${esc(plan.solanaStore)}${plan.solanaProgram !== programId ? ' <b class="err">(plan was made for a different program id)</b>' : ''}</p>` : ''}
    <p class="small">EVM wallet: ${wallet.address ? `<span class="mono">${esc(wallet.address)}</span>` : '<button class="bbtn sm" data-act="connect">Connect</button>'}</p></div>
   ${evm}
   <div class="fcard"><div class="gh">3 · Solana</div><p class="small">Solana wallet (becomes the program admin and LayerZero delegate): ${sw ? `<span class="mono">${esc(sw)}</span>` : '<button class="obtn sm" data-solw="phantom">Phantom</button> <button class="obtn sm" data-solw="solflare">Solflare</button>'}</p>
    <ol class="small"><li>init_store: fee recipient <span class="mono">${esc(FEE_RECIPIENT)}</span>, 0.5%, approver <span class="mono">${esc(M.approver)}</span> ${done.store ? '<b class="ok">✓ done</b>' : `<button class="obtn sm" data-act="store" ${busy || !sw || !programId ? 'disabled' : ''}>Sign</button>`}</li>${solRows}</ol></div>
   <div class="fcard small"><div class="gh">4 · Go live</div><ol><li>After the timelock delay, send each chain's last step (timelock.execute setOmni) above.</li><li>Tell MultiSea the program id and the V2 escrows: they go into <span class="mono">config/launchpad.json</span> (solana.programId, omniEscrows) and the Worker; that publishes the Solana option.</li></ol></div>
   ${log ? `<pre class="small">${esc(log)}</pre>` : ''}</section>`;
  bindNav();
}
app.addEventListener('click', e => { const t = e.target as HTMLElement; const b = t.closest('[data-act],[data-evm],[data-sol],[data-solw]') as HTMLElement | null; if (!b) return;
  if (b.dataset.act === 'connect') openConnect();
  if (b.dataset.solw) import('./solwallet').then(m => m.connectSol(b.dataset.solw!)).then(() => refresh()).catch(x => lg('✗ ' + (x?.message || x)));
  if (b.dataset.act === 'store') run('store', initStore);
  if (b.dataset.sol) run('sol', () => wireChain(b.dataset.sol!));
  if (b.dataset.evm) { const [k, i] = b.dataset.evm.split(':'); run('evm', () => sendEvm(k, +i)); } });
app.addEventListener('change', e => { const t = e.target as HTMLInputElement;
  if (t.dataset.pid !== undefined) { try { new PublicKey(t.value.trim()); programId = t.value.trim(); refresh(); } catch { lg('✗ not a Solana program id'); } }
  if (t.dataset.plan !== undefined && t.files?.[0]) t.files[0].text().then(x => { plan = JSON.parse(x); refresh(); }).catch(er => lg('✗ plan: ' + er.message)); });
onWallet(render); render(); refresh();
