// Founder tools on the collection page: withdraw mint proceeds, on-chain royalty (single-chain drops only),
// and a native-token airdrop to each NFT's ERC-6551 Tokenbound wallet. Only the connected contract owner()
// or the stored launchpad creator sees the button. The connected wallet signs; this module never sends a tx itself.
import { concat, createWalletClient, custom, encodeAbiParameters, formatEther, getContractAddress, parseAbi, parseEther, type Hex } from 'viem';
import CFG from '../config/collections.json';
import { wallet, readClient, ensureChain, vchain, friendly } from './wallet';
import { logo, esc, short } from './gx';

export type Dep = { chain: string; address: string };
export type FounderCol = { name: string; deployments: Dep[]; creator?: string | null };
const chains = CFG.chains as Record<string, { name: string; chainId: number; native: string; explorer: string }>;
const DROP = parseAbi([
  'function owner() view returns (address)',
  'function payout() view returns (address)',
  'function platformFeeBps() view returns (uint16)',
  'function held() view returns (uint256)',
  'function withdraw()',
  'function setRoyalty(address,uint96)',
  'function royaltyInfo(uint256,uint256) view returns (address,uint256)',
  'function isHub() view returns (bool)',
  'function isActiveHere(uint256) view returns (bool)',
  'function totalAssigned() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
const MC3 = parseAbi(['function aggregate3Value((address,bool,uint256,bytes)[]) payable returns ((bool,bytes)[])']);
const MC3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex;
const TB = { registry: '0x000000006551c19487814612e58FE06813775758' as Hex, proxy: '0x55266d75D1a14E4572138116aF39863Ed6596E7F' as Hex, salt: ('0x' + '0'.repeat(64)) as Hex };
const evm = (ds: Dep[]) => (ds || []).filter(d => d?.address && chains[d.chain]?.chainId);
const lc = (a?: string | null) => (a || '').toLowerCase();
const rejected = (e: any) => e?.code === 4001 || e?.cause?.code === 4001 || /user rejected|user denied|rejected in wallet|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));
const fe = (v: bigint, max = 6) => Number(formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: max });
const chunk = <T>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export function tokenTba(chainId: bigint, token: Hex, id: bigint): Hex {
  return getContractAddress({ opcode: 'CREATE2', from: TB.registry, salt: TB.salt, bytecode: concat(['0x3d60ad80600a3d3981f3363d3d373d3d3d363d73', TB.proxy, '0x5af43d82803e903d91602b57fd5bf3', encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [TB.salt, chainId, token, id])]) });
}
export const founderBtn = (show: boolean) => show ? '<button class="editbtn" data-act="founder">Founder</button>' : '';

export async function isFounder(col: FounderCol): Promise<boolean> {
  const me = lc(wallet.address); if (!me) return false;
  if (col.creator && lc(col.creator) === me) return true;
  const hits = await Promise.all(evm(col.deployments).map(d =>
    readClient(d.chain).readContract({ address: d.address as Hex, abi: DROP, functionName: 'owner' }).then((a: string) => lc(String(a)) === me).catch(() => false)
  ));
  return hits.some(Boolean);
}

type Row = { k: string; address: Hex; name: string; native: string; bal: bigint | null; feeBps: number; fee: bigint; net: bigint; omni: boolean; hub: boolean; err: string };
type Prev = { n: number; per: bigint; gasEth: bigint | null; err: string };
type S = {
  col: FounderCol; rows: Row[]; roy: { recv: string; bps: number } | null; canSet: boolean;
  royTo: string; royPct: string; picked: Set<string>; amounts: Record<string, string>; all: boolean;
  prev: Record<string, Prev>; msg: string; busy: boolean; withdrawn: Set<string>; sent: Set<string>; chunkAt: Record<string, number>;
};
let S: S | null = null; let box: HTMLElement | null = null;

function wc(k: string) { return createWalletClient({ chain: vchain(k), transport: custom(wallet.provider) }); }
// Wallet estimates can under-run (the Island's flush OOGed at the raw estimate). Buffer 1.5x with a floor.
async function bufferedGas(pc: ReturnType<typeof readClient>, req: Parameters<ReturnType<typeof readClient>['estimateContractGas']>[0], floor: bigint) {
  const est = await pc.estimateContractGas(req as any); const padded = est * 15n / 10n; return padded > floor ? padded : floor;
}

