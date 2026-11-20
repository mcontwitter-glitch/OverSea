// Solana for launchpad multichain drops: deploy (create_drop with MultiSea's approval), mint (REQUEST to the Base hub),
import './btc/polyfill';
// and bridge to / from Solana. Everything here stays disabled until Solana is switched on (src/solflag.ts: the Worker's
// verified "Turn Solana on", or VITE_SOLANA_OMNI_ID for a local / devnet build).
import { PublicKey } from '@solana/web3.js';
import { keccak256, encodeAbiParameters, parseAbi, createPublicClient, http, type Address } from 'viem';
import CFG from '../config/collections.json';
import LP from '../config/launchpad.json';
import { api } from './auth';
import { solWallet, solConn, sendSol, SOL_RPC } from './solwallet';
import * as O from './solanaomni';

const SL: any = (LP as any).solana || {};
import { SOLANA_ID } from './solflag';
export { SOLANA_ID, SOLANA_ON } from './solflag';
export const SOL_EID: number = Number((import.meta as any).env?.VITE_SOLANA_EID || SL.eid || 30168);
const PID = () => new PublicKey(SOLANA_ID);
const MAX_LZ_FEE = BigInt(SL.maxLzFeeLamports || 50_000_000); // cap passed to the endpoint; the libraries charge their actual quote
const SEND_LIB = new PublicKey(SL.sendLib || '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH');
const chains = CFG.chains as Record<string, { name: string; chainId: number; rpc: string }>;
const ESC_ABI = parseAbi(['function quoteHubValue(bytes32,uint32,uint256) view returns (uint256)', 'function quoteMove(bytes32,uint32,uint256,bytes32) view returns (uint256,uint256)']);
export const DROP_V2 = parseAbi(['function moveTo(uint32,uint256,bytes32) payable', 'function hasSolana() view returns (bool)']);

