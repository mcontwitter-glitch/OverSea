// Holder areas: /holders (list) and /holders/<slug>. Gates on the connected wallet holding >= minBalance of the
// collection on ANY of its chains (ERC-721 balanceOf per deployment). Generic: add a collection to config/gates.json.
// NOTE: cosmetic gating only. Everything here ships in the public bundle; real perks must be checked server-side.
import CFG from '../config/collections.json';
import GATES from '../config/gates.json';
import { parseAbi } from 'viem';
import { wallet, onWallet, openConnect, readClient } from './wallet';
import { frame, esc, logo, chains } from './gx';
import { addrHtml } from './names';
import { mountHolderChat } from './holderchat';
type Gate = { title: string; minBalance: number; lockedText: string; perks: { title: string; body: string }[] };
const gates = (GATES as any).gates as Record<string, Gate>;
const slug = location.pathname.replace(/\/+$/, '').split('/')[2] || '';
const el = frame('holders', slug && gates[slug] ? gates[slug].title : 'Holder areas');
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
const q = new URLSearchParams(location.search); const previewAs = /^0x[0-9a-fA-F]{40}$/.test(q.get('as') || '') ? q.get('as')! : '';
let res: Record<string, number | null> = {}; let checking = false; let checkedFor = '';
const who = () => previewAs || wallet.address || '';
async function check() {
  const col = CFG.collections.find(c => c.slug === slug); const a = who(); if (!col || !a) { draw(); return; }
  if (checkedFor === a) return; checkedFor = a; checking = true; res = {}; draw();
  await Promise.all(col.deployments.map(async d => {
    try { res[d.chain] = Number(await Promise.race([readClient(d.chain).readContract({ address: d.address as any, abi: ABI, functionName: 'balanceOf', args: [a as any] }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 12_000))])); }
    catch { res[d.chain] = null; } draw();
  }));
  checking = false; draw();
}
function draw() {
  if (!slug || !gates[slug]) {
    el.innerHTML = `<div class="gate"><h1>Holder areas</h1><p class="mut">Holder-only pages for collections on MultiSea.</p>${Object.entries(gates).map(([s, g]) => `<a class="fcard" style="display:block" href="/holders/${s}"><b>${esc(g.title)}</b><div class="mut small">${esc(CFG.collections.find(c => c.slug === s)?.name || s)} · hold ${g.minBalance}+ on any chain</div></a>`).join('')}</div>`; return;
  }
  const g = gates[slug]; const col = CFG.collections.find(c => c.slug === slug)!; const a = who();
  const total = Object.values(res).reduce<number>((s, v) => s + (v || 0), 0); const ok = total >= g.minBalance;
  const chips = col.deployments.map(d => `<span>${logo(d.chain)} ${esc(chains[d.chain].name)}: ${res[d.chain] === undefined ? (a ? '…' : '-') : res[d.chain] === null ? '<i class="mut">unavailable</i>' : `<b>${res[d.chain]}</b>`}</span>`).join('');
  el.innerHTML = `<div class="gate" data-gate="${ok ? 'open' : a ? (checking ? 'checking' : 'locked') : 'noconnect'}"><h1>${esc(g.title)}</h1>
    ${previewAs ? `<p class="mut small">Previewing as ${addrHtml(previewAs)} (read-only check).</p>` : ''}
    ${!a ? `<div class="lock"><h3>${esc(g.lockedText)}</h3><p class="mut">Connect the wallet that holds your ${esc(col.name)}. We check every chain it lives on.</p><button class="bbtn" data-act="connect">Connect wallet</button> <a class="obtn" href="/c/${slug}">Buy a ${esc(col.name)}</a></div>`
      : `<div class="chk">${chips}</div>
    ${ok ? `<div id="holder-chat"></div>${previewAs ? '<p class="mut small">Chat is disabled in read-only address previews.</p>' : ''}<p class="ok">Welcome, ${addrHtml(a)}: you hold <b>${total}</b> ${esc(col.name)}.</p><div class="perks">${g.perks.map(p => `<div class="perk"><b>${esc(p.title)}</b><p class="mut small">${esc(p.body)}</p></div>`).join('')}</div>`
      : checking ? '<p><span class="spin"></span> Checking your wallet on every chain…</p>'
      : `<div class="lock"><h3>${esc(g.lockedText)}</h3><p class="mut">${addrHtml(a)} holds ${total} on the chains we could read${Object.values(res).includes(null) ? ' (some chains could not be read; try again)' : ''}.</p><a class="bbtn" href="/c/${slug}">Buy a ${esc(col.name)}</a></div>`}`}
    <p class="mut small" style="margin-top:22px">Holder status is checked on every chain. Chat access and posting are verified again by the MultiSea server.</p></div>`;
  if (ok && !previewAs) mountHolderChat(el.querySelector('#holder-chat')!, slug, col.name);
}
el.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-act="connect"]')) openConnect(); });
onWallet(() => { if (!previewAs) { checkedFor = ''; check(); } });
draw(); check();
