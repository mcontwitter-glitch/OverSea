// Submit step 2 (testnet preview): pick chains, see the live tier price, prove ownership with SIWE (wallet must be the
// contract's owner()/deployer), then pay the listing fee to the MultiSea factory on the native chain.
import { formatEther, recoverMessageAddress, type Address } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';
import { wallet, openConnect, onWallet } from './wallet';
import { esc } from './shell';
import { bridgeCfg, pubFor, walletFor, NFT, FACTORY, type BCfg } from './bridgekit';

let S: any = null;
export async function mountListPay(el: HTMLElement) {
  const cfg0 = await bridgeCfg();
  if (!cfg0) { el.innerHTML = ''; return; }
  const cfg: BCfg = cfg0;
  const keys = Object.keys(cfg.chains);
  const s = (S ??= { native: keys[0], nft: '', sel: new Set<string>(keys), verified: '' as string, owner: '' as string, msg: '', cls: 'mut', busy: false, paid: '' });
  const tier = (n: number) => cfg.tiers.find(t => n >= t.min && n <= t.max);
  const MAIN = ['Abstract', 'Ethereum', 'Base', 'BNB Chain', 'ApeChain', 'Robinhood'];
  function draw() {
    const n = s.sel.size; const t = tier(n);
    const okAddr = /^0x[0-9a-fA-F]{40}$/.test(s.nft);
    const me = wallet.address?.toLowerCase();
    const verified = !!me && s.verified === me && s.owner === me;
    el.innerHTML = `<div class="lp">
     <div class="gh">On-chain listing &amp; bridge <span class="tnet">${esc(cfg.network)}${cfg.mode === 'fork' ? ' · preview' : ''}</span></div>
     <p class="mut small">MultiSea deploys an escrow on your collection's native chain and a mirror collection (full supply held by its escrow) on each other chain you pick, then wires them over LayerZero so holders can bridge.</p>
     <div class="two"><label>Native chain<select data-k="native">${keys.map(k => `<option value="${k}" ${k === s.native ? 'selected' : ''}>${esc(cfg.chains[k].name)}</option>`).join('')}</select></label>
      <label>Collection contract on ${esc(cfg.chains[s.native].name)}<input data-k="nft" placeholder="0x…" value="${esc(s.nft)}"></label></div>
     <div class="gh">Chains <span class="mut small">(native chain always included)</span></div>
     <div class="lpchips">${keys.map(k => `<button type="button" class="lpchip ${s.sel.has(k) ? 'on' : ''}" data-chain="${k}" ${k === s.native ? 'disabled' : ''}><img class="cl" src="/logos/${cfg.chains[k].logo}.svg" alt="">${esc(cfg.chains[k].name)}${s.sel.has(k) ? ' ✓' : ''}</button>`).join('')}</div>
     <p class="mut small">Mainnet (after launch): ${MAIN.join(', ')}.</p>
     <div class="lptiers">${cfg.tiers.map(x => `<div class="lpt ${t === x ? 'on' : ''}"><b>${x.eth} ETH</b><span>${x.label || (x.min === x.max ? x.min + ' chains' : x.min + '-' + x.max + ' chains')}</span></div>`).join('')}</div>
     <div class="lpprice"><span>Listing fee for ${n} chain${n > 1 ? 's' : ''}</span><b>${n < 2 ? 'Pick at least 2 chains' : t ? t.eth + ' ETH' : '-'}</b></div>
     <ol class="lpsteps">
      <li class="${wallet.address ? 'done' : ''}">Connect the wallet that deployed / owns the contract ${wallet.address ? '✓' : ''}</li>
      <li class="${verified ? 'done' : ''}">Verify ownership with Sign-In With Ethereum (must match the contract's <code>owner()</code>) ${verified ? '✓' : ''}</li>
      <li class="${s.paid ? 'done' : ''}">Pay the listing fee on ${esc(cfg.chains[s.native].name)} ${s.paid ? '✓' : ''}</li></ol>
     <p class="msg ${s.cls}">${s.msg}</p>
     <div class="lpbtns">${!wallet.address ? '<button type="button" class="bbtn" data-act="lp-connect">Connect wallet</button>'
       : !verified ? `<button type="button" class="bbtn" data-act="lp-verify" ${okAddr && !s.busy ? '' : 'disabled'}>Verify ownership (SIWE)</button>`
       : s.paid ? '' : `<button type="button" class="bbtn" data-act="lp-pay" ${n >= 2 && !s.busy ? '' : 'disabled'}>Pay ${t ? t.eth : ''} ETH &amp; list</button>`}</div>
    </div>`;
  }
  async function verify() {
    s.busy = true; s.msg = 'Reading owner() on-chain…'; s.cls = 'mut'; draw();
    try {
      const pub = pubFor(cfg.chains[s.native]);
      const owner = ((await pub.readContract({ address: s.nft as Address, abi: NFT, functionName: 'owner' })) as string).toLowerCase();
      const message = createSiweMessage({ domain: location.host, address: wallet.address as Address, statement: `Verify I own ${s.nft} on ${cfg.chains[s.native].name} to list it on MultiSea.`, uri: location.origin, version: '1', chainId: cfg.chains[s.native].chainId, nonce: generateSiweNonce(), issuedAt: new Date(), expirationTime: new Date(Date.now() + 600e3) });
      s.msg = 'Sign the message in your wallet…'; draw();
      const hex = '0x' + [...new TextEncoder().encode(message)].map(b => b.toString(16).padStart(2, '0')).join('');
      const sig = await wallet.provider.request({ method: 'personal_sign', params: [hex, wallet.address] });
      const signer = (await recoverMessageAddress({ message, signature: sig })).toLowerCase();
      s.verified = signer; s.owner = owner;
      if (signer !== owner) { s.msg = `This wallet isn't the contract owner. owner() is ${owner.slice(0, 6)}…${owner.slice(-4)}.`; s.cls = 'err'; }
      else { s.msg = '✓ Ownership verified: the signer is the contract owner.'; s.cls = 'ok'; }
    } catch (e: any) { s.msg = e?.code === 4001 ? 'Rejected in wallet.' : 'Could not verify: ' + (e.shortMessage || e.message); s.cls = 'err'; }
    s.busy = false; draw();
  }
  async function pay() {
    s.busy = true; s.msg = 'Switching network…'; s.cls = 'mut'; draw();
    try {
      const c = cfg.chains[s.native]; const pub = pubFor(c); const w = await walletFor(c);
      const eids = [s.native, ...[...s.sel].filter(k => k !== s.native)].map(k => cfg.chains[k].eid);
      const ex = await pub.readContract({ address: c.factory as Address, abi: FACTORY, functionName: 'escrowOf', args: [s.nft as Address] });
      if (!/^0x0{40}$/i.test(ex)) throw new Error('This collection is already listed on MultiSea (escrow ' + ex + ').');
      const fee = await pub.readContract({ address: c.factory as Address, abi: FACTORY, functionName: 'listingFee', args: [BigInt(eids.length)] });
      s.msg = `Confirm ${formatEther(fee)} ETH in your wallet…`; draw();
      const h = await w.writeContract({ address: c.factory as Address, abi: FACTORY, functionName: 'list', args: [s.nft as Address, eids], value: fee });
      const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error('Transaction reverted');
      s.paid = h; s.msg = `✓ Paid ${formatEther(fee)} ETH. The MultiSea deployer is now deploying mirrors and wiring LayerZero peers…`; s.cls = 'ok'; draw();
      for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 3000));
        const j = await fetch('/bridge.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => null);
        const col = j?.collections?.find((x: any) => x.contracts[s.native]?.toLowerCase() === s.nft.toLowerCase());
        if (col && Object.keys(col.escrows).length >= eids.length) { s.msg = `✓ Live on ${Object.keys(col.contracts).map(k => cfg.chains[k].name).join(' + ')}. Holders can bridge from the Bridge page.`; break; } }
    } catch (e: any) { s.msg = e?.code === 4001 ? 'Rejected in wallet.' : (e.shortMessage || e.message); s.cls = 'err'; }
    s.busy = false; draw();
  }
  el.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.dataset.k === 'nft') { s.nft = t.value.trim(); s.verified = ''; } });
  el.addEventListener('change', e => { const t = e.target as HTMLInputElement; if (t.dataset.k === 'native') { s.native = t.value; s.sel.add(t.value); s.verified = ''; draw(); } if (t.dataset.k === 'nft') setTimeout(draw); });
  el.addEventListener('click', e => { const t = e.target as HTMLElement; const ch = t.closest('[data-chain]') as HTMLElement | null; const a = t.closest('[data-act]') as HTMLElement | null;
    if (ch) { e.stopPropagation(); const k = ch.dataset.chain!; if (k !== s.native) { s.sel.has(k) ? s.sel.delete(k) : s.sel.add(k); draw(); } return; }
    if (!a) return; e.stopPropagation();
    if (a.dataset.act === 'lp-connect') openConnect(); if (a.dataset.act === 'lp-verify') verify(); if (a.dataset.act === 'lp-pay') pay(); });
  onWallet(() => el.isConnected && draw());
  draw();
}
