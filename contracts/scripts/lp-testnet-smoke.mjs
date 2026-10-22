// TESTNET end-to-end smoke test for a multichain (BATCHED) drop. Resumable: state in deployments/launchpad-testnet.json (.smoke).
//   node scripts/lp-testnet-smoke.mjs create|hubmint|remotemint|flush|check|move|status
import { keccak256, toBytes, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import { T, load, save, art, deployer, net, guard, send } from './lp-testnet.mjs';
import { omniConfigHash, collectionIdOf, OMNI_APPROVAL_TYPES } from '../../worker/src/launchpad.js';
const s = load(); const acct = deployer(); const sm = (s.smoke ??= {});
const CH = ['baseSepolia', 'sepolia', 'robinhoodTestnet']; const HUB = 'baseSepolia', REMOTE = 'robinhoodTestnet', MOVE_TO = 'sepolia';
const F = art('MultiSeaLaunchpadFactory').abi, D = art('MultiSeaOmniDrop').abi, E = art('MultiSeaOmniEscrow').abi;
const ZERO = '0x0000000000000000000000000000000000000000';
const slug = sm.slug ??= 'smoke-' + Math.floor(Date.now() / 1000);
const cid = sm.cid ??= collectionIdOf(slug, acct.address);
const PRICE = 10_000_000_000_000n; // 0.00001 per NFT on every chain
const params = () => ({ name: 'MultiSea Smoke', symbol: 'MSMOKE', owner: acct.address, payout: acct.address, feeWallet: ZERO, platformFeeBps: 0, maxSupply: 20,
  royaltyReceiver: acct.address, royaltyBps: 500, baseURI: 'ipfs://bafysmoke/', preRevealURI: '',
  phases: [{ start: BigInt(sm.start), end: 0n, price: 0n, maxPerWallet: 0, merkleRoot: '0x' + '0'.repeat(64) }],
  eids: CH.map(k => T.chains[k].eid), hubEid: T.chains[HUB].eid, prices: CH.map(() => PRICE), copyMode: 0, batchK: 10, batchT: 300 });
const log = (what, k, hash) => { (sm.txs ??= []).push({ what, chain: k, hash }); save(s); console.log(`  ${what} [${k}] ${T.chains[k].explorer}/tx/${hash}  lz: https://testnet.layerzeroscan.com/tx/${hash}`); };
const dropOn = k => s.chains[k].drops?.[cid];
const cmd = process.argv[2];
if (cmd === 'create') {
  sm.start ??= Math.floor(Date.now() / 1000) - 120; save(s);
  const approver = privateKeyToAccount(fs.readFileSync(new URL('../.secrets/staging-approver.key', import.meta.url), 'utf8').trim());
  const p = params(); const cfg = omniConfigHash(p); const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
  for (const k of CH) { const n = net(k, acct); await guard(n); const d = s.chains[k]; d.drops ??= {};
    if (d.drops[cid]) continue;
    const fcfg = await n.pub.readContract({ address: d.factory, abi: F, functionName: 'omniConfigHash', args: [p] }); if (fcfg !== cfg) throw new Error('config hash mismatch worker vs ' + k);
    const sig = await approver.signTypedData({ domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: n.c.chainId, verifyingContract: d.factory }, types: OMNI_APPROVAL_TYPES, primaryType: 'OmniDropApproval', message: { creator: acct.address, configHash: cfg, collectionId: cid, deadline } });
    const { request, result } = await n.pub.simulateContract({ account: acct, address: d.factory, abi: F, functionName: 'createOmniDrop', args: [p, cid, deadline, sig] });
    const { hash } = await send(n, d.factory, F, 'createOmniDrop', [p, cid, deadline, sig], s, undefined, 'createOmniDrop ' + slug);
    d.drops[cid] = result; save(s); log('createOmniDrop -> ' + result, k, hash); }
}
if (cmd === 'hubmint') { const n = net(HUB, acct); const q = BigInt(process.argv[3] || 3);
  const [price, lz] = await n.pub.readContract({ address: dropOn(HUB), abi: D, functionName: 'quoteMint', args: [0n, q, acct.address, 0n] });
  console.log(`  hub quote: price ${formatEther(price)} + batch share ${formatEther(lz)} ETH for ${q}`);
  const { hash } = await send(n, dropOn(HUB), D, 'mint', [acct.address, 0n, q, [], 0n], s, price + lz, `hub mint x${q}`); log(`hub mint x${q} (Active on Base Sepolia now, copies queued)`, HUB, hash);
  console.log('  queue', await n.pub.readContract({ address: s.chains[HUB].escrow, abi: E, functionName: 'queueOf', args: [cid] }), 'pool', formatEther(await n.pub.readContract({ address: s.chains[HUB].escrow, abi: E, functionName: 'poolOf', args: [cid] }))); }
