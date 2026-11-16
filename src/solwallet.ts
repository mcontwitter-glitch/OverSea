// Solana wallet (Phantom / Solflare) next to the thirdweb EVM connect. Used only by Solana drops (src/solui.ts), which stay
// hidden until the mainnet program exists (config/launchpad.json solana.programId).
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';
import LP from '../config/launchpad.json';
import { addBroadcast } from './soltx';

import { sol, onSol, connectSolWallet, disconnectSolWallet, solWalletOptions, type SolProv } from './solconnect';
type Prov = SolProv;
// Wallet choice and connection live in src/solconnect.ts (shared with the connect window, nav and profile); this mirrors it
// as a web3.js PublicKey for the transaction code.
export const SOL_WALLETS = [
  { id: 'phantom', name: 'Phantom', url: 'https://phantom.app/' },
  { id: 'solflare', name: 'Solflare', url: 'https://solflare.com/' },
];
export const SOL_RPC: string = (import.meta as any).env?.VITE_SOLANA_RPC || (LP as any).solana?.rpc || 'https://api.mainnet-beta.solana.com';
/** The public RPC (publicnode) answers at most 10 accounts per getMultipleAccounts ("403: A maximum of 10 accounts is allowed"):
 *  split bigger reads. Patched on the connection itself so the LayerZero SDK's reads through it are split too. */
export function chunkMulti<T extends Connection>(c: T, max = 10): T {
  const orig = c.getMultipleAccountsInfoAndContext.bind(c);
  (c as any).getMultipleAccountsInfoAndContext = async (keys: PublicKey[], cfg?: any) => {
    if (keys.length <= max) return orig(keys, cfg);
    const parts: PublicKey[][] = []; for (let i = 0; i < keys.length; i += max) parts.push(keys.slice(i, i + max));
    const rs = await Promise.all(parts.map(p => orig(p, cfg)));
    return { context: rs[0].context, value: rs.flatMap(r => r.value) };
  };
  return c;
}
export const solConn = chunkMulti(new Connection(SOL_RPC, 'confirmed'));
// Second broadcast RPC for signed transactions (public, browser-friendly); not used for reads or on a test validator.
export const SOL_SEND_RPC = (import.meta as any).env?.VITE_SOLANA_RPC ? '' : 'https://solana.leorpc.com/?api_key=FREE';
if (SOL_SEND_RPC) addBroadcast(new Connection(SOL_SEND_RPC, 'confirmed'));
export const solWallet: { id: string; name: string; pubkey: PublicKey | null; prov: Prov | null } = { id: '', name: '', pubkey: null, prov: null };
const subs: (() => void)[] = [];
export const onSolWallet = (f: () => void) => { subs.push(f); };
const sync = () => { Object.assign(solWallet, sol.address ? { id: sol.id, name: sol.name, pubkey: new PublicKey(sol.address), prov: sol.prov } : { id: '', name: '', pubkey: null, prov: null }); subs.forEach(f => f()); };
onSol(sync); if (sol.address) sync();

export async function connectSol(id: string) { await connectSolWallet(id); return solWallet.pubkey!; }
export async function disconnectSol() { await disconnectSolWallet(); }
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const solConnectHtml = () => solWallet.pubkey
  ? `<span class="mono small">${solWallet.name}: ${short(solWallet.pubkey.toBase58())}</span> <button type="button" class="obtn sm" data-solact="disconnect">Disconnect</button>`
  : solWalletOptions().map(w => `<button type="button" class="obtn sm" data-solact="connect" data-solw="${w.id.replace(/"/g, '&quot;')}" style="margin:2px 4px 2px 0">${w.name.replace(/</g, '&lt;')}</button>`).join('');
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
