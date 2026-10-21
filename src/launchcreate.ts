// MultiSea Launchpad: "Create a drop" multi-step creator form (/launchpad/create).
// Submits to the Worker (POST /launchpad/submit, SIWE) when the API advertises the 'launchpad' feature; until the Worker
// change is deployed it saves a LOCAL PREVIEW submission in this browser, shown in the /admin review queue on localhost.
import CFG from '../config/collections.json';
import { parseEther } from 'viem';
import { checkApi, onWallet, wallet, openConnect, apiFeatures } from './wallet';
import { navHtml, bindNav, esc } from './shell';
import { api } from './auth';
import { LP_CHAINS, FEE_BPS, localDrops, saveLocal, isLocalHost, type Drop, type Phase } from './launchdata';
const app = document.getElementById('app')!; document.title = 'Create a drop · Launchpad · MultiSea';
const chains = CFG.chains as Record<string, { name: string; native: string }>;
const STEPS = ['Project', 'Art & metadata', 'Chains & supply', 'Mint phases', 'Royalties & payout', 'Review'];
const SKEY = 'multisea-lp-draft';
type PhaseIn = { name: string; kind: 'allowlist' | 'public'; start: string; end: string; price: string; maxPerWallet: string; allowlist: string };
type St = { step: number; name: string; symbol: string; slug: string; description: string; website: string; x: string; storage: 'ipfs' | 'arweave' | 'own'; baseURI: string; reveal: 'instant' | 'delayed'; preRevealURI: string; files: number;
  chains: Record<string, string>; reserve: string; phases: PhaseIn[]; royalty: string; payout: string; royaltyReceiver: string; agree: boolean };
const iso = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const blank = (): St => ({ step: 0, name: '', symbol: '', slug: '', description: '', website: '', x: '', storage: 'ipfs', baseURI: '', reveal: 'instant', preRevealURI: '', files: 0, chains: { base: '' }, reserve: '0',
  phases: [{ name: 'Allowlist', kind: 'allowlist', start: iso(Date.now() + 3 * 86400e3), end: iso(Date.now() + 4 * 86400e3), price: '0.002', maxPerWallet: '2', allowlist: '' }, { name: 'Public', kind: 'public', start: iso(Date.now() + 4 * 86400e3), end: '', price: '0.003', maxPerWallet: '10', allowlist: '' }],
  royalty: '5', payout: '', royaltyReceiver: '', agree: false });
