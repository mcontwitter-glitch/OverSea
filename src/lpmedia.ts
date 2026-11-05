// Launchpad create form: OpenSea-style media + metadata CSV upload. Files stay in memory (never in sessionStorage);
// on submit, media is pinned to IPFS via thirdweb storage (VITE_THIRDWEB_CLIENT_ID, no extra secret), then per-token
// JSON (tokenID.json) is generated and pinned as one folder; its ipfs://CID/ becomes the drop's baseURI.
import { esc } from './shell';
import { THIRDWEB_CLIENT_ID } from './embedded';

export const MEDIA_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/webm,audio/mpeg,audio/wav,model/gltf-binary,.glb,.gltf';
const MAX_FILE = 100 * 1024 * 1024; // per file
export const CSV_BASE = ['tokenID', 'name', 'description', 'file_name', 'external_url'];
export type Row = { line: number; tokenID: string; name: string; description: string; file_name: string; external_url: string; attrs: { trait_type: string; value: string }[]; errs: string[] };
export const PH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/webm';
export const ph = { file: null as File | null, url: '' };
export function setPlaceholder(f: File | null) { if (ph.url) URL.revokeObjectURL(ph.url); ph.file = f; ph.url = f ? URL.createObjectURL(f) : ''; }
export const media = { files: new Map<string, File>(), rows: [] as Row[], csvName: '', csvErr: '', thumbs: new Map<string, string>() };

const isVid = (f: File) => /^(video|audio)\//.test(f.type) || /\.(mp4|webm|mov|mp3|wav)$/i.test(f.name);
export function addMedia(list: FileList | File[]) {
  const skipped: string[] = [];
  for (const f of Array.from(list)) { if (f.size > MAX_FILE) { skipped.push(f.name); continue; } media.files.set(f.name, f); }
  validateRows(); return skipped;
}
export function clearMedia() { for (const u of media.thumbs.values()) URL.revokeObjectURL(u); media.files.clear(); media.thumbs.clear(); validateRows(); }
const thumb = (f: File) => { let u = media.thumbs.get(f.name); if (!u) { u = URL.createObjectURL(f); media.thumbs.set(f.name, u); } return u; };

/** RFC4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(txt: string): string[][] {
  const out: string[][] = []; let row: string[] = [], cell = '', q = false;
  txt = txt.replace(/^\uFEFF/, '');
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter(r => r.some(v => v.trim()));
}
export function loadCsv(name: string, txt: string) {
  media.csvName = name; media.csvErr = ''; media.rows = [];
  const t = parseCsv(txt); if (!t.length) { media.csvErr = 'CSV is empty.'; return; }
  const head = t[0].map(h => h.trim()); const low = head.map(h => h.toLowerCase());
  const need = ['tokenid', 'name', 'file_name']; const miss = need.filter(n => !low.includes(n));
  if (miss.length) { media.csvErr = 'Missing column(s): ' + miss.join(', ') + '. Download the template.'; return; }
  const col = (n: string) => low.indexOf(n.toLowerCase());
  const traits = head.map((h, i) => [h.match(/^attributes\[(.+)\]$/i)?.[1]?.trim(), i] as const).filter(([n]) => n) as [string, number][];
  media.rows = t.slice(1).map((r, k) => ({ line: k + 2, tokenID: (r[col('tokenid')] || '').trim(), name: (r[col('name')] || '').trim(), description: col('description') >= 0 ? (r[col('description')] || '').trim() : '',
    file_name: (r[col('file_name')] || '').trim(), external_url: col('external_url') >= 0 ? (r[col('external_url')] || '').trim() : '',
    attrs: traits.map(([n, i]) => ({ trait_type: n, value: (r[i] || '').trim() })).filter(a => a.value), errs: [] }));
  if (!media.rows.length) media.csvErr = 'CSV has a header but no rows.';
  validateRows();
}
export function validateRows() {
  const seen = new Map<string, number>();
  for (const r of media.rows) {
    r.errs = [];
    if (!/^\d+$/.test(r.tokenID)) r.errs.push('tokenID must be a whole number');
    else if (seen.has(r.tokenID)) r.errs.push(`duplicate tokenID (also row ${seen.get(r.tokenID)})`); else seen.set(r.tokenID, r.line);
    if (!r.name) r.errs.push('name is empty');
    if (!r.file_name) r.errs.push('file_name is empty'); else if (!media.files.has(r.file_name)) r.errs.push(`no uploaded file "${r.file_name}"`);
    if (r.external_url && !/^https?:\/\/\S+$/.test(r.external_url)) r.errs.push('external_url must start with https://');
  }
}
export const badRows = () => media.rows.filter(r => r.errs.length);
export const usingUpload = () => media.files.size > 0 || media.rows.length > 0;
/** '' when ready to pin, else the first problem. */
export function uploadProblem(): string {
  if (!media.files.size) return 'Upload your media files.';
  if (media.csvErr) return 'Metadata CSV: ' + media.csvErr;
  if (!media.rows.length) return 'Upload the metadata CSV (download the template).';
  const b = badRows(); if (b.length) return `Metadata CSV: ${b.length} row${b.length > 1 ? 's have' : ' has'} errors (first: row ${b[0].line}, ${b[0].errs[0]}).`;
  const used = new Set(media.rows.map(r => r.file_name)); const unused = [...media.files.keys()].filter(n => !used.has(n));
  if (unused.length) return `${unused.length} uploaded file${unused.length > 1 ? 's are' : ' is'} not in the CSV (e.g. "${unused[0]}"). Remove it or add a row.`;
  return '';
}

