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
  // Mobile browsers block popups opened after an await, so use a full-page redirect there (restored by restoreSocial on return).
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const auth = mobile ? { options: ['google', 'x'], mode: 'redirect', redirectUrl: location.href.split('#')[0] } : { options: ['google', 'x'], mode: 'popup' };
  const wallet = w.inAppWallet({ auth: auth as any, metadata: { name: 'MultiSea' } as any });
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
          // Abstract (zkSync stack): with gas + fees set, thirdweb skips its own estimate, which doubles both gas and fee and can exceed a just-bridged balance.
          let fees = {};
          if (t.gas && chainId === 2741) { const gp = BigInt(await c.tw.getRpcClient({ client: c.client, chain: twChain(chainId) })({ method: 'eth_gasPrice', params: [] })); fees = { maxFeePerGas: (gp * 12n) / 10n, maxPriorityFeePerGas: 0n }; }
          const tx = c.tw.prepareTransaction({ chain: twChain(chainId), client: c.client, to: t.to, data: t.data || '0x', value: t.value ? BigInt(t.value) : 0n, ...(t.gas ? { gas: BigInt(t.gas) } : {}), ...fees });
          const r = await c.tw.sendTransaction({ account: acct(), transaction: tx }); return r.transactionHash;
        }
        default: return c.tw.getRpcClient({ client: c.client, chain: twChain(chainId) })({ method, params });
      }
    },
  };
}

/** Warm the SDK when the modal opens so the popup opens within the click's user activation. */
export function preloadSocial() { load().catch(() => {}); }
export async function connectSocial(strategy: Social) {
  const c = await load();
  const account = await c.wallet.connect({ client: c.client, strategy });
  return { address: account.address as string, provider: provider(c), name: strategy === 'x' ? 'X account (embedded)' : 'Google (embedded)' };
}
/** True when thirdweb just redirected back here with a login result (mobile redirect mode). */
export const hasAuthReturn = () => /[?&#]authResult=|[?&]authCookie=/.test(location.search + location.hash);
/**
 * Restore after a page navigation. After a mobile *redirect* login the session only exists in the
 * URL (authResult + walletId + state): wallet.autoConnect() ignores it, so it must go through
 * thirdweb's top-level autoConnect, which reads the URL token, checks the one-time state, logs in
 * and strips the params. Normal reloads use the stored session via wallet.autoConnect().
 */
export async function restoreSocial() {
  const c = await load();
  if (hasAuthReturn()) {
    const ok = await c.w.autoConnect({ client: c.client, wallets: [c.wallet], timeout: 30000 });
    const a = c.wallet.getAccount();
    if (!ok || !a) throw new Error('Sign-in did not complete: the login result from thirdweb could not be used (it may have expired). Please try again.');
    return { address: a.address as string, provider: provider(c), name: 'Embedded wallet' };
  }
  const account = await c.wallet.autoConnect({ client: c.client }).catch(() => null);
  return account ? { address: account.address as string, provider: provider(c), name: 'Embedded wallet' } : null;
}
/**
 * Private-key export for the X/Google in-app wallet, using thirdweb's own export UI: the same hidden-key
 * iframe (embedded-wallet.thirdweb.com/.../export-private-key) that thirdweb's React ConnectButton
 * "Manage wallet > Export private key" screen uses. The key is decrypted and shown ONLY inside that
 * cross-origin iframe; MultiSea never receives it. We only answer the iframe's ready event with the
 * user's existing thirdweb session token, posted to thirdweb's origin only (exactly like the SDK does).
 */
export const EXPORT_ORIGIN = 'https://embedded-wallet.thirdweb.com';
export function mountKeyExport(host: HTMLElement, onError: (m: string) => void) {
  const id = 'tw-export-' + Math.random().toString(36).slice(2);
  const f = document.createElement('iframe');
  f.id = id; f.title = 'Export in-app wallet (thirdweb)'; f.allow = 'clipboard-read; clipboard-write';
  f.referrerPolicy = 'no-referrer';
  f.src = `${EXPORT_ORIGIN}/sdk/2022-08-12/embedded-wallet/export-private-key?clientId=${encodeURIComponent(THIRDWEB_CLIENT_ID)}&theme=dark`;
  f.style.cssText = 'width:100%;height:250px;border:0;border-radius:12px;background:#0b0b0b';
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== EXPORT_ORIGIN || e.source !== f.contentWindow || typeof e.data !== 'object' || e.data?.eventType !== 'exportPrivateKeyIframeLoaded') return;
    const token = localStorage.getItem(`walletToken-${THIRDWEB_CLIENT_ID}`); // thirdweb's session token (not the key)
    if (!token) { onError('Your sign-in session has expired. Sign out and sign in with X/Google again, then retry.'); return; }
    f.contentWindow!.postMessage({ authToken: token, eventType: 'initExportPrivateKey' }, EXPORT_ORIGIN);
  };
  window.addEventListener('message', onMsg);
  f.addEventListener('error', () => onError('Could not load thirdweb\'s export window. Check your connection or blockers.'));
  host.appendChild(f);
  return () => window.removeEventListener('message', onMsg);
}
export async function logoutSocial() { try { await ctx?.wallet.disconnect(); } catch {} }
