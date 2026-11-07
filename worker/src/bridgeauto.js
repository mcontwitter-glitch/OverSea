// MultiSea bridge auto-listing. A creator prepays the gas-only listing fee at review (factory.prepay(keccak256(slug), eids)).
// Once their drop is verified deployed, a job `bjob:<slug>` is queued; the cron (and the deployed hook) advances it with the
// BRIDGE_OPERATOR_PK server wallet: listPrepaid -> deployMirror per chain -> wire per chain -> public `bcol:<slug>`.
// Every step is idempotent: a sent tx hash is stored before waiting, so a crashed run resumes from its receipt next time.
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, keccak256, toBytes, pad, defineChain, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const FAC = parseAbi([
  'struct Prepaid { address payer; uint32[] eids; uint256 paid; bool used; }',
  'function getPrepaid(bytes32) view returns (Prepaid)',
  'function escrowOf(address) view returns (address)',
  'function listPrepaid(bytes32 dropId, address nft) returns (uint256, address)',
  'function deployMirror(uint256 listingId, string name, string symbol, string baseURI, uint256 firstId, uint256 supply) returns (address, address)',
  'function wire(address escrow, uint32[] eids, bytes32[] peers)',
  'event Listed(uint256 indexed id, address indexed nft, address indexed owner, address escrow, uint32[] eids, uint256 fee)',
  'event MirrorDeployed(uint256 indexed listingId, address mirror, address escrow)',
]);
const ESC = parseAbi(['function peers(uint32) view returns (bytes32)']);
const lc = s => String(s || '').toLowerCase();
const MAX_TX_PER_RUN = 8, MAX_TRIES = 6;