export function templateCsv(traits = ['Background', 'Eyes']) {
  const head = [...CSV_BASE, ...traits.map(t => `attributes[${t}]`)];
  const rows = [['1', 'My NFT #1', 'The first one', '1.png', 'https://example.com/1', 'Blue', 'Laser'], ['2', 'My NFT #2', 'An animated one', '2.gif', '', 'Red', 'Sleepy'], ['3', 'My NFT #3', 'A video', '3.mp4', '', 'Green', '']];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [head, ...rows].map(r => r.map(q).join(',')).join('\n') + '\n';
}
export function downloadTemplate() {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([templateCsv()], { type: 'text/csv' })); a.download = 'multisea-metadata-template.csv';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function cell(r: Row) {
  const f = media.files.get(r.file_name);
  const pv = f ? (isVid(f) ? (/^video\//.test(f.type) || /\.(mp4|webm|mov)$/i.test(f.name) ? `<video src="${thumb(f)}" muted loop playsinline autoplay></video>` : '<div class="lmnone">♪</div>') : `<img src="${thumb(f)}" alt="" loading="lazy">`) : '<div class="lmnone">?</div>';
  return `<div class="lmcell ${r.errs.length ? 'bad' : ''}">${pv}<div class="lmmeta"><b>#${esc(r.tokenID || '?')} ${esc(r.name || '(no name)')}</b><span class="mut mono">${esc(r.file_name || '—')}</span>${r.attrs.length ? `<span class="mut">${r.attrs.slice(0, 3).map(a => `${esc(a.trait_type)}: ${esc(a.value)}`).join(' · ')}</span>` : ''}${r.errs.map(e => `<span class="err">Row ${r.line}: ${esc(e)}</span>`).join('')}</div></div>`;
}
/** Media + CSV sections. */
export function uploadHtml(supply: number) {
  const n = media.files.size; const bad = badRows();
  const total = [...media.files.values()].reduce((a, f) => a + f.size, 0);
  const sample = [...bad.slice(0, 4), ...media.rows.filter(r => !r.errs.length).slice(0, Math.max(0, 6 - Math.min(bad.length, 4)))].sort((a, b) => a.line - b.line);
  const used = new Set(media.rows.map(r => r.file_name)); const unused = media.rows.length ? [...media.files.keys()].filter(k => !used.has(k)) : [];
  return `<div class="fcard ldup"><div class="gh">1. Media</div><p class="mut small">Images, GIFs, video (mp4/webm), audio or 3D (glb). Up to 100 MB per file. File names must match the <span class="mono">file_name</span> column of your CSV.</p>
   <label class="lmdrop" data-drop><input type="file" class="fin" data-media multiple accept="${MEDIA_ACCEPT}"><b>Drag &amp; drop media here</b><span class="mut small">or <u>browse files</u></span></label>
   <div class="lmsum small">${n ? `<b>${n.toLocaleString()}</b> file${n > 1 ? 's' : ''} · ${(total / 1048576).toFixed(1)} MB <button type="button" class="pill sm" data-act="clrmedia">Clear</button>` : '<span class="mut">No media yet.</span>'}</div></div>
  <div class="fcard ldup"><div class="gh">2. Metadata CSV</div><p class="mut small">One row per token: <span class="mono">${CSV_BASE.join(', ')}</span>, plus one <span class="mono">attributes[Trait]</span> column per trait. <button type="button" class="pill sm" data-act="csvtpl">Download CSV template</button></p>
   <span class="fpick"><input type="file" class="fin" data-mcsv accept=".csv,text/csv"><span class="upbtn">Upload CSV</span><span class="fname mut small">${esc(media.csvName || 'No file chosen')}</span></span>
   ${media.csvErr ? `<p class="err small">${esc(media.csvErr)}</p>` : ''}
   ${media.rows.length ? `<div class="lmsum small"><b>${media.rows.length.toLocaleString()}</b> rows · ${bad.length ? `<span class="err">${bad.length} with errors</span>` : '<span class="ok">all rows match a file ✓</span>'}${supply && supply !== media.rows.length ? ` · <span class="mut">supply is ${supply.toLocaleString()} (set in step 3)</span>` : ''}${unused.length ? ` · <span class="err">${unused.length} file${unused.length > 1 ? 's' : ''} not in CSV</span>` : ''}</div>
   <div class="gh pad small">Preview</div><div class="lmgrid">${sample.map(cell).join('')}</div>` : ''}</div>`;
}

let cid: Promise<any> | null = null;
const tw = () => (cid ??= Promise.all([import('thirdweb'), import('thirdweb/storage')]).then(([t, s]) => ({ client: t.createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID }), upload: s.upload })));
export const pinningReady = () => !!THIRDWEB_CLIENT_ID;
/** ERC-463N7 agent drops: the onchain renderer shows media file `<n><ext>` for the n-th gen-0 mint, so the CSV must be
 * tokenID 1..N (mint order) and every file an image with one shared extension. '' when OK. */
