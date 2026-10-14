// MultiSea bridge deployer.
//   node scripts/deploy-bridge.mjs factories            -> deploy a MultiSeaFactory on every configured chain (owner = admin, operator = deployer)
//   node scripts/deploy-bridge.mjs process <chain> <id> -> after a paid listing on <chain>, deploy mirrors on the other selected chains and wire all peers
import { CFG, MODE, art, deployer, loadDep, saveDep, clients, deploy, send, b32, eventsOf } from './lib.mjs';
const F = art('MultiSeaFactory'), M = art('MultiSeaMirror'), N = art('LilFootsTest');
const byEid = eid => Object.keys(CFG.chains).find(k => CFG.chains[k].eid === Number(eid));

export async function factories() {
  const dep = loadDep(); const acct = deployer();
  for (const key of Object.keys(CFG.chains)) {
    if (dep.chains[key]?.factory) { console.log(key, 'factory exists', dep.chains[key].factory); continue; }
    const cl = clients(key, acct); const c = cl.c;
    const factory = await deploy(cl, 'MultiSeaFactory', [c.endpoint, CFG.admin, acct.address, CFG.feeWallet, c.ethUsdFeed, BigInt(CFG.maxPriceAge), BigInt(CFG.supportedChains)]);
    dep.chains[key] = { ...(dep.chains[key] || {}), factory, eid: c.eid, chainId: c.chainId }; saveDep(dep);
    console.log(key, 'factory', factory);
  }
}

export async function processListing(nativeKey, listingId) {
  const dep = loadDep(); const acct = deployer();
  const nat = clients(nativeKey, acct); const facA = dep.chains[nativeKey].factory;
  const L = await nat.pub.readContract({ address: facA, abi: F.abi, functionName: 'getListing', args: [BigInt(listingId)] });
  const [name, symbol] = await Promise.all(['name', 'symbol'].map(fn => nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: fn })));
  let supply = 4404n; try { supply = await nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: 'totalSupply' }); } catch {}
  let baseURI = ''; try { baseURI = (await nat.pub.readContract({ address: L.nft, abi: N.abi, functionName: 'tokenURI', args: [1n] })).replace(/1$/, ''); } catch {}
  const rec = { native: nativeKey, nft: L.nft, owner: L.owner, paid: L.paid.toString(), escrows: { [nativeKey]: L.escrow }, mirrors: {} };
  for (const eid of L.eids) {
    const key = byEid(eid); if (!key || key === nativeKey) continue;
    const cl = clients(key, acct);
    const { r } = await send(cl, dep.chains[key].factory, F.abi, 'deployMirror', [BigInt(listingId), name, symbol, baseURI, 1n, supply]);
    const ev = eventsOf(r, F.abi, 'MirrorDeployed')[0].args;
    rec.mirrors[key] = ev.mirror; rec.escrows[key] = ev.escrow;
    console.log(key, 'mirror', ev.mirror, 'escrow', ev.escrow);
  }
  const keys = Object.keys(rec.escrows);
  for (const a of keys) for (const b of keys) if (a !== b) {
    const cl = clients(a, acct);
    await send(cl, dep.chains[a].factory, F.abi, 'setPeer', [rec.escrows[a], CFG.chains[b].eid, b32(rec.escrows[b])]);
    console.log('peer', a, '->', b);
  }
  dep.listings[`${nativeKey}:${listingId}`] = rec; saveDep(dep); return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  console.log('mode', MODE);
  if (cmd === 'factories') await factories();
  else if (cmd === 'process') await processListing(a, b);
  else console.log('usage: factories | process <nativeChain> <listingId>');
}
