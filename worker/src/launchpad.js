// MultiSea Launchpad (PREVIEW, not deployed): drop submissions -> admin review -> EIP-712 deploy approval -> live drop.
// KV keys (COLLECTIONS namespace):
//   lpending:<slug>  submitted drop awaiting review      ldrop:<slug>   approved / deployed drop (public)
//   lrejected:<slug> rejected drop (+reason)            lallow:<slug>:<phase>  allowlist addresses (lowercase, sorted)
// Endpoints:
//   GET  /launchpad/drops                     public list (approved + live)
//   GET  /launchpad/drops/<slug>              one drop (phases, no allowlist contents)
//   GET  /launchpad/proof/<slug>/<phase>/<a>  { eligible, proof[] } Merkle proof for an allowlist phase
//   POST /launchpad/submit             (SIWE) creator submits a drop
//   POST /launchpad/approval/<slug>    (SIWE, creator) EIP-712 DropApproval for MultiSeaLaunchpadFactory.createDrop
//   POST /launchpad/deployed/<slug>    (SIWE, creator) { chain, address } -> verified isDrop() on the factory -> live + listed
//   GET  /admin/launchpad/pending      (admin)  review queue
//   POST /admin/launchpad/approve|reject/<slug> (admin)
import { keccak256, encodeAbiParameters, concat } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const PHASE_T = [{ name: 'start', type: 'uint64' }, { name: 'end', type: 'uint64' }, { name: 'price', type: 'uint128' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'merkleRoot', type: 'bytes32' }];
export const INIT_T = [{ type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'payout', type: 'address' },
  { name: 'feeWallet', type: 'address' }, { name: 'platformFeeBps', type: 'uint16' }, { name: 'maxSupply', type: 'uint32' }, { name: 'creatorReserve', type: 'uint32' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint96' }, { name: 'baseURI', type: 'string' }, { name: 'preRevealURI', type: 'string' },
  { name: 'phases', type: 'tuple[]', components: PHASE_T }] }];
export const OMNI_T = [{ type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'payout', type: 'address' },
  { name: 'feeWallet', type: 'address' }, { name: 'platformFeeBps', type: 'uint16' }, { name: 'maxSupply', type: 'uint32' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint96' }, { name: 'baseURI', type: 'string' }, { name: 'preRevealURI', type: 'string' },
  { name: 'phases', type: 'tuple[]', components: PHASE_T }, { name: 'eids', type: 'uint32[]' }, { name: 'hubEid', type: 'uint32' }, { name: 'prices', type: 'uint128[]' }] }];
export const OMNI_APPROVAL_TYPES = { OmniDropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'collectionId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
export const APPROVAL_TYPES = { DropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
const ZERO = '0x0000000000000000000000000000000000000000', ZH = '0x' + '0'.repeat(64);

// Merkle tree compatible with OpenZeppelin MerkleProof (sorted pairs, double-hashed abi.encode(address) leaves).
export const leafOf = a => keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [a])));
const hpair = (a, b) => keccak256(a < b ? concat([a, b]) : concat([b, a]));
export function merkle(addrs) {
  let lvl = [...new Set(addrs.map(a => a.toLowerCase()))].map(leafOf).sort();
  if (!lvl.length) return { root: ZH, layers: [[]] };
  const layers = [lvl];
  while (lvl.length > 1) { const n = []; for (let i = 0; i < lvl.length; i += 2) n.push(i + 1 < lvl.length ? hpair(lvl[i], lvl[i + 1]) : lvl[i]); layers.push(lvl = n); }
  return { root: lvl[0], layers };
}
export function proofFor(layers, addr) {
  let i = layers[0].indexOf(leafOf(addr.toLowerCase())); if (i < 0) return null; const out = [];
  for (let l = 0; l < layers.length - 1; l++) { const sib = i ^ 1; if (sib < layers[l].length) out.push(layers[l][sib]); i >>= 1; }
  return out;
}
/** Mirrors MultiSeaLaunchpadFactory.configHash: abi.encode(InitParams) with feeWallet/platformFeeBps zeroed. */
/** Mirrors MultiSeaLaunchpadFactory.omniConfigHash for multichain (escrow) drops. */
export const omniConfigHash = p => keccak256(encodeAbiParameters(OMNI_T, [{ ...p, feeWallet: ZERO, platformFeeBps: 0 }]));
/** Same collection id on every chain: routes LayerZero messages between the drop's clones. */
export const collectionIdOf = (slug, creator) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [slug, creator]));
export const configHash = p => keccak256(encodeAbiParameters(INIT_T, [{ ...p, feeWallet: ZERO, platformFeeBps: 0 }]));