function account() { const a = wallet.address as Hex | undefined; if (!a || !wallet.provider) throw new Error('Connect your wallet first.'); return a; }

export function openFounder(col: FounderCol) {
  document.querySelector('.modal.fndov')?.remove();
  const m = document.createElement('div'); m.className = 'modal wov fndov';
  m.innerHTML = `<div class="wbox form fnd"><button class="x mx" type="button">✕</button><h3>Founder</h3><p class="mut small">Tools for ${esc(col.name)}. Each chain is a separate signature in your wallet.</p><div class="fndbody"><div class="spin"></div> Loading…</div></div>`;
  document.body.appendChild(m);
  box = m.querySelector('.fndbody');
  m.addEventListener('click', e => { if (e.target === m || (e.target as HTMLElement).classList.contains('mx')) { m.remove(); S = null; box = null; } });
  S = { col, rows: [], roy: null, canSet: false, royTo: '', royPct: '', picked: new Set(), amounts: {}, all: false, prev: {}, msg: '', busy: false, withdrawn: new Set(), sent: new Set(), chunkAt: {} };
  load().then(draw); bind(m);
}

async function load() {
  if (!S) return;
  const rows = await Promise.all(evm(S.col.deployments).map(async d => {
    const k = d.chain, address = d.address as Hex, c = chains[k], pc = readClient(k);
    const row: Row = { k, address, name: c?.name || k, native: c?.native || 'ETH', bal: null, feeBps: 50, fee: 0n, net: 0n, omni: false, hub: false, err: '' };
    try {
      const [bal, feeBps, held, hub] = await Promise.all([
        pc.getBalance({ address }),
        pc.readContract({ address, abi: DROP, functionName: 'platformFeeBps' }).catch(() => 50n),
        pc.readContract({ address, abi: DROP, functionName: 'held' }).then((v: bigint) => { row.omni = true; return v; }).catch(() => 0n),
        pc.readContract({ address, abi: DROP, functionName: 'isHub' }).then((v: boolean) => { row.omni = true; return !!v; }).catch(() => false),
      ]);
      const withdrawable = bal - (held as bigint);
      row.bal = withdrawable < 0n ? 0n : withdrawable;
      row.feeBps = Number(feeBps);
      row.fee = (row.bal * BigInt(row.feeBps)) / 10_000n;
      row.net = row.bal - row.fee;
      row.hub = !!hub;
    } catch (e) { row.err = friendly(e, k); }
    return row;
  }));
  S.rows = rows;
  S.canSet = rows.some(r => !r.err) && rows.every(r => !r.omni);
  for (const r of rows) {
    if (S.roy) break;
    try {
      const [recv, amt] = await readClient(r.k).readContract({ address: r.address, abi: DROP, functionName: 'royaltyInfo', args: [1n, 10_000n] }) as [string, bigint];
      S.roy = { recv, bps: Number(amt) };
      S.royTo = recv; S.royPct = (Number(amt) / 100).toString();
    } catch {}
  }
}

