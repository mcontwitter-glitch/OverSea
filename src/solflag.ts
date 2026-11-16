// Solana switch with no heavy dependencies (safe to import from any page). Solana stays shown-but-greyed-out until MC signs
// "Turn Solana on" on /deploy-solana and the MultiSea Worker verifies the program and every chain on-chain; the Worker then
// answers GET /launchpad/solana with the program id. (A local / devnet build can still pin VITE_SOLANA_OMNI_ID.)
// SOLANA_ID / SOLANA_ON are live bindings: pages re-render on onSolanaFlag().
import LP from '../config/launchpad.json';
import APP from '../config/app.json';
const PINNED: string = (import.meta as any).env?.VITE_SOLANA_OMNI_ID || (LP as any).solana?.programId || '';
const API: string = ((import.meta as any).env?.VITE_API_BASE as string) || (APP as any).apiBase || '';
const CK = 'msea-solana-v1';
const cached = (): string => { try { return JSON.parse(localStorage.getItem(CK) || 'null')?.programId || ''; } catch { return ''; } };
export let SOLANA_ID: string = PINNED || cached();
export let SOLANA_ON = !!SOLANA_ID;
export const SOL_MAX_QTY = 8;
const EV = 'msea-solana';
export const onSolanaFlag = (f: () => void) => window.addEventListener(EV, f);
function set(id: string) { if (id === SOLANA_ID) return; SOLANA_ID = id; SOLANA_ON = !!id; window.dispatchEvent(new Event(EV)); }
/** Resolves once the Worker answered (or failed: then the last verified answer cached in this browser stays). */
export const solanaReady: Promise<void> = PINNED || !API || typeof fetch === 'undefined' ? Promise.resolve() : fetch(API + '/launchpad/solana', { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null)).then(j => { if (!j) return; const id = j.on && typeof j.programId === 'string' ? j.programId : '';
    try { id ? localStorage.setItem(CK, JSON.stringify({ programId: id })) : localStorage.removeItem(CK); } catch {} set(id); }).catch(() => {});
// Solana is SHOWN everywhere the other chains are; until it is switched on its actions are disabled with this note.
export const SOL_SOON = 'Solana: available after program deploy';
export const solSoonChip = (cls = 'ldch') => `<button type="button" class="${cls} solsoon" disabled title="${SOL_SOON}"><img class="cl" src="/logos/solana.svg" alt=""><span><b>Solana</b><em>available after program deploy</em></span></button>`;
