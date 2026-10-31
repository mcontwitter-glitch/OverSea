// Bitcoin wallet connectors: Xverse, UniSat, Leather, OKX, Magic Eden. Injected providers only (desktop extensions and the
// wallets' in-app mobile browsers): no QR codes. Phantom is intentionally not offered.
import type { Net } from './data';
export type WalletId = 'xverse' | 'unisat' | 'leather' | 'okx' | 'magiceden';
export type Acct = { wallet: WalletId; ordAddress: string; ordPubkey: string; payAddress: string; payPubkey: string; net: Net };
export type SignReq = { address: string; index: number }[];
type W = any;
const w = () => window as W;
const req = async (p: any, method: string, params?: any) => { const r = await p.request(method, params); if (r?.error) throw new Error(r.error.message || 'wallet error'); return r?.result ?? r; };
const satsNet = (n: Net) => ({ type: n === 'mainnet' ? 'Mainnet' : n === 'signet' ? 'Signet' : 'Testnet' });
const b64url = (o: any) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (o: any) => b64url({ typ: 'JWT', alg: 'none' }) + '.' + b64url(o) + '.'; // Magic Eden's sats-connect v1 transport (unsecured JWT)
const toHex = (b64: string) => Array.from(atob(b64), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const toB64 = (hex: string) => btoa(hex.match(/../g)!.map(h => String.fromCharCode(parseInt(h, 16))).join(''));
const group = (r: SignReq) => r.reduce((a: Record<string, number[]>, x) => ((a[x.address] ||= []).push(x.index), a), {});
function pick(list: any[], purpose: string) { return list.find(a => a.purpose === purpose) || list.find(a => (purpose === 'ordinals' ? a.addressType === 'p2tr' : a.addressType !== 'p2tr')); }

export type Prov = { id: WalletId; name: string; icon: string; detect: () => boolean; nets: Net[]; install: string; mobile?: (url: string) => string;
  connect: (n: Net) => Promise<Acct>; signMessage: (a: Acct, address: string, msg: string) => Promise<string>; signPsbt: (a: Acct, b64: string, r: SignReq, sighash?: number) => Promise<string> };
export const PROVIDERS: Prov[] = [
  { id: 'xverse', name: 'Xverse', icon: '/logos/w-xverse.svg', nets: ['mainnet', 'signet', 'testnet'], install: 'https://www.xverse.app/download',
    mobile: u => `https://connect.xverse.app/browser?url=${encodeURIComponent(u)}`,
    detect: () => !!w().XverseProviders?.BitcoinProvider,
    async connect(n) { const p = w().XverseProviders.BitcoinProvider; const r = await req(p, 'getAccounts', { purposes: ['ordinals', 'payment'], message: 'Connect to MultiSea' });
      const l = Array.isArray(r) ? r : r.addresses || []; const o = pick(l, 'ordinals'), y = pick(l, 'payment');
      if (!o) throw new Error('Xverse returned no ordinals address');
      return { wallet: 'xverse', ordAddress: o.address, ordPubkey: o.publicKey, payAddress: (y || o).address, payPubkey: (y || o).publicKey, net: n }; },
    async signMessage(_a, address, message) { const r = await req(w().XverseProviders.BitcoinProvider, 'signMessage', { address, message, protocol: 'BIP322' }); return r.signature; },
    async signPsbt(_a, psbt, r) { const x = await req(w().XverseProviders.BitcoinProvider, 'signPsbt', { psbt, signInputs: group(r), broadcast: false }); return x.psbt; } },
  { id: 'unisat', name: 'UniSat', icon: '/logos/w-unisat.svg', nets: ['mainnet', 'signet', 'testnet'], install: 'https://unisat.io/download',
    mobile: u => `unisat://request?method=dappbrowser&url=${encodeURIComponent(u)}`,
    detect: () => !!w().unisat,
    async connect(n) { const u = w().unisat; const chain = { mainnet: 'BITCOIN_MAINNET', signet: 'BITCOIN_SIGNET', testnet: 'BITCOIN_TESTNET' }[n];
      try { if (u.switchChain) await u.switchChain(chain); else await u.switchNetwork(n === 'mainnet' ? 'livenet' : 'testnet'); } catch {}
      const [addr] = await u.requestAccounts(); const pk = await u.getPublicKey(); return { wallet: 'unisat', ordAddress: addr, ordPubkey: pk, payAddress: addr, payPubkey: pk, net: n }; },
    signMessage: (_a, _addr, m) => w().unisat.signMessage(m, 'bip322-simple'),
    async signPsbt(_a, b64, r, sighash) { const h = await w().unisat.signPsbt(toHex(b64), { autoFinalized: false, toSignInputs: r.map(x => ({ index: x.index, address: x.address, ...(sighash ? { sighashTypes: [sighash] } : {}) })) }); return toB64(h); } },
  { id: 'leather', name: 'Leather', icon: '/logos/w-leather.svg', nets: ['mainnet', 'signet', 'testnet'], install: 'https://leather.io/install-extension',
    detect: () => !!w().LeatherProvider,
    async connect(n) { const r = await req(w().LeatherProvider, 'getAddresses'); const l = (r.addresses || []).filter((a: any) => a.symbol === 'BTC');
      const o = l.find((a: any) => a.type === 'p2tr'), y = l.find((a: any) => a.type === 'p2wpkh'); if (!o || !y) throw new Error('Leather returned no BTC addresses');
      return { wallet: 'leather', ordAddress: o.address, ordPubkey: o.publicKey, payAddress: y.address, payPubkey: y.publicKey, net: n }; },
    async signMessage(a, address, message) { const r = await req(w().LeatherProvider, 'signMessage', { message, paymentType: address === a.ordAddress ? 'p2tr' : 'p2wpkh', network: a.net }); return r.signature; },
    async signPsbt(a, b64, r) { const x = await req(w().LeatherProvider, 'signPsbt', { hex: toHex(b64), signAtIndex: r.map(i => i.index), network: a.net, broadcast: false }); return toB64(x.hex); } },
  { id: 'okx', name: 'OKX Wallet', icon: '/logos/w-okx.svg', nets: ['mainnet', 'signet', 'testnet'], install: 'https://www.okx.com/web3',
    mobile: u => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(u)}`,
    detect: () => !!w().okxwallet?.bitcoin,
    async connect(n) { const o = w().okxwallet; const p = n === 'mainnet' ? o.bitcoin : n === 'signet' ? o.bitcoinSignet : o.bitcoinTestnet; if (!p) throw new Error(`OKX Wallet has no ${n} provider`);
      const r = await p.connect(); return { wallet: 'okx', ordAddress: r.address, ordPubkey: r.publicKey || r.compressedPublicKey, payAddress: r.address, payPubkey: r.publicKey || r.compressedPublicKey, net: n }; },
    signMessage: (a, _addr, m) => okx(a.net).signMessage(m, 'bip322-simple'),
    async signPsbt(a, b64, r, sighash) { const h = await okx(a.net).signPsbt(toHex(b64), { autoFinalized: false, toSignInputs: r.map(x => ({ index: x.index, address: x.address, ...(sighash ? { sighashTypes: [sighash] } : {}) })) }); return toB64(h); } },
  { id: 'magiceden', name: 'Magic Eden', icon: '/logos/w-magiceden.svg', nets: ['mainnet'], install: 'https://wallet.magiceden.io/download',
    detect: () => !!w().magicEden?.bitcoin,
    async connect(n) { const r = await w().magicEden.bitcoin.connect(jwt({ purposes: ['ordinals', 'payment'], message: 'Connect to MultiSea', network: satsNet(n) }));
      const l = r.addresses || r; const o = pick(l, 'ordinals'), y = pick(l, 'payment');
      return { wallet: 'magiceden', ordAddress: o.address, ordPubkey: o.publicKey, payAddress: (y || o).address, payPubkey: (y || o).publicKey, net: n }; },
    async signMessage(a, address, message) { const r = await w().magicEden.bitcoin.signMessage(jwt({ address, message, protocol: 'BIP322', network: satsNet(a.net) })); return r.signature || r; },
    async signPsbt(a, psbtBase64, r, sighash) { const x = await w().magicEden.bitcoin.signTransaction(jwt({ psbtBase64, broadcast: false, network: satsNet(a.net), inputsToSign: Object.entries(group(r)).map(([address, signingIndexes]) => ({ address, signingIndexes, ...(sighash ? { sigHash: sighash } : {}) })) })); return x.psbtBase64 || x.psbt; } },
];
const okx = (n: Net) => { const o = w().okxwallet; return n === 'mainnet' ? o.bitcoin : n === 'signet' ? o.bitcoinSignet : o.bitcoinTestnet; };
export const prov = (id: WalletId) => PROVIDERS.find(p => p.id === id)!;

// ---- session ----
const SK = 'multisea-btc-acct';
export const btc = { acct: null as Acct | null, verified: '' as '' | 'worker' | 'local' };
const ls: (() => void)[] = [];
export const onBtc = (f: () => void) => ls.push(f);
const emit = () => ls.forEach(f => f());
try { const s = JSON.parse(localStorage.getItem(SK) || 'null'); if (s?.acct) { btc.acct = s.acct; btc.verified = s.verified || ''; } } catch {}
export function setAcct(a: Acct | null, verified: '' | 'worker' | 'local' = '') { btc.acct = a; btc.verified = verified; if (a) localStorage.setItem(SK, JSON.stringify({ acct: a, verified })); else localStorage.removeItem(SK); emit(); }
