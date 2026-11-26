// Helpers for wallet authorization (EIP-1193 4100) and chain add/switch.
// No DOM or MultiSea wallet state: claim and other signers call these, then send from the returned EOA.
const UNAUTH = /requested method and\/or account has not been authorized by the user/i;
const REJECTED = /user rejected|user denied|rejected the request|rejected in wallet/i;

export function unauthorized(e: any): boolean {
  for (let c = e, i = 0; c && i < 8; c = c.cause ?? c.error, i++) {
    const code = Number(c?.code ?? c?.data?.code);
    const m = String(c?.shortMessage || c?.message || c?.data?.message || c || '');
    if (code === 4100 || UNAUTH.test(m)) return true;
  }
  return false;
}
export const authHint = (chainName?: string) =>
  chainName
    ? `Approve this site for your wallet account and ${chainName} network, then try again`
    : 'Approve this site for your wallet account and this network, then try again';

export function chainIdOf(v: any): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  const s = String(v ?? '');
  if (!s) return NaN;
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}
const rejected = (e: any) => e?.code === 4001 || e?.cause?.code === 4001 || REJECTED.test(String(e?.shortMessage || e?.message || ''));

/** Prompt for accounts; on 4100, request permissions and try again. Returns the authorized address (lowercase-preserving from the wallet). */
export async function unlockAccount(provider: any): Promise<string> {
  if (!provider?.request) throw new Error('Connect your wallet first.');
  const ask = async () => {
    const a = await provider.request({ method: 'eth_requestAccounts' });
    return Array.isArray(a) ? a.map(String) : [];
  };
  try {
    const a = await ask();
    if (a[0]) return a[0];
  } catch (e: any) {
    if (rejected(e)) throw e;
    if (!unauthorized(e)) throw e;
  }
  try { await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
  catch (e: any) { if (rejected(e)) throw e; }
  const a = await ask();
  if (!a[0]) throw new Error('Connect your wallet first.');
  return a[0];
}

export type ChainAdd = { chainId: number; name: string; native: string; rpc: string; explorer: string };

/** Switch to the chain; if it is missing or not authorized (4100 / 4902), add it, then switch. */
export async function switchOrAddChain(provider: any, c: ChainAdd): Promise<void> {
  if (!provider?.request) throw new Error('Connect your wallet first.');
  const hex = '0x' + c.chainId.toString(16);
  const readId = async () => chainIdOf(await provider.request({ method: 'eth_chainId' }));
  const add = () => provider.request({
    method: 'wallet_addEthereumChain',
    params: [{ chainId: hex, chainName: c.name, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] }],
  });
  const switchTo = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  const missing = (e: any) => e?.code === 4902 || unauthorized(e) || /unrecognized|not added|unknown chain/i.test(String(e?.shortMessage || e?.message || ''));
  try { if (await readId() === c.chainId) return; }
  catch (e: any) { if (!unauthorized(e) && !missing(e)) throw e; }
  try { await switchTo(); }
  catch (e: any) {
    if (rejected(e)) throw e;
    if (!missing(e)) throw e;
    try { await add(); }
    catch (e2: any) {
      if (rejected(e2)) throw e2;
      if (unauthorized(e2)) {
        try { await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); } catch {}
        await add();
      } else throw e2;
    }
    if (await readId() !== c.chainId) {
      try { await switchTo(); } catch (e3: any) { if (rejected(e3)) throw e3; }
    }
  }
  if (await readId() !== c.chainId) throw Object.assign(new Error(`Please switch your wallet to ${c.name}.`), { kind: 'wrong-chain' });
}
