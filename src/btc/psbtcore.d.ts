export const SIGHASH_SINGLE_ACP: number; export const DUST: number; export const DUMMY: number; export const DUMMY_MAX: number;
export function makeBtc(bitcoin: any, ecc: any): any;
export function parseSatpoint(sp: string): { txid: string; vout: number; offset: number } | null;
export function inscriptionTradable(ins: any): { ok: boolean; why?: string; txid?: string; vout?: number; offset?: number };