export const cidOf = (slug: string, creator: string) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [slug, creator.toLowerCase() as Address]));
export const lamportsOfUsd = (usd: string, solUsd: number | null | undefined) => (usd === '' || !(+usd >= 0) ? '' : +usd === 0 ? '0' : solUsd ? String(Math.round((+usd / solUsd) * 1e9)) : '');
export const fmtSol = (lamports: string | bigint) => (Number(BigInt(lamports || 0)) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
const pubEvm = (k: string) => createPublicClient({ transport: http(chains[k].rpc) });
const lzEid = (k: string) => (LP as any).eids[k] as number;
// Solana drops are V2 drops: their escrow on every EVM chain is the V2 escrow (config/launchpad.json solana.v2, CREATE2).
const escrowOn = (k: string) => (LP as any).solana.v2.escrows[k] as Address;
const hub = () => (LP as any).hubChain as string;

async function sendAccounts(payer: PublicKey, dstEid: number, receiver: string) {
  const { EndpointProgram, UlnProgram } = await import('@layerzerolabs/lz-solana-sdk-v2');
  const ep = new EndpointProgram.Endpoint(O.LZ_ENDPOINT_ID); const uln = new UlnProgram.Uln(SEND_LIB);
  return ep.getSendIXAccountMetaForCPI(solConn as any, payer, { sender: O.storePda(PID()).toBytes(), dstEid, receiver } as any, uln as any) as any;
}

/** Creator: create the drop's Solana side (creator pays the rent), then record it with the Worker. Returns the Drop account. */
export async function deploySolanaDrop(slug: string, onTx: (sig: string) => void): Promise<string> {
  const a = await api('/launchpad/approval/' + slug, { auth: true, body: { chain: 'solana' } });
  if (!solWallet.pubkey) throw new Error('Connect Phantom or Solflare (the Solana wallet you entered when you created the drop).');
  if (solWallet.pubkey.toBase58() !== a.creator) throw new Error(`Connect the Solana wallet ${a.creator}: MultiSea approved the drop for that wallet.`);
  const p = a.params; const { sig, recoveryId } = O.splitApprovalSig(a.signature);
  const params: O.DropParams = { name: p.name, collectionUri: p.collectionUri, baseUri: p.baseUri, preRevealUri: p.preRevealUri, payout: new PublicKey(p.payout), royaltyBps: p.royaltyBps,
    maxSupply: p.maxSupply, hubEid: p.hubEid, eids: p.eids, phases: p.phases.map((x: any) => ({ start: BigInt(x.start), end: BigInt(x.end), maxPerWallet: x.maxPerWallet, maxSupply: x.maxSupply, merkleRoot: O.hex32(x.merkleRoot), price: BigInt(x.price) })) };
  const drop = O.dropPda(a.collectionId, PID());
  if (!(await solConn.getAccountInfo(drop))) onTx(await sendSol([O.createDropIx({ creator: solWallet.pubkey, cid: a.collectionId, params, deadline: BigInt(a.deadline), sig, recoveryId }, PID())], 400_000, { landed: async () => !!(await solConn.getAccountInfo(drop)) }));
  await api('/launchpad/deployed/' + slug, { auth: true, body: { chain: 'solana', address: drop.toBase58() } });
  return drop.toBase58();
}

/** Collector: mint `qty` (<= 8) on Solana. Pays the phase price (held by the drop until the hub confirms; refunded if rejected),
 *  the LayerZero fee and the Base hub's CONFIRM leg back to Solana. Resolves once the request is confirmed or rejected. */
export async function mintOnSolana(cid: string, phaseId: number, qty: number, proof: string[], onTx: (sig: string) => void): Promise<{ status: 'confirmed' | 'refunded' | 'pending'; rid: bigint }> {
  if (!solWallet.pubkey) throw new Error('Connect Phantom or Solflare first.');
  if (qty < 1 || qty > O.SOL_MAX_QTY) throw new Error(`Solana mints are 1-${O.SOL_MAX_QTY} per transaction.`);
  const dropAcc = await solConn.getAccountInfo(O.dropPda(cid, PID())); if (!dropAcc) throw new Error('This drop is not deployed on Solana yet.');
  const d = O.decodeDrop(dropAcc.data);
  const hubValue = ((await pubEvm(hub()).readContract({ address: escrowOn(hub()), abi: ESC_ABI, functionName: 'quoteHubValue', args: [cid as `0x${string}`, SOL_EID, BigInt(qty)] })) as bigint) * 12n / 10n;
  const accts = await sendAccounts(solWallet.pubkey, d.hubEid, escrowOn(hub()));
  const rid = d.nextRid + 1n;
  onTx(await sendSol([O.mintIx({ minter: solWallet.pubkey, cid, hubEid: d.hubEid, nextRid: d.nextRid, phaseId, qty, proof: proof.map(x => O.hex32(x)), hubValue, nativeFee: MAX_LZ_FEE, sendAccounts: accts }, PID())], 600_000));
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 6000));
    const r = await solConn.getAccountInfo(O.requestPda(cid, rid, PID())); if (!r) continue; const q = O.decodeRequest(r.data);
    if (q.status === 2) return { status: 'confirmed', rid }; if (q.status === 3 || q.status === 4) return { status: 'refunded', rid }; }
  return { status: 'pending', rid };
}
export const claimSolRefund = (cid: string, rid: bigint) => sendSol([O.claimRefundIx(solWallet.pubkey!, cid, rid, PID())], 200_000);

/** EVM -> Solana: the holder moves token `id` from EVM chain `k` to a Solana wallet (V2 drops only). */
export async function quoteToSolana(k: string, cid: string, id: bigint, solTo: string) {
  const [p, lz] = (await pubEvm(k).readContract({ address: escrowOn(k), abi: ESC_ABI, functionName: 'quoteMove', args: [cid as `0x${string}`, SOL_EID, id, O.hexOf(new PublicKey(solTo).toBytes())] })) as [bigint, bigint];
  return { platform: p, lz, value: p + (lz * 102n) / 100n };
}
export const toSolanaArgs = (id: bigint, solTo: string) => [SOL_EID, id, O.hexOf(new PublicKey(solTo).toBytes())] as const;

/** Solana -> EVM: lock token `id` on Solana and release it to `evmTo` on chain `k`. Pays the 0.001 SOL move fee + LayerZero. */
export async function fromSolana(cid: string, id: number, k: string, evmTo: string, onTx: (sig: string) => void) {
  if (!solWallet.pubkey) throw new Error('Connect Phantom or Solflare first.');
  const st = await solConn.getAccountInfo(O.storePda(PID())); if (!st) throw new Error('Solana program not initialised.');
  const store = O.decodeStore(st.data); const eid = lzEid(k);
  const accts = await sendAccounts(solWallet.pubkey, eid, escrowOn(k));
  onTx(await sendSol([O.moveOutIx({ holder: solWallet.pubkey, cid, tokenId: id, dstEid: eid, to: O.evmTo32(evmTo), nativeFee: MAX_LZ_FEE, feeRecipient: store.feeRecipient, sendAccounts: accts }, PID())], 400_000,
    { landed: async () => (await solOwner(cid, id)) === 'locked' }));
}
/** Owner of Solana copy `id` (null = not minted / not on Solana yet; the Store PDA = locked copy). */
export async function solOwner(cid: string, id: number) { const a = await solConn.getAccountInfo(O.assetPda(cid, id, PID())); const o = a ? O.coreAssetOwner(a.data) : null; return o ? (o.equals(O.storePda(PID())) ? 'locked' : o.toBase58()) : null; }
export const solTxLink = (sig: string) => `<a href="https://solscan.io/tx/${sig}${/devnet/.test(SOL_RPC) ? '?cluster=devnet' : ''}" target="_blank" rel="noopener" class="mono">${sig.slice(0, 10)}…</a>`;

