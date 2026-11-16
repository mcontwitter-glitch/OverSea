// /deploy-solana: MC wires up Solana for NEW multichain drops with his own wallets. Never uses a server key.
// Order: (1) CLI: solana/deploy/deploy-program.sh (program deploy, MC's keypair) -> program id.
// (2) node scripts/lp-solana-plan.mjs --i-will-sign-myself --deployer <MC> --solana-program <id> -> plan JSON.
// (3) This page: load the plan, send the EVM txs (EVM wallet, chain by chain) and the Solana steps (Phantom / Solflare).
// (4) The new contracts (V2 escrow/drop impl, mover) stay owned by MC's wallet (direct calls). The live factory + V1 escrow are
//     owned by the existing 48 h timelock: the plan's step 1 schedules the timelock exit (default: ownership back to MC); 48 h later
//     send the executeBatch step and the rest of the chain (acceptOwnership, V1 escrow Solana peer, setOmni) here.
// (5) Only then put the program id + V2 escrows into config/launchpad.json (that is what un-hides Solana on the site).
// Existing V1 collections (Option A): per chain set_mover (the plan's MultiSeaSolanaMover + the chain's V1 escrow), then per
// collection register_existing + existing_copies (all ids created as locked copies, ~0.0032 SOL each, paid by the admin wallet).
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
    for (const k of Object.keys(plan?.chains || {})) { const pa = await solConn.getAccountInfo(O.peerPda(plan.chains[k].eid, pid())); done['sol:' + k] = !!pa;
      done['mover:' + k] = !!pa && O.decodePeer(pa.data).mover.some((x: number) => x !== 0); }
    if (xcid) { const d = await solConn.getAccountInfo(O.dropPda(xcid, pid())); done.xreg = !!d; if (d) xminted = await countCopies(); } } catch (e: any) { lg('RPC: ' + (e?.message || e)); }
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
async function wireMover(k: string) {
  const { ep } = await lz(); const admin = solWallet.pubkey!; const store = O.storePda(pid()); const c = plan.chains[k];
  if (!c.predicted.solanaMover || !c.predicted.v1Escrow) throw new Error('This plan has no mover (re-run lp-solana-plan.mjs).');
  const mv = O.evmTo32(c.predicted.solanaMover), v1 = O.evmTo32(c.predicted.v1Escrow);
  lg(`${k}: set_mover -> mover ${c.predicted.solanaMover}, existing V1 escrow ${c.predicted.v1Escrow}, LayerZero nonces`);
  lg('  ✓ ' + await sendSol([O.setMoverIx(admin, c.eid, mv, v1, pid()), ep.initOAppNonce(admin, c.eid, store, mv), ep.initOAppNonce(admin, c.eid, store, v1)], 400_000));
}
// existing collection form (Solana side of a live V1 drop)
let xcid = ''; let xminted = 0; const xf: any = { name: '', collectionUri: '', baseUri: '', payout: '', royaltyBps: 500, maxSupply: 0, eids: '' };
async function countCopies() { let n = 0; for (let i = 1; i <= Number(xf.maxSupply || 0); i += 100) { const ks = []; for (let j = i; j < i + 100 && j <= xf.maxSupply; j++) ks.push(O.assetPda(xcid, j, pid()));
  n += (await solConn.getMultipleAccountsInfo(ks)).filter(Boolean).length; } return n; }
function xparams(): O.ExistingParams {
  if (!/^0x[0-9a-fA-F]{64}$/.test(xcid)) throw new Error('collection id must be the bytes32 cid of the live V1 drop');
  const eids = String(xf.eids).split(',').map((x: string) => +x.trim()).filter(Boolean); if (!eids.includes(SL.eid)) eids.push(SL.eid);
  return { name: xf.name, collectionUri: xf.collectionUri, baseUri: xf.baseUri, payout: new PublicKey(xf.payout), royaltyBps: +xf.royaltyBps, maxSupply: +xf.maxSupply, eids };
}
async function registerExisting() { const p = xparams(); lg(`register_existing ${xcid}: ${p.name}, ${p.maxSupply} ids, royalty ${p.royaltyBps} bps to ${p.payout.toBase58()}, eids ${p.eids.join(',')}`);
  lg('  ✓ ' + await sendSol([O.registerExistingIx({ admin: solWallet.pubkey!, cid: xcid, params: p }, pid())], 400_000)); }
