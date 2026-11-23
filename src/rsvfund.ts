// Admin "Fund vault": MC (fee wallet) sends the revenue-share FEE amount accrued in the Worker ledger into each collection's on-chain
// RevShareVault, signed in his own wallet (simulated first). The Worker then verifies the tx on-chain and records it so the owed amount drops.
import { createWalletClient, custom, encodeFunctionData, formatEther, parseEther, type Address } from 'viem';
import CFG from '../config/collections.json';
import { wallet, readClient, ensureChain, vchain, friendly, API } from './wallet';
import { api, getSession } from './auth';
import { VAULT_ABI, errText, fe } from './rsvault';

const chains = CFG.chains as Record<string, { name: string; native: string; explorer: string }>;
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Item = { slug: string; name: string; chain: string; vault: string; owed: bigint; funded: bigint; amount: string; busy: boolean; msg: string };
let items: Item[] | null = null; let err = '';

export async function loadVaultFund(rerender: () => void) {
  err = '';
  try {
    const list = await fetch(`${API}/revshare`).then(r => r.json());
    const out: Item[] = [];
    for (const c of (list.collections || []).filter((x: any) => x.vaults && Object.keys(x.vaults).length)) {
      const info = await fetch(`${API}/revshare/${c.slug}`).then(r => r.json());
      for (const [k, vault] of Object.entries(c.vaults as Record<string, string>)) {
        const owed = BigInt(info.fund?.owedFee?.[k] || '0'); const funded = BigInt(info.fund?.funded?.[k] || '0');
        const prev = items?.find(x => x.slug === c.slug && x.chain === k);
        out.push({ slug: c.slug, name: c.name, chain: k, vault, owed, funded, amount: prev?.amount ?? (owed > 0n ? formatEther(owed) : ''), busy: false, msg: prev?.msg || '' });
      }
    }
    items = out;
  } catch (e: any) { err = e.message || String(e); items = items || []; }
  rerender();
}
export function vaultFundHtml(): string {
  const s = getSession();
  if (!items && !err) return '';
  if (!items?.length && !err) return '';
  const isFee = !!s?.isFee && !!wallet.address;
  return `<div class="fees"><div class="fh"><h2>Fund revenue-share vaults</h2></div>
    <p class="mut small">Collections with an on-chain vault get their <b>creator royalty</b> paid straight into the vault by each sale. Only MultiSea's <b>fee share</b> has to be added by hand: the amount below is the fee share accrued in the ledger minus what you already funded. It is sent from your connected fee wallet to the vault (your signature, you pay gas); nothing is sent until you confirm in your wallet.</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    ${(items || []).map(i => { const c = chains[i.chain]; return `<div class="fcard"><div class="fndr"><img class="cl" src="/logos/${esc(i.chain)}.svg" alt=""><div class="fndm"><b>${esc(i.name)}</b> · ${esc(c?.name || i.chain)}
      <div class="mut small">Vault <a class="mono" href="${esc(c?.explorer)}/address/${esc(i.vault)}" target="_blank" rel="noopener">${esc(i.vault.slice(0, 8))}…${esc(i.vault.slice(-6))}</a> · owed ${fe(i.owed, 8)} ${esc(c?.native)} · already funded ${fe(i.funded, 8)}</div>
      <div class="crow"><input data-vf-amt="${esc(i.slug)}:${esc(i.chain)}" inputmode="decimal" placeholder="0.0" value="${esc(i.amount)}" style="width:160px;flex:none"><span class="mut">${esc(c?.native)}</span>
      <button class="bbtn sm" data-vfund="${esc(i.slug)}:${esc(i.chain)}" ${isFee && !i.busy ? '' : 'disabled'}>${i.busy ? 'Working…' : 'Fund vault'}</button></div>
      ${!isFee ? '<div class="small warn">Connect and sign in with the MultiSea fee wallet to fund.</div>' : ''}${i.msg ? `<div class="small">${i.msg}</div>` : ''}</div></div></div>`; }).join('')}</div>`;
}
export function bindVaultFundInputs(root: HTMLElement) {
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; const k = t.dataset.vfAmt; if (!k || !items) return; const [slug, chain] = k.split(':'); const it = items.find(x => x.slug === slug && x.chain === chain); if (it) it.amount = t.value.trim(); });
}
export async function doVaultFund(key: string, rerender: () => void) {
  const [slug, chain] = key.split(':'); const it = items?.find(x => x.slug === slug && x.chain === chain); if (!it || it.busy) return;
  it.busy = true; it.msg = ''; rerender();
  try {
    if (!wallet.address || !wallet.provider) throw new Error('Connect the fee wallet first.');
    let value: bigint; try { value = parseEther(it.amount || '0'); } catch { throw new Error('Enter a valid amount.'); }
    if (value <= 0n) throw new Error('Enter an amount greater than 0.');
    await ensureChain(chain);
    const me = wallet.address as Address; const pc = readClient(chain);
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit' });
    try { await pc.estimateGas({ account: me, to: it.vault as Address, data, value }); }
    catch (e: any) { throw new Error(`The transfer would fail (${String(friendly(e, chain) || e?.shortMessage || e?.message).split('\n')[0].slice(0, 160)}). Nothing was sent.`); }
    const wc = createWalletClient({ chain: vchain(chain), transport: custom(wallet.provider) });
    const hash = await wc.sendTransaction({ account: me, chain: vchain(chain), to: it.vault as Address, data, value });
    it.msg = 'Waiting for confirmation…'; rerender();
    const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('The transfer reverted.');
    await api('/admin/growth/vault-funded', { auth: true, body: { slug, chain, txHash: hash } });
    it.msg = `<span class="ok">✓ Funded ${esc(it.amount)} ${esc(chains[chain]?.native)}. <a href="${esc(chains[chain]?.explorer)}/tx/${hash}" target="_blank" rel="noopener">Tx ↗</a></span>`;
    it.amount = '';
  } catch (e: any) { it.msg = `<span class="err">${esc(errText(e, chain))}</span>`; }
  it.busy = false; await loadVaultFund(rerender);
}
