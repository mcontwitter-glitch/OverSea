// FORK ONLY: end-to-end launchpad approval -> createDrop / createOmniDrop -> mint -> withdraw against the REAL Base mainnet
// factory on a local anvil fork (default http://127.0.0.1:8555, start: anvil --fork-url https://mainnet.base.org --port 8555).
// The Worker code (worker/src/launchpad.js) produces the typed data and the creator's approval exactly as the app does.
// The real approver key is not available here, so ON THE FORK ONLY the factory owner (deployer, impersonated) calls
// setApprover(<throwaway key>). Nothing is broadcast to mainnet. Throwaway keys only.
import fs from 'node:fs';
import { createTestClient, createPublicClient, createWalletClient, http, parseEther, decodeEventLog, publicActions, walletActions } from 'viem';
import { base } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { makeLaunchpad } from '../worker/src/launchpad.js';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8555';
const LP0 = JSON.parse(fs.readFileSync(new URL('../config/launchpad.json', import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(new URL('../config/collections.json', import.meta.url)));
const ABI = JSON.parse(fs.readFileSync(new URL('../src/lpabi.json', import.meta.url)));
const FACTORY = LP0.factories.base, FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0';
const tc = createTestClient({ chain: { ...base, id: 8453 }, mode: 'anvil', transport: http(RPC) }).extend(publicActions).extend(walletActions);
const FA = [...ABI.factory, ...['approver', 'owner', 'feeWallet'].map(n => ({ type: 'function', name: n, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] })),
  { type: 'function', name: 'platformFeeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] }, { type: 'function', name: 'isDrop', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprover', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }];
const lc = s => String(s || '').toLowerCase(); const bad = (m, s = 400) => { throw Object.assign(new Error(m), { status: s }); };
let ok = 0, fail = 0; const check = (c, m) => { console.log(c ? '  ✓' : '  ✗', m); c ? ok++ : fail++; };
function fromAbi(t, v) { if (t.type.endsWith('[]')) return v.map(x => fromAbi({ ...t, type: t.type.slice(0, -2) }, x)); if (t.type === 'tuple') return Object.fromEntries(t.components.map(c => [c.name, fromAbi(c, v[c.name])])); return /^u?int/.test(t.type) ? BigInt(v) : v; }

const appr = privateKeyToAccount(generatePrivateKey()), creator = privateKeyToAccount(generatePrivateKey()), minter = privateKeyToAccount(generatePrivateKey());
const ADMIN = '0xca89ae48a5c61d13e78236daa4ac29ee588ea475';
console.log('fork block', await tc.getBlockNumber(), 'factory', FACTORY);
const owner = await tc.readContract({ address: FACTORY, abi: FA, functionName: 'owner' });
check(lc(await tc.readContract({ address: FACTORY, abi: FA, functionName: 'approver' })) === lc(LP0.approver), 'on-chain approver = config approver ' + LP0.approver);
check(lc(await tc.readContract({ address: FACTORY, abi: FA, functionName: 'feeWallet' })) === lc(FEE) && Number(await tc.readContract({ address: FACTORY, abi: FA, functionName: 'platformFeeBps' })) === 50, 'feeWallet 0x2541…a4d0, 50 bps');
// FORK ONLY: owner (deployer) points the approver at a throwaway key so this script can sign like the approver wallet does.
await tc.impersonateAccount({ address: owner }); await tc.setBalance({ address: owner, value: parseEther('1') });
await tc.writeContract({ account: owner, address: FACTORY, abi: FA, functionName: 'setApprover', args: [appr.address], chain: null }); await tc.stopImpersonatingAccount({ address: owner });
for (const a of [creator, minter]) await tc.setBalance({ address: a.address, value: parseEther('10') });

const kv = new Map(); const K = { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); }, async list({ prefix = '' }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
let who = lc(creator.address); const env = { COLLECTIONS: K, ADMIN_ADDRESSES: ADMIN };
const L = makeLaunchpad({ LP: { ...LP0, approver: lc(appr.address) }, chains: CFG.chains, lc, bad, ADDR: /^0x[0-9a-fA-F]{40}$/, admins: () => [ADMIN], requireSession: async () => ({ address: who }),
  isDropOnChain: async (k, f, a) => tc.readContract({ address: f, abi: FA, functionName: 'isDrop', args: [a] }), now: () => Date.now() });
const call = (M, path, b) => L.handle({ json: async () => b ?? {} }, env, null, path.split('/').filter(Boolean), M, async () => b);
const now = Number((await tc.getBlock()).timestamp); const PRICE = parseEther('0.01');
const phases = [{ name: 'Public', kind: 'public', start: now + 60, end: 0, price: PRICE.toString(), maxPerWallet: 5 }];
const common = { name: 'Fork Test', symbol: 'FORK', maxSupply: 100, royaltyBps: 500, reveal: 'delayed', preRevealURI: 'ipfs://bafyforktest/hidden.json', phases };
await call('POST', '/launchpad/submit', { ...common, slug: 'fork-single', chains: ['base'], creatorReserve: 0 });
await call('POST', '/launchpad/submit', { ...common, slug: 'fork-omni', mode: 'multichain', chains: ['base', 'bnb'], allocations: { base: 60, bnb: 40 }, phases: phases.map(p => ({ ...p, prices: { base: p.price, bnb: p.price } })) });
who = ADMIN; for (const s of ['fork-single', 'fork-omni']) await call('POST', '/admin/launchpad/approve/' + s);
who = lc(appr.address); // approver wallet in /admin: GET typed data, sign, POST (what src/lpchain.ts signApprovals does)
for (const s of ['fork-single', 'fork-omni']) { const g = await call('GET', '/admin/launchpad/approvals/' + s); const a = g.approvals.find(x => x.chain === 'base'); const t = a.typed;
  const sig = await appr.signTypedData({ ...t, message: { ...t.message, deadline: BigInt(t.message.deadline) } });
  await call('POST', '/admin/launchpad/approvals/' + s, { chain: 'base', signature: sig, deadline: t.message.deadline }); }
who = lc(creator.address); const drops = {};
for (const s of ['fork-single', 'fork-omni']) { // creator: what src/lpchain.ts deployOn does
  const a = await call('POST', '/launchpad/approval/' + s, { chain: 'base' }); const multi = a.mode === 'multichain'; const fn = multi ? 'createOmniDrop' : 'createDrop';
  const item = ABI.factory.find(x => x.name === fn); const args = [fromAbi(item.inputs[0], a.params), multi ? a.collectionId : a.salt, BigInt(a.deadline), a.signature];
  const { request } = await tc.simulateContract({ address: a.factory, abi: FA, functionName: fn, args, account: creator });
  const hash = await tc.writeContract(request); const r = await tc.waitForTransactionReceipt({ hash });
  let drop; for (const l of r.logs) { try { const e = decodeEventLog({ abi: ABI.factory, data: l.data, topics: l.topics }); if (/DropCreated/.test(e.eventName)) drop = e.args.drop; } catch {} }
  check(r.status === 'success' && !!drop, `${fn} ok · drop ${drop} · gas ${r.gasUsed}`);
  const dep = await call('POST', '/launchpad/deployed/' + s, { chain: 'base', address: drop }); check(dep.drop.deployed === true, `Worker /launchpad/deployed accepted (factory.isDrop) for ${s}`);
  drops[s] = { drop, multi };
}
// a bad signature (wrong key) must revert
{ const a = await call('POST', '/launchpad/approval/fork-single', { chain: 'base' }); const item = ABI.factory.find(x => x.name === 'createDrop');
  const t = { domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: 8453, verifyingContract: FACTORY }, types: { DropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'DropApproval', message: { creator: creator.address, configHash: a.configHash, salt: a.salt, deadline: BigInt(a.deadline) } };
  const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(t);
  let rev = false; try { await tc.simulateContract({ address: FACTORY, abi: FA, functionName: 'createDrop', args: [fromAbi(item.inputs[0], a.params), a.salt, BigInt(a.deadline), forged], account: creator }); } catch { rev = true; } check(rev, 'createDrop with a non-approver signature reverts'); }
await tc.increaseTime({ seconds: 120 }); await tc.mine({ blocks: 1 });
for (const [s, { drop, multi }] of Object.entries(drops)) {
  let value = PRICE, args = [minter.address, 0n, 1n, []];
  if (multi) { const [price, lz] = await tc.readContract({ address: drop, abi: ABI.omni, functionName: 'quoteMint', args: [0n, 1n, minter.address, 0n] }); value = price + lz; args = [...args, 0n]; console.log(`  quoteMint: price ${price} lz ${lz}`); }
  const hash = await tc.writeContract({ account: minter, address: drop, abi: multi ? ABI.omni : ABI.drop, functionName: 'mint', args, value, chain: null }); const r = await tc.waitForTransactionReceipt({ hash });
  check(r.status === 'success', `${s}: minted 1 (paid ${value} wei) gas ${r.gasUsed}`);
  const bal = await tc.getBalance({ address: drop }); const fee0 = await tc.getBalance({ address: FEE });
  const h2 = await tc.writeContract({ account: minter, address: drop, abi: multi ? ABI.omni : ABI.drop, functionName: 'withdraw', args: [], chain: null }); await tc.waitForTransactionReceipt({ hash: h2 });
  const fee = (await tc.getBalance({ address: FEE })) - fee0;
  check(fee === PRICE * 50n / 10000n, `${s}: withdraw → fee wallet 0x2541…a4d0 +${fee} wei = 0.5% of ${PRICE} (drop balance before withdraw ${bal})`);
}
console.log(`\n${ok} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
