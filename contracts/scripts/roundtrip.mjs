// Full round trip for "LIL FOOTS test": deploy factories, deploy the test collection, pay the listing fee,
// deploy + wire mirrors, then bridge Sepolia -> Base Sepolia -> Sepolia.
// MODE=fork: runs on local anvil forks of both testnets (real LayerZero endpoints + Chainlink feeds); message delivery
// is simulated by calling lzReceive as the destination EndpointV2 (what the LZ executor does after DVN verification).
import { CFG, MODE, art, deployer, loadDep, saveDep, clients, deploy, send, b32, eventsOf, PACKET_ABI } from './lib.mjs';
import { factories, processListing } from './deploy-bridge.mjs';
import { parseEther, formatEther, slice, getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
const E = art('MultiSeaEscrow'), F = art('MultiSeaFactory'), N = art('LilFootsTest'), M = art('MultiSeaMirror');
const A = 'sepolia', B = 'baseSepolia';
const acct = deployer(); const holder = privateKeyToAccount(generatePrivateKey()); // throwaway, never printed
const fund = async (key, addr, eth) => { if (MODE !== 'fork') return; const { pub } = clients(key); await pub.request({ method: 'anvil_setBalance', params: [addr, '0x' + parseEther(eth).toString(16)] }); };
// executor options: type 3, lzReceive gas 300k
const OPTS = '0x0003' + '01' + '0011' + '01' + (300000).toString(16).padStart(32, '0');
async function relay(srcKey, dstKey, receipt, dstEscrow) {
  const ev = eventsOf(receipt, PACKET_ABI, 'PacketSent')[0]; const p = ev.args.encodedPayload;
  // packet = version(1) nonce(8) srcEid(4) sender(32) dstEid(4) receiver(32) guid(32) message
  const nonce = BigInt(slice(p, 1, 9)), srcEid = Number(BigInt(slice(p, 9, 13))), sender = slice(p, 13, 45), guid = slice(p, 81, 113), message = slice(p, 113);
  if (MODE !== 'fork') { console.log('live mode: waiting for the LayerZero executor (guid', guid, ')'); return guid; }
  const dst = clients(dstKey); const ep = CFG.chains[dstKey].endpoint;
  await dst.pub.request({ method: 'anvil_impersonateAccount', params: [ep] }); await fund(dstKey, ep, '1');
  const { createWalletClient, http } = await import('viem');
  const w = createWalletClient({ chain: dst.chain, transport: http(dst.rpc), account: ep });
  const hash = await w.writeContract({ address: dstEscrow, abi: E.abi, functionName: 'lzReceive', args: [{ srcEid, sender, nonce }, guid, message, ep, '0x'], gas: 500000n });
  const r = await dst.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('lzReceive failed');
  return guid;
}
const T = {}; const log = (k, v) => { T[k] = v; console.log(k.padEnd(28), v); };
for (const k of [A, B]) await fund(k, acct.address, '5');
await fund(A, holder.address, '1'); await fund(B, holder.address, '1');
const fb = {}; for (const k of [A, B]) fb[k] = Number(await clients(k).pub.getBlockNumber());
await factories();
const dep0 = loadDep(); dep0.fromBlock = fb; saveDep(dep0);
const dep = loadDep();
const ca = clients(A, acct), cb = clients(B, acct);
// test collection, owner() = deployer (stands in for the collection deployer wallet verified by SIWE on the site)
const nft = await deploy(ca, 'LilFootsTest', [acct.address, 'https://multisea.io/data/lil-foots/meta/']);
for (const id of [7n, 8n, 2396n]) await send(ca, nft, N.abi, 'mint', [holder.address, id]);
log('test collection (Sepolia)', nft);
const fee = await ca.pub.readContract({ address: dep.chains[A].factory, abi: F.abi, functionName: 'listingFee', args: [2n] });
const feeBefore = await ca.pub.getBalance({ address: CFG.feeWallet });
const { r: lr } = await send(ca, dep.chains[A].factory, F.abi, 'list', [nft, [CFG.chains[A].eid, CFG.chains[B].eid]], fee);
const lid = eventsOf(lr, F.abi, 'Listed')[0].args.id;
log('listing fee paid', formatEther(fee) + ' ETH -> fee wallet +' + formatEther((await ca.pub.getBalance({ address: CFG.feeWallet })) - feeBefore));
const rec = await processListing(A, lid);
const escA = rec.escrows[A], escB = rec.escrows[B], mirror = rec.mirrors[B];
log('escrow Sepolia', escA); log('escrow Base Sepolia', escB); log('mirror Base Sepolia', mirror);
// bridge A -> B
const ha = clients(A, holder), hb = clients(B, holder);
const [pf, lz] = await ha.pub.readContract({ address: escA, abi: E.abi, functionName: 'quote', args: [CFG.chains[B].eid, holder.address, 7n, OPTS] });
log('quote Sepolia->Base', `$0.30 = ${formatEther(pf)} ETH + LZ ${formatEther(lz)} ETH`);
await send(ha, nft, N.abi, 'approve', [escA, 7n]);
const fw0 = await ha.pub.getBalance({ address: CFG.feeWallet });
const { r: br } = await send(ha, escA, E.abi, 'bridge', [CFG.chains[B].eid, holder.address, 7n, OPTS], pf + lz);
log('platform fee received', formatEther((await ha.pub.getBalance({ address: CFG.feeWallet })) - fw0) + ' ETH');
log('#7 owner on Sepolia', (await ha.pub.readContract({ address: nft, abi: N.abi, functionName: 'ownerOf', args: [7n] })) === escA ? 'escrow' : 'NOT ESCROW');
await relay(A, B, br, escB);
log('#7 owner on Base Sepolia', (await hb.pub.readContract({ address: mirror, abi: M.abi, functionName: 'ownerOf', args: [7n] })) === holder.address ? 'holder' : 'WRONG');
// bridge B -> A
const [pf2, lz2] = await hb.pub.readContract({ address: escB, abi: E.abi, functionName: 'quote', args: [CFG.chains[A].eid, holder.address, 7n, OPTS] });
log('quote Base->Sepolia', `$0.30 = ${formatEther(pf2)} ETH + LZ ${formatEther(lz2)} ETH`);
await send(hb, mirror, M.abi, 'approve', [escB, 7n]);
const { r: br2 } = await send(hb, escB, E.abi, 'bridge', [CFG.chains[A].eid, holder.address, 7n, OPTS], pf2 + lz2);
await relay(B, A, br2, escA);
log('#7 owner back on Sepolia', (await ha.pub.readContract({ address: nft, abi: N.abi, functionName: 'ownerOf', args: [7n] })) === holder.address ? 'holder' : 'WRONG');
log('#7 on Base Sepolia', (await hb.pub.readContract({ address: mirror, abi: M.abi, functionName: 'ownerOf', args: [7n] })) === escB ? 'escrow' : 'WRONG');
dep.roundtrip = { mode: MODE, at: new Date().toISOString(), ...T }; dep.testCollection = { sepolia: nft, baseSepoliaMirror: mirror }; saveDep({ ...loadDep(), roundtrip: dep.roundtrip, testCollection: dep.testCollection });
console.log('ROUND TRIP OK');