let st: St = (() => { try { return { ...blank(), ...JSON.parse(sessionStorage.getItem(SKEY) || 'null') }; } catch { return blank(); } })();
let msg = ''; let msgCls = 'mut'; let done = '';
const save = () => sessionStorage.setItem(SKEY, JSON.stringify(st));
const supply = () => Object.values(st.chains).reduce((a, v) => a + (parseInt(v) || 0), 0);
const addrs = (s: string) => [...new Set(s.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
const ADDR = /^0x[0-9a-f]{40}$/;
const ts = (v: string) => (v ? Math.floor(new Date(v).getTime() / 1000) : 0);

function validate(step: number): string {
  if (step === 0) { if (!st.name.trim()) return 'Project name is required.'; if (!/^[A-Za-z0-9]{1,12}$/.test(st.symbol)) return 'Symbol: 1-12 letters or digits.'; if (!/^[a-z0-9-]{3,40}$/.test(st.slug)) return 'Slug: 3-40 lowercase letters, digits, dashes.'; }
  if (step === 1) { if (st.reveal === 'instant' && !/^(ipfs|ar):\/\/\S+|^https:\/\/\S+/.test(st.baseURI)) return 'Instant reveal needs the final metadata base URI (ipfs://CID/ or ar://TX/).'; if (st.reveal === 'delayed' && !/^(ipfs|ar|https):\/\/\S+/.test(st.preRevealURI)) return 'Delayed reveal needs a placeholder metadata URI.'; }
  if (step === 2) { if (!Object.keys(st.chains).length) return 'Pick at least one chain.'; for (const [k, v] of Object.entries(st.chains)) if (!(parseInt(v) > 0)) return `Set the supply for ${chains[k].name}.`; if ((parseInt(st.reserve) || 0) > supply()) return 'Creator reserve exceeds supply.'; }
  if (step === 3) { if (!st.phases.length) return 'Add at least one phase.'; for (const [i, p] of st.phases.entries()) { if (!p.start) return `Phase ${i + 1}: set a start time.`; if (p.end && ts(p.end) <= ts(p.start)) return `Phase ${i + 1}: end must be after start.`; if (!(+p.price >= 0)) return `Phase ${i + 1}: price must be 0 or more.`; if (p.kind === 'allowlist') { const l = addrs(p.allowlist); if (!l.length) return `Phase ${i + 1}: paste allowlist addresses.`; const badA = l.find(a => !ADDR.test(a)); if (badA) return `Phase ${i + 1}: "${badA.slice(0, 20)}" is not an address.`; } } }
  if (step === 4) { if (!(+st.royalty >= 0 && +st.royalty <= 10)) return 'Royalty must be 0-10%.'; if (st.payout && !ADDR.test(st.payout.toLowerCase())) return 'Payout must be a 0x address.'; if (st.royaltyReceiver && !ADDR.test(st.royaltyReceiver.toLowerCase())) return 'Royalty receiver must be a 0x address.'; }
  if (step === 5) { if (!st.agree) return 'Confirm you own the rights to the art.'; }
  return '';
}
const inp = (k: keyof St, label: string, extra = '') => `<label>${label}<input data-k="${k}" value="${esc(st[k] as string)}" ${extra}></label>`;
function stepHtml(): string {
  const s = st.step;
  if (s === 0) return `<div class="two">${inp('name', 'Project name', 'maxlength="60" placeholder="LIL FOOTS"')}${inp('symbol', 'Token symbol', 'maxlength="12" placeholder="FOOT"')}</div>
   ${inp('slug', 'Slug <span class="mut small">multisea.io/launchpad/<b>' + esc(st.slug || 'your-slug') + '</b></span>', 'maxlength="40" placeholder="lowercase-with-dashes"')}
   <label>Description<textarea data-k="description" rows="4" maxlength="1000">${esc(st.description)}</textarea></label>
   <div class="two">${inp('website', 'Website', 'placeholder="https://"')}${inp('x', 'X', 'placeholder="https://x.com/handle"')}</div>`;
  if (s === 1) return `<div class="gh">Where the art lives</div><div class="ldopts">${([['ipfs', 'IPFS', 'Pinned by MultiSea (pinning service). Content-addressed, cheap.'], ['arweave', 'Arweave', 'One-time fee, permanent storage (via a bundler).'], ['own', 'I already host it', 'Paste an existing ipfs:// or ar:// base URI.']] as const).map(([k, t, d]) => `<label class="ldopt ${st.storage === k ? 'on' : ''}"><input type="radio" name="storage" value="${k}" ${st.storage === k ? 'checked' : ''}><b>${t}</b><span class="mut small">${d}</span></label>`).join('')}</div>
   ${st.storage !== 'own' ? `<div class="fcard ldup"><div class="gh">Upload images + metadata</div><p class="mut small">Pick a folder with <span class="mono">1.png … N.png</span> and matching <span class="mono">1.json … N.json</span> (or one CSV of traits). Preview: files are counted locally, <b>nothing is uploaded</b>.</p><span class="fpick"><input type="file" class="fin" data-files multiple accept="image/*,.json,.csv"><span class="upbtn">Choose files</span><span class="fname mut small">${st.files ? st.files + ' files selected' : 'No files chosen'}</span></span></div>` : ''}
   <div class="gh pad">Reveal</div><div class="ldopts two">${([['instant', 'Instant reveal', 'Each NFT shows its art right after mint.'], ['delayed', 'Delayed reveal', 'Placeholder until you reveal, then freeze.']] as const).map(([k, t, d]) => `<label class="ldopt ${st.reveal === k ? 'on' : ''}"><input type="radio" name="reveal" value="${k}" ${st.reveal === k ? 'checked' : ''}><b>${t}</b><span class="mut small">${d}</span></label>`).join('')}</div>
   ${st.reveal === 'instant' ? inp('baseURI', 'Metadata base URI <span class="mut small">token N → baseURI + N.json</span>', 'placeholder="ipfs://bafy…/"') : inp('preRevealURI', 'Placeholder metadata URI', 'placeholder="ipfs://bafy…/hidden.json"')}`;
  if (s === 2) return `<div class="gh">Chains <span class="mut small">each chain is its own ERC-721A contract with its own supply allocation</span></div>
   <div class="ldchgrid">${LP_CHAINS.map(k => { const on = k in st.chains; return `<div class="ldchrow ${on ? 'on' : ''}"><label class="ldchk"><input type="checkbox" data-chain="${k}" ${on ? 'checked' : ''}><img class="cl" src="/logos/${k}.svg" alt=""><b>${esc(chains[k].name)}</b><span class="mut small">${esc(chains[k].native)}</span></label>${on ? `<input class="ldsup" data-sup="${k}" type="number" min="1" placeholder="Supply" value="${esc(st.chains[k])}">` : ''}</div>`; }).join('')}</div>
   <div class="two"><label>Total supply<input value="${supply().toLocaleString()}" disabled></label>${inp('reserve', 'Creator reserve <span class="mut small">free team mints, counted in supply</span>', 'type="number" min="0"')}</div>`;
  if (s === 3) return `<p class="mut small">Phases run in order. Allowlist phases use a Merkle root on-chain; MultiSea serves each wallet's proof. Prices are per token in each chain's native currency.</p>
   ${st.phases.map((p, i) => `<div class="fcard ldphin"><div class="ldphinh"><b>Phase ${i + 1}</b>${st.phases.length > 1 ? `<button class="x" data-rmph="${i}" aria-label="Remove phase">✕</button>` : ''}</div>
    <div class="two"><label>Name<input data-ph="${i}" data-f="name" value="${esc(p.name)}" maxlength="40"></label><label>Type<select data-ph="${i}" data-f="kind"><option value="allowlist" ${p.kind === 'allowlist' ? 'selected' : ''}>Allowlist (Merkle)</option><option value="public" ${p.kind === 'public' ? 'selected' : ''}>Public</option></select></label></div>
    <div class="two"><label>Start<input type="datetime-local" data-ph="${i}" data-f="start" value="${esc(p.start)}"></label><label>End <span class="mut small">empty = until sold out</span><input type="datetime-local" data-ph="${i}" data-f="end" value="${esc(p.end)}"></label></div>
    <div class="two"><label>Price per token<input type="number" step="0.0001" min="0" data-ph="${i}" data-f="price" value="${esc(p.price)}"></label><label>Max per wallet <span class="mut small">0 = no limit</span><input type="number" min="0" data-ph="${i}" data-f="maxPerWallet" value="${esc(p.maxPerWallet)}"></label></div>
    ${p.kind === 'allowlist' ? `<label>Allowlist <span class="mut small">${addrs(p.allowlist).length} addresses · one per line or comma-separated</span><textarea rows="3" data-ph="${i}" data-f="allowlist" placeholder="0x…">${esc(p.allowlist)}</textarea></label>` : ''}</div>`).join('')}
   ${st.phases.length < 8 ? '<button type="button" class="pill" data-act="addph">+ Add phase</button>' : ''}`;
  if (s === 4) return `<div class="two">${inp('royalty', 'Creator royalty % <span class="mut small">ERC-2981, max 10%</span>', 'type="number" step="0.1" min="0" max="10"')}${inp('royaltyReceiver', 'Royalty receiver <span class="mut small">default: payout</span>', 'placeholder="0x…"')}</div>
   ${inp('payout', 'Mint proceeds payout address <span class="mut small">default: your wallet</span>', `placeholder="${esc(wallet.address || '0x…')}"`)}
   <div class="fcard small"><div class="kv"><span>MultiSea primary fee</span><b>${FEE_BPS / 100}% of mint proceeds</b><span>Paid to</span><b>MultiSea fee wallet, at withdraw</b><span>You receive</span><b>${100 - FEE_BPS / 100}% of proceeds</b><span>Secondary sales on MultiSea</span><b>0.5% marketplace fee + your royalty</b></div></div>`;
  const ph = st.phases.map((p, i) => `<div>${i + 1}. <b>${esc(p.name)}</b> · ${p.kind} · ${esc(p.price)} native · ${p.maxPerWallet === '0' ? 'no limit' : 'max ' + esc(p.maxPerWallet)} · ${esc(p.start.replace('T', ' '))}${p.kind === 'allowlist' ? ` · ${addrs(p.allowlist).length} wallets` : ''}</div>`).join('');
  return `<div class="fcard"><div class="kv"><span>Project</span><b>${esc(st.name)} (${esc(st.symbol.toUpperCase())})</b><span>Slug</span><b>/launchpad/${esc(st.slug)}</b><span>Chains</span><b>${Object.entries(st.chains).map(([k, v]) => `${esc(chains[k].name)} ${(+v).toLocaleString()}`).join(' · ')}</b><span>Total supply</span><b>${supply().toLocaleString()} (reserve ${esc(st.reserve || '0')})</b><span>Storage</span><b>${esc(st.storage === 'own' ? 'Own host' : st.storage.toUpperCase())}</b><span>Reveal</span><b>${st.reveal}</b><span>Royalty</span><b>${esc(st.royalty)}%</b></div><div class="small ldrev">${ph}</div></div>
   <div class="fcard small"><div class="gh">What happens next</div><ol class="mut"><li>MultiSea reviews the drop in the admin review queue (art rights, metadata, phases).</li><li>Once approved you get a one-time deploy approval and deploy from your wallet (you pay gas, est. ~0.55M gas per chain).</li><li>The drop page goes live at the first phase start; minted NFTs trade on MultiSea immediately.</li></ol></div>
   <label class="ldagree"><input type="checkbox" data-agree ${st.agree ? 'checked' : ''}> I own or have licensed the rights to this art and metadata.</label>`;
}
function render() {
  app.innerHTML = `${navHtml('launchpad')}<section class="page form ldcreate"><a class="mut small" href="/launchpad">← Launchpad</a><h2>Create a drop</h2>
  ${done ? `<div class="okbox">✓ <b>${esc(done)}</b> submitted for review. ${apiFeatures.includes('launchpad') ? 'You will see it on /launchpad once approved.' : `Preview mode: saved in this browser only (the Worker launchpad endpoints are not deployed).${isLocalHost() ? ' Open <a href="/admin">/admin</a> to see it in the review queue.' : ''}`}</div><p><a class="obtn" href="/launchpad">Back to Launchpad</a> <button class="obtn" data-act="new">Create another</button></p>` : `
  <ol class="ldsteps">${STEPS.map((n, i) => `<li class="${i === st.step ? 'on' : i < st.step ? 'done' : ''}"><button type="button" data-go="${i}" ${i > st.step ? 'disabled' : ''}><span>${i < st.step ? '✓' : i + 1}</span><em>${n}</em></button></li>`).join('')}</ol>
  <div class="ldstepn mut small">Step ${st.step + 1} of ${STEPS.length} · <b>${STEPS[st.step]}</b></div>
  ${st.step === 0 && !st.name ? '<button type="button" class="pill ldfill" data-act="demo">Fill with LIL FOOTS demo</button>' : ''}
  <fieldset>${stepHtml()}</fieldset>
  <p class="msg ${msgCls}">${esc(msg)}</p>
  <div class="ldnav">${st.step ? '<button type="button" class="obtn" data-act="back">Back</button>' : '<span></span>'}${st.step < STEPS.length - 1 ? '<button type="button" class="bbtn sm" data-act="next">Continue</button>' : `<button type="button" class="bbtn sm" data-act="submit">${apiFeatures.includes('launchpad') ? (wallet.address ? 'Sign in & submit for review' : 'Connect wallet to submit') : 'Submit for review (preview)'}</button>`}</div>`}
  </section>`;
}
app.addEventListener('input', e => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.k) { (st as any)[t.dataset.k] = t.value; if (t.dataset.k === 'slug') { t.value = st.slug = t.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); } if (t.dataset.k === 'name' && !st.slug) { /* keep user-typed slug */ } save(); }
  if (t.dataset.sup) { st.chains[t.dataset.sup] = t.value; save(); const tot = app.querySelector('input[disabled]') as HTMLInputElement | null; if (tot) tot.value = supply().toLocaleString(); }
  if (t.dataset.ph) { (st.phases[+t.dataset.ph] as any)[t.dataset.f!] = t.value; save(); }
});
app.addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'storage' || t.name === 'reveal') { (st as any)[t.name] = t.value; save(); render(); }
  if (t.dataset.chain) { if (t.checked) st.chains[t.dataset.chain] = ''; else delete st.chains[t.dataset.chain]; save(); render(); }
  if (t.dataset.ph && t.dataset.f === 'kind') { st.phases[+t.dataset.ph].kind = t.value as any; save(); render(); }
  if (t.dataset.files != null) { st.files = t.files?.length || 0; save(); render(); }
  if (t.dataset.agree != null) { st.agree = t.checked; save(); }
});
async function submit() {
  const err = [0, 1, 2, 3, 4, 5].map(validate).find(Boolean); if (err) { msg = err; msgCls = 'err'; render(); return; }
  const me = (wallet.address || '').toLowerCase();
  const phases = st.phases.map(p => ({ name: p.name, kind: p.kind, start: ts(p.start), end: ts(p.end), maxPerWallet: parseInt(p.maxPerWallet) || 0, price: p.price, allowlist: p.kind === 'allowlist' ? addrs(p.allowlist) : undefined }));
  if (apiFeatures.includes('launchpad')) {
    if (!wallet.address) { openConnect(); return; }
    msg = 'Check your wallet to sign…'; msgCls = 'mut'; render();
    try {
      const j = await api('/launchpad/submit', { auth: true, body: { slug: st.slug, name: st.name, symbol: st.symbol, description: st.description, website: st.website, x: st.x, chains: Object.keys(st.chains), allocations: Object.fromEntries(Object.entries(st.chains).map(([k, v]) => [k, parseInt(v) || 0])), maxSupply: supply(), creatorReserve: parseInt(st.reserve) || 0,
        royaltyBps: Math.round(+st.royalty * 100), payout: st.payout || undefined, royaltyReceiver: st.royaltyReceiver || undefined, reveal: st.reveal, baseURI: st.baseURI, preRevealURI: st.preRevealURI, metadataHost: st.storage,
        phases: phases.map(p => ({ ...p, price: parseEther(p.price || '0').toString() })) } });
      done = j.slug;
    } catch (er: any) { msg = er.message; msgCls = 'err'; render(); return; }
  } else {
    const l = localDrops(); if (l.some(d => d.slug === st.slug)) { msg = 'You already submitted that slug in this browser.'; msgCls = 'err'; render(); return; }
    const art = st.slug.includes('foot') ? [2396, 1858, 3958, 4356].map(i => `/img/lil-foots/m/${i}.webp`) : ['/brand/icon-128.webp'];
    const d: Drop = { slug: st.slug, name: st.name, symbol: st.symbol.toUpperCase(), creator: me, description: st.description, website: st.website, x: st.x, local: true, status: 'pending', submittedAt: new Date().toISOString(),
      chains: Object.entries(st.chains).map(([chain, v]) => ({ chain, supply: parseInt(v), minted: 0 })), maxSupply: supply(), creatorReserve: parseInt(st.reserve) || 0, royaltyBps: Math.round(+st.royalty * 100), reveal: st.reveal, storage: st.storage, baseURI: st.baseURI, preRevealURI: st.preRevealURI, payout: st.payout || me,
      phases: phases.map(p => ({ name: p.name, kind: p.kind, start: p.start, end: p.end, price: +p.price, maxPerWallet: p.maxPerWallet, allowlist: p.allowlist, allowCount: p.allowlist?.length })) as Phase[], img: art[0], art };
    l.push(d); saveLocal(l); done = st.slug;
  }
  sessionStorage.removeItem(SKEY); msg = ''; render(); window.scrollTo(0, 0);
}
app.addEventListener('click', e => {
  const t = e.target as HTMLElement; const el = t.closest('[data-act],[data-go],[data-rmph]') as HTMLElement | null; if (!el) return;
  if (el.dataset.go) { st.step = +el.dataset.go; msg = ''; save(); render(); return; }
  if (el.dataset.rmph) { st.phases.splice(+el.dataset.rmph, 1); save(); render(); return; }
  const a = el.dataset.act;
  if (a === 'next') { const er = validate(st.step); if (er) { msg = er; msgCls = 'err'; render(); return; } st.step++; msg = ''; save(); render(); window.scrollTo(0, 0); }
  if (a === 'back') { st.step--; msg = ''; save(); render(); }
  if (a === 'addph') { st.phases.push({ name: 'Public', kind: 'public', start: st.phases[st.phases.length - 1]?.end || iso(Date.now() + 86400e3), end: '', price: '0.003', maxPerWallet: '10', allowlist: '' }); save(); render(); }
  if (a === 'submit') submit();
  if (a === 'new') { done = ''; st = blank(); save(); render(); }
  if (a === 'demo') { st = { ...blank(), name: 'LIL FOOTS', symbol: 'FOOT', slug: 'lil-foots-v2', description: '4,404 tiny feet walking every chain. Demo drop for the launchpad preview.', website: 'https://multisea.io', x: 'https://x.com/lilfoots',
    storage: 'own', baseURI: 'ipfs://bafybeidemolilfootsmetadata/', reveal: 'instant', chains: { base: '2404', apechain: '1000', bnb: '1000' }, reserve: '4', royalty: '5',
    phases: [{ name: 'Foot holders', kind: 'allowlist', start: iso(Date.now() + 2 * 86400e3), end: iso(Date.now() + 3 * 86400e3), price: '0', maxPerWallet: '1', allowlist: '0xca89ae48a5c61d13e78236daa4ac29ee588ea475\n0x000000000000000000000000000000000000f007' }, { name: 'Public', kind: 'public', start: iso(Date.now() + 3 * 86400e3), end: '', price: '0.003', maxPerWallet: '10', allowlist: '' }] }; save(); render(); }
});
bindNav(); render(); onWallet(render); checkApi().then(render);
