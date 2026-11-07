// Live mainnet rollout: factories (+ pushed feeds), gas-only listing costs, then a real test round trip with a private
// test collection on Base (Base -> ApeChain -> Base). NET=mainnet MODE=live. The test collection is not published.
import { CFG, MODE, NET, art, deployer, loadDep, saveDep, clients, deploy, send, eventsOf } from './lib.mjs';
import { factories, setGasCosts, processListing } from './deploy-bridge.mjs';
import { formatEther } from 'viem';
if (NET !== 'mainnet' || MODE !== 'live') throw new Error('run with NET=mainnet MODE=live');
const E = art('MultiSeaEscrow'), F = art('MultiSeaFactory'), N = art('LilFootsTest');
const acct = deployer(); const keys = Object.keys(CFG.chains);
const OPTS = '0x0003' + '01' + '0011' + '01' + (300000).toString(16).padStart(32, '0');
const step = process.argv[2] || 'all';
if (step === 'all' || step === 'factories') { await factories(); await setGasCosts(); }
if (step === 'all' || step === 'test') {
  const dep = loadDep(); const NAT = 'base'; const cn = clients(NAT, acct);
  let t = dep.test || {};
  if (!t.nft) { t.nft = await deploy(cn, 'LilFootsTest', [acct.address, 'https://multisea.io/data/lil-foots/meta/']); await send(cn, t.nft, N.abi, 'mint', [acct.address, 7n]); dep.test = t; saveDep(dep); }
  console.log('test collection', t.nft);
  if (!t.listing && !t.listingId) {
    const eids = [NAT, ...keys.filter(k => k !== NAT)].map(k => CFG.chains[k].eid);
    const fee = await cn.pub.readContract({ address: dep.chains[NAT].factory, abi: F.abi, functionName: 'listingFee', args: [eids] });
    console.log('listing fee', formatEther(fee), 'ETH');
    const { r } = await send(cn, dep.chains[NAT].factory, F.abi, 'list', [t.nft, eids], fee * 103n / 100n);
    t.listingId = Number(eventsOf(r, F.abi, 'Listed')[0].args.id); const d2 = loadDep(); d2.test = t; saveDep(d2);
    const rec = await processListing(NAT, t.listingId); t.listing = `${NAT}:${t.listingId}`; const d3 = loadDep(); d3.test = t; saveDep(d3);
  }
  if (!t.listing) { await processListing(NAT, t.listingId); t.listing = `${NAT}:${t.listingId}`; const d4 = loadDep(); d4.test = t; delete d4.pending; saveDep(d4); }
  const rec = loadDep().listings[t.listing];
  const go = async (from, to, token) => {
    const cf = clients(from, acct), ct = clients(to, acct); const esc = rec.escrows[from];
    const [p, lz] = await cf.pub.readContract({ address: esc, abi: E.abi, functionName: 'quote', args: [CFG.chains[to].eid, acct.address, 7n, OPTS] });
    console.log(`${from} -> ${to}: fee ${formatEther(p)} + LZ ${formatEther(lz)} ${CFG.chains[from].native}`);
    await send(cf, token, N.abi, 'approve', [esc, 7n]);
    const { hash } = await send(cf, esc, E.abi, 'bridge', [CFG.chains[to].eid, acct.address, 7n, OPTS], p + lz * 105n / 100n);
    console.log('tx', hash, `https://layerzeroscan.com/tx/${hash}`);
    const dst = to === NAT ? t.nft : rec.mirrors[to];
    for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 15000));
      const o = await ct.pub.readContract({ address: dst, abi: N.abi, functionName: 'ownerOf', args: [7n] }).catch(() => null);
      if (o && o.toLowerCase() === acct.address.toLowerCase()) { console.log('delivered on', to, 'after', (i + 1) * 15, 's'); return true; } }
    console.log('NOT delivered within 20 min'); return false;
  };
  if (await go(NAT, 'apechain', t.nft)) await go('apechain', NAT, rec.mirrors.apechain);
}
