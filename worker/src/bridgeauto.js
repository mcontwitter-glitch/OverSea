// MultiSea bridge auto-listing. A creator prepays the gas-only listing fee at review (factory.prepay(keccak256(slug), eids)).
// Once their drop is verified deployed, a job `bjob:<slug>` is queued; the cron (and the deployed hook) advances it with the
// BRIDGE_OPERATOR_PK server wallet: listPrepaid -> deployMirror per chain -> wire per chain -> public `bcol:<slug>`.
// Every step is idempotent: a sent tx hash is stored before waiting, so a crashed run resumes from its receipt next time.
// DIRECT listings: an owner who pays factory.list(nft, eids) on the native chain (submit page) is picked up too: listpay POSTs the tx to
// /bridge/direct (verified against the on-chain Listed event) and a cron scan of recent Listed logs is the backstop. Those jobs start at
// the `refuel` step (the escrow already exists), read name/symbol/baseURI/supply from the NFT, and PAUSE visibly (job.waiting / job.hold)
// instead of failing when the operator lacks gas on a chain or the token range is unclear.
import { createPublicClient, createWalletClient, http, fallback, parseAbi, parseEventLogs, keccak256, toBytes, pad, defineChain, formatEther } from 'viem';
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
const REF = parseAbi(['function quote(uint32[] dsts, uint128[] amounts, address to) view returns (uint256)', 'function refuel(uint32[] dsts, uint128[] amounts, address to) payable']);
const ESC = parseAbi(['function peers(uint32) view returns (bytes32)']);
const OPS = parseAbi(['function operators(address) view returns (bool)', 'function gasWallet() view returns (address)']);
const NFTABI = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function maxSupply() view returns (uint256)',
  'function baseURI() view returns (string)', 'function tokenURI(uint256) view returns (string)', 'function ownerOf(uint256) view returns (address)', 'function tokenByIndex(uint256) view returns (uint256)']);
const LISTED = FAC.find(x => x.name === 'Listed');
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
const perm = (m, status = 400) => Object.assign(new Error(m), { perm: true, status });
const LOOKBACK = 100000, MAXSPAN = 40000, LEASE_MS = 4 * 60 * 1000;
const NOGAS = /insufficient funds|exceeds the balance|gas required exceeds allowance|insufficient balance/i;
const lc = s => String(s || '').toLowerCase();
const MAX_TX_PER_RUN = 8, MAX_TRIES = 6;

