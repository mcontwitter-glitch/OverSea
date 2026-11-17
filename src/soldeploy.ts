// /deploy-solana: "Turn on Solana" in 5 big steps. MC signs everything with his own wallets; MultiSea never holds a key.
// Every step's ✓ comes from an on-chain read, so the page picks up where MC left off (any browser, any time).
//  1 Connect Phantom (or Solflare)
//  2 Deploy the Solana program from the browser: 2 wallet approvals; the upload in between is signed by a throwaway key kept
//    in this browser (src/solprogdeploy.ts). Resume / cancel-and-refund. CLI fallback under Details.
//  3 Set up the program: settings + links to every EVM chain, one "Approve all" (src/solsetup.ts)
//  4 Each EVM chain: one "Sign next step" button over the ~28 steps of src/solplan.ts (48 h timelock exit countdown)
//  5 Turn Solana on: a free signature from MC's EVM wallet; the Worker checks everything on-chain, then switches Solana on.
import './btc/polyfill';
import './solshim';
import { createWalletClient, custom, formatUnits, type Hex, type Address } from 'viem';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import CFG from '../config/collections.json';
import LP from '../config/launchpad.json';
import ART from './solartifacts.json';
import { wallet, openConnect, onWallet, ensureChain, vchain, readClient, esc, API } from './wallet';
import { navHtml, bindNav } from './shell';
import { solWallet, solConn, connectSol, onSolWallet, SOL_RPC } from './solwallet';
import * as O from './solanaomni';
import { chainPlan, type ChainPlan } from './solplan';
import * as PD from './solprogdeploy';
import type { SetupItem, Link } from './solsetup';
// The LayerZero SDK is loaded on demand, after the `process` shim (a static import would evaluate first in the production build).
const SS = () => import('./solsetup');
const ULN302 = '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH';
/** The MultiSea program MC deployed on mainnet (2026-11-16); a test build on a local validator does not use it. */
const MAINNET_PROGRAM = (import.meta as any).env?.VITE_SOLANA_RPC ? '' : 'ELFn27BHnJV5MxtpwsZSebgfjRqFwfHEf2Ar3gzGD2LH';

const L: any = LP; const SL = L.solana; const M = L.mainnet; const V2 = SL.v2;
const chainsCfg = CFG.chains as Record<string, { name: string; explorer: string; logo?: string }>;
const KEYS: string[] = Object.keys(V2.escrows);
const NAMES: Record<string, string> = Object.fromEntries(KEYS.map(k => [k, chainsCfg[k]?.name || k]));
const MC: string = V2.owner;
// LayerZero message library: ULN302 on mainnet; a local-validator test build may point at the simple test library (no DVN config there).
const MSGLIB: string = (import.meta as any).env?.VITE_SOLANA_MSGLIB || SL.sendLib || ULN302;
const SO = (ART as any).so as { path: string; size: number; sha256: string };
const app = document.getElementById('app')!; document.title = 'Turn on Solana · MultiSea';
const short = (s: string, a = 4, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 4 });
const lsKeys: PD.KeyStore = { get: () => localStorage.getItem('msea-solprog-keys'), set: v => localStorage.setItem('msea-solprog-keys', v), clear: () => localStorage.removeItem('msea-solprog-keys') };

// ------------------------------------------------------------------ state
let programId = new URLSearchParams(location.search).get('program') || localStorage.getItem('msea-solprog-id') || '';
let soBytes: Uint8Array | null = null;
let dst: PD.DeployState | null = null; let costs: Awaited<ReturnType<typeof PD.costs>> | null = null;
let solBal: number | null = null;
let setup: SetupItem[] | null = null;
const plans: Record<string, ChainPlan | undefined> = {}; const gasPrice: Record<string, bigint | undefined> = {}; const clockSkew: Record<string, number> = {};
const chainErr: Record<string, string> = {};
let flag: { on: boolean; programId: string | null; enabledAt: string | null } | null = null;
let busy = ''; let msg = ''; let up: { written: number; total: number } | null = null;
const openDet = new Set<string>();
const say = (s: string) => { msg = s; render(); };
const errText = (e: any) => String(e?.shortMessage || e?.message || e).slice(0, 300);

const store32 = (): Hex | null => (programId ? O.hexOf(O.storePda(new PublicKey(programId)).toBytes()) : null);
const deployed = () => dst?.phase === 'deployed';
const setupDone = () => !!setup && setup.every(i => i.done);
const chainDone = (k: string) => !!plans[k] && plans[k]!.firstOpen === -1;
const isOn = () => !!flag?.on && !!programId && flag.programId === programId;

