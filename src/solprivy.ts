// Google / X sign-in that gives a Solana wallet: Privy embedded wallets (non-custodial, key material in Privy's iframe),
// loaded ONLY when VITE_PRIVY_APP_ID is set. EVM sign-in stays on thirdweb (src/embedded.ts), unchanged; this only adds a
// Solana address. Flow: privySolana('google' | 'twitter') redirects to the provider; back on the same page, the OAuth code in
// the URL is exchanged (completePrivyRedirect), the user's Solana embedded wallet is created once (createSolana) and its
// provider is wrapped into the site's Solana provider shape (signMessage / signTransaction / signAllTransactions).
import type { SolProv } from './solconnect';

const ENV = (import.meta as any).env || {};
const APP_ID: string = ENV.VITE_PRIVY_APP_ID || '';
const CLIENT_ID: string = ENV.VITE_PRIVY_CLIENT_ID || '';
const PENDING = 'msea-privy-pending';
let ctx: Promise<any> | null = null;

async function client() {
  if (!APP_ID) throw new Error('Google/X Solana sign-in is not configured (VITE_PRIVY_APP_ID).');
  return (ctx ??= (async () => {
    const P: any = await import('@privy-io/js-sdk-core');
    const Privy = P.default; const privy = new Privy({ appId: APP_ID, ...(CLIENT_ID ? { clientId: CLIENT_ID } : {}), storage: new P.LocalStorage() });
    await privy.initialize();
    const iframe = document.createElement('iframe'); iframe.src = privy.embeddedWallet.getURL(); iframe.style.display = 'none'; iframe.title = 'Privy wallet';
    const ready = new Promise<void>(r => { iframe.onload = () => r(); });
    document.body.appendChild(iframe); await ready;
    privy.setMessagePoster(iframe.contentWindow);
    window.addEventListener('message', e => { if (e.source !== iframe.contentWindow) return; try { privy.embeddedWallet.onMessage(typeof e.data === 'string' ? JSON.parse(e.data) : e.data); } catch {} });
    return { P, privy };
  })());
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function walletFor(user: any) {
  const { P, privy } = await client();
  let u = user; let acct = P.getUserEmbeddedSolanaWallet(u);
  if (!acct) { u = (await privy.embeddedWallet.createSolana()).user; acct = P.getUserEmbeddedSolanaWallet(u); }
  const { entropyId, entropyIdVerifier } = P.getEntropyDetailsFromUser(u);
  const provider = await privy.embeddedWallet.getSolanaProvider(acct, entropyId, entropyIdVerifier);
  const address: string = acct.address;
  const sig = (r: any) => (r?.signature instanceof Uint8Array ? r.signature : typeof r?.signature === 'string' ? unb64(r.signature) : r instanceof Uint8Array ? r : null);
  const signTx = async (tx: any) => { const r: any = await provider.request({ method: 'signTransaction', params: { transaction: tx } }); return r?.signedTransaction || r; };
  const prov: SolProv = {
    publicKey: { toBase58: () => address },
    async connect() {},
    signTransaction: signTx,
    async signAllTransactions(txs: any[]) { const out = []; for (const t of txs) out.push(await signTx(t)); return out; },
    async signMessage(m: Uint8Array) { const r: any = await provider.request({ method: 'signMessage', params: { message: b64(m) } }); const s = sig(r); if (!s) throw new Error('Privy returned no signature.'); return { signature: s }; },
  };
  return { address, prov, name: 'Google/X wallet' };
}
/** Signed in already (session restored): the wallet. Otherwise start the OAuth redirect (resolves never). */
export async function privySolana(provider?: 'google' | 'twitter') {
  const { privy } = await client();
  const { user } = await privy.user.get().catch(() => ({ user: null }));
  if (user) return walletFor(user);
  if (!provider) throw new Error('Not signed in.');
  sessionStorage.setItem(PENDING, location.pathname + location.search);
  location.assign(await privy.auth.oauth.generateURL(provider, location.origin + location.pathname));
  return new Promise<never>(() => {});
}
/** Back from Google/X: finish the login on this page. Returns the wallet, or null when the URL has no Privy code. */
export async function completePrivyRedirect() {
  const q = new URLSearchParams(location.search); const code = q.get('privy_oauth_code'), state = q.get('privy_oauth_state');
  if (!code || !state) return null;
  const { privy } = await client();
  const { user } = await privy.auth.oauth.loginWithCode(code, state);
  const back = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING);
  history.replaceState(null, '', back || location.pathname);
  return walletFor(user);
}
export async function privyLogout() { const { privy } = await client(); const { user } = await privy.user.get().catch(() => ({ user: null })); if (user) await privy.auth.logout({ userId: user.id }); }
