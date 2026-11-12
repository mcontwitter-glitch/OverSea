// Mainnet launchpad on-chain actions (config/launchpad.json). Every transaction is signed by the visitor's own wallet:
//  - approver (/admin): signs EIP-712 deploy approvals only (eth_signTypedData_v4, no transaction, no nonce change)
//  - creator (/launchpad/<slug>): createDrop / createOmniDrop with the approver's signature, then reports the address
//  - collectors: mint (single chain: price × qty; multichain: quoteMint, incl. hub value from a non-hub chain)
import LPC from '../config/launchpad.json';
import CFG from '../config/collections.json';
import ABI from './lpabi.json';
import { createWalletClient, custom, decodeEventLog, getContractAddress, formatUnits, parseAbi, type Address, type Abi } from 'viem';
import { wallet, ensureChain, readClient, vchain } from './wallet';
import { api } from './auth';

const LP = LPC as any;
export const LP_LIVE: boolean = !!LP.mainnet?.deployed && !!LP.mainnet?.dropApprovals;
export const factoryOn = (k: string): Address | null => LP.factories?.[k] || null;
export const escrowOn = (k: string): Address | null => LP.omniEscrows?.[k] || null;
export const HUB: string = LP.hubChain;
const F = ABI.factory as Abi, D = ABI.drop as Abi, O = ABI.omni as Abi;
const ESC = [{ type: 'function', name: 'quoteHubValue', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const FX = [{ type: 'function', name: 'usedSalt', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] }, { type: 'function', name: 'omniImplementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }, { type: 'function', name: 'isDrop', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }] as const;
const OMNI_CID = [{ type: 'function', name: 'collectionId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }] as const;

async function walletOn(k: string) {
  if (!wallet.address || !wallet.provider) throw new Error('Connect your wallet first.');
  try { await ensureChain(k); }
  catch (e: any) { // e.g. Coinbase smart wallets (Base app) cannot add ApeChain or Robinhood
    if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '') || e?.kind === 'wrong-chain') throw e;
    const n = (CFG.chains as any)[k]?.name || k; throw new Error(`Your wallet can't switch to ${n}. Pick another chain to mint on (Base works in every wallet).`);
  }
  return createWalletClient({ chain: vchain(k), transport: custom(wallet.provider), account: wallet.address as Address });
}
// Worker JSON has bigints as decimal strings: rebuild them from the ABI types.
function fromAbi(t: any, v: any): any {
  if (t.type.endsWith('[]')) return (v as any[]).map(x => fromAbi({ ...t, type: t.type.slice(0, -2) }, x));
  if (t.type === 'tuple') return Object.fromEntries(t.components.map((c: any) => [c.name, fromAbi(c, v[c.name])]));
  if (/^u?int/.test(t.type)) return BigInt(v);
  return v;
}

/** Approver (/admin): sign every unsigned chain of one drop. Switches the wallet to each chain first (EIP-712 domain chainId). */
export async function signApprovals(slug: string, log: (s: string) => void) {
  const g = await api('/admin/launchpad/approvals/' + slug, { auth: true });
  if (wallet.address?.toLowerCase() !== String(g.approver).toLowerCase()) throw new Error(`Connect the factory approver wallet ${g.approver} to sign.`);
  for (const a of g.approvals) {
    if (a.signed || a.deployed) { log(`${a.chain}: ${a.deployed ? 'already deployed' : 'already signed'}`); continue; }
    const w = await walletOn(a.chain); const t = a.typed;
    const sig = await w.signTypedData({ account: wallet.address as Address, domain: t.domain, types: t.types, primaryType: t.primaryType, message: { ...t.message, deadline: BigInt(t.message.deadline) } });
    await api('/admin/launchpad/approvals/' + slug, { auth: true, body: { chain: a.chain, signature: sig, deadline: t.message.deadline } });
    log(`${a.chain}: signed ✓`);
  }
}

/** Creator: deploy the drop contract on one chain. Returns the new drop address (already reported to the Worker). */
export async function deployOn(slug: string, k: string, onTx: (h: string) => void): Promise<Address> {
  const a = await api('/launchpad/approval/' + slug, { auth: true, body: { chain: k } });
  const multi = a.mode === 'multichain'; const fn = multi ? 'createOmniDrop' : 'createDrop';
  const item = (F as any[]).find(x => x.name === fn); const params = fromAbi(item.inputs[0], a.params);
  const args = [params, multi ? a.collectionId : a.salt, BigInt(a.deadline), a.signature] as const;
  const pub = readClient(k);
  if (multi && (await pub.readContract({ address: a.factory, abi: FX, functionName: 'usedSalt', args: [a.collectionId] }))) { // already created (e.g. an earlier tap landed but was not recorded)
    const impl = await pub.readContract({ address: a.factory, abi: FX, functionName: 'omniImplementation' }) as Address;
    const drop = getContractAddress({ opcode: 'CREATE2', from: a.factory, salt: a.collectionId, bytecode: `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` });
    if (!(await pub.readContract({ address: a.factory, abi: FX, functionName: 'isDrop', args: [drop] }))) throw new Error('this collection ID is already used on ' + k);
    await api('/launchpad/deployed/' + slug, { auth: true, body: { chain: k, address: drop } });
    return drop;
  }
  const w = await walletOn(k);
  const sim = await pub.simulateContract({ address: a.factory, abi: F, functionName: fn, args, account: wallet.address as Address });
  const gas = await pub.estimateContractGas({ address: a.factory, abi: F, functionName: fn, args, account: wallet.address as Address });
  const hash = await w.writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: wallet.address as Address });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('deploy transaction reverted');
  let drop: Address | null = null;
  for (const l of r.logs) { if (l.address.toLowerCase() !== a.factory.toLowerCase()) continue; try { const e: any = decodeEventLog({ abi: F, data: l.data, topics: l.topics }); if (e.eventName === 'DropCreated' || e.eventName === 'OmniDropCreated') drop = e.args.drop; } catch {} }
  if (!drop) throw new Error('no DropCreated event in the receipt');
  await api('/launchpad/deployed/' + slug, { auth: true, body: { chain: k, address: drop } });
  return drop;
}

/** Collector: quote one mint. Multichain non-hub chains add the hub's CONFIRM budget (+30% buffer, unspent part claimable). */
export async function quote(multi: boolean, k: string, drop: Address, phaseId: number, qty: number, unitWei: bigint, to: Address) {
  if (!multi) return { value: unitWei * BigInt(qty), price: unitWei * BigInt(qty), lz: 0n, hubValue: 0n };
  let hubValue = 0n;
  if (k !== HUB) {
    const cid = await readClient(k).readContract({ address: drop, abi: OMNI_CID, functionName: 'collectionId' });
    const eid = LP.mainnet.chains[k].eid ?? LP.eids?.[k];
    hubValue = ((await readClient(HUB).readContract({ address: escrowOn(HUB)!, abi: ESC, functionName: 'quoteHubValue', args: [cid, eid, BigInt(qty)] })) as bigint) * 13n / 10n;
  }
  const [price, lz] = (await readClient(k).readContract({ address: drop, abi: O, functionName: 'quoteMint', args: [BigInt(phaseId), BigInt(qty), to, hubValue] })) as [bigint, bigint];
  return { value: price + lz, price, lz, hubValue };
}
// Contract errors, so a revert reads as a reason instead of a raw selector.
const MINT_ERR = parseAbi(['error IsPaused()', 'error PhaseNotActive()', 'error NotAllowlisted()', 'error WalletLimit()', 'error PhaseSoldOut()', 'error PhaseSoldOut(uint256 left)', 'error SoldOut()', 'error SoldOut(uint256 left)', 'error WrongPayment(uint256 required)', 'error BadParams()']);
function mintError(e: any, qty: number): Error {
  const r = e?.walk?.((x: any) => x?.data?.errorName) || e?.cause; const n = r?.data?.errorName; const a = r?.data?.args;
  const msg: Record<string, string> = {
    WalletLimit: `That is over this wallet's mint limit for the phase (it counts mints on every chain). Lower the quantity.`,
    SoldOut: a?.[0] ? `Only ${a[0]} left. Lower the quantity.` : 'Sold out.', PhaseSoldOut: a?.[0] ? `Only ${a[0]} left in this phase. Lower the quantity.` : 'This phase is sold out.',
    PhaseNotActive: "This mint phase isn't open right now.", NotAllowlisted: 'This wallet is not on the allowlist.', IsPaused: 'Minting is paused.',
    WrongPayment: 'The price changed. Refresh the page and try again.', BadParams: qty > 50 ? 'At most 50 per transaction.' : 'The mint was rejected. Refresh the page and try again.',
  };
  return n && msg[n] ? new Error(msg[n]) : e;
}
/** Collector: price, gas and balance for one mint. Gas is estimated with the wallet's balance topped up (state override), so a
 *  short balance shows as a clear message here instead of an RPC error, and smart wallets (Coinbase) estimate like any EOA. */
export async function mintPlan(multi: boolean, k: string, drop: Address, phaseId: number, qty: number, proof: `0x${string}`[], unitWei: bigint) {
  const to = wallet.address as Address; const q = await quote(multi, k, drop, phaseId, qty, unitWei, to);
  const args: any = multi ? [to, BigInt(phaseId), BigInt(qty), proof, q.hubValue] : [to, BigInt(phaseId), BigInt(qty), proof];
  const pub = readClient(k); const abi = [...(multi ? O : D), ...MINT_ERR] as Abi;
  let est: bigint;
  try { est = await pub.estimateContractGas({ address: drop, abi, functionName: 'mint', args, value: q.value, account: to, stateOverride: [{ address: to, balance: q.value + 10n ** 21n }] }); }
  catch (e: any) { throw mintError(e, qty); }
  const [bal, gp] = await Promise.all([pub.getBalance({ address: to }), pub.getGasPrice().catch(() => 0n)]) as [bigint, bigint];
  const gas = (est * 125n) / 100n;
  return { q, args, abi, gas, bal, need: q.value + gas * gp };
}
export async function mint(multi: boolean, k: string, drop: Address, phaseId: number, qty: number, proof: `0x${string}`[], unitWei: bigint, onTx: (h: string) => void) {
  const to = wallet.address as Address; const p = await mintPlan(multi, k, drop, phaseId, qty, proof, unitWei);
  if (p.bal < p.need) { const c = (CFG.chains as any)[k]; const nat = c?.native || 'ETH'; const f = (w: bigint) => (+formatUnits(w, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 });
    throw Object.assign(new Error(`Not enough ${nat} on ${c?.name || k}: this mint needs about ${f(p.need)} ${nat} (price + gas) and the wallet has ${f(p.bal)}.`), { kind: 'funds', plan: p }); }
  const pub = readClient(k); const w = await walletOn(k);
  const hash = await w.writeContract({ address: drop, abi: p.abi, functionName: 'mint', args: p.args, value: p.q.value, gas: p.gas, chain: vchain(k), account: to });
  onTx(hash); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('mint reverted');
  return { hash, ...p.q };
}

// Delayed reveal (MultiSeaDrop and MultiSeaOmniDrop share these): owner-only reveal(baseURI), one tx per chain's contract.
const REV = [{ type: 'function', name: 'revealed', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }, { type: 'function', name: 'metadataFrozen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }, { type: 'function', name: 'reveal', stateMutability: 'nonpayable', inputs: [{ type: 'string' }], outputs: [] }] as const;
export async function revealState(k: string, addr: Address) {
  const pub = readClient(k); const [revealed, frozen, owner] = await Promise.all(['revealed', 'metadataFrozen', 'owner'].map(fn => pub.readContract({ address: addr, abi: REV, functionName: fn as any })));
  return { revealed: !!revealed, frozen: !!frozen, owner: String(owner).toLowerCase() };
}
export const storedRevealURI = (slug: string): Promise<string> => api('/launchpad/reveal-uri/' + slug, { auth: true }).then((j: any) => j.baseURI || '');
export async function revealOn(k: string, addr: Address, uri: string, onTx: (h: string) => void) {
  const pub = readClient(k); const w = await walletOn(k);
  const sim = await pub.simulateContract({ address: addr, abi: REV, functionName: 'reveal', args: [uri], account: wallet.address as Address });
  const hash = await w.writeContract({ ...sim.request, chain: vchain(k), account: wallet.address as Address }); onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('reveal transaction reverted');
}
