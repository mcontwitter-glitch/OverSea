// Solana wallet (Phantom / Solflare) next to the thirdweb EVM connect. Used only by Solana drops (src/solui.ts), which stay
// hidden until the mainnet program exists (config/launchpad.json solana.programId).
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';
import LP from '../config/launchpad.json';

type Prov = { publicKey?: { toBase58(): string } | null; connect(): Promise<unknown>; disconnect?(): Promise<void>; signTransaction(tx: Transaction): Promise<Transaction> };
const W = window as any;
export const SOL_WALLETS = [
  { id: 'phantom', name: 'Phantom', get: (): Prov | undefined => W.phantom?.solana, url: 'https://phantom.app/' },
  { id: 'solflare', name: 'Solflare', get: (): Prov | undefined => W.solflare, url: 'https://solflare.com/' },
];
export const SOL_RPC: string = (import.meta as any).env?.VITE_SOLANA_RPC || (LP as any).solana?.rpc || 'https://api.mainnet-beta.solana.com';
export const solConn = new Connection(SOL_RPC, 'confirmed');
export const solWallet: { id: string; name: string; pubkey: PublicKey | null; prov: Prov | null } = { id: '', name: '', pubkey: null, prov: null };
const subs: (() => void)[] = [];
export const onSolWallet = (f: () => void) => { subs.push(f); };

export async function connectSol(id: string) {
  const w = SOL_WALLETS.find(x => x.id === id); const p = w?.get();
  if (!w || !p) { window.open(w?.url || 'https://phantom.app/', '_blank', 'noopener'); throw new Error(`${w?.name || 'A Solana wallet'} is not installed in this browser.`); }
  await p.connect(); if (!p.publicKey) throw new Error('Wallet did not share an address.');
  Object.assign(solWallet, { id, name: w.name, pubkey: new PublicKey(p.publicKey.toBase58()), prov: p }); subs.forEach(f => f());
  return solWallet.pubkey!;
}
export async function disconnectSol() { await solWallet.prov?.disconnect?.().catch(() => {}); Object.assign(solWallet, { id: '', name: '', pubkey: null, prov: null }); subs.forEach(f => f()); }
export const solConnectHtml = () => solWallet.pubkey
  ? `<span class="mono small">${solWallet.name}: ${solWallet.pubkey.toBase58().slice(0, 4)}…${solWallet.pubkey.toBase58().slice(-4)}</span> <button type="button" class="obtn sm" data-solact="disconnect">Disconnect</button>`
  : SOL_WALLETS.map(w => `<button type="button" class="obtn sm" data-solact="connect" data-solw="${w.id}" style="margin:2px 4px 2px 0">${w.name}</button>`).join('');
/** Wire [data-solact] buttons inside `root` (connect / disconnect), then call `after`. */
export function bindSolConnect(root: HTMLElement, after: () => void, onErr: (m: string) => void) {
  root.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-solact]') as HTMLElement | null; if (!b) return; e.preventDefault();
    (b.dataset.solact === 'connect' ? connectSol(b.dataset.solw!) : disconnectSol()).then(after).catch(x => onErr(x?.message || String(x))); });
}
/** Sign with the connected wallet and send; resolves to the signature once confirmed. */
export async function sendSol(ixs: TransactionInstruction[], cu = 400_000): Promise<string> {
  if (!solWallet.pubkey || !solWallet.prov) throw new Error('Connect Phantom or Solflare first.');
  const { blockhash, lastValidBlockHeight } = await solConn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: solWallet.pubkey, blockhash, lastValidBlockHeight }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
  const signed = await solWallet.prov.signTransaction(tx);
  const sig = await solConn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const r = await solConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (r.value.err) throw new Error('Solana transaction failed: ' + JSON.stringify(r.value.err));
  return sig;
}