export function makeBridgeAuto({ cfgUrl = 'https://multisea.io/bridge.json', fetchImpl = fetch, clients } = {}) {
  let cfgP = null;
  const cfg = () => (cfgP ??= fetchImpl(cfgUrl, { cf: { cacheTtl: 300 } }).then(r => r.json()).catch(e => { cfgP = null; throw e; }));
  const keyByEid = (c, eid) => Object.keys(c.chains).find(k => c.chains[k].eid === Number(eid));
  const mk = clients || ((c, k, pk) => {
    const ch = c.chains[k];
    const chain = defineChain({ id: ch.chainId, name: ch.name, nativeCurrency: { name: ch.native, symbol: ch.native, decimals: 18 }, rpcUrls: { default: { http: [ch.rpc] } } });
    const pub = createPublicClient({ chain, transport: http(ch.rpc, { timeout: 15000, retryCount: 2 }) });
    const wal = pk ? createWalletClient({ chain, account: privateKeyToAccount(pk), transport: http(ch.rpc, { timeout: 15000, retryCount: 2 }) }) : null;
    return { pub, wal };
  });

  // Queue a job for a freshly deployed drop that prepaid. Returns the job or null.
  async function enqueue(env, drop, chain, nft) {
    const bp = drop.bridgePrepay; if (!bp || bp.chain !== chain) return null;
    const K = env.COLLECTIONS; if (await K.get('bjob:' + drop.slug)) return null;
    const job = { slug: drop.slug, name: drop.name, symbol: drop.symbol, supply: Number(drop.allocations?.[chain] ?? drop.maxSupply),
      baseURI: drop.baseURI || drop.preRevealURI || '', img: drop.logo || '', native: chain, nft: lc(nft), dropId: keccak256(toBytes(drop.slug)),
      step: 'list', escrows: {}, mirrors: {}, fromBlock: {}, wired: {}, tries: 0, createdAt: new Date().toISOString() };
    await K.put('bjob:' + drop.slug, JSON.stringify(job)); return job;
  }

  async function advance(env, job, budget) {
    const c = await cfg(); const pk = env.BRIDGE_OPERATOR_PK; if (!pk) throw new Error('BRIDGE_OPERATOR_PK not set');
    const K = env.COLLECTIONS; const save = () => K.put('bjob:' + job.slug, JSON.stringify(job));
    // Send (or resume) one tx and return its receipt. Stored hash => no double-send after a crash.
    const tx = async (k, tag, args) => {
      const { pub, wal } = mk(c, k, pk);
      if (job.pending?.tag === tag) {
        const r = await pub.waitForTransactionReceipt({ hash: job.pending.hash, timeout: 120000 }).catch(() => null);
        if (r?.status === 'success') { job.pending = null; return r; }
        if (r) job.pending = null; else throw new Error('pending tx not mined yet: ' + job.pending.hash);
      }
      if (budget.n-- <= 0) throw Object.assign(new Error('budget'), { budget: true });
      const hash = await wal.writeContract({ address: c.chains[k].factory, abi: FAC, ...args });
      job.pending = { tag, hash, chain: k }; await save();
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
      job.pending = null; if (r.status !== 'success') throw new Error(`${tag} reverted (${hash})`); (job.gas ??= {})[tag] = Number(r.gasUsed); return r;
    };
    if (job.step === 'list') {
      const { pub } = mk(c, job.native);
      const pre = await pub.readContract({ address: c.chains[job.native].factory, abi: FAC, functionName: 'getPrepaid', args: [job.dropId] });
      if (lc(pre.payer) === lc('0x0000000000000000000000000000000000000000')) throw Object.assign(new Error('no prepayment found for this drop'), { fatal: true });
      job.eids = pre.eids.map(Number);
      const r = await tx(job.native, 'list', { functionName: 'listPrepaid', args: [job.dropId, job.nft] });
      const ev = parseEventLogs({ abi: FAC, logs: r.logs, eventName: 'Listed' })[0].args;
      job.listingId = Number(ev.id); job.escrows[job.native] = lc(ev.escrow); job.mirrors[job.native] = job.nft; job.fromBlock[job.native] = Number(r.blockNumber);
      job.step = 'mirrors'; await save();
    }
    const keys = () => job.eids.map(e => keyByEid(c, e)).filter(Boolean);
    if (job.step === 'mirrors') {
      for (const k of keys()) { if (job.escrows[k]) continue;
        const r = await tx(k, 'mirror:' + k, { functionName: 'deployMirror', args: [BigInt(job.listingId), job.name, job.symbol, job.baseURI, 1n, BigInt(job.supply)] });
        const ev = parseEventLogs({ abi: FAC, logs: r.logs, eventName: 'MirrorDeployed' })[0].args;
        job.mirrors[k] = lc(ev.mirror); job.escrows[k] = lc(ev.escrow); job.fromBlock[k] = Number(r.blockNumber); await save(); }
      job.step = 'wire'; await save();
    }
    if (job.step === 'wire') {
      for (const k of keys()) { if (job.wired[k]) continue;
        const others = keys().filter(o => o !== k);
        await tx(k, 'wire:' + k, { functionName: 'wire', args: [job.escrows[k], others.map(o => c.chains[o].eid), others.map(o => pad(job.escrows[o]))] });
        job.wired[k] = true; await save(); }
      job.step = 'publish'; await save();
    }
    if (job.step === 'publish') {
      const col = { id: `${job.native}:${job.listingId}`, slug: job.slug, mirrorsSlug: job.slug, name: job.name, native: job.native, contracts: job.mirrors, escrows: job.escrows, img: job.img, fromBlock: job.fromBlock };
      await K.put('bcol:' + job.slug, JSON.stringify(col)); job.step = 'done'; job.doneAt = new Date().toISOString(); await save();
    }
    return job;
  }

  // Advance every unfinished job, within a tx budget per run. Called from the cron and right after a drop is deployed.
  async function run(env) {
    const K = env.COLLECTIONS; const l = await K.list({ prefix: 'bjob:' }); const out = []; const budget = { n: MAX_TX_PER_RUN };
    for (const { name } of l.keys) {
      const job = await K.get(name, 'json'); if (!job || job.step === 'done' || job.step === 'failed') continue;
      try { await advance(env, job, budget); out.push({ slug: job.slug, step: job.step }); }
      catch (e) {
        if (e.budget) { out.push({ slug: job.slug, step: job.step, paused: true }); break; }
        job.tries = (job.tries || 0) + 1; job.err = String(e.shortMessage || e.message || e).slice(0, 300);
        if (e.fatal || job.tries >= MAX_TRIES) job.step = 'failed';
        await K.put(name, JSON.stringify(job)); out.push({ slug: job.slug, step: job.step, err: job.err });
      }
    }
    return out;
  }

  async function collections(env) {
    const K = env.COLLECTIONS; const l = await K.list({ prefix: 'bcol:' });
    return (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean);
  }

  // Admin view: jobs + the server wallet's balance on each chain (it pays gas on chains other than the one prepaid on).
  async function status(env) {
    const c = await cfg(); const K = env.COLLECTIONS; const l = await K.list({ prefix: 'bjob:' });
    const jobs = (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean).map(j => ({ slug: j.slug, step: j.step, err: j.err, tries: j.tries, pending: j.pending }));
    let operator = null, balances = {};
    if (env.BRIDGE_OPERATOR_PK) { operator = privateKeyToAccount(env.BRIDGE_OPERATOR_PK).address;
      await Promise.all(Object.keys(c.chains).map(async k => { try { balances[k] = formatEther(await mk(c, k).pub.getBalance({ address: operator })) + ' ' + c.chains[k].native; } catch { balances[k] = 'unknown'; } })); }
    return { operator, balances, jobs };
  }

  // Admin: retry a failed job from where it stopped.
  async function retry(env, slug) {
    const K = env.COLLECTIONS; const job = await K.get('bjob:' + slug, 'json'); if (!job) return null;
    if (job.step === 'failed') { job.step = job.listingId ? (Object.keys(job.wired).length ? 'wire' : 'mirrors') : 'list'; job.tries = 0; job.err = undefined; await K.put('bjob:' + slug, JSON.stringify(job)); }
    return job;
  }

  return { enqueue, run, advance, collections, status, retry };
}
