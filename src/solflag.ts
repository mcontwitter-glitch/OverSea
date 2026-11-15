// Solana switch with no dependencies (safe to import from any page). Solana stays hidden until the mainnet MultiSea
// program exists: config/launchpad.json solana.programId (or VITE_SOLANA_OMNI_ID in a local / devnet build).
import LP from '../config/launchpad.json';
export const SOLANA_ID: string = (import.meta as any).env?.VITE_SOLANA_OMNI_ID || (LP as any).solana?.programId || '';
export const SOLANA_ON = !!SOLANA_ID;
export const SOL_MAX_QTY = 8;
