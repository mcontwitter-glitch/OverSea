// MultiSea bridge deployer.
//   node scripts/deploy-bridge.mjs factories            -> deploy a MultiSeaFactory on every configured chain (owner = admin, operator = deployer)
//   node scripts/deploy-bridge.mjs process <chain> <id> -> after a paid listing on <chain>, deploy mirrors on the other selected chains and wire all peers
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, CFG, MODE, art, deployer, loadDep, saveDep, clients, deploy, send, b32, eventsOf } from './lib.mjs';
const F = art('MultiSeaFactory'), M = art('MultiSeaMirror'), N = art('LilFootsTest'); const E = art('MultiSeaEscrow');
const byEid = eid => Object.keys(CFG.chains).find(k => CFG.chains[k].eid === Number(eid));

export async function factories() {
  const dep = loadDep(); const acct = deployer();
  for (const key of Object.keys(CFG.chains)) {
    if (dep.chains[key]?.factory) { console.log(key, 'factory exists', dep.chains[key].factory); continue; }
    const cl = clients(key, acct); const c = cl.c;
    // Chains with no Chainlink native/USD feed get a MultiSeaPriceFeed seeded with today's price (owner can push updates).
    let feed = c.ethUsdFeed;
    if (!feed && c.pushedFeed) {
      const usd = await usdPrice(c.pushedFeed.coingecko);
      feed = dep.chains[key]?.feed || await deploy(cl, 'MultiSeaPriceFeed', [CFG.admin, acct.address, c.pushedFeed.description, BigInt(Math.round(usd * 1e8))]);
      dep.chains[key] = { ...(dep.chains[key] || {}), feed }; saveDep(dep);
      console.log(key, 'price feed', feed, c.pushedFeed.description, usd);
    }
    const age = BigInt(c.maxPriceAge || CFG.maxPriceAge);
    const factory = await deploy(cl, 'MultiSeaFactory', [c.endpoint, CFG.admin, CFG.operator || acct.address, CFG.feeWallet, feed, age, BigInt(CFG.supportedChains)]);
    dep.chains[key] = { ...(dep.chains[key] || {}), factory, feed, eid: c.eid, chainId: c.chainId }; saveDep(dep);
    console.log(key, 'factory', factory);
  }
}