function draw() {
  if (!S || !box) return;
  const feeb = S.rows.find(r => r.bal != null)?.feeBps ?? 50;
  const claimRows = S.rows.map(r => {
    if (r.err) return `<div class="fndr">${logo(r.k)} <span>${esc(r.name)}</span><span class="err small">${esc(r.err)}</span></div>`;
    if (r.bal == null) return `<div class="fndr">${logo(r.k)} <span>${esc(r.name)}</span><span class="mut">…</span></div>`;
    const done = r.bal === 0n || S!.withdrawn.has(r.k);
    return `<div class="fndr">${logo(r.k)} <div class="fndm"><b>${esc(r.name)}</b><div class="mut small">${done && r.bal === 0n ? 'Nothing to withdraw' : `${fe(r.bal)} ${r.native} · ${feeb / 100}% fee ${fe(r.fee)} · you get ${fe(r.net)} ${r.native}`}</div></div></div>`;
  }).join('');
  const todo = S.rows.filter(r => r.bal != null && r.bal > 0n && !S!.withdrawn.has(r.k));
  const leftover = todo.length && S.withdrawn.size ? 'Resume withdraw' : 'Withdraw mint funds';

  let roy = '';
  if (S.canSet) {
    roy = `<label>Recipient<input data-fnd="royto" placeholder="0x…" value="${esc(S.royTo)}"></label>
      <label>Royalty % <span class="mut small">(0–10)</span><input data-fnd="roypct" inputmode="decimal" value="${esc(S.royPct)}"></label>
      <button class="bbtn sm" data-fnd="roy" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Working…' : 'Save royalty'}</button>`;
  } else {
    const cur = S.roy ? `${S.roy.bps / 100}% to <span class="mono">${esc(short(S.roy.recv))}</span>` : 'None set (or could not be read).';
    roy = `<p class="small">${cur}</p><p class="mut small">This drop's royalty was set at deploy and can't be changed on-chain. Marketplaces read this ERC-2981 value. MultiSea listing royalty can still be changed in Edit.</p>`;
  }

  const pick = S.rows.map(r => `<label class="chk"><input type="checkbox" data-fnd-chain="${r.k}" ${S!.picked.has(r.k) ? 'checked' : ''}>${logo(r.k)} ${esc(r.name)}</label>`).join('');
  const amts = [...S.picked].map(k => {
    const r = S!.rows.find(x => x.k === k)!; const p = S!.prev[k];
    const note = !p ? '' : p.err ? `<div class="err small">${esc(p.err)}</div>` : `<div class="mut small">${p.n} wallet${p.n === 1 ? '' : 's'} · ${fe(p.per, 8)} ${r.native} each${p.gasEth != null ? ` · gas ≈ ${fe(p.gasEth, 8)} ${r.native}` : ''}</div>`;
    return `<label>${logo(k)} Amount on ${esc(r.name)} (${r.native})<input data-fnd-amt="${k}" inputmode="decimal" placeholder="0.0" value="${esc(S!.amounts[k] || '')}"></label>${note}`;
  }).join('');
  const airTodo = [...S.picked].filter(k => !S!.sent.has(k) && S!.amounts[k]);
  const airLabel = airTodo.length && S.sent.size ? 'Resume airdrop' : 'Send';

  box.innerHTML = `
    <div class="fndsec"><h4>Claim</h4><p class="mut small">Mint funds sit in the drop until you withdraw. Anyone may call it; the payout always goes to the collection payout address, minus the platform fee.</p>
      ${claimRows || '<p class="mut">No drop contracts.</p>'}
      <button class="bbtn" data-fnd="withdraw" ${S.busy || !todo.length ? 'disabled' : ''}>${S.busy ? 'Working…' : leftover}</button></div>
    <div class="fndsec"><h4>Change royalty</h4>${roy}</div>
    <div class="fndsec"><h4>Fee sharing</h4><p class="mut small">Sends native tokens from your wallet, split evenly across this drop's tokenbound wallets on the chains you pick. Undeployed wallets can already receive funds. Default: only tokens currently Active on that chain (not in escrow).</p>
      <div class="fndpick">${pick}</div>
      <label class="chk"><input type="checkbox" data-fnd="all" ${S.all ? 'checked' : ''}> Include every token's wallet (including ones in escrow)</label>
      ${amts}
      <button class="bbtn" data-fnd="air" ${S.busy || !airTodo.length ? 'disabled' : ''}>${S.busy ? 'Working…' : airLabel}</button></div>
    ${S.msg ? `<p class="small fndmsg">${S.msg}</p>` : ''}`;
}

function bind(m: HTMLElement) {
  m.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-fnd]');
    if (b?.dataset.fnd === 'withdraw') { e.preventDefault(); doWithdraw(); }
    if (b?.dataset.fnd === 'roy') { e.preventDefault(); doRoyalty(); }
    if (b?.dataset.fnd === 'air') { e.preventDefault(); doAirdrop(); }
  });
  m.addEventListener('change', e => {
    if (!S) return; const t = e.target as HTMLInputElement;
    if (t.dataset.fndChain) { t.checked ? S.picked.add(t.dataset.fndChain) : S.picked.delete(t.dataset.fndChain); draw(); preview().then(draw); return; }
    if (t.dataset.fnd === 'all') { S.all = t.checked; draw(); preview().then(draw); }
  });
  m.addEventListener('input', e => {
    if (!S) return; const t = e.target as HTMLInputElement;
    if (t.dataset.fnd === 'royto') S.royTo = t.value.trim();
    if (t.dataset.fnd === 'roypct') S.royPct = t.value.trim();
    if (t.dataset.fndAmt) { S.amounts[t.dataset.fndAmt] = t.value.trim(); schedulePreview(); }
  });
}