if (cmd === 'remotemint') { const k = process.argv[4] || REMOTE; const n = net(k, acct); const h = net(HUB); const q = BigInt(process.argv[3] || 7);
  const hv0 = await h.pub.readContract({ address: s.chains[HUB].escrow, abi: E, functionName: 'quoteHubValue', args: [cid, T.chains[k].eid, q] });
  const hubValue = process.env.NODROP ? 0n : hv0 * 13n / 10n; // NODROP: pathway executor has nativeCap 0 (Robinhood/Curtis testnet -> Base Sepolia) // +30% buffer; unspent part is claimable on the hub (refundOf)
  const [price, lz] = await n.pub.readContract({ address: dropOn(k), abi: D, functionName: 'quoteMint', args: [0n, q, acct.address, hubValue] });
  console.log(`  ${k} quote: price ${formatEther(price)} + REQUEST ${formatEther(lz)} (hub value ${formatEther(hubValue)} ETH on Base)`);
  const { hash } = await send(n, dropOn(k), D, 'mint', [acct.address, 0n, q, [], hubValue], s, price + lz, `remote mint x${q}`); log(`${k} mint x${q} (REQUEST -> Base hub)`, k, hash); }
if (cmd === 'flush') { const n = net(HUB, acct); const esc = s.chains[HUB].escrow;
  console.log('  ready', await n.pub.readContract({ address: esc, abi: E, functionName: 'flushReady', args: [cid] }), 'plan', await n.pub.readContract({ address: esc, abi: E, functionName: 'quoteFlush', args: [cid] }), 'pool', formatEther(await n.pub.readContract({ address: esc, abi: E, functionName: 'poolOf', args: [cid] })));
  const [, need] = await n.pub.readContract({ address: esc, abi: E, functionName: 'quoteFlush', args: [cid] }); const pool = await n.pub.readContract({ address: esc, abi: E, functionName: 'poolOf', args: [cid] });
  const top = need > pool ? (need - pool) * 11n / 10n : 0n; if (top) console.log('  pool short (gas limits were raised after these mints): topping up', formatEther(top));
  const { hash, r } = await send(n, esc, E, 'flush', [cid], s, top, 'flush'); log('flush (permissionless; one BATCH message per chain)', HUB, hash);
  console.log('  pool after', formatEther(await n.pub.readContract({ address: esc, abi: E, functionName: 'poolOf', args: [cid] }))); }
if (cmd === 'move') { const k = process.argv[4] || HUB, to = process.argv[5] || MOVE_TO; const id = BigInt(process.argv[3] || 1); const n = net(k, acct);
  const [platform, lzFee] = await n.pub.readContract({ address: s.chains[k].escrow, abi: E, functionName: 'quoteMove', args: [cid, T.chains[to].eid, id, acct.address] });
  const { hash } = await send(n, dropOn(k), D, 'moveTo', [T.chains[to].eid, id, acct.address], s, platform + lzFee, `move #${id}`); log(`move #${id} ${k} -> ${to} (platform ${formatEther(platform)} + lz ${formatEther(lzFee)})`, k, hash); }
if (cmd === 'check' || cmd === 'status') {
  const hn = net(HUB); console.log('  hub totalAssigned', await hn.pub.readContract({ address: dropOn(HUB), abi: D, functionName: 'totalAssigned' }), 'queue', await hn.pub.readContract({ address: s.chains[HUB].escrow, abi: E, functionName: 'queueOf', args: [cid] }));
  const out = {};
  for (const k of CH) { const n = net(k); const d = dropOn(k); const row = [];
    for (let id = 1n; id <= 20n; id++) { const ex = await n.pub.readContract({ address: d, abi: D, functionName: 'existsHere', args: [id] });
      const act = ex && await n.pub.readContract({ address: d, abi: D, functionName: 'isActiveHere', args: [id] }); row.push(!ex ? '.' : act ? 'A' : 'e'); }
    out[k] = row.join(''); console.log(`  ${k.padEnd(17)} ids 1..20: ${row.join(' ')}   (A=Active here, e=escrow copy, .=none)  pending=${await n.pub.readContract({ address: d, abi: D, functionName: 'pendingQty' })}`); }
  if (cmd === 'check') { sm.check = { at: new Date().toISOString(), ...out }; save(s); } }