const CG = { ETH: 'ethereum', APE: 'apecoin', BNB: 'binancecoin' };
export async function usdPrice(id) {
  const j = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`).then(r => r.json());
  if (!j[id]?.usd) throw new Error('no USD price for ' + id); return j[id].usd;
}
// Gas units measured in the mainnet fork dry run (deployments/gas-units.json); fallbacks are conservative.
const UNITS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/gas-units.json'), 'utf8')); } catch { return { list: 1_400_000, deployMirror: 3_300_000, setPeer: 52_000 }; } })();
/** Live gas-only listing costs: what each step costs on its own chain, converted into every factory chain's native token. */
export async function gasCosts() {
  const keys = Object.keys(CFG.chains); const peers = BigInt(CFG.supportedChains - 1); const mk = BigInt(Math.round((CFG.gasMarkup || 1.25) * 100));
  const usd = {}; for (const n of new Set(keys.map(k => CFG.chains[k].native))) usd[n] = await usdPrice(CG[n]);
  const { createPublicClient, http: h } = await import('viem');
  const gp = {}; for (const k of keys) gp[k] = await createPublicClient({ transport: h(CFG.chains[k].rpc) }).getGasPrice(); // live, even in fork mode
  const usdOf = (k, units) => Number(BigInt(units) * gp[k]) / 1e18 * usd[CFG.chains[k].native];
  const remote = {}, base = {};
  for (const k of keys) { remote[k] = usdOf(k, BigInt(UNITS.deployMirror) + peers * BigInt(UNITS.setPeer)); base[k] = usdOf(k, BigInt(UNITS.list) + peers * BigInt(UNITS.setPeer)); }
  const toWei = (usdAmt, k) => BigInt(Math.ceil(usdAmt / usd[CFG.chains[k].native] * 1e18)) * mk / 100n;
  const out = {}; for (const k of keys) { out[k] = { base: toWei(base[k], k), chains: {} }; for (const d of keys) if (d !== k) out[k].chains[CFG.chains[d].eid] = toWei(remote[d], k); }
  return { out, usd, gp, remoteUsd: remote, baseUsd: base };
}
export async function setGasCosts() {
  const dep = loadDep(); const acct = deployer(); const { out, remoteUsd, baseUsd } = await gasCosts();
  for (const k of Object.keys(out)) {
    const eids = [0, ...Object.keys(out[k].chains).map(Number)], costs = [out[k].base, ...Object.values(out[k].chains)];
    await send(clients(k, acct), dep.chains[k].factory, F.abi, 'setGasCosts', [eids, costs]);
    console.log(k, 'gas costs set (USD): base', baseUsd[k].toFixed(3));
  }
  console.log('per-chain mirror cost (USD):', Object.fromEntries(Object.entries(remoteUsd).map(([k, v]) => [k, +v.toFixed(3)])));
}

/** Pin every pathway of a collection to the LayerZero Labs DVN + LZ executor (send side) and the matching receive config. */
export async function lzConfig(escrows, dep = loadDep()) {
  const { encodeAbiParameters } = await import('viem'); const acct = deployer();
  const ULN = [{ type: 'tuple', components: [{ name: 'confirmations', type: 'uint64' }, { name: 'requiredDVNCount', type: 'uint8' }, { name: 'optionalDVNCount', type: 'uint8' }, { name: 'optionalDVNThreshold', type: 'uint8' }, { name: 'requiredDVNs', type: 'address[]' }, { name: 'optionalDVNs', type: 'address[]' }] }];
  const EXE = [{ type: 'tuple', components: [{ name: 'maxMessageSize', type: 'uint32' }, { name: 'executor', type: 'address' }] }];
  const uln = (conf, dvn) => encodeAbiParameters(ULN, [{ confirmations: BigInt(conf), requiredDVNCount: 1, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: [dvn], optionalDVNs: [] }]);
  const keys = Object.keys(escrows);
  for (const a of keys) {
    const A = CFG.chains[a]; const cl = clients(a, acct); const send_ = [], recv = [];
    for (const b of keys) if (b !== a) { const B = CFG.chains[b];
      send_.push({ eid: B.eid, configType: 1, config: encodeAbiParameters(EXE, [{ maxMessageSize: 10000, executor: A.executor }]) });
      send_.push({ eid: B.eid, configType: 2, config: uln(A.confirmations, A.dvn) });
      recv.push({ eid: B.eid, configType: 2, config: uln(B.confirmations, A.dvn) }); }
    await send(cl, dep.chains[a].factory, F.abi, 'setEscrowLzConfig', [escrows[a], A.sendLib, send_]);
    await send(cl, dep.chains[a].factory, F.abi, 'setEscrowLzConfig', [escrows[a], A.receiveLib, recv]);
    console.log('lz config', a);
  }
}

export async function processListing(nativeKey, listingId) {
  const dep = loadDep(); const acct = deployer();
  const nat = clients(nativeKey, acct); const facA = dep.chains[nativeKey].factory;
  const L = await nat.pub.readContract({ address: facA, abi: F.abi, functionName: 'getListing', args: [BigInt(listingId)] });
  const [name, symbol] = await Promise.all(['name', 'symbol'].map(fn => nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: fn })));
  let supply = 4404n; try { supply = await nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: 'totalSupply' }); } catch {}
  let baseURI = ''; try { baseURI = (await nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: 'tokenURI', args: [1n] })).replace(/1$/, ''); } catch {}
  const rec = (dep.pending && dep.pending[`${nativeKey}:${listingId}`]) || { native: nativeKey, nft: L.nft, owner: L.owner, paid: L.paid.toString(), escrows: { [nativeKey]: L.escrow }, mirrors: {} };
  rec.escrows[nativeKey] = L.escrow;
  for (const eid of L.eids) {
    const key = byEid(eid); if (!key || key === nativeKey || rec.mirrors[key]) continue;
    const cl = clients(key, acct);
    const { r } = await send(cl, dep.chains[key].factory, F.abi, 'deployMirror', [BigInt(listingId), name, symbol, baseURI, 1n, supply]);
    const ev = eventsOf(r, F.abi, 'MirrorDeployed')[0].args;
    rec.mirrors[key] = ev.mirror; rec.escrows[key] = ev.escrow;
    console.log(key, 'mirror', ev.mirror, 'escrow', ev.escrow);
  }
  const keys = Object.keys(rec.escrows);
  for (const a of keys) for (const b of keys) if (a !== b) {
    const cl = clients(a, acct);
    const cur = await cl.pub.readContract({ address: rec.escrows[a], abi: E.abi, functionName: 'peers', args: [CFG.chains[b].eid] }).catch(() => null);
    if (cur && cur.toLowerCase() === b32(rec.escrows[b]).toLowerCase()) { console.log('peer', a, '->', b, '(already)'); continue; }
    await send(cl, dep.chains[a].factory, F.abi, 'setPeer', [rec.escrows[a], CFG.chains[b].eid, b32(rec.escrows[b])]);
    console.log('peer', a, '->', b);
  }
  if (CFG.chains[keys[0]].dvn) await lzConfig(rec.escrows, dep);
  dep.listings[`${nativeKey}:${listingId}`] = rec; saveDep(dep); return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  console.log('mode', MODE);
  if (cmd === 'factories') await factories();
  else if (cmd === 'process') await processListing(a, b);
  else if (cmd === 'gascosts') await setGasCosts();
  else console.log('usage: factories | gascosts | process <nativeChain> <listingId>');
}