// ---------------------------------------------------------------- drop page card (mint on Solana, bridge to / from Solana)
type Card = { tab: 'mint' | 'to' | 'from'; qty: number; id: string; evm: string; busy: boolean; msg: string; refund?: { cid: string; rid: bigint } };
const S: Card = { tab: 'mint', qty: 1, id: '', evm: '', busy: false, msg: '' };
const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function mountSolCard(el: HTMLElement, d: any) {
  const R = d.raw || {}; const cid = cidOf(R.slug, R.creator); const deployed = !!R.solana?.drop;
  const evms: string[] = Object.keys(d.addresses || {}); if (!S.evm || !evms.includes(S.evm)) S.evm = evms[0] || '';
  const now = Date.now() / 1000; const ai = (R.phases || []).findIndex((p: any) => now >= p.start && (!p.end || now < p.end)); const ph = ai >= 0 ? R.phases[ai] : null;
  const draw = () => {
    const w = solWallet.pubkey?.toBase58();
    const conn = w ? `<span class="mono small">${e(solWallet.name)} ${e(w.slice(0, 4))}…${e(w.slice(-4))}</span>` : `<button type="button" class="obtn sm" data-sc="connect" data-w="phantom">Phantom</button> <button type="button" class="obtn sm" data-sc="connect" data-w="solflare">Solflare</button>`;
    const tabs = (['mint', 'to', 'from'] as const).map(t => `<button type="button" class="pill ${S.tab === t ? 'on' : ''}" data-sc="tab" data-t="${t}">${t === 'mint' ? 'Mint on Solana' : t === 'to' ? 'Bridge to Solana' : 'Bridge from Solana'}</button>`).join(' ');
    const sel = `<select data-scf="evm">${evms.map(k => `<option value="${k}" ${k === S.evm ? 'selected' : ''}>${e((CFG.chains as any)[k]?.name || k)}</option>`).join('')}</select>`;
    let body = '';
    if (!deployed) body = '<p class="mut small">Not deployed on Solana yet.</p>';
    else if (S.tab === 'mint') body = !ph ? '<p class="mut small">No phase is live right now.</p>'
      : `<p class="small">${e(ph.name)}${ph.kind === 'allowlist' ? ' · allowlist' : ''} · ${fmtSol(ph.prices?.solana || '0')} SOL each + LayerZero fee</p><label class="small">Quantity (1-${O.SOL_MAX_QTY})<input type="number" min="1" max="${O.SOL_MAX_QTY}" data-scf="qty" value="${S.qty}"></label>
         <button type="button" class="bbtn ldmint" data-sc="mint" ${S.busy || !w ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span> Minting…' : `Mint ${S.qty} on Solana`}</button>
         <p class="mut small">${ph.kind === 'allowlist' ? 'Your connected Solana wallet must be on this allowlist (a Merkle proof is fetched before you sign). ' : ''}Your SOL is held by the drop until Base confirms the token ids (about a minute); if the mint is rejected you can claim it back.</p>`;
    else if (S.tab === 'to') body = `<label class="small">Token id<input data-scf="id" value="${e(S.id)}" placeholder="e.g. 42"></label><label class="small">From ${sel}</label>
         <button type="button" class="bbtn" data-sc="to" ${S.busy || !w ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span> Moving…' : 'Move to my Solana wallet'}</button><p class="mut small">Your EVM wallet signs on that chain; the NFT arrives in the Solana wallet above.</p>`;
    else body = `<label class="small">Token id<input data-scf="id" value="${e(S.id)}" placeholder="e.g. 42"></label><label class="small">To ${sel}</label>
         <button type="button" class="bbtn" data-sc="from" ${S.busy || !w ? 'disabled' : ''}>${S.busy ? '<span class="spin"></span> Moving…' : 'Move to my EVM wallet'}</button><p class="mut small">Pays the 0.001 SOL move fee plus LayerZero; delivered to your connected EVM wallet.</p>`;
    el.innerHTML = `<div class="fcard ldmintbox" style="margin-top:12px"><div class="gh">Solana <span class="mut small">Metaplex Core · royalties enforced</span></div>
      <div class="small" style="margin-bottom:6px">Wallet: ${conn}</div><div style="margin-bottom:8px">${tabs}</div>${body}
      ${S.refund ? `<button type="button" class="obtn sm" data-sc="refund">Claim refund</button>` : ''}${S.msg ? `<p class="small" style="margin-top:8px">${S.msg}</p>` : ''}</div>`;
  };
  const run = (f: () => Promise<void>) => { S.busy = true; S.msg = ''; draw(); f().catch(x => { S.msg = `<span class="err">${e(x?.shortMessage || x?.message || x)}</span>`; }).finally(() => { S.busy = false; draw(); }); };
  el.onclick = ev => { const b = (ev.target as HTMLElement).closest('[data-sc]') as HTMLElement | null; if (!b) return; ev.preventDefault(); ev.stopPropagation(); const a = b.dataset.sc;
    if (a === 'connect') { import('./solwallet').then(m => m.connectSol(b.dataset.w!)).then(draw).catch(x => { S.msg = `<span class="err">${e(x?.message || x)}</span>`; draw(); }); return; }
    if (a === 'tab') { S.tab = b.dataset.t as any; S.msg = ''; draw(); return; }
    if (a === 'mint') run(async () => { let proof: string[] = [];
      if (ph?.kind === 'allowlist') {
        const sw = solWallet.pubkey?.toBase58(); if (!sw) throw new Error('Connect Phantom or Solflare first.');
        const r0 = await api(`/launchpad/proof/${d.slug}/${ai}/${encodeURIComponent(sw)}`);
        if (!r0.eligible) throw new Error('This Solana wallet is not on the ' + ph.name + ' allowlist.');
        proof = r0.proof || [];
      }
      const r = await mintOnSolana(cid, ai, S.qty, proof, sig => { S.msg = `Sent: ${solTxLink(sig)} · waiting for Base to confirm…`; draw(); });
      if (r.status === 'confirmed') S.msg = `✓ Minted ${S.qty} on Solana.`; else if (r.status === 'refunded') { S.refund = { cid, rid: r.rid }; S.msg = 'The hub rejected this mint (sold out or over the limit). Claim your SOL back below.'; } else S.msg = 'Still confirming. Check your wallet in a few minutes.'; });
    if (a === 'refund' && S.refund) run(async () => { const sig = await claimSolRefund(S.refund!.cid, S.refund!.rid); S.refund = undefined; S.msg = `✓ Refunded: ${solTxLink(sig)}`; });
    if (a === 'to') run(async () => { const id = BigInt(S.id || '0'); const q = await quoteToSolana(S.evm, cid, id, solWallet.pubkey!.toBase58());
      const kit = await import('./bridgekit'); const w = await kit.walletFor({ ...(CFG.chains as any)[S.evm], eid: lzEid(S.evm) });
      const h = await w.writeContract({ address: d.addresses[S.evm], abi: DROP_V2, functionName: 'moveTo', args: toSolanaArgs(id, solWallet.pubkey!.toBase58()), value: q.value } as any);
      S.msg = `Sent ${h.slice(0, 10)}… · LayerZero delivers to Solana in a few minutes.`; });
    if (a === 'from') run(async () => { const { wallet } = await import('./wallet'); if (!wallet.address) throw new Error('Connect your EVM wallet (top right) to receive it.');
      await fromSolana(cid, Number(S.id || '0'), S.evm, wallet.address, sig => { S.msg = `Sent: ${solTxLink(sig)} · LayerZero delivers in a few minutes.`; draw(); }); });
  };
  el.oninput = ev => { const t = ev.target as HTMLInputElement; const f = t.dataset.scf; if (!f) return; ev.stopPropagation();
    if (f === 'qty') S.qty = Math.max(1, Math.min(O.SOL_MAX_QTY, parseInt(t.value) || 1)); else if (f === 'id') S.id = t.value.replace(/\D/g, ''); else if (f === 'evm') S.evm = t.value; };
  el.onchange = ev => { const t = ev.target as HTMLInputElement; if (t.dataset.scf) { ev.stopPropagation(); if (t.dataset.scf === 'evm') S.evm = t.value; draw(); } };
  draw();
}