export function makeBridgeAuto({ cfgUrl = 'https://multisea.io/bridge.json', fetchImpl = fetch, clients, rpcsFor, onPublish, now = () => Date.now() } = {}) {
  let cfgP = null;
  const cfg = () => (cfgP ??= fetchImpl(cfgUrl, { cf: { cacheTtl: 300 } }).then(r => r.json()).catch(e => { cfgP = null; throw e; }));
  const keyByEid = (c, eid) => Object.keys(c.chains).find(k => c.chains[k].eid === Number(eid));
  const mk = clients || ((c, k, pk) => {
    const ch = c.chains[k];
    const chain = defineChain({ id: ch.chainId, name: ch.name, nativeCurrency: { name: ch.native, symbol: ch.native, decimals: 18 }, rpcUrls: { default: { http: [ch.rpc] } } });
    // Public RPCs often answer 429 to Cloudflare Worker egress (Robinhood's own RPC always does), so fall through a list of endpoints.
    const urls = [...new Set([...(rpcsFor?.(k) || []), ch.rpc])];
    // Reads fall through on any RPC error (some endpoints lack eth_getLogs or cap ranges); sends use viem's default so a real rejection is not replayed elsewhere.
    const transport = reads => urls.length > 1 ? fallback(urls.map(u => http(u, { timeout: 10000, retryCount: 0 })), { retryCount: 1, ...(reads ? { shouldThrow: () => false } : {}) }) : http(ch.rpc, { timeout: 15000, retryCount: 2 });
    const pub = createPublicClient({ chain, transport: transport(true) });
    const wal = pk ? createWalletClient({ chain, account: privateKeyToAccount(pk), transport: transport(false) }) : null;
    return { pub, wal };
  });

  // Queue a job for a freshly deployed drop that prepaid. Returns the job or null.
  async function enqueue(env, drop, chain, nft) {
    const bp = drop.bridgePrepay; if (!bp || bp.chain !== chain) return null;
    const K = env.COLLECTIONS; if (await K.get('bjob:' + drop.slug)) return null;
    const job = { slug: drop.slug, name: drop.name, symbol: drop.symbol, supply: Number(drop.allocations?.[chain] ?? drop.maxSupply),
      baseURI: drop.baseURI || drop.preRevealURI || '', img: drop.logo || '', native: chain, nft: lc(nft), dropId: keccak256(toBytes(drop.slug)),
      step: 'list', escrows: {}, mirrors: {}, fromBlock: {}, wired: {}, tries: 0, createdAt: new Date().toISOString() };
    await K.put('bjob:' + drop.slug, JSON.stringify(job)); await K.put('bnft:' + chain + ':' + lc(nft), drop.slug); return job;
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
      const hash = await wal.writeContract({ address: c.chains[k].factory, abi: FAC, ...args }).catch(e => { if (NOGAS.test(String(e?.shortMessage || e?.message || e))) throw Object.assign(new Error(`operator wallet is out of gas on ${c.chains[k].name} (${tag}); top it up or wait for the gas drop`), { wait: true }); throw e; });
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
      job.step = 'refuel'; await save();
    }
    const keys = () => job.eids.map(e => keyByEid(c, e)).filter(Boolean);
    const remotes = () => keys().filter(k => k !== job.native);
    // Same units as the creator's fee (src/feeplan.ts): the fee sizes each chain's gas drop at feePlan.dropMarkup (2x) of its price at fee time; the job sizes it at 1.3x the live price, so the fee covers a ~1.5x gas move.
    const setupGas = c.gasUnits ? c.gasUnits.deployMirror + c.gasUnits.wire : c.setupGas || 6300000;
    const setupWei = async k => BigInt(setupGas) * await mk(c, k).pub.getGasPrice() * 13n / 10n;
    // The creator's prepay (received on the native chain) carries each other chain's setup gas there via LayerZero native drops.
    if (job.step === 'refuel') {
      const ref = c.chains[job.native].refuel;
      if (ref) {
        const me = privateKeyToAccount(pk).address, dsts = remotes();
        const amounts = []; for (const k of dsts) { const bal = await mk(c, k).pub.getBalance({ address: me }), need = await setupWei(k); amounts.push(need > bal ? need - bal : 0n); }
        const send = dsts.map((k, i) => [c.chains[k].eid, amounts[i]]).filter(([, a]) => a > 0n);
        if (send.length) {
          const args = [send.map(x => x[0]), send.map(x => x[1]), me];
          const fee = await mk(c, job.native).pub.readContract({ address: ref, abi: REF, functionName: 'quote', args });
          const nb = await mk(c, job.native).pub.getBalance({ address: me }), total = send.reduce((t, x) => t + x[1], 0n) + fee * 102n / 100n;
          if (nb < total * 102n / 100n) throw Object.assign(new Error(`operator wallet ${me} has ${formatEther(nb)} ${c.chains[job.native].native} on ${c.chains[job.native].name} but needs ~${formatEther(total * 102n / 100n)} to send gas to the other chains (LayerZero drop + fee)`), { wait: true });
          await tx(job.native, 'refuel', { address: ref, abi: REF, functionName: 'refuel', args, value: fee * 102n / 100n });
        }
      }
      job.step = 'mirrors'; await save();
    }
    if (job.step === 'mirrors') {
      for (const k of keys()) { if (job.escrows[k]) continue;
        if (job.pending?.tag !== 'mirror:' + k) { const opb = await mk(c, k).pub.getBalance({ address: privateKeyToAccount(pk).address }), need = await setupWei(k); if (opb < need) throw Object.assign(new Error(`waiting for gas on ${c.chains[k].name}: operator has ${formatEther(opb)}, needs ~${formatEther(need)} ${c.chains[k].native} (LayerZero gas drop in flight, or top up)`), { wait: true }); }
        const r = await tx(k, 'mirror:' + k, { functionName: 'deployMirror', args: [BigInt(job.listingId), job.name, job.symbol, job.baseURI, BigInt(job.firstId ?? 1), BigInt(job.supply)] });
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
      await K.put('bcol:' + job.slug, JSON.stringify(col)); job.step = 'done'; job.doneAt = new Date().toISOString(); job.waiting = undefined; await save();
      if (onPublish) await Promise.resolve(onPublish(env, job, col)).catch(e => console.log('bridge onPublish failed', e?.message));
    }
    return job;
  }

  // ---------------- direct listings (factory.list paid by the collection owner) ----------------
  const readMeta = async (c, k, nft) => {
    const { pub } = mk(c, k); const rd = (functionName, args = []) => pub.readContract({ address: nft, abi: NFTABI, functionName, args }).catch(() => null);
    const has = async id => (await rd('ownerOf', [BigInt(id)])) != null;
    const name = String((await rd('name')) || 'Collection').slice(0, 100), symbol = String((await rd('symbol')) || 'NFT').slice(0, 32);
    const ts = await rd('totalSupply'), ms = await rd('maxSupply'); const supply = Number(ts ?? ms ?? 0n);
    const notes = []; let hold = '';
    let firstId = null; for (const id of [0, 1]) if (await has(id)) { firstId = id; break; }
    if (firstId == null) { const t0 = await rd('tokenByIndex', [0n]); if (t0 != null) firstId = Number(t0); }
    if (firstId == null) { firstId = 1; notes.push('first token id not detected, assumed 1'); }
    if (!(supply > 0)) hold = 'could not read totalSupply()/maxSupply() from the NFT contract (or it is 0): set the supply with Retry';
    else if (await has(firstId + supply)) hold = `token id ${firstId + supply} exists beyond totalSupply ${supply} (ids not contiguous?): check the range and Retry with supply/firstId`;
    else if (!(await has(firstId + supply - 1))) notes.push(`last id ${firstId + supply - 1} is not minted/burned; mirror range is [${firstId}, ${firstId + supply})`);
    let baseURI = String((await rd('baseURI')) || '');
    const turi = await rd('tokenURI', [BigInt(firstId)]);
    if (!baseURI && turi) { const t = String(turi); if (t.endsWith(String(firstId))) baseURI = t.slice(0, -String(firstId).length); else { const m = t.match(/^(.*\/)\d+(\.json)?$/); if (m) { baseURI = m[1]; if (m[2]) notes.push('tokenURI ends in .json; mirror metadata URLs will not include the suffix'); } else notes.push('tokenURI is not baseURI + id (on-chain/other); mirror has no baseURI'); } }
    else if (baseURI && turi && String(turi) !== baseURI + firstId) notes.push('tokenURI(first) is not baseURI()+id; mirror metadata may differ');
    if (!baseURI) notes.push('no baseURI found; mirror tokenURI will be empty');
    return { name, symbol, supply, firstId, baseURI, note: notes.join('; '), hold };
  };
  const findJobByNft = async (K, chain, nft) => {
    const l = await K.list({ prefix: 'bjob:' });
    for (const { name } of l.keys) { const j = await K.get(name, 'json'); if (j && j.native === chain && lc(j.nft) === nft) return j; }
    return null;
  };
  const resolveSlug = async (K, chain, nft, meta, listingId) => {
    let slug = await K.get('idx:' + chain + ':' + nft);
    if (!slug) { const l = await K.list({ prefix: 'pending:' });
      for (const { name } of l.keys) { const r = await K.get(name, 'json'); if (r?.deployments?.some(d => d.chain === chain && lc(d.address) === nft)) { slug = r.slug; break; } } }
    if (!slug) slug = `${slugify(meta.name) || 'collection'}-${nft.slice(2, 8)}`;
    const ex = await K.get('bjob:' + slug, 'json'); if (ex && !(ex.native === chain && lc(ex.nft) === nft)) slug = `${slug.slice(0, 32)}-${nft.slice(2, 8)}-${listingId}`;
    return slug;
  };
  const stateOf = j => {
    const done = j.step === 'done', n = (j.eids || []).length, m = Object.keys(j.mirrors || {}).length, w = Object.keys(j.wired || {}).length;
    const state = done ? 'live' : j.hold ? 'held' : j.step === 'failed' ? 'failed' : j.waiting ? 'waiting-gas' : j.step === 'refuel' || j.step === 'list' ? 'queued' : j.step === 'mirrors' ? 'deploying' : j.step === 'wire' ? 'wiring' : 'publishing';
    return { known: true, slug: j.slug, state, step: j.step, chains: n, mirrors: m, wired: w, message: state === 'waiting-gas' ? 'Waiting for gas to reach the deployer on a chain; this resumes automatically.' : state === 'held' ? 'MultiSea is checking your collection’s token range; an admin will resume this.' : state === 'failed' ? 'Deployment hit an error; MultiSea has been alerted and will retry.' : undefined };
  };
  // Verify one Listed event against the chain, then queue a job at the `refuel` step. One job per native nft (bnft marker).
  async function enqueueListed(env, c, chain, a, block, txHash) {
    const K = env.COLLECTIONS; const nft = lc(a.nft); const ch = c.chains[chain];
    const have = await K.get('bnft:' + chain + ':' + nft); if (have) return { slug: have, existing: true };
    const eids = a.eids.map(Number), ks = eids.map(e => keyByEid(c, e));
    if (ks.length < 2 || ks.some(x => !x) || new Set(ks).size !== ks.length || ks[0] !== chain || ks.some(x => !c.chains[x].factory)) throw perm('listing chains are not all supported');
    const { pub } = mk(c, chain);
    const esc = lc(await pub.readContract({ address: ch.factory, abi: FAC, functionName: 'escrowOf', args: [a.nft] }));
    if (esc !== lc(a.escrow) || esc === '0x0000000000000000000000000000000000000000') throw perm('escrow does not match the factory registry');
    const prev = await findJobByNft(K, chain, nft); if (prev) { await K.put('bnft:' + chain + ':' + nft, prev.slug); return { slug: prev.slug, existing: true }; }
    const meta = await readMeta(c, chain, nft); const slug = await resolveSlug(K, chain, nft, meta, Number(a.id));
    const job = { slug, name: meta.name, symbol: meta.symbol, supply: meta.supply, firstId: meta.firstId, baseURI: meta.baseURI, img: '', native: chain, nft, dropId: null,
      step: 'refuel', eids, listingId: Number(a.id), escrows: { [chain]: esc }, mirrors: { [chain]: nft }, fromBlock: { [chain]: Number(block) }, wired: {}, tries: 0,
      direct: true, owner: lc(a.owner), listTx: txHash, note: meta.note || undefined, hold: meta.hold || undefined, createdAt: new Date(now()).toISOString() };
    await K.put('bjob:' + slug, JSON.stringify(job)); await K.put('bnft:' + chain + ':' + nft, slug);
    return { slug, existing: false, job };
  }
  // POST /bridge/direct {chain, tx}: public, safe because the Listed event is checked on-chain against the configured factory.
  async function enqueueDirect(env, { chain, tx }) {
    const c = await cfg(); const ch = c.chains[chain]; const K = env.COLLECTIONS;
    if (!ch?.factory) throw perm('unsupported chain'); if (!/^0x[0-9a-fA-F]{64}$/.test(tx || '')) throw perm('bad tx hash');
    const seen = await K.get('btx:' + chain + ':' + lc(tx), 'json'); if (seen) return directStatus(env, chain, seen.nft);
    const { pub } = mk(c, chain);
    const r = await pub.getTransactionReceipt({ hash: tx }).catch(() => null); if (!r) throw perm('transaction not found yet; wait for it to confirm', 404);
    if (r.status !== 'success') throw perm('that transaction reverted');
    const evs = parseEventLogs({ abi: FAC, logs: r.logs.filter(l => lc(l.address) === lc(ch.factory)), eventName: 'Listed' });
    if (!evs.length) throw perm('no MultiSea Listed event from the factory in that transaction');
    let first = null; for (const ev of evs) { const o = await enqueueListed(env, c, chain, ev.args, r.blockNumber, tx); first ||= ev.args.nft; }
    await K.put('btx:' + chain + ':' + lc(tx), JSON.stringify({ nft: lc(first) }));
    return directStatus(env, chain, first);
  }
  async function directStatus(env, chain, nft) {
    const K = env.COLLECTIONS; const slug = await K.get('bnft:' + chain + ':' + lc(nft)); if (!slug) return { known: false, state: 'unknown' };
    const j = await K.get('bjob:' + slug, 'json'); if (!j) return { known: false, state: 'unknown' };
    return stateOf(j);
  }
  // Backstop (cron): scan recent Listed logs on every factory from the last stored block, enqueue anything without a job.
  async function scan(env) {
    const c = await cfg(); const K = env.COLLECTIONS; const out = {};
    for (const [k, ch] of Object.entries(c.chains)) { if (!ch.factory) continue;
      const { pub } = mk(c, k); out[k] = { enqueued: [] };
      try {
        const head = Math.max(0, Number(await pub.getBlockNumber()) - 2);
        let last = Number(await K.get('bscan:' + k)); if (!last) last = Math.max(0, head - LOOKBACK);
        let span = MAXSPAN, from = last + 1, rounds = 0;
        while (from <= head && rounds++ < 8) {
          const to = Math.min(head, from + span - 1); let logs;
          try { logs = await pub.getLogs({ address: ch.factory, event: LISTED, fromBlock: BigInt(from), toBlock: BigInt(to) }); }
          catch (e) { if (span > 2000) { span = Math.max(2000, Math.floor(span / 4)); continue; } throw e; }
          for (const l of logs) {
            const t = await pub.getTransaction({ hash: l.transactionHash });
            if (await pub.readContract({ address: ch.factory, abi: OPS, functionName: 'operators', args: [t.from] })) continue; // launchpad listPrepaid: already has its own job
            try { const r = await enqueueListed(env, c, k, l.args, l.blockNumber, l.transactionHash); if (!r.existing) out[k].enqueued.push(r.slug); }
            catch (e) { if (!e.perm) throw e; console.log('bridge scan skipped', k, l.transactionHash, e.message); }
          }
          await K.put('bscan:' + k, String(to)); out[k].to = to; from = to + 1;
        }
        await K.delete('bscanerr:' + k);
      } catch (e) { out[k].err = String(e.shortMessage || e.message || e).slice(0, 200); await K.put('bscanerr:' + k, out[k].err); }
    }
    return out;
  }

  // Advance every unfinished job, within a tx budget per run. Called from the cron and right after a drop is deployed.
  // A per-job lease stops the cron and an HTTP-triggered run from sending the same step twice. Paused jobs (gas / token range) keep their
  // reason on the job (job.waiting / job.hold) so the admin status shows it.
  async function run(env) {
    const K = env.COLLECTIONS; const l = await K.list({ prefix: 'bjob:' }); const out = []; const budget = { n: MAX_TX_PER_RUN };
    for (const { name } of l.keys) {
      const job = await K.get(name, 'json'); if (!job || job.step === 'done' || job.step === 'failed') continue;
      if (job.hold) { out.push({ slug: job.slug, step: job.step, hold: job.hold }); continue; }
      if (job.lease && job.lease > now()) { out.push({ slug: job.slug, step: job.step, busy: true }); continue; }
      job.lease = now() + LEASE_MS; await K.put(name, JSON.stringify(job));
      try { await advance(env, job, budget); job.lease = 0; job.waiting = undefined; job.waitingSince = undefined; job.err = undefined; await K.put(name, JSON.stringify(job)); out.push({ slug: job.slug, step: job.step }); }
      catch (e) {
        job.lease = 0;
        if (e.budget) { await K.put(name, JSON.stringify(job)); out.push({ slug: job.slug, step: job.step, paused: true }); break; }
        if (e.wait) { job.waiting = String(e.message).slice(0, 300); job.waitingSince ||= new Date(now()).toISOString(); await K.put(name, JSON.stringify(job)); out.push({ slug: job.slug, step: job.step, waiting: e.message }); continue; }
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

  // Admin view: jobs (with pause reasons) + the server wallet's balance on each chain and each factory's gas wallet (the listing fee lands there).
  async function status(env) {
    const c = await cfg(); const K = env.COLLECTIONS; const l = await K.list({ prefix: 'bjob:' });
    const jobs = (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean).map(j => ({ slug: j.slug, step: j.step, state: stateOf(j).state, direct: !!j.direct, nft: j.nft, native: j.native, err: j.err, tries: j.tries, pending: j.pending, waiting: j.waiting, waitingSince: j.waitingSince, hold: j.hold, note: j.note, mirrors: Object.keys(j.mirrors || {}), wired: Object.keys(j.wired || {}) }));
    let operator = null, balances = {}, gasWallets = {}, scan = {};
    if (env.BRIDGE_OPERATOR_PK) { operator = privateKeyToAccount(env.BRIDGE_OPERATOR_PK).address;
      await Promise.all(Object.keys(c.chains).map(async k => { try { balances[k] = formatEther(await mk(c, k).pub.getBalance({ address: operator })) + ' ' + c.chains[k].native; } catch { balances[k] = 'unknown'; } })); }
    await Promise.all(Object.keys(c.chains).map(async k => { const ch = c.chains[k]; if (ch.factory) { try { gasWallets[k] = await mk(c, k).pub.readContract({ address: ch.factory, abi: OPS, functionName: 'gasWallet' }); } catch { gasWallets[k] = 'unknown'; }
      scan[k] = { block: Number(await K.get('bscan:' + k)) || null, err: (await K.get('bscanerr:' + k)) || undefined }; } }));
    return { operator, operatorIsGasWallet: operator ? Object.values(gasWallets).every(g => lc(g) === lc(operator)) : null, balances, gasWallets, scan, jobs };
  }

  // Admin: retry a failed / held / waiting job from where it stopped. Optional overrides while no mirror exists yet: supply, firstId, baseURI, name, symbol.
  async function retry(env, slug, over = {}) {
    const K = env.COLLECTIONS; const job = await K.get('bjob:' + slug, 'json'); if (!job) return null;
    const fresh = !Object.keys(job.mirrors || {}).some(k => k !== job.native);
    if (fresh) { if (Number.isInteger(over.supply) && over.supply > 0) job.supply = over.supply; if (Number.isInteger(over.firstId) && over.firstId >= 0) job.firstId = over.firstId;
      if (typeof over.baseURI === 'string') job.baseURI = over.baseURI.slice(0, 300); if (over.name) job.name = String(over.name).slice(0, 100); if (over.symbol) job.symbol = String(over.symbol).slice(0, 32); }
    job.hold = undefined; job.waiting = undefined; job.waitingSince = undefined; job.lease = 0;
    if (job.step === 'failed') { job.step = job.listingId ? (!Object.keys(job.escrows).some(k => k !== job.native) && !job.gas?.refuel ? 'refuel' : Object.keys(job.wired).length ? 'wire' : 'mirrors') : 'list'; job.tries = 0; job.err = undefined; }
    await K.put('bjob:' + slug, JSON.stringify(job));
    return job;
  }

  return { enqueue, enqueueDirect, enqueueListed, directStatus, readMeta, scan, run, advance, collections, status, retry };
}
