// Chain quests + badges: buy / list / bridge / hold on each of 5 chains (verified by the Worker from MultiSea events and
// on-chain reads). All 5 badges unlock a Worker-signed MintPass for the rare free "Chain Voyager" mint. Also /u/<address>.
import { parseAbi, parseEther, encodeFunctionData, type Hex } from 'viem';
import { wallet, onWallet, openConnect, checkApi, friendly } from './wallet';
import { API } from './wallet';
import { frame, getJ, esc, short, logo, chains, connectCta, fmtWei, exactInQuote, runRelay, balances } from './gx';
const prof = location.pathname.match(/^\/u\/(0x[0-9a-fA-F]{40})$/)?.[1]?.toLowerCase();
const el = frame(prof ? '' : 'quests', prof ? `Profile ${short(prof)}` : 'Quests');
const KIND: Record<string, [string, string]> = { buy: ['Buy', 'Buy any NFT on MultiSea'], list: ['List', 'List an NFT for sale'], bridge: ['Bridge', 'Bridge funds or an NFT here'], hold: ['Hold', 'Hold a MultiSea-listed NFT'] };
const st = { q: null as any, prof: null as any, err: '', msg: '', elig: null as any, busy: '' };
const who = () => prof || wallet.address?.toLowerCase();
async function load() {
  st.err = ''; const a = who(); if (!a) { draw(); return; }
  try { if (prof) st.prof = await getJ('/profile/' + a); st.q = prof ? st.prof.quests : await getJ('/quests/' + a); } catch (e: any) { st.err = e.message; }
  draw();
}
const badgeRow = (q: any) => `<div class="badges">${q.chains.map((c: any) => `<div class="cbadge ${c.badge ? 'on' : ''}" title="${esc(chains[c.chain]?.name)}${c.badge ? ' badge earned' : ''}">${logo(c.chain, 'cl lg')}<span>${esc(chains[c.chain]?.name)}</span>${c.badge ? '<i>✓</i>' : ''}</div>`).join('')}</div>`;
function draw() {
  const q = st.q;
  if (prof) {
    const p = st.prof;
    el.innerHTML = `<div class="ghero prof"><div class="pava">${esc(prof.slice(2, 4).toUpperCase())}</div><div><h1 class="mono">${short(prof)}</h1><p class="mut small mono">${esc(prof)}</p></div></div>
      ${st.err ? `<p class="err">${esc(st.err)}</p>` : !p ? '<div class="spin"></div>' : `
      <div class="fcard"><div class="gh">Chain badges <span class="mut small">${q.count}/${q.total}</span></div>${badgeRow(q)}${q.eligible ? '<p class="ok small">✓ All 5 badges: eligible for the rare Chain Voyager mint.</p>' : ''}<a class="obtn sm" href="/quests">Go to quests →</a></div>
      <div class="gstats"><div class="gstat"><b>${p.referrals.friends}</b><span>Friends referred</span></div><div class="gstat"><b>${p.referrals.earnings?.sales || 0}</b><span>Referred sales</span></div><div class="gstat"><b>${p.bundles.length}</b><span>Bundles listed</span></div></div>
      ${p.bundles.length ? `<div class="fcard"><div class="gh">Bundles</div>${p.bundles.map((b: any) => `<a class="frow" href="/bundles?id=${esc(b.id)}"><span><b>${esc(b.title)}</b><em>${b.legs.map((l: any) => logo(l.chain)).join('')} ${esc(b.status)}</em></span></a>`).join('')}</div>` : ''}`}`;
    return;
  }
  el.innerHTML = `<div class="ghero"><h1>Chain quests</h1><p class="lpsub">Earn a badge on each of 5 chains by buying, listing, bridging or holding there. Collect all 5 to unlock a <b>free mint of the rare Chain Voyager</b> NFT.</p></div>
  ${!wallet.address ? connectCta('Connect a wallet to track your quests.') : st.err ? `<p class="err">${esc(st.err)}</p>` : !q ? '<div class="spin"></div> Loading…' : `
  <div class="qprog"><div class="qbar"><i style="width:${(q.count / q.total) * 100}%"></i></div><b>${q.count}/${q.total} badges</b><button class="obtn sm" data-act="verify">${st.busy === 'verify' ? 'Checking…' : 'Verify holdings'}</button><a class="obtn sm" href="/u/${esc(q.address)}">My profile</a></div>
  ${badgeRow(q)}
  <div class="qgrid">${q.chains.map((c: any) => `<div class="qcard ${c.badge ? 'on' : ''}"><div class="qch">${logo(c.chain, 'cl lg')}<div><b>${esc(chains[c.chain]?.name)}</b><span class="mut small">${c.badge ? 'Badge earned' : 'Complete any one quest'}</span></div></div>
    ${Object.entries(KIND).map(([k, [n, d]]) => `<div class="qrow ${c.done[k] ? 'done' : ''}"><span class="qck">${c.done[k] ? '✓' : ''}</span><span><b>${n}</b><em>${d}</em></span>${c.done[k] ? `<small>${new Date(c.done[k]).toLocaleDateString()}</small>` : k === 'buy' || k === 'hold' ? '<a class="small" href="/c/lil-foots">Browse →</a>' : k === 'list' ? '<a class="small" href="/c/lil-foots?tab=items">Sell →</a>' : `<button class="lnk small" data-bridge="${c.chain}">Bridge →</button>`}</div>`).join('')}</div>`).join('')}</div>
  <div class="fcard mintcard ${q.eligible ? 'on' : ''}"><div class="gh">Rare free mint · Chain Voyager</div>
    <p class="mut small">${q.eligible ? 'You collected all 5 badges. MultiSea signs a one-time MintPass for your wallet; the contract checks it and mints for free (gas only).' : `Collect ${q.total - q.count} more badge(s) to unlock.`}</p>
    ${st.elig ? (st.elig.signature ? `<p class="ok small">MintPass signed, valid until ${new Date(st.elig.deadline * 1000).toLocaleString()}.</p><button class="bbtn" data-act="mint">Mint now (free)</button>` : `<p class="warn small">${esc(st.elig.note || 'Not eligible yet.')}</p>`) : `<button class="bbtn" data-act="elig" ${q.eligible ? '' : 'disabled'}>Unlock free mint</button>`}
    ${st.msg}</div>`}`;
}
async function bridgeModal(to: string) {
  const { overlay } = await import('./wallet');
  const m = overlay(`<div class="bhead"><div><div class="mut">Bridge quest · Relay</div><h3>Bridge to ${esc(chains[to].name)}</h3></div></div><div class="bbody"><div class="spin"></div> Loading balances…</div>`);
  const body = m.querySelector('.bbody') as HTMLElement;
  try {
    const bal = await balances(); const srcs = Object.entries(bal).filter(([k, b]) => k !== to && b && b > 0n && chains[k].native === chains[to].native);
    if (!srcs.length) throw new Error(`No ${chains[to].native} on another chain to bridge from.`);
    body.innerHTML = `<label>From<select class="bfrom">${srcs.map(([k, b]) => `<option value="${k}">${esc(chains[k].name)} (${fmtWei(b!)} ${esc(chains[k].native)})</option>`).join('')}</select></label><label>Amount (${esc(chains[to].native)})<input class="bamt" value="0.002" inputmode="decimal"></label><p class="mut small">Relay moves the funds to your own wallet on ${esc(chains[to].name)}. MultiSea verifies the completed bridge and credits the quest on both chains.</p><button class="bbtn go">Bridge</button>`;
    await new Promise<void>(res => body.querySelector('.go')!.addEventListener('click', () => res()));
    const from = (body.querySelector('.bfrom') as HTMLSelectElement).value; const amt = parseEther((body.querySelector('.bamt') as HTMLInputElement).value || '0');
    body.innerHTML = '<div class="spin"></div> Getting a Relay quote…';
    const q = await exactInQuote(from, to, amt);
    await runRelay(q.quote, from, s => { body.innerHTML = `<div class="spin"></div> ${s}`; });
    body.innerHTML = '<p class="ok">✓ Bridged. Quest credited (refresh in a few seconds).</p>'; setTimeout(load, 3000);
  } catch (e: any) { body.innerHTML = `<p class="err">${esc(friendly(e))}</p>`; }
}
el.addEventListener('click', async e => {
  const t = e.target as HTMLElement; const a = t.dataset.act;
  if (a === 'connect') openConnect();
  if (t.dataset.bridge) bridgeModal(t.dataset.bridge);
  if (a === 'verify' && wallet.address) { st.busy = 'verify'; draw(); try { const r = await fetch(`${API}/quests/${wallet.address.toLowerCase()}/verify`, { method: 'POST' }); st.q = await r.json(); } catch {} st.busy = ''; draw(); }
  if (a === 'elig' && wallet.address) { try { st.elig = await getJ(`/quests/${wallet.address.toLowerCase()}/eligibility`); } catch (x: any) { st.msg = `<p class="err">${esc(x.message)}</p>`; } draw(); }
  if (a === 'mint' && st.elig?.signature) {
    try {
      const id = '0x' + Number(st.elig.chainId).toString(16);
      await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] });
      const data = encodeFunctionData({ abi: parseAbi(['function mint(uint256 deadline, bytes signature) returns (uint256)']), functionName: 'mint', args: [BigInt(st.elig.deadline), st.elig.signature as Hex] });
      const h = await wallet.provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet.address, to: st.elig.contract, data }] });
      st.msg = `<p class="ok small">✓ Mint sent: <span class="mono">${esc(String(h).slice(0, 14))}…</span></p>`;
    } catch (x: any) { st.msg = `<p class="err">${esc(friendly(x))}</p>`; }
    draw();
  }
});
onWallet(load); checkApi().then(load); draw();
