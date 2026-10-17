// Sign in with X / Google -> auto-created embedded wallet (thirdweb in-app wallet, no seed phrase).
// Loaded lazily only when VITE_THIRDWEB_CLIENT_ID is set and the user picks a social login.
// Exposed as a multichain EIP-1193 provider, so every existing flow (SIWE, Seaport, Relay) works unchanged.
import CFG from '../config/collections.json';
export const THIRDWEB_CLIENT_ID = (import.meta.env.VITE_THIRDWEB_CLIENT_ID as string) || '';
export const embeddedConfigured = !!THIRDWEB_CLIENT_ID;
export type Social = 'google' | 'x';
const chains = CFG.chains as Record<string, { chainId: number; rpc: string; name: string }>;
const rpcFor = (id: number) => Object.values(chains).find(c => c.chainId === id)?.rpc;

let ctx: { tw: any; w: any; client: any; wallet: any } | null = null;
async function load() {
  if (ctx) return ctx;
  if (!embeddedConfigured) throw Object.assign(new Error('Social sign-in needs setup: the site admin must add VITE_THIRDWEB_CLIENT_ID.'), { kind: 'setup' });
  const [tw, w] = await Promise.all([import('thirdweb'), import('thirdweb/wallets')]);
  const client = tw.createThirdwebClient({ clientId: THIRDWEB_CLIENT_ID });
  const wallet = w.inAppWallet({ auth: { options: ['google', 'x'], mode: 'popup' }, metadata: { name: 'MultiSea' } as any });
  return (ctx = { tw, w, client, wallet });
}

/** EIP-1193 provider over the thirdweb account that can switch between all MultiSea chains. */
function provider(c: NonNullable<typeof ctx>) {
  let chainId = 1; const L: Record<string, ((x: any) => void)[]> = {};
  const emit = (ev: string, x: any) => (L[ev] || []).forEach(f => { try { f(x); } catch {} });
  const twChain = (id: number) => c.tw.defineChain(rpcFor(id) ? { id, rpc: rpcFor(id) } : id);
  const acct = () => { const a = c.wallet.getAccount(); if (!a) throw Object.assign(new Error('Embedded wallet signed out'), { code: 4100 }); return a; };
  return {
    isMultiSeaEmbedded: true,
    on: (ev: string, f: any) => { (L[ev] ??= []).push(f); },
    removeListener: (ev: string, f: any) => { L[ev] = (L[ev] || []).filter(x => x !== f); },
    async request({ method, params = [] }: { method: string; params?: any[] }) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [acct().address];
        case 'eth_chainId': return '0x' + chainId.toString(16);
        case 'wallet_switchEthereumChain': { const id = parseInt(params[0].chainId, 16); if (!rpcFor(id)) throw Object.assign(new Error('Unsupported chain'), { code: 4902 }); chainId = id; emit('chainChanged', params[0].chainId); return null; }
        case 'wallet_addEthereumChain': { const id = parseInt(params[0].chainId, 16); if (rpcFor(id)) return null; throw Object.assign(new Error('Unsupported chain'), { code: 4902 }); }
        case 'personal_sign': return acct().signMessage({ message: { raw: params[0] } });
        case 'eth_signTypedData_v4': return acct().signTypedData(typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]);
        case 'eth_sendTransaction': {
          const t = params[0];
          const tx = c.tw.prepareTransaction({ chain: twChain(chainId), client: c.client, to: t.to, data: t.data || '0x', value: t.value ? BigInt(t.value) : 0n, ...(t.gas ? { gas: BigInt(t.gas) } : {}) });
          const r = await c.tw.sendTransaction({ account: acct(), transaction: tx }); return r.transactionHash;
        }
        default: return c.tw.getRpcClient({ client: c.client, chain: twChain(chainId) })({ method, params });
      }
    },
  };
}

export async function connectSocial(strategy: Social) {
  const c = await load();
  const account = await c.wallet.connect({ client: c.client, strategy });
  return { address: account.address as string, provider: provider(c), name: strategy === 'x' ? 'X account (embedded)' : 'Google (embedded)' };
}
/** Silent restore after a page navigation (thirdweb keeps the session in localStorage). */
export async function restoreSocial() {
  const c = await load();
  const account = await c.wallet.autoConnect({ client: c.client }).catch(() => null);
  return account ? { address: account.address as string, provider: provider(c), name: 'Embedded wallet' } : null;
}
export async function logoutSocial() { try { await ctx?.wallet.disconnect(); } catch {} }
