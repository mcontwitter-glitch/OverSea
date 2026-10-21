// LOCAL ONLY end-to-end for the launchpad: anvil (chain 31337, throwaway dev keys) -> deploy impl + factory ->
// worker/src/launchpad.js signs the EIP-712 DropApproval -> creator calls createDrop -> allowlist mint with a Worker proof
// -> public mint -> withdraw split. Never points at a real network. Run: anvil --port 8599 & node scripts/launchpad-local-e2e.mjs
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, defineChain } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'; // approver key: random per run, never stored
import { makeLaunchpad, merkle, proofFor } from '../../worker/src/launchpad.js';
const RPC = process.env.RPC || 'http://127.0.0.1:8599';
const local = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain: local, transport: http(RPC) });
if ((await pub.getChainId()) !== 31337) throw new Error('refusing: not a local anvil chain');
// anvil's unlocked dev accounts: anvil signs eth_sendTransaction itself, so no private key appears in this repo.
const [deployer, creator, minter] = (await pub.request({ method: 'eth_accounts' })).slice(0, 3);
const W = a => createWalletClient({ account: a, chain: local, transport: http(RPC) }); // JSON-RPC account (address)
const art = n => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8'));
const Drop = art('MultiSeaDrop'), Fac = art('MultiSeaLaunchpadFactory');
const FEE = '0x25411039F77529A543344603bD8acdd65fABA4d0';
const approverKey = generatePrivateKey(); const approver = privateKeyToAccount(approverKey);
const deploy = async (a, args = []) => { const h = await W(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); return { address: r.contractAddress, gas: r.gasUsed }; };
const impl = await deploy(Drop); const fac = await deploy(Fac, [deployer, impl.address, FEE, approver.address, 50]);
console.log('impl gas', impl.gas, 'factory gas', fac.gas);
const LP = { ...JSON.parse(fs.readFileSync('../config/launchpad.json', 'utf8')), factories: { local: fac.address } };
const chains = { local: { chainId: 31337, rpc: RPC } }; LP.chains = ['local'];
const kvm = new Map(); const K = { async get(k, t) { const v = kvm.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kvm.set(k, String(v)); }, async delete(k) { kvm.delete(k); }, async list({ prefix }) { return { keys: [...kvm.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
let who = creator.toLowerCase(); const ADMIN = '0xca89ae48a5c61d13e78236daa4ac29ee588ea475';
const isDropOnChain = (k, f, d) => pub.readContract({ address: f, abi: Fac.abi, functionName: 'isDrop', args: [d] });
const L = makeLaunchpad({ LP, chains, lc: s => String(s || '').toLowerCase(), bad: (m) => { throw new Error(m); }, ADDR: /^0x[0-9a-fA-F]{40}$/, admins: () => [ADMIN], requireSession: async () => ({ address: who }), isDropOnChain });
const env = { COLLECTIONS: K, LAUNCHPAD_APPROVER_KEY: approverKey };
const call = (M, path, b) => L.handle({ json: async () => b ?? {} }, env, null, path.split('/').filter(Boolean), M, async () => b);
const t0 = Number((await pub.getBlock()).timestamp);
await call('POST', '/launchpad/submit', { slug: 'lil-foots-e2e', name: 'LIL FOOTS', symbol: 'FOOT', chains: ['local'], maxSupply: 4404, creatorReserve: 4, royaltyBps: 500, reveal: 'delayed', preRevealURI: 'ipfs://bafyplaceholder/hidden.json',
  phases: [{ kind: 'allowlist', start: t0 - 10, end: t0 + 3600, price: '2000000000000000', maxPerWallet: 2, allowlist: [minter, deployer] }, { kind: 'public', start: t0 + 3600, end: 0, price: '3000000000000000', maxPerWallet: 5 }] });
who = ADMIN; await call('POST', '/admin/launchpad/approve/lil-foots-e2e'); who = creator.toLowerCase();
const a = await call('POST', '/launchpad/approval/lil-foots-e2e', { chain: 'local' });
const params = JSON.parse(JSON.stringify(a.params), (k, v) => (typeof v === 'string' && /^\d+$/.test(v) && ['start', 'end', 'price', 'royaltyBps'].includes(k) ? BigInt(v) : v));
const sim = await pub.simulateContract({ account: creator, address: fac.address, abi: Fac.abi, functionName: 'createDrop', args: [params, a.salt, BigInt(a.deadline), a.signature] });
const h = await W(creator).writeContract(sim.request); const rc = await pub.waitForTransactionReceipt({ hash: h });
const drop = sim.result; console.log('createDrop gas', rc.gasUsed, 'drop', drop);
const replay = await pub.simulateContract({ account: creator, address: fac.address, abi: Fac.abi, functionName: 'createDrop', args: [params, a.salt, BigInt(a.deadline), a.signature] }).then(() => 'ACCEPTED', e => e.shortMessage || 'reverted');
console.log('replay of same approval ->', replay);
const pr = await call('GET', `/launchpad/proof/lil-foots-e2e/0/${minter}`);
const m1 = await W(minter).writeContract({ address: drop, abi: Drop.abi, functionName: 'mint', args: [minter, 0n, 2n, pr.proof], value: parseEther('0.004') });
console.log('allowlist mint x2 gas', (await pub.waitForTransactionReceipt({ hash: m1 })).gasUsed);
await pub.request({ method: 'evm_increaseTime', params: [3700] }); await pub.request({ method: 'evm_mine', params: [] });
const m2 = await W(minter).writeContract({ address: drop, abi: Drop.abi, functionName: 'mint', args: [minter, 1n, 1n, []], value: parseEther('0.003') });
console.log('public mint x1 gas', (await pub.waitForTransactionReceipt({ hash: m2 })).gasUsed);
const m3 = await W(minter).writeContract({ address: drop, abi: Drop.abi, functionName: 'mint', args: [minter, 1n, 4n, []], value: parseEther('0.012') });
console.log('public mint x4 gas', (await pub.waitForTransactionReceipt({ hash: m3 })).gasUsed);
const f0 = await pub.getBalance({ address: FEE }); const w = await W(minter).writeContract({ address: drop, abi: Drop.abi, functionName: 'withdraw' }); await pub.waitForTransactionReceipt({ hash: w });
console.log('fee wallet received (wei)', (await pub.getBalance({ address: FEE })) - f0, '(0.5% of 0.019 ETH = 95000000000000)');
const dep = await call('POST', '/launchpad/deployed/lil-foots-e2e', { chain: 'local', address: drop });
console.log('worker marked', dep.drop.status, 'auto-listed', (await K.get('col:lil-foots-e2e', 'json')).status, '| totalMinted', await pub.readContract({ address: drop, abi: Drop.abi, functionName: 'totalMinted' }));