async function existingCopies() { const max = +xf.maxSupply;
  for (let s = 1; s <= max; s += O.MAX_COPIES_TX) { const q = Math.min(O.MAX_COPIES_TX, max - s + 1);
    const have = (await solConn.getMultipleAccountsInfo(Array.from({ length: q }, (_, i) => O.assetPda(xcid, s + i, pid())))).every(Boolean); if (have) continue;
    lg(`existing_copies #${s}-#${s + q - 1}`); lg('  ✓ ' + await sendSol([O.existingCopiesIx(solWallet.pubkey!, xcid, s, q, pid())], 1_400_000)); } }
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
  const solRows = plan ? Object.keys(plan.chains).map(k => `<li>${esc(chains[k]?.name || k)} (eid ${plan.chains[k].eid}): peer + LayerZero config ${done['sol:' + k] ? '<b class="ok">✓ peer set</b>' : `<button class="obtn sm" data-sol="${k}" ${busy || !done.store ? 'disabled' : ''}>Sign</button>`}
     · existing collections mover ${done['mover:' + k] ? '<b class="ok">✓</b>' : `<button class="obtn sm" data-mover="${k}" ${busy || !done['sol:' + k] ? 'disabled' : ''}>Sign</button>`}</li>`).join('') : '<li class="mut">Load the plan first.</li>';
  const xin = (k: string, label: string, ph = '') => `<label>${label}<input data-xf="${k}" value="${esc(String(xf[k] ?? ''))}" placeholder="${esc(ph)}"></label>`;
  const xcard = `<div class="fcard small"><div class="gh">5 · Existing collection (live V1 drop)</div>
    <p>After the chain's mover is set (above) and its V1 escrow Solana peer step (plan) is sent. Registers the collection on Solana (no minting there) and creates every id as a locked copy (~0.0032 SOL each, from this wallet).</p>
    <label>Collection id (bytes32)<input data-xcid value="${esc(xcid)}" placeholder="0x…"></label>${xin('name', 'Name')}${xin('collectionUri', 'Collection metadata URI', 'ipfs://…/collection.json')}${xin('baseUri', 'Base URI', 'ipfs://…/')}
    ${xin('payout', 'Royalty payout (Solana address)')}${xin('royaltyBps', 'Royalty bps')}${xin('maxSupply', 'Max supply')}${xin('eids', 'EVM eids of the drop (comma)', '30184,30101')}
    <p>${done.xreg ? '<b class="ok">✓ registered</b>' : `<button class="obtn sm" data-act="xreg" ${busy || !done.store || !sw ? 'disabled' : ''}>Register</button>`}
     ${done.xreg ? `copies ${xminted}/${esc(String(xf.maxSupply))} ${xminted >= +xf.maxSupply ? '<b class="ok">✓</b>' : `<button class="obtn sm" data-act="xcopies" ${busy ? 'disabled' : ''}>Create copies</button>`}` : ''}</p></div>`;
  app.innerHTML = `${navHtml('admin')}<section class="page"><h2>Deploy Solana (new multichain drops)</h2>
   <p class="mut">You sign everything with your own wallets. Live drops are not touched: only drops created after <span class="mono">factory.setOmni</span> use the V2 escrows. The new contracts stay owned by your wallet (no timelock); the live factory and V1 escrow need one 48 h timelock wait (plan step 1, see <span class="mono">--timelock-exit</span>). Solana stays hidden on the site until the program id is put in <span class="mono">config/launchpad.json</span> at the very end.</p>
   <div class="fcard"><div class="gh">1 · Program</div><p class="small">Deploy with <span class="mono">solana/deploy/deploy-program.sh</span> (your keypair; ~0.49 SOL rent, ~1.03 SOL needed during the deploy), then paste the program id.</p>
    <label>Program id<input data-pid value="${esc(programId)}" placeholder="from deploy-program.sh"></label><p class="mut small">RPC ${esc(SOL_RPC)}</p></div>
   <div class="fcard"><div class="gh">2 · EVM plan</div><p class="small">Run <span class="mono">node scripts/lp-solana-plan.mjs --i-will-sign-myself --deployer ${esc(M.approver)} --solana-program ${esc(programId || '&lt;id&gt;')}</span> and load the JSON.</p>
    <input type="file" accept=".json,application/json" data-plan>${plan ? `<p class="small ok">Plan loaded: ${Object.keys(plan.chains).length} chains, Store PDA ${esc(plan.solanaStore)}${plan.solanaProgram !== programId ? ' <b class="err">(plan was made for a different program id)</b>' : ''}</p>` : ''}
    <p class="small">EVM wallet: ${wallet.address ? `<span class="mono">${esc(wallet.address)}</span>` : '<button class="bbtn sm" data-act="connect">Connect</button>'}</p></div>
   ${evm}
   <div class="fcard"><div class="gh">3 · Solana</div><p class="small">Solana wallet (becomes the program admin and LayerZero delegate): ${sw ? `<span class="mono">${esc(sw)}</span>` : '<button class="obtn sm" data-solw="phantom">Phantom</button> <button class="obtn sm" data-solw="solflare">Solflare</button>'}</p>
    <ol class="small"><li>init_store: fee recipient <span class="mono">${esc(FEE_RECIPIENT)}</span>, 0.5%, approver <span class="mono">${esc(M.approver)}</span> ${done.store ? '<b class="ok">✓ done</b>' : `<button class="obtn sm" data-act="store" ${busy || !sw || !programId ? 'disabled' : ''}>Sign</button>`}</li>${solRows}</ol></div>
   <div class="fcard small"><div class="gh">4 · Go live</div><ol><li>48 h after each chain's step 1 (timelock exit), send its executeBatch step and the remaining steps above (acceptOwnership, V1 escrow Solana peer, setOmni).</li><li>Tell MultiSea the program id and the V2 escrows: they go into <span class="mono">config/launchpad.json</span> (solana.programId, omniEscrows) and the Worker; that publishes the Solana option.</li></ol></div>
   ${xcard}
   ${log ? `<pre class="small">${esc(log)}</pre>` : ''}</section>`;
  bindNav();
}
app.addEventListener('click', e => { const t = e.target as HTMLElement; const b = t.closest('[data-act],[data-evm],[data-sol],[data-solw],[data-mover]') as HTMLElement | null; if (!b) return;
  if (b.dataset.act === 'connect') openConnect();
  if (b.dataset.solw) import('./solwallet').then(m => m.connectSol(b.dataset.solw!)).then(() => refresh()).catch(x => lg('✗ ' + (x?.message || x)));
  if (b.dataset.act === 'store') run('store', initStore);
  if (b.dataset.sol) run('sol', () => wireChain(b.dataset.sol!));
  if (b.dataset.mover) run('mover', () => wireMover(b.dataset.mover!));
  if (b.dataset.act === 'xreg') run('xreg', registerExisting);
  if (b.dataset.act === 'xcopies') run('xcopies', existingCopies);
  if (b.dataset.evm) { const [k, i] = b.dataset.evm.split(':'); run('evm', () => sendEvm(k, +i)); } });
app.addEventListener('change', e => { const t = e.target as HTMLInputElement;
  if (t.dataset.xf) { xf[t.dataset.xf] = t.value.trim(); return; }
  if (t.dataset.xcid !== undefined) { xcid = t.value.trim(); refresh(); return; }
  if (t.dataset.pid !== undefined) { try { new PublicKey(t.value.trim()); programId = t.value.trim(); refresh(); } catch { lg('✗ not a Solana program id'); } }
  if (t.dataset.plan !== undefined && t.files?.[0]) t.files[0].text().then(x => { plan = JSON.parse(x); refresh(); }).catch(er => lg('✗ plan: ' + er.message)); });
onWallet(render); render(); refresh();