// ------------------------------------------------------------------ reads
async function soFile() {
  if (soBytes) return soBytes;
  const b = new Uint8Array(await (await fetch(SO.path, { cache: 'force-cache' })).arrayBuffer());
  const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), x => x.toString(16).padStart(2, '0')).join('');
  if (h !== SO.sha256 || b.length !== SO.size) throw new Error('The program file did not download correctly (hash mismatch). Reload the page.');
  return (soBytes = b);
}
/** Program id: ?program=, this browser (saved / upload keys), the Worker's switch, or the Base V2 escrow's Solana peer -> Store -> owner. */
async function findProgram() {
  if (programId) return;
  const k = PD.loadKeys(lsKeys, SO.sha256); if (k) { programId = k.program.publicKey.toBase58(); return; }
  if (flag?.programId) { programId = flag.programId; return; }
  try {
    const peer = await readClient(L.hubChain).readContract({ address: V2.escrows[L.hubChain], abi: [{ type: 'function', name: 'peers', stateMutability: 'view', inputs: [{ type: 'uint32' }], outputs: [{ type: 'bytes32' }] }], functionName: 'peers', args: [SL.eid] }) as Hex;
    if (peer && !/^0x0+$/.test(peer)) { const st = await solConn.getAccountInfo(new PublicKey(Buffer.from(peer.slice(2), 'hex'))); if (st) programId = st.owner.toBase58(); }
  } catch { /* the V2 escrow is not deployed yet */ }
  if (!programId) programId = SL.programId || MAINNET_PROGRAM; // any browser (e.g. the EVM wallet's) finds the deployed program
}
async function readFlag() { try { const r = await fetch(API + '/launchpad/solana', { cache: 'no-store' }); if (r.ok) flag = await r.json(); } catch {} }
async function readSolana() {
  try {
    const so = await soFile();
    [costs, dst] = await Promise.all([PD.costs(solConn, so), PD.deployState(solConn, so, lsKeys, SO.sha256, programId || undefined)]);
    if (dst.programId && dst.phase === 'deployed') { programId = dst.programId; localStorage.setItem('msea-solprog-id', programId); }
    solBal = solWallet.pubkey ? await solConn.getBalance(solWallet.pubkey) : null;
    if (deployed()) setup = await (await SS()).setupPlan(solConn, setupCfg());
  } catch (e) { msg = `<span class="err">Solana: ${esc(errText(e))}</span>`; }
}
function links(): Link[] { return KEYS.map(k => ({ k, name: NAMES[k], eid: M.chains[k].eid, escrow: V2.escrows[k], mover: V2.movers[k], v1: M.chains[k].omniEscrow, confirmations: M.chains[k].confirmations })); }
function setupCfg() {
  return { pid: new PublicKey(programId), admin: solWallet.pubkey || new PublicKey(dst?.authority || programId), localEid: SL.eid, approver: M.approver, feeRecipient: new PublicKey(SL.feeRecipient),
    feeBps: SL.feeBps ?? 50, moveFee: BigInt(SL.moveFeeLamports ?? 1_000_000), links: links(), msgLib: new PublicKey(MSGLIB), dvnConfig: MSGLIB === ULN302 };
}
let cidCache: Record<string, Hex[]> | null = null;
/** Existing multichain (V1) collections: their ids, so the mover can be enabled for them (setCollection steps). */
async function existingCids(): Promise<Record<string, Hex[]>> {
  if (cidCache) return cidCache;
  const cand: Record<string, Set<string>> = Object.fromEntries(KEYS.map(k => [k, new Set<string>()]));
  for (const c of (CFG as any).collections) for (const d of c.deployments || []) if (cand[d.chain]) cand[d.chain].add(d.address);
  try { const r = await fetch(API + '/launchpad/drops'); const j = await r.json(); for (const d of j.drops || []) if (d.mode === 'multichain') for (const x of d.deployments || []) if (cand[x.chain]) cand[x.chain].add(x.address); } catch {}
  const CID = [{ type: 'function', name: 'collectionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }] as const;
  const out: Record<string, Hex[]> = {};
  await Promise.all(KEYS.map(async k => { const ids = await Promise.all([...cand[k]].map(a => readClient(k).readContract({ address: a as Address, abi: CID, functionName: 'collectionId' }).catch(() => null)));
    out[k] = [...new Set(ids.filter(Boolean) as Hex[])]; }));
  return (cidCache = out);
}
async function readChain(k: string) {
  try {
    const pub = readClient(k) as any; const [blk, gp, cids] = await Promise.all([pub.getBlock(), pub.getGasPrice().catch(() => undefined), existingCids()]);
    const now = Number(blk.timestamp); clockSkew[k] = now - Math.floor(Date.now() / 1000); gasPrice[k] = gp;
    plans[k] = await chainPlan({ k, pub, LP, names: NAMES, store32: deployed() ? store32() : null, existingCids: cids[k] || [], now }); delete chainErr[k];
  } catch (e) { chainErr[k] = errText(e); }
}
async function refresh(what: 'all' | 'sol' | string = 'all') {
  if (what === 'all') { await readFlag(); await findProgram(); }
  if (what === 'all' || what === 'sol') { await readSolana(); if (xf) await xRefresh().catch(() => {}); }
  render();
  if (what === 'all') await Promise.all(KEYS.map(k => readChain(k).then(render)));
  else if (what !== 'sol') await readChain(what);
  render();
}

// ------------------------------------------------------------------ actions
const solSigner = () => { if (!solWallet.pubkey || !solWallet.prov) throw new Error('Connect Phantom first (step 1).'); const p = solWallet.prov;
  return { publicKey: solWallet.pubkey, signTransaction: (t: any) => p.signTransaction(t), signAllTransactions: async (ts: any[]) => (p.signAllTransactions ? p.signAllTransactions(ts) : Promise.all(ts.map(t => p.signTransaction(t)))) }; };
// Deploy: resumable at any point (it re-reads the chain). wantDeploy = MC started it and it is not finished: an upload that
// stalled (busy network, phone tab suspended) continues by itself when the tab is visible again.
let wantDeploy = false; let autoTries = 0;
const RETRYABLE = /tap Deploy again|network|busy|fetch|timed? ?out|expired|block height/i;
async function doDeploy() {
  const so = await soFile(); const w = solSigner(); wantDeploy = true;
  if (solBal !== null && costs && solBal < costs.need && dst?.phase === 'new') throw new Error(`Your wallet has ${sol(solBal)} SOL; the deploy needs about ${sol(costs.need)} SOL while it runs.`);
  const pid = await PD.deployProgram(solConn, so, w, lsKeys, SO.sha256, p => {
    if (p.stage === 'approve-1') say('Approve 1 of 2 in your wallet: create the upload account.');
    if (p.stage === 'upload') { up = { written: p.written || 0, total: p.total || 0 }; say('Uploading the program… keep this tab open.'); }
    if (p.stage === 'retry') say(`<span class="warn">${esc(p.note || 'Network busy: retrying…')}</span>`);
    if (p.stage === 'top-up') say('Approve a small top-up for the upload fees (retries used them up).');
    if (p.stage === 'approve-2') say('Approve 2 of 2 in your wallet: create the program.');
  });
  wantDeploy = false; autoTries = 0; up = null; programId = pid; localStorage.setItem('msea-solprog-id', pid); say(`<span class="ok">Program deployed: <span class="mono">${esc(pid)}</span></span>`);
  await refresh('all');
}
function autoResume() {
  if (!wantDeploy || busy || document.visibilityState !== 'visible' || !dst || dst.phase === 'new' || dst.phase === 'deployed' || autoTries >= 5) return;
  autoTries++; say('<span class="warn">Continuing the upload…</span>'); run('deploy', doDeploy);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; if (busy) return; refresh('sol').then(autoResume); });
async function doCancel() { wantDeploy = false; await PD.cancelUpload(solConn, solSigner(), lsKeys, SO.sha256); up = null; programId = ''; localStorage.removeItem('msea-solprog-id'); say('Upload cancelled; the deposit went back to your wallet.'); await refresh('sol'); }
async function doSetup() {
  const w = solSigner(); if (dst?.authority && dst.authority !== w.publicKey.toBase58()) throw new Error(`Connect the wallet that deployed the program (${short(dst.authority)}).`);
  const { setupPlan, runSetup } = await SS(); const items = await setupPlan(solConn, setupCfg());
  await runSetup(solConn, w, items, m => say(esc(m)));
  say('<span class="ok">Program set up.</span>'); await refresh('sol'); await Promise.all(KEYS.map(k => readChain(k))); render();
}
const isMcWallet = () => !!wallet.address && wallet.address.toLowerCase() === MC.toLowerCase();
async function doStep(k: string) {
  if (!wallet.address) { openConnect(); throw new Error('Connect your EVM wallet.'); }
  if (!isMcWallet()) throw new Error(`These steps must be signed by ${short(MC, 6, 4)} (the owner wallet). Connected: ${short(wallet.address, 6, 4)}.`);
  const p = plans[k]; if (!p || p.next < 0) return; const s = p.steps[p.next];
  say(`${esc(NAMES[k])}: confirm step ${p.next + 1} of ${p.steps.length} in your wallet (${esc(s.title)}).`);
  await ensureChain(k);
  const wc = createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) });
  const h = await wc.sendTransaction({ account: wallet.address as Hex, to: s.to as Hex, data: s.data as Hex, value: 0n } as any);
  say(`${esc(NAMES[k])}: step ${p.next + 1} sent, waiting for the chain…`);
  const rc = await readClient(k).waitForTransactionReceipt({ hash: h, timeout: 300_000 });
  if (rc.status !== 'success') throw new Error(`${NAMES[k]} step ${p.next + 1} failed on-chain.`);
  say(`<span class="ok">${esc(NAMES[k])}: step ${p.next + 1} done ✓</span>`); await readChain(k);
}
async function doTurnOn() {
  if (!wallet.address) { openConnect(); throw new Error('Connect your EVM wallet.'); }
  if (!isMcWallet()) throw new Error(`Only ${short(MC, 6, 4)} can turn Solana on.`);
  const message = `MultiSea: turn Solana on\nProgram: ${programId}\nIssued: ${new Date().toISOString()}`;
  say('Sign the message in your wallet (free, no transaction).');
  const wc = createWalletClient({ transport: custom(wallet.provider) });
  const signature = await wc.signMessage({ account: wallet.address as Hex, message });
  say('MultiSea is checking every contract on-chain…');
  const r = await fetch(API + '/launchpad/solana/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `MultiSea answered ${r.status}`);
  localStorage.setItem('msea-solana-v1', JSON.stringify({ programId }));
  say('<span class="ok">Solana is on for creators and collectors.</span>'); await readFlag();
}
// ---- existing collections (live V1 drops) on Solana: register + create every id as a locked copy (from the previous page)
// Live V1 multichain collections (config) get their full set on Solana like on the EVM chains: registered (enforced royalties
// to the MultiSea fee wallet) + every id created as a locked copy held by the Store (escrow). src/solexisting.ts.
const XCOLS: any[] = (CFG as any).collections.filter((c: any) => (c.deployments || []).length > 1 && c.escrow);
const SOL_PER_COPY = 0.00289192, SOL_REGISTER = 0.0093; // measured (mainnet simulation): Core asset rent + Metaplex create fee; drop + collection rent
let xslug = ''; let xcid = ''; let xf: O.ExistingParams | null = null; let xst: { registered: boolean; total: number; created: number; items: any[] } | null = null;
const pid = () => new PublicKey(programId);
const xcfg = () => ({ pid: pid(), admin: solWallet.pubkey || new PublicKey(dst?.authority || programId), cid: xcid, params: xf! });
async function xLoad(slug: string) {
  xslug = slug; xcid = ''; xf = null; xst = null; render(); const c = XCOLS.find(x => x.slug === slug); if (!c) return;
  try {
    const orig = c.deployments.find((d: any) => d.original) || c.deployments[0]; const pub = readClient(orig.chain) as any;
    const ABI = [{ type: 'function', name: 'collectionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
      { type: 'function', name: 'royaltyInfo', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'uint256' }] },
      { type: 'function', name: 'eids', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32[]' }] }] as const;
    const [cid, roy, eids] = await Promise.all([pub.readContract({ address: orig.address, abi: ABI, functionName: 'collectionId' }),
      pub.readContract({ address: orig.address, abi: ABI, functionName: 'royaltyInfo', args: [1n, 10000n] }), pub.readContract({ address: orig.address, abi: ABI, functionName: 'eids' })]);
    const suffix = c.metadataSuffix ?? '.json'; if (suffix !== '.json') throw new Error(`${c.name}: metadata files end in "${suffix}", the Solana program expects ".json".`);
    xcid = cid; xf = { name: String(c.name).slice(0, 32), collectionUri: `${c.metadataBase}${c.idStart ?? 1}${suffix}`, baseUri: c.metadataBase,
      payout: new PublicKey(SL.feeRecipient), royaltyBps: Number(roy[1]), maxSupply: Number(c.supply), eids: [...new Set([...(eids as number[]).map(Number), SL.eid])] };
    await xRefresh();
  } catch (e) { say(`<span class="err">${esc(c.name)}: ${esc(errText(e))}</span>`); }
}
async function xRefresh() { if (!programId || !xf) return render(); xst = await (await import('./solexisting')).existingPlan(solConn, xcfg()); render(); }
async function xAdd() {
  if (!xf) throw new Error('Pick a collection first.');
  const E = await import('./solexisting');
  try { await E.runExisting(solConn, solSigner(), xcfg(), m => say(esc(m))); }
  finally { await xRefresh().catch(() => {}); } // re-read the chain: the button continues with only the missing copies
  say(`<span class="ok">${esc(xf.name)}: all ${xf.maxSupply} pieces exist on Solana, held in escrow.</span>`);
}
function existingHtml() {
  const missing = xst ? xst.total - xst.created : 0; const n = xst?.items.length || 0; const copiesTx = n - (xst && !xst.registered ? 1 : 0);
  const appr = (xst && !xst.registered ? 1 : 0) + Math.ceil(Math.max(0, copiesTx) / 6); // register alone first, then the copies (src/solexisting.ts)
  const cost = xst ? missing * SOL_PER_COPY + (xst.registered ? 0 : SOL_REGISTER) + n * 0.00002 : 0; // + network/priority fees
  return `<details class="sddet sdx" data-det="x" ${openDet.has('x') ? 'open' : ''}><summary>Existing collections on Solana</summary><div class="sdpre">
    <p>Gives a live multichain collection its full set on Solana, like the other chains: registers it (royalties enforced, paid to ${esc(short(SL.feeRecipient))}) and creates every piece as a locked copy held by the Solana escrow. Bridging to Solana then releases the copy from escrow; leaving locks it again. About ${SOL_PER_COPY.toFixed(4)} SOL per piece (account rent + Metaplex fee, not refundable), paid by the program admin wallet. After step 3.</p>
    <label>Collection <select class="sdin" data-xslug><option value="">Choose…</option>${XCOLS.map(c => `<option value="${esc(c.slug)}" ${c.slug === xslug ? 'selected' : ''}>${esc(c.name)} (${c.supply})</option>`).join('')}</select></label>
    ${xf ? `<p class="mut">${esc(xf.name)} · ${xf.maxSupply} pieces · royalties ${xf.royaltyBps / 100}% to <span class="mono">${esc(short(SL.feeRecipient, 6, 4))}</span> · id <span class="mono">${esc(short(xcid, 6, 4))}</span></p>` : ''}
    ${xst ? `<p>${xst.registered ? '<b class="ok">✓ registered</b>' : 'not registered'} · copies ${xst.created}/${xst.total}
      ${n ? btn('xadd', `${xst.created ? `Continue: ${xst.created} of ${xst.total} copies done · ` : 'Add to Solana: '}${n} transaction${n > 1 ? 's' : ''} · ${appr} approval${appr > 1 ? 's' : ''} · ≈ ${cost.toFixed(3)} SOL`, setupDone() && !!solWallet.pubkey, 'obtn') : '<b class="ok">✓ full set on Solana</b>'}</p>` : ''}
    </div></details>`;
}
const run = (key: string, f: () => Promise<void>) => { if (busy) return; busy = key; render(); let again = false;
  f().catch(e => { const m = errText(e); const soft = RETRYABLE.test(m) && !/reject|denied|cancel/i.test(m);
    say(soft ? `<span class="warn">${esc(m)}</span>` : `<span class="err">${esc(m)}</span>`); again = key === 'deploy' && soft; })
    .finally(async () => { busy = ''; if (key === 'deploy') await refresh('sol'); render(); if (again) setTimeout(autoResume, 3000); }); };

// ------------------------------------------------------------------ render
const det = (id: string, body: string) => `<details class="sddet" data-det="${id}" ${openDet.has(id) ? 'open' : ''}><summary>Details</summary><div class="sdpre">${body}</div></details>`;
const btn = (act: string, label: string, on: boolean, cls = 'sdbig') => `<button class="${cls}" data-act="${act}" ${on && !busy ? '' : 'disabled'}>${busy === act ? '<span class="spin"></span> ' : ''}${label}</button>`;
const hms = (s: number) => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const left = (k: string, readyAt: number) => readyAt - (Math.floor(Date.now() / 1000) + (clockSkew[k] || 0));
const fmtNative = (wei: bigint, k: string) => { const v = Number(formatUnits(wei, 18)); return `${v < 0.0001 ? v.toPrecision(2) : v.toLocaleString(undefined, { maximumSignificantDigits: 3 })} ${esc(M.chains[k].native || 'ETH')}`; };
const logo = (k: string) => `<img src="/logos/${esc(chainsCfg[k]?.logo || k)}.svg" alt="">`;

function chainRow(k: string) {
  const p = plans[k]; const name = esc(NAMES[k]);
  if (!p) return `<div class="sdch"><div>${logo(k)}<b>${name}</b></div><div><div class="sdbar"><i style="width:0"></i></div><div class="lbl">${chainErr[k] ? `<span class="err">Could not read ${name}: ${esc(chainErr[k])}</span>` : '<span class="spin"></span> reading the chain…'}</div></div><button class="sdbig sm" disabled>Sign step 1</button></div>`;
  const N = p.steps.length, pct = Math.round(p.doneCount / N * 100); const gas = gasPrice[k] !== undefined && p.remainingGas > 0n ? ` · about ${fmtNative(p.remainingGas * gasPrice[k]!, k)} in gas left` : '';
  let lbl: string, b: string;
  if (p.firstOpen === -1) { lbl = `<span class="ok">All ${N} steps done ✓</span>`; b = '<button class="sdbig sm" disabled>Done ✓</button>'; }
  else if (p.next >= 0) { const s = p.steps[p.next]; const w = p.steps.find(x => !x.done && x.readyAt && left(k, x.readyAt) > 0);
    lbl = `${p.doneCount ? `${p.doneCount} of ${N} done · ` : ''}Next: ${esc(s.title)}${w ? ` · 48-hour wait: <span class="sdcd" data-cd="${k}:${w.readyAt}">${hms(left(k, w.readyAt!))}</span> left` : ''}${gas}`; b = btn('step:' + k, `Sign step ${p.next + 1}`, true, 'sdbig sm'); }
  else { const w = p.steps[p.firstOpen];
    if (w.readyAt) { const t = left(k, w.readyAt); lbl = `${p.doneCount} of ${N} done · 48-hour safety wait on the old contracts: <span class="sdcd" data-cd="${k}:${w.readyAt}">${hms(t)}</span> left${gas}`; b = `<button class="sdbig sm" disabled>Sign step ${p.firstOpen + 1} in ${Math.ceil(t / 3600)} h</button>`; }
    else { lbl = `${p.doneCount} of ${N} done · ${esc(w.blocked || 'waiting')}`; b = `<button class="sdbig sm" disabled>Sign step ${p.firstOpen + 1}</button>`; } }
  return `<div class="sdch"><div>${logo(k)}<b>${name}</b></div><div><div class="sdbar"><i style="width:${pct}%"></i></div><div class="lbl">${lbl}</div></div>${b}</div>`;
}
function chainDetails() {
  return KEYS.map(k => { const p = plans[k]; if (!p) return `<b>${esc(NAMES[k])}</b>: not read yet`;
    const nx = p.next >= 0 ? p.steps[p.next] : null;
    return `<b>${esc(NAMES[k])}</b>${gasPrice[k] !== undefined ? ` · gas price ${Number(formatUnits(gasPrice[k]!, 9)).toLocaleString(undefined, { maximumSignificantDigits: 3 })} gwei` : ''}${nx ? `<br>next: step ${p.next + 1}, ${esc(nx.detail)}<br>to <span class="mono">${esc(nx.to)}</span> · ${(nx.data.length - 2) / 2} bytes of data` : ''}
      <ol>${p.steps.map(s => `<li class="${s.done ? 'ok' : ''}">${s.done ? '✓ ' : ''}${esc(s.title)}${!s.done && s.blocked ? ` <span class="mut">(${esc(s.blocked)})</span>` : ''}${!s.done && s.readyAt ? ` <span class="mut">(ready ${esc(new Date(s.readyAt * 1000).toLocaleString())})</span>` : ''}</li>`).join('')}</ol>`; }).join('') +
    `<p>Each ✓ is an on-chain read: code at the contract's fixed (CREATE2) address, peers(), LayerZero getConfig, owner(), the timelock operation state. Gas figures = remaining gas units (measured on a mainnet fork) × the chain's current gas price.</p>`;
}
function render() {
  const sw = solWallet.pubkey?.toBase58(); const N = KEYS.length;
  const chainsDone = KEYS.filter(chainDone).length; const chainFrac = KEYS.reduce((s, k) => s + (plans[k] ? plans[k]!.doneCount / plans[k]!.steps.length : 0), 0) / N;
  const setupFrac = setup ? setup.filter(i => i.done).length / setup.length : deployed() ? 0 : 0;
  const s1 = !!sw || deployed(), s2 = deployed(), s3 = setupDone(), s4 = chainsDone === N, s5 = isOn();
  const pct = Math.round(((s1 ? 1 : 0) + (s2 ? 1 : (dst && dst.total ? (up ? up.written : dst.written) / dst.total * 0.9 : 0)) + (s3 ? 1 : setupFrac) + chainFrac + (s5 ? 1 : 0)) / 5 * 100);
  const nowStep = !s1 ? 0 : !s2 ? 1 : !s3 ? 2 : !s4 ? 3 : !s5 ? 4 : -1;
  const wrongSol = s2 && sw && dst?.authority && dst.authority !== sw;
  const steps = [
    { t: 'Connect Phantom', done: !!sw, p: 'Your Solana wallet. It pays the Solana costs and becomes the owner of the MultiSea Solana program.',
      body: sw ? `<div class="sdst"><span class="okc">✓ Connected</span> <span class="mono">${esc(short(sw))}</span>${solBal !== null ? ` · ${sol(solBal)} SOL` : ''}${wrongSol ? ` · <span class="err">the program belongs to <span class="mono">${esc(short(dst!.authority!))}</span>: connect that wallet</span>` : ''}</div>`
        : `${btn('solw:phantom', 'Connect Phantom', true)} ${btn('solw:solflare', 'Solflare', true, 'obtn')}`,
      d: 'The wallet becomes the program\'s upgrade authority, its MultiSea admin and its LayerZero delegate.' },
    { t: 'Deploy the Solana program', done: s2, cost: costs ? `≈ ${sol(costs.need)} SOL needed · ≈ ${sol(costs.locked)} SOL stays locked` : '',
      p: `One button. Your wallet asks you to approve 2 times; the upload in between runs by itself (${dst ? dst.total : '~100'} small transactions, keep this tab open). The upload deposit comes back automatically at the end.`,
      body: s2 ? `<div class="sdst"><span class="okc">✓ Deployed</span> program <span class="mono">${esc(programId)}</span> · ${costs ? sol(costs.locked) : ''} SOL locked (refundable if ever closed)</div>`
        : `${btn('deploy', dst && dst.phase !== 'new' ? 'Continue deploy' : 'Deploy program', !!sw && !!dst)}${dst && dst.phase !== 'new' ? ` ${btn('cancel', 'Cancel and refund', !!sw, 'obtn')}` : ''}
          ${up || (dst && dst.phase !== 'new') ? `<div class="sdbar wide"><i style="width:${Math.round(((up?.written ?? dst!.written) / (up?.total || dst!.total || 1)) * 100)}%"></i></div><div class="sdst mut">Uploaded ${up?.written ?? dst!.written} of ${up?.total ?? dst!.total} parts</div>` : ''}
          ${!sw ? '<div class="sdst mut">Connect Phantom first.</div>' : ''}`,
      d: `Program file <span class="mono">multisea_omni.so</span> · ${SO.size.toLocaleString()} bytes · sha256 <span class="mono">${SO.sha256}</span>
        <br>Approval 1: create a temporary upload account${costs ? ` (${sol(costs.buffer)} SOL deposit)` : ''} + fund a throwaway upload key (${sol(PD.UPLOAD_FUND)} SOL for the upload fees). The throwaway keys stay in this browser so an interrupted upload resumes; they control nothing after the deploy.
        <br>Upload: ${dst ? dst.total : '~100'} transactions of ${PD.CHUNK} bytes signed by the throwaway key in this tab (no wallet prompts), 4 at a time.
        <br>Approval 2: create the program from the upload (upgrade authority = your wallet); the upload account is closed, its deposit refunded, and the throwaway key returns what is left.
        <br>RPC <span class="mono">${esc(SOL_RPC)}</span>
        <br><br>Prefer the terminal? Same result with your keypair file (the script builds the program from source):<br><span class="mono">git clone https://github.com/mcontwitter-glitch/OverSea && OverSea/solana/deploy/deploy-program.sh --keypair &lt;your-wallet.json&gt; --go</span>
        <br>Already deployed elsewhere? Program id: <input class="sdin" data-pid value="${esc(programId)}" placeholder="program id">` },
    { t: 'Set up the program', done: s3, cost: setup && !s3 ? `${setup.filter(i => !i.done).length} transactions · ${Math.ceil(setup.filter(i => !i.done).length / 6)} approval${setup.filter(i => !i.done).length > 6 ? 's' : ''}` : '',
      p: `Saves the MultiSea settings (${(SL.feeBps ?? 50) / 100}% fee to ${esc(short(SL.feeRecipient))}, the MultiSea approver) and links the program to the ${N} chains. ${setup && !setupDone() ? (Math.ceil(setup.filter(i => !i.done).length / 6) > 1 ? `${Math.ceil(setup.filter(i => !i.done).length / 6)} approvals in your wallet ("Approve all" each).` : 'One "Approve all" in your wallet.') : ''}`,
      body: s3 ? `<div class="sdst"><span class="okc">✓ Done</span> settings saved · ${N} of ${N} chains linked</div>` : `${btn('setup', 'Set up program', s2 && !!sw && !wrongSol)}${!s2 ? '<div class="sdst mut">After step 2.</div>' : ''}`,
      d: setup ? `<ol>${setup.map(i => `<li class="${i.done ? 'ok' : ''}">${i.done ? '✓ ' : ''}${esc(i.label)}</li>`).join('')}</ol>` : `init_store (fee recipient ${esc(SL.feeRecipient)}, ${SL.feeBps ?? 50} bps, move fee ${(SL.moveFeeLamports ?? 1_000_000) / 1e9} SOL); per chain: set_peer + LayerZero libraries, nonce and config (2-of-2 DVNs), set_mover (existing collections).` },
    { t: 'Connect your EVM wallet and sign each chain', done: s4, cost: `${N} chains`,
      p: 'Each chain has one button that always knows the next step. Start every chain today: step 1 starts a 48-hour safety wait on the old contracts, and the rest can be signed while it runs. You can stop and come back anytime; the page reads the chain to see where you are.',
      body: `${wallet.address ? `<div class="sdst"><span class="okc">✓ Connected</span> <span class="mono">${esc(short(wallet.address, 6, 5))}</span>${isMcWallet() ? '' : ` · <span class="err">sign with ${esc(short(MC, 6, 5))}</span>`}</div>` : btn('connect', 'Connect EVM wallet', true)}<div class="sdchains">${KEYS.map(chainRow).join('')}</div>`,
      d: chainDetails() },
    { t: 'Turn Solana on', done: s5,
      p: 'When every step shows ✓, this button shows Solana to creators and collectors on multisea.io. Until then Solana stays visible but greyed out.',
      body: s5 ? `<div class="sdst"><span class="okc">✓ Solana is on</span>${flag?.enabledAt ? ` since ${esc(new Date(flag.enabledAt).toLocaleString())}` : ''}</div>`
        : `${btn('on', 'Turn Solana on', s2 && s3 && s4)}${!(s2 && s3 && s4) ? `<div class="sdst mut">Waiting for: ${[!s2 && 'the program (step 2)', s2 && !s3 && 'program setup (step 3)', ...KEYS.filter(k => !chainDone(k)).map(k => NAMES[k] + (plans[k]?.steps.some(s => !s.done && s.readyAt) ? ' (48 h wait)' : ''))].filter(Boolean).join(', ')}</div>` : ''}`,
      d: 'Signs a short message with your EVM wallet (no gas). The MultiSea server checks the program, its settings and links, and every chain\'s escrow, factory and Solana link on-chain, then switches Solana on for the site and the minting server.' },
  ];
  app.innerHTML = `${navHtml('admin')}<section class="page sdp"><h1>Turn on Solana</h1>
   <p class="sdlead">5 steps. You sign everything with your own wallets; MultiSea never holds a key. Each step shows ✓ when it is done, and the page picks up where you left off.</p>
   <div class="sdprog"><i style="width:${pct}%"></i></div>
   ${msg ? `<div class="sdmsg">${msg}</div>` : ''}
   ${steps.map((s, i) => `<div class="sdstep ${s.done ? 'done' : i === nowStep ? 'now' : ''}"><div class="sdnum">${s.done ? '✓' : i + 1}</div><div class="sdbody"><h3>${s.t}${s.cost ? `<span class="sdcost">${s.cost}</span>` : ''}</h3><p>${s.p}</p>${s.body}${det('s' + i, s.d)}</div></div>`).join('')}
   ${existingHtml()}
  </section>`;
  bindNav();
}
setInterval(() => { document.querySelectorAll<HTMLElement>('[data-cd]').forEach(el => { const [k, t] = el.dataset.cd!.split(':'); const s = left(k, +t); el.textContent = hms(s); if (s <= 0) readChain(k).then(render); }); }, 1000);
app.addEventListener('toggle', e => { const d = e.target as HTMLElement; if (d.dataset?.det) (d as HTMLDetailsElement).open ? openDet.add(d.dataset.det) : openDet.delete(d.dataset.det); }, true);
app.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!b || (b as HTMLButtonElement).disabled) return; const a = b.dataset.act!;
  if (a === 'connect') return openConnect();
  if (a.startsWith('solw:')) return run(a, () => connectSol(a.slice(5)).then(() => refresh('sol')));
  if (a === 'deploy') return run(a, doDeploy);
  if (a === 'cancel') return run(a, doCancel);
  if (a === 'setup') return run(a, doSetup);
  if (a.startsWith('step:')) return run(a, () => doStep(a.slice(5)));
  if (a === 'on') return run(a, doTurnOn);
  if (a === 'xadd') return run(a, xAdd); });
app.addEventListener('change', e => { const t = e.target as HTMLInputElement;
  if (t.dataset.xslug !== undefined) { xLoad(t.value); return; }
  if (t.dataset.pid !== undefined) { const v = t.value.trim(); try { if (v) new PublicKey(v); programId = v; v ? localStorage.setItem('msea-solprog-id', v) : localStorage.removeItem('msea-solprog-id'); refresh('all'); } catch { say('<span class="err">That is not a Solana program id.</span>'); } } });
onWallet(render); onSolWallet(() => refresh('sol'));
render(); refresh('all');