export const AGENT_IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
export const extOf = (n: string) => (n.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
export function agentMediaProblem(): string {
  const ids = media.rows.map(r => +r.tokenID).sort((a, b) => a - b);
  if (ids.some((v, i) => v !== i + 1)) return 'Agent drops: CSV tokenID must run 1, 2, 3… N (token N = the N-th agent minted).';
  const exts = new Set(media.rows.map(r => extOf(r.file_name)));
  if ([...exts].some(e => !AGENT_IMG_EXT.test(e))) return 'Agent drops: media must be images (png, jpg, gif, webp, svg); the token image is rendered onchain.';
  if (exts.size > 1) return `Agent drops: use one file type for all media (found ${[...exts].join(', ')}).`;
  return '';
}
/** Set by pinAll({ agent: true }): folder of `<tokenID><ext>` for AgentInit.kit (mediaBase + n + mediaExt). */
export const agentPin = { mediaBase: '', mediaExt: '' };
/** Pins media, then tokenID.json metadata folder. Returns ipfs://CID/ (token N → baseURI + N.json). */
export async function pinAll(project: { description?: string; website?: string }, onStep: (s: string) => void, agent = false): Promise<string> {
  if (!pinningReady()) throw new Error('IPFS pinning is not configured on this site (thirdweb client id missing). Use "Advanced: I already have a base URI".');
  const { client, upload } = await tw();
  const ext = agent ? extOf(media.rows[0]?.file_name || '') : '';
  // agent: one file per token renamed <tokenID><ext> so the onchain renderer can derive it; else de-duplicated originals
  const files = agent ? media.rows.map(r => { const f = media.files.get(r.file_name)!; return new File([f], `${r.tokenID}${ext}`, { type: f.type }); })
    : media.rows.map(r => media.files.get(r.file_name)!).filter((f, i, a) => a.indexOf(f) === i);
  onStep(`Pinning ${files.length} media file${files.length > 1 ? 's' : ''} to IPFS…`);
  const mu: string[] = [].concat(await upload({ client, files }) as any);
  const uriOf = new Map(agent ? media.rows.map((r, i) => [r.file_name + '#' + r.tokenID, mu[i]]) : files.map((f, i) => [f.name, mu[i]]));
  if (agent) { const mb = mu[0].replace(/[^/]+$/, ''); if (!/^ipfs:\/\/\w+\/$/.test(mb)) throw new Error('Unexpected IPFS response: ' + mu[0]); agentPin.mediaBase = mb; agentPin.mediaExt = ext; }
  onStep(`Pinning ${media.rows.length} metadata files…`);
  const metas = media.rows.map(r => { const f = media.files.get(r.file_name)!; const u = uriOf.get(agent ? r.file_name + '#' + r.tokenID : f.name)!;
    const j: Record<string, unknown> = { name: r.name, description: r.description || project.description || '', image: u };
    if (isVid(f)) j.animation_url = u;
    if (r.external_url || project.website) j.external_url = r.external_url || project.website;
    if (r.attrs.length) j.attributes = r.attrs;
    return new File([JSON.stringify(j)], `${r.tokenID}.json`, { type: 'application/json' }); });
  const out: string[] = [].concat(await upload({ client, files: metas }) as any);
  const base = out[0].replace(/[^/]+$/, '');
  if (!/^ipfs:\/\/\w+\/$/.test(base)) throw new Error('Unexpected IPFS response: ' + out[0]);
  return base;
}

/** Delayed-reveal placeholder drop box (single file) + optional name/description. */
export function placeholderHtml(name: string, desc: string, coll: string) {
  const f = ph.file; const vid = f && /^video\//.test(f.type);
  const pv = f ? (vid ? `<video class="lmphpv" src="${ph.url}" muted loop playsinline autoplay></video>` : `<img class="lmphpv" src="${ph.url}" alt="">`) : '';
  return `<div class="fcard ldup"><div class="gh">Placeholder (shown until reveal)</div><p class="mut small">One image (png, jpg, gif, webp, svg) or video (mp4, webm). Every token shows it until you reveal.</p>
   <div class="lmph">${pv}<label class="lmdrop" data-drop="ph"><input type="file" class="fin" data-phfile accept="${PH_ACCEPT}"><b>${f ? 'Replace placeholder' : 'Drag &amp; drop placeholder here'}</b><span class="mut small">${f ? `${esc(f.name)} · ${(f.size / 1048576).toFixed(2)} MB` : 'or <u>browse files</u>'}</span></label></div>
   <label>Placeholder name <span class="mut small">optional</span><input data-k="phName" value="${esc(name)}" placeholder="${esc((coll || 'Collection') + ' (Unrevealed)')}"></label>
   <label>Placeholder description <span class="mut small">optional</span><textarea data-k="phDesc" rows="2" placeholder="Revealing soon.">${esc(desc)}</textarea></label></div>`;
}
/** Pins the placeholder media then a single placeholder JSON. Returns its ipfs://CID/placeholder.json (the contract returns it verbatim for every token). */
export async function pinPlaceholder(meta: { name: string; description: string }, onStep: (s: string) => void): Promise<string> {
  if (!pinningReady()) throw new Error('IPFS pinning is not configured on this site. Use "Advanced: I already have a placeholder URI".');
  const f = ph.file; if (!f) throw new Error('Add a placeholder image.');
  const { client, upload } = await tw();
  onStep('Pinning placeholder to IPFS…');
  const u: string = [].concat(await upload({ client, files: [f] }) as any)[0] as any;
  const j: Record<string, unknown> = { name: meta.name, description: meta.description, image: u };
  if (/^video\//.test(f.type) || /\.(mp4|webm)$/i.test(f.name)) j.animation_url = u;
  const out: string = [].concat(await upload({ client, files: [new File([JSON.stringify(j)], 'placeholder.json', { type: 'application/json' })] }) as any)[0] as any;
  if (!/^ipfs:\/\/\w+\/placeholder\.json$/.test(out)) throw new Error('Unexpected IPFS response: ' + out);
  return out;
}

/** ERC-463N7 death image: one image shown for dead / burned agents instead of the onchain tombstone. */
export const DEATH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg';
export const DEATH_RE = /^(ipfs:\/\/[A-Za-z0-9]+\/[\w\-.%]+|https:\/\/[\w\-./%]+)\.(png|jpe?g|gif|webp|svg)$/i;
export const death = { file: null as File | null, url: '' };
export function setDeath(f: File | null): string {
  if (f && !AGENT_IMG_EXT.test(f.name)) return 'Death image: png, jpg, gif, webp or svg only.';
  if (f && f.size > 20 * 1048576) return 'Death image: 20 MB max.';
  if (death.url) URL.revokeObjectURL(death.url); death.file = f; death.url = f ? URL.createObjectURL(f) : ''; return '';
}
/** Same picture as AgentRenderer's onchain tombstone (dead agent, no custom image). */
export function tombstoneSvg(id = 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 350" font-family="monospace"><rect width="100%" height="100%" fill="#0b0b12"/><path d="M115 260 V140 a60 60 0 0 1 120 0 V260 Z" fill="#2a2a2a" stroke="#777" stroke-width="3"/><text x="175" y="175" text-anchor="middle" font-size="28" fill="#999">RIP</text><text x="20" y="30" font-size="16" fill="#fff">ERC-463N7 #${id}</text><text x="20" y="300" font-size="13" fill="#ccc">Dead | gen 0 | Common</text><text x="20" y="325" font-size="13" fill="#ccc">score 0</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
export function deathHtml(pinned: string) {
  const f = death.file; const cur = f ? `<img class="lmphpv" src="${death.url}" alt="">` : pinned ? `<img class="lmphpv" src="${esc(pinned.replace(/^ipfs:\/\//, 'https://gateway.pinata.cloud/ipfs/'))}" alt="">` : '';
  return `<div class="fcard ldup lddeath"><div class="gh">🪦 Death image <span class="mut small">optional</span></div><p class="mut small">Shown for agents that die (starved or killed) or are burned, instead of the default tombstone. One image: png, jpg, gif, webp or svg. Fixed once the first agent is minted.</p>
   <div class="lddeathcmp"><figure><img class="lmphpv" src="${tombstoneSvg()}" alt="Default tombstone"><figcaption class="mut small">Default (onchain)</figcaption></figure>
   <figure>${cur || '<div class="lmphpv lddeathnone mut small">Your image</div>'}<figcaption class="mut small">${f ? esc(f.name) : pinned ? 'Pinned' : 'Yours'}</figcaption></figure></div>
   <label class="lmdrop" data-drop="death"><input type="file" class="fin" data-deathfile accept="${DEATH_ACCEPT}"><b>${f || pinned ? 'Replace death image' : 'Drag &amp; drop death image here'}</b><span class="mut small">${f ? `${esc(f.name)} · ${(f.size / 1048576).toFixed(2)} MB` : pinned ? `<span class="mono">${esc(pinned)}</span>` : 'or <u>browse files</u>'}</span></label>
   ${f || pinned ? '<button type="button" class="pill sm" data-act="deathclear">Use default tombstone</button>' : ''}</div>`;
}
/** Pins the death image as a direct image: ipfs://CID/death.<ext>. */
export async function pinDeath(onStep: (s: string) => void): Promise<string> {
  if (!pinningReady()) throw new Error('IPFS pinning is not configured on this site. Use "Advanced: I already have a death image URI".');
  const f = death.file; if (!f) throw new Error('Add a death image.');
  const { client, upload } = await tw();
  onStep('Pinning death image to IPFS…');
  const out: string = [].concat(await upload({ client, files: [new File([f], 'death' + extOf(f.name), { type: f.type })] }) as any)[0] as any;
  if (!DEATH_RE.test(out) || !/\/death\.\w+$/.test(out)) throw new Error('Unexpected IPFS response: ' + out);
  return out;
}
