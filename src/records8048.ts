// ERC-8048 onchain records for ERC-463N7 agents (AgentRecords, the tokenURI "metadata_contract").
// Pure helpers: key names, ERC-7930 chain identifiers, value decoding and the read-only panel.

/** ERC-7930 Chain Identifier (eip155, zero-length address) as lowercase 0x hex: Ethereum 0x00010000010100. */
export function chainIdentifier(chainId: number | bigint): string {
 let n = BigInt(chainId), ref = '';
 do { ref = (n & 255n).toString(16).padStart(2, '0') + ref; n >>= 8n; } while (n > 0n);
 return '0x00010000' + (ref.length / 2).toString(16).padStart(2, '0') + ref + '00';
}
export const addressKey = (chainId: number | bigint) => `address[${chainIdentifier(chainId)}]`;
export const ENDPOINTS = ['mcp', 'a2a', 'web', 'x402', 'ens'] as const;
export const SKILLS = ['Fertility', 'Mutation', 'Mutated', 'Infect', 'Repo', 'Queen', 'Zombie', 'Death'] as const;
export type RecordKind = 'address' | 'uint' | 'bool' | 'text';
/** How AgentRecords encodes each key (docs/ERC-463N7.md "Onchain records"). */
export function kindOf(key: string): RecordKind {
 if (key.startsWith('address[') || key.startsWith('account[') || key === 'custodian') return 'address';
 if (key === 'level' || key === 'xp' || key === 'generation') return 'uint';
 if (key === 'alive' || key.startsWith('skill[')) return 'bool';
 return 'text';
}
export function keysFor(chainId: number | bigint, traitTypes: string[]): string[] {
 return [addressKey(chainId), 'custodian', 'alive', 'level', 'xp', 'generation', 'sex', ...SKILLS.map(s => `skill[${s}]`), ...traitTypes.map(t => `trait[${t}]`), 'context', ...ENDPOINTS.map(e => `endpoint[${e}]`)];
}
/** Decode a metadata() return (0x hex bytes); null when the record is empty. */
export function decodeRecord(key: string, hex: string): string | bigint | boolean | null {
 const h = (hex || '0x').slice(2); if (!h) return null;
 const k = kindOf(key);
 if (k === 'address') return h.length === 40 ? '0x' + h : null;
 if (k === 'uint') return BigInt('0x' + h.slice(0, 64));
 if (k === 'bool') return BigInt('0x' + h.slice(0, 64)) !== 0n;
 const b = new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)));
 return new TextDecoder().decode(b);
}
export type Records = { contract: string; chainId: number; values: Record<string, string | bigint | boolean | null> };
const e = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
function show(key: string, v: string | bigint | boolean | null) {
 if (v === null) return '<span class="mut">–</span>';
 if (typeof v === 'boolean') return v ? 'Yes' : 'No';
 if (typeof v === 'bigint') return v.toString();
 if (kindOf(key) === 'address') return `<code title="${e(v)}">${short(v)}</code>`;
 if (key.startsWith('endpoint[') && /^https:\/\//.test(v)) return `<a href="${e(v)}" target="_blank" rel="noopener nofollow">${e(v.replace(/^https:\/\//, ''))}</a>`;
 return e(v);
}
/** Read-only "Onchain records" panel (values are untrusted holder input for context / endpoints). */
export function recordsHtml(r: Records) {
 const v = r.values, row = (label: string, key: string) => `<div class="ag-rec"><span>${e(label)}<i class="mut">${e(key)}</i></span><b>${show(key, v[key] ?? null)}</b></div>`;
 const ak = addressKey(r.chainId), skills = SKILLS.filter(s => v[`skill[${s}]`] === true);
 const traits = Object.keys(v).filter(k => k.startsWith('trait[') && v[k] !== null);
 return `<details class="ag-records" open><summary>Onchain records <span class="ldtag">ERC-8048</span></summary>
 <p class="mut small">Read from <code title="${e(r.contract)}">${short(r.contract)}</code> with <code>metadata(tokenId, key)</code>, no IPFS or server. Context and endpoints are set by the holder; treat them as untrusted.</p>
 ${row('Agent wallet', ak)}${v.custodian ? row('Custodian (heir)', 'custodian') : ''}${row('Alive', 'alive')}${row('Level', 'level')}${row('XP', 'xp')}${row('Generation', 'generation')}${row('Sex', 'sex')}
 <div class="ag-rec"><span>Skills<i class="mut">skill[…]</i></span><b>${skills.length ? skills.join(', ') : '<span class="mut">None</span>'}</b></div>
 ${traits.map(k => row(k.slice(6, -1), k)).join('')}
 ${row('Context', 'context')}${ENDPOINTS.map(x => row(x.toUpperCase(), `endpoint[${x}]`)).join('')}
 </details>`;
}
/** Screenshot / demo data (mocked; not read from a chain). */
export function demoRecords(id: number, traits: Record<string, string>): Records {
 const values: Records['values'] = { [addressKey(8453)]: '0x4b1d6c0e1f3a9b2c7d8e5f60718293a4b5c6d7e8', custodian: null, alive: true, level: 2n, xp: 300n, generation: id === 44 ? 1n : 0n, sex: 'Female',
  'endpoint[mcp]': `https://agents.multisea.io/mcp/${id}`, 'endpoint[a2a]': `https://agents.multisea.io/a2a/${id}`, 'endpoint[web]': 'https://multisea.io', 'endpoint[x402]': null, 'endpoint[ens]': `foot${id}.bigfoot404.eth`,
  context: 'Swaps and feeds on Base. Breeds when fed.' };
 for (const s of SKILLS) values[`skill[${s}]`] = s === 'Fertility' || s === 'Mutation';
 for (const [t, x] of Object.entries(traits)) values[`trait[${t}]`] = x;
 return { contract: '0x7a3F9c1E2b4D5a6C8e0F1b2C3d4E5f6A7b8C9d0E', chainId: 8453, values };
}