let pt: ReturnType<typeof setTimeout> | undefined;
function schedulePreview() { clearTimeout(pt); pt = setTimeout(() => { preview().then(draw); }, 350); }

async function minted(rows: Row[]): Promise<number> {
  const hub = rows.find(r => r.hub);
  if (hub) return Number(await readClient(hub.k).readContract({ address: hub.address, abi: DROP, functionName: 'totalAssigned' }));
  const r = rows[0]; if (!r) return 0;
  return Number(await readClient(r.k).readContract({ address: r.address, abi: DROP, functionName: 'totalSupply' }));
}

async function recipients(r: Row, includeAll: boolean, n: number): Promise<Hex[]> {
  const ids = Array.from({ length: n }, (_, i) => BigInt(i + 1));
  const tba = (id: bigint) => tokenTba(BigInt(chains[r.k].chainId), r.address, id);
  if (includeAll || !r.omni) return ids.map(tba);
  const pc = readClient(r.k);
  const res = await pc.multicall({
    contracts: ids.map(id => ({ address: r.address, abi: DROP, functionName: 'isActiveHere' as const, args: [id] })),
    allowFailure: true, multicallAddress: MC3_ADDR, batchSize: 0,
  });
  return ids.filter((_, i) => res[i].status === 'success' && res[i].result === true).map(tba);
}

async function preview() {
  if (!S) return;
  const n = await minted(S.rows).catch(() => 0);
  for (const k of S.picked) {
    const r = S.rows.find(x => x.k === k); if (!r) continue;
    try {
      const raw = S.amounts[k] || '';
      if (!raw || Number(raw) <= 0) { S.prev[k] = { n: 0, per: 0n, gasEth: null, err: '' }; continue; }
      const value = parseEther(raw);
      const rec = await recipients(r, S.all, n);
      if (!rec.length) { S.prev[k] = { n: 0, per: 0n, gasEth: null, err: S.all ? 'No tokens to send to on this chain.' : 'No active tokens on this chain.' }; continue; }
      const per = value / BigInt(rec.length);
      if (per === 0n) { S.prev[k] = { n: rec.length, per: 0n, gasEth: null, err: 'Amount is too small to split evenly.' }; continue; }
      let gasEth: bigint | null = null;
      try {
        const first = rec.slice(0, 100);
        const calls = first.map(to => [to, false, per, '0x'] as const);
        const sent = per * BigInt(calls.length);
        const pc = readClient(k);
        const gas = await pc.estimateContractGas({ address: MC3_ADDR, abi: MC3, functionName: 'aggregate3Value', args: [calls], account: account(), value: sent });
        const price = await pc.getGasPrice();
        const chunks = BigInt(Math.ceil(rec.length / 100));
        gasEth = BigInt(gas) * BigInt(price) * chunks;
      } catch { gasEth = null; }
      S.prev[k] = { n: rec.length, per, gasEth, err: '' };
    } catch (e) { S.prev[k] = { n: 0, per: 0n, gasEth: null, err: friendly(e, k) }; }
  }
  for (const k of Object.keys(S.prev)) if (!S.picked.has(k)) delete S.prev[k];
}

async function doWithdraw() {
  if (!S || S.busy) return; S.busy = true; S.msg = ''; draw();
  try {
    const me = account();
    const todo = S.rows.filter(r => r.bal != null && r.bal > 0n && !S!.withdrawn.has(r.k));
    for (const r of todo) {
      S.msg = `Switch to ${esc(r.name)} and sign withdraw…`; draw();
      await ensureChain(r.k);
      const pc = readClient(r.k);
      const wd = { address: r.address, abi: DROP, functionName: 'withdraw' as const, account: me };
      await pc.simulateContract(wd);
      const hash = await wc(r.k).writeContract({ ...wd, chain: vchain(r.k), gas: await bufferedGas(pc, wd, 300_000n) });
      S.withdrawn.add(r.k);
      S.msg = `Withdrawn on ${esc(r.name)}. <a href="${esc(chains[r.k].explorer)}/tx/${hash}" target="_blank" rel="noopener">Tx ↗</a>`;
      draw();
    }
    await load();
    S.msg = S.rows.every(r => !r.bal) ? 'All mint funds withdrawn.' : S.msg;
  } catch (e: any) {
    S.msg = rejected(e) ? 'Rejected in wallet. Tap Withdraw to resume the rest.' : `<span class="err">${esc(friendly(e))}</span>`;
  }
  S.busy = false; draw();
}