export function makeLaunchpad({ LP, chains, lc, bad, ADDR, admins, requireSession, isDropOnChain, now = () => Date.now() }) {
  const SLUG = /^[a-z0-9-]{3,40}$/;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const int = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) bad(`${what} must be an integer ${lo}-${hi}`); return n; };
  const wei = (v, what) => { if (!/^\d{1,30}$/.test(String(v ?? ''))) bad(`${what} must be a wei integer string`); return String(v); };
  const uri = (v, what) => { const s = str(v, 200); if (s && !/^(ipfs:\/\/|ar:\/\/|https:\/\/)[\w\-./?=&%#]+$/.test(s)) bad(`${what} must be ipfs://, ar:// or https://`); return s; };
  const pub = d => ({ ...d, submitter: undefined, approval: undefined, allowlists: undefined });

  function validate(b, creator) {
    const slug = str(b.slug, 40); if (!SLUG.test(slug)) bad('slug must be 3-40 chars a-z 0-9 -');
    const name = str(b.name, 60); if (!name) bad('name required');
    const symbol = str(b.symbol, 12).toUpperCase(); if (!/^[A-Z0-9]{1,12}$/.test(symbol)) bad('symbol must be 1-12 letters/digits');
    const chainsSel = Array.isArray(b.chains) ? [...new Set(b.chains)] : []; if (!chainsSel.length || chainsSel.some(k => !LP.chains.includes(k) || !chains[k])) bad('pick supported chains: ' + LP.chains.join(', '));
    const mode = b.mode === 'multichain' ? 'multichain' : 'single';
    if (mode === 'multichain' && chainsSel.length < 2) bad('multichain drops need at least 2 chains');
    // Multichain: the hub chain (Base) assigns every token id and enforces the shared supply, so it must be in the drop.
    if (mode === 'multichain' && !chainsSel.includes(LP.hubChain)) bad(`multichain drops must include ${chains[LP.hubChain]?.name || LP.hubChain} (the supply hub)`);
    const maxSupply = int(b.maxSupply, 1, 1_000_000, 'supply');
    // Per-chain allocation: each chain is its own contract with its own maxSupply. Default: everything on the first chain.
    // Single chain: per-chain editions that must add up to the total. Multichain: ONE shared supply, no per-chain split
    // (any chain can mint the next id; the hub assigns it), so allocations are not used.
    let allocations;
    if (mode === 'single') {
      allocations = {}; const al = b.allocations && typeof b.allocations === 'object' ? b.allocations : { [chainsSel[0]]: maxSupply };
      for (const k of chainsSel) allocations[k] = int(al[k] ?? 0, 0, maxSupply, `${k} supply`);
      if (Object.values(allocations).reduce((a, v) => a + v, 0) !== maxSupply) bad('per-chain supplies must add up to the total supply');
      if (Object.entries(allocations).some(([, v]) => v === 0)) bad('every selected chain needs a supply');
    }
    if (mode === 'multichain' && Number(b.creatorReserve || 0) > 0) bad('creator reserve is not supported in multichain mode yet (mint it in an allowlist phase)');
    const creatorReserve = mode === 'multichain' ? 0 : int(b.creatorReserve ?? 0, 0, allocations[chainsSel[0]], 'creator reserve (taken from the first chain)');
    const royaltyBps = int(b.royaltyBps ?? 0, 0, LP.maxRoyaltyBps, 'royalty bps');
    const payout = lc(b.payout || creator); if (!ADDR.test(payout)) bad('payout must be an address');
    const royaltyReceiver = lc(b.royaltyReceiver || payout); if (!ADDR.test(royaltyReceiver)) bad('royalty receiver must be an address');
    const reveal = b.reveal === 'delayed' ? 'delayed' : 'instant';
    const baseURI = uri(b.baseURI, 'base URI'), preRevealURI = uri(b.preRevealURI, 'pre-reveal URI');
    if (reveal === 'instant' && !baseURI) bad('instant reveal needs the final base URI (ipfs://CID/ or ar://TX/)');
    if (reveal === 'delayed' && !preRevealURI) bad('delayed reveal needs a placeholder URI');
    const ph = Array.isArray(b.phases) ? b.phases : []; if (!ph.length || ph.length > LP.maxPhases) bad(`1-${LP.maxPhases} phases`);
    const allowlists = {}; let totalAllow = 0;
    const phases = ph.map((x, i) => {
      const start = int(x.start, 0, 2 ** 40, 'phase start'), end = int(x.end ?? 0, 0, 2 ** 40, 'phase end'); if (end && end <= start) bad(`phase ${i + 1}: end before start`);
      const kind = x.kind === 'allowlist' ? 'allowlist' : 'public'; let merkleRoot = ZH;
      if (kind === 'allowlist') {
        const list = (Array.isArray(x.allowlist) ? x.allowlist : []).map(lc); if (!list.length || list.some(a => !ADDR.test(a))) bad(`phase ${i + 1}: allowlist needs valid 0x addresses`);
        totalAllow += list.length; if (totalAllow > LP.maxAllowlist) bad(`allowlists capped at ${LP.maxAllowlist} addresses in this version`);
        const u = [...new Set(list)].sort(); allowlists[i] = u; merkleRoot = merkle(u).root;
      }
      const price = wei(x.price, `phase ${i + 1} price`);
      // Multichain: one price per chain in that chain's native token (ETH / APE / BNB); defaults to `price` for ETH chains.
      const prices = mode === 'multichain' ? Object.fromEntries(chainsSel.map(k => [k, wei(x.prices?.[k] ?? (chains[k].native === 'ETH' ? price : undefined), `phase ${i + 1} price on ${k}`)])) : undefined;
      return { name: str(x.name, 40) || (kind === 'allowlist' ? 'Allowlist' : 'Public'), kind, start, end, price, prices, maxPerWallet: int(x.maxPerWallet ?? 0, 0, 1_000_000, 'per-wallet limit'), merkleRoot };
    });
    return { slug, name, symbol, description: str(b.description, 1000), website: str(b.website, 200), x: str(b.x, 200), logo: str(b.logo, 120), banner: str(b.banner, 120),
      mode, chains: chainsSel, allocations, maxSupply, creatorReserve, royaltyBps, royaltyReceiver, payout, reveal, baseURI, preRevealURI, phases, allowlists, metadataHost: str(b.metadataHost, 20) };
  }

  const initParams = (d, creator, chain) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.allocations?.[chain] ?? d.maxSupply, creatorReserve: chain === d.chains[0] ? d.creatorReserve : 0,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: BigInt(p.price), maxPerWallet: p.maxPerWallet, merkleRoot: p.merkleRoot })) });

  const omniParams = (d, creator) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.maxSupply,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: 0n, maxPerWallet: p.maxPerWallet, merkleRoot: p.merkleRoot })),
    eids: d.chains.map(k => LP.eids[k]), hubEid: LP.eids[LP.hubChain], prices: d.chains.flatMap(k => d.phases.map(p => BigInt(p.prices[k]))) });

  async function handle(req, env, url, p, M, body) {
    if (p[0] === 'launchpad') {
      const K = env.COLLECTIONS;
      if (M === 'GET' && p[1] === 'drops' && p.length === 2) { const l = await K.list({ prefix: 'ldrop:' }); return { drops: (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean).map(pub) }; }
      if (M === 'GET' && p[1] === 'drops' && p.length === 3) { const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404); return { drop: pub(d) }; }
      if (M === 'GET' && p[1] === 'proof' && p.length === 5) {
        const ph = Number(p[3]); const a = lc(p[4]); if (!ADDR.test(a) || !Number.isInteger(ph)) bad('bad request');
        const list = await K.get(`lallow:${p[2]}:${ph}`, 'json'); if (!list) return { eligible: false, proof: [] };
        const pr = proofFor(merkle(list).layers, a); return { eligible: !!pr, proof: pr || [] };
      }
      if (M === 'POST' && p[1] === 'submit') {
        const s = await requireSession(req, env); const d = validate(await body(), s.address);
        if ((await K.get('ldrop:' + d.slug)) || (await K.get('lpending:' + d.slug)) || (await K.get('col:' + d.slug))) bad('slug already used');
        await K.put('lpending:' + d.slug, JSON.stringify({ ...d, kind: 'drop', submitter: s.address, status: 'pending', submittedAt: new Date(now()).toISOString() }));
        return { ok: true, status: 'pending', slug: d.slug };
      }
      if (M === 'POST' && p[1] === 'approval' && p.length === 3) {
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('only the creator can request a deploy approval', 403);
        if (!env.LAUNCHPAD_APPROVER_KEY) bad('launchpad deploy approvals are not enabled yet', 501);
        const b = await body(); const chain = b.chain; const factory = LP.factories[chain]; if (!d.chains.includes(chain) || !factory) bad('no factory on that chain yet', 501);
        if (d.mode === 'multichain') {
          if (!LP.omniEscrows?.[chain]) bad('no multichain escrow on that chain yet', 501);
          const ip = omniParams(d, s.address); const cfg = omniConfigHash(ip); const collectionId = collectionIdOf(d.slug, s.address);
          const deadline = BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec);
          const signature = await privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY).signTypedData({ domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: chains[chain].chainId, verifyingContract: factory }, types: OMNI_APPROVAL_TYPES, primaryType: 'OmniDropApproval', message: { creator: s.address, configHash: cfg, collectionId, deadline } });
          return { mode: 'multichain', chain, factory, collectionId, deadline: deadline.toString(), signature, configHash: cfg, params: JSON.parse(JSON.stringify(ip, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) };
        }
        const ip = initParams(d, s.address, chain); const cfg = configHash(ip);
        const salt = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'address' }], [d.slug, chain, s.address]));
        const deadline = BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec);
        const acct = privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY);
        const signature = await acct.signTypedData({ domain: { name: 'MultiSeaLaunchpad', version: '1', chainId: chains[chain].chainId, verifyingContract: factory }, types: APPROVAL_TYPES, primaryType: 'DropApproval', message: { creator: s.address, configHash: cfg, salt, deadline } });
        return { chain, factory, salt, deadline: deadline.toString(), signature, configHash: cfg, params: JSON.parse(JSON.stringify(ip, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) };
      }
      if (M === 'POST' && p[1] === 'deployed' && p.length === 3) {
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('creator only', 403);
        const b = await body(); const chain = b.chain, address = lc(b.address);
        if (!d.chains.includes(chain) || !ADDR.test(address)) bad('bad chain/address');
        if (!LP.factories[chain] || !(await isDropOnChain(chain, LP.factories[chain], address))) bad('address is not a MultiSea launchpad drop on ' + chain);
        const deployments = [...(d.deployments || []).filter(x => x.chain !== chain), { chain, address }];
        const live = { ...d, deployments, status: 'live' }; await K.put('ldrop:' + d.slug, JSON.stringify(live));
        // Auto-list on MultiSea: the drop becomes a normal approved collection page /c/<slug> (trading uses the 0.5% marketplace fee).
        const col = (await K.get('col:' + d.slug, 'json')) || { slug: d.slug, name: d.name, description: d.description, website: d.website, x: d.x, logo: d.logo, banner: d.banner, escrow: [], submitter: d.submitter, status: 'approved', approvedAt: new Date(now()).toISOString(), source: 'launchpad' };
        col.deployments = deployments;
        // Multichain: the shared per-chain escrow holds every non-Active copy, so it is excluded from holder counts.
        if (d.mode === 'multichain') col.escrow = deployments.map(x => ({ chain: x.chain, address: lc(LP.omniEscrows?.[x.chain] || ZERO) })).filter(x => x.address !== ZERO);
        await K.put('col:' + d.slug, JSON.stringify(col));
        return { ok: true, drop: pub(live) };
      }
      return undefined;
    }
    if (p[0] === 'admin' && p[1] === 'launchpad') {
      const s = await requireSession(req, env); if (!admins(env).includes(s.address)) bad('admin only', 403);
      const K = env.COLLECTIONS;
      if (M === 'GET' && p[2] === 'pending') { const l = await K.list({ prefix: 'lpending:' }); return { pending: (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean).map(d => ({ ...d, allowlists: undefined, allowlistCounts: Object.fromEntries(Object.entries(d.allowlists || {}).map(([k, v]) => [k, v.length])) })) }; }
      if (M === 'POST' && (p[2] === 'approve' || p[2] === 'reject') && SLUG.test(p[3] || '')) {
        const rec = await K.get('lpending:' + p[3], 'json'); if (!rec) bad('no such pending drop', 404);
        const b = await req.json().catch(() => ({})); await K.delete('lpending:' + p[3]);
        if (p[2] === 'reject') { await K.put('lrejected:' + p[3], JSON.stringify({ ...rec, status: 'rejected', reason: str(b?.reason, 300), reviewedBy: s.address, reviewedAt: new Date(now()).toISOString() })); return { ok: true, status: 'rejected' }; }
        for (const [i, list] of Object.entries(rec.allowlists || {})) await K.put(`lallow:${rec.slug}:${i}`, JSON.stringify(list));
        const d = { ...rec, allowlists: undefined, status: 'approved', approvedBy: s.address, approvedAt: new Date(now()).toISOString() };
        await K.put('ldrop:' + rec.slug, JSON.stringify(d)); return { ok: true, status: 'approved', drop: pub(d) };
      }
    }
    return undefined;
  }
  return { handle, validate, initParams };
}