async function doRoyalty() {
  if (!S || S.busy || !S.canSet) return;
  try {
    const pct = parseFloat(S.royPct || '0'); if (!(pct >= 0 && pct <= 10)) throw new Error('Royalty must be between 0 and 10%.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(S.royTo)) throw new Error('Enter a valid royalty recipient address.');
    const bps = BigInt(Math.round(pct * 100));
    S.busy = true; S.msg = ''; draw();
    const me = account();
    for (const r of S.rows) {
      if (S.sent.has('roy:' + r.k)) continue;
      S.msg = `Switch to ${esc(r.name)} and sign the royalty change…`; draw();
      await ensureChain(r.k);
      const pc = readClient(r.k);
      const sr = { address: r.address, abi: DROP, functionName: 'setRoyalty' as const, args: [S.royTo as Hex, bps] as const, account: me };
      await pc.simulateContract(sr);
      const hash = await wc(r.k).writeContract({ ...sr, chain: vchain(r.k), gas: await bufferedGas(pc, sr, 200_000n) });
      S.sent.add('roy:' + r.k);
      S.msg = `Royalty updated on ${esc(r.name)}. <a href="${esc(chains[r.k].explorer)}/tx/${hash}" target="_blank" rel="noopener">Tx ↗</a>`;
      draw();
    }
    S.roy = { recv: S.royTo, bps: Number(bps) };
    S.msg = 'Royalty saved.';
  } catch (e: any) {
    S!.msg = rejected(e) ? 'Rejected in wallet. Tap Save royalty to resume the rest.' : `<span class="err">${esc(e?.message && !e?.shortMessage ? e.message : friendly(e))}</span>`;
  }
  if (S) { S.busy = false; draw(); }
}

async function doAirdrop() {
  if (!S || S.busy) return; S.busy = true; S.msg = ''; draw();
  try {
    const me = account();
    const n = await minted(S.rows);
    for (const k of [...S.picked]) {
      if (S.sent.has(k)) continue;
      const r = S.rows.find(x => x.k === k)!;
      const raw = S.amounts[k]; if (!raw || Number(raw) <= 0) continue;
      const value = parseEther(raw);
      const rec = await recipients(r, S.all, n);
      if (!rec.length) { S.msg = `<span class="err">${esc(r.name)}: no wallets to send to.</span>`; draw(); continue; }
      const per = value / BigInt(rec.length); if (per === 0n) throw new Error(`Amount on ${r.name} is too small to split evenly.`);
      const parts = chunk(rec, 100);
      for (let i = S.chunkAt[k] || 0; i < parts.length; i++) {
        const calls = parts[i].map(to => [to, false, per, '0x'] as const);
        const sent = per * BigInt(calls.length);
        S.msg = `Switch to ${esc(r.name)} and sign the airdrop${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}…`; draw();
        await ensureChain(k);
        const pc = readClient(k);
        const air = { address: MC3_ADDR, abi: MC3, functionName: 'aggregate3Value' as const, args: [calls] as const, account: me, value: sent };
        await pc.simulateContract(air);
        const hash = await wc(k).writeContract({ ...air, chain: vchain(k), gas: await bufferedGas(pc, air, 500_000n) });
        S.chunkAt[k] = i + 1;
        S.msg = `Sent on ${esc(r.name)}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''}. <a href="${esc(chains[k].explorer)}/tx/${hash}" target="_blank" rel="noopener">Tx ↗</a>`;
        draw();
      }
      S.sent.add(k);
    }
    if (S) { const st = S; if ([...st.picked].every(k => st.sent.has(k) || !st.amounts[k])) st.msg = 'Airdrop sent on every selected chain.'; }
  } catch (e: any) {
    if (S) S.msg = rejected(e) ? 'Rejected in wallet. Tap Send to resume the rest.' : `<span class="err">${esc(friendly(e))}</span>`;
  }
  if (S) { S.busy = false; draw(); }
}
