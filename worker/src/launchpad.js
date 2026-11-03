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
//   GET  /launchpad/mine                      (session) the caller's own approved drops
//   GET  /admin/launchpad/approvals/<slug>    (admin)  EIP-712 typed data per chain for the approver wallet to sign
//   POST /admin/launchpad/approvals/<slug>    (admin)  { chain, signature } -> verified against the on-chain approver, stored
// Approvals: with the LAUNCHPAD_APPROVER_KEY secret (testnet staging) the Worker signs on request. Without it (mainnet) the
// approver wallet signs each chain's approval in /admin (signature only, no transaction) and the Worker hands it to the creator.
import { keccak256, encodeAbiParameters, concat, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const PHASE_T = [{ name: 'start', type: 'uint64' }, { name: 'end', type: 'uint64' }, { name: 'price', type: 'uint128' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'maxSupply', type: 'uint32' }, { name: 'merkleRoot', type: 'bytes32' }];
export const INIT_T = [{ type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'payout', type: 'address' },
  { name: 'feeWallet', type: 'address' }, { name: 'platformFeeBps', type: 'uint16' }, { name: 'maxSupply', type: 'uint32' }, { name: 'creatorReserve', type: 'uint32' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint96' }, { name: 'baseURI', type: 'string' }, { name: 'preRevealURI', type: 'string' },
  { name: 'phases', type: 'tuple[]', components: PHASE_T }] }];
export const OMNI_T = [{ type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'payout', type: 'address' },
  { name: 'feeWallet', type: 'address' }, { name: 'platformFeeBps', type: 'uint16' }, { name: 'maxSupply', type: 'uint32' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint96' }, { name: 'baseURI', type: 'string' }, { name: 'preRevealURI', type: 'string' },
  { name: 'phases', type: 'tuple[]', components: PHASE_T }, { name: 'eids', type: 'uint32[]' }, { name: 'hubEid', type: 'uint32' }, { name: 'prices', type: 'uint128[]' },
  { name: 'copyMode', type: 'uint8' }, { name: 'batchK', type: 'uint16' }, { name: 'batchT', type: 'uint32' }] }];
export const OMNI_APPROVAL_TYPES = { OmniDropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'collectionId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
export const APPROVAL_TYPES = { DropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
const ZERO = '0x0000000000000000000000000000000000000000', ZH = '0x' + '0'.repeat(64);

// Merkle tree compatible with OpenZeppelin MerkleProof (sorted pairs, double-hashed abi.encode(address) leaves).
// ERC-463N7 agent drops (AgentDropFactory in the ERC-463N7 repo). Mirrors AgentDropFactory.AgentInit exactly.
export const LIMITS_C = [{ name: 'skillBps', type: 'uint16' }, { name: 'attackerCooldown', type: 'uint32' }, { name: 'minTargetAge', type: 'uint32' }, { name: 'grace', type: 'uint32' }, { name: 'minGap', type: 'uint32' }, { name: 'targetCooldown', type: 'uint32' }, { name: 'requestTimeout', type: 'uint32' }];
export const AGENT_T = [{ type: 'tuple', components: [{ name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'treasury', type: 'address' }, { name: 'mintPrice', type: 'uint256' }, { name: 'maxSupply', type: 'uint32' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'royaltyBps', type: 'uint16' }, { name: 'starvationPeriod', type: 'uint32' }, { name: 'deathSkill', type: 'bool' }, { name: 'modelId', type: 'uint256' }, { name: 'limits', type: 'tuple', components: LIMITS_C }, { name: 'fertilityBps', type: 'uint16' }, { name: 'twinBps', type: 'uint16' }, { name: 'mutationBps', type: 'uint16' }, { name: 'mutationSkillBps', type: 'uint16' }] }];
export const AGENT_APPROVAL_TYPES = { AgentDropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
export const agentConfigHash = p => keccak256(encodeAbiParameters(AGENT_T, [p]));
export const DEATH_LIMITS_DEFAULT = { attackerCooldown: 86400, minTargetAge: 604800, grace: 172800, minGap: 86400, targetCooldown: 21600, requestTimeout: 86400 };
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
  // deployed: true only once POST /launchpad/deployed verified a contract on-chain against a factory (status 'live').
  // Approved drops without one stay deployed: false, and the site shows them as "Coming soon". (Additive field.)
  const pub = d => ({ ...d, submitter: undefined, approval: undefined, allowlists: undefined, deployed: d.status === 'live' && Array.isArray(d.deployments) && d.deployments.length > 0 });

  const AG = LP.agentDrops || { enabled: false };
  // Agent drop: single chain, one public phase (the engine has one mint price), art rendered on-chain (no URIs needed).
  function validateAgent(b, base) {
    if (!AG.enabled) bad('ERC-463N7 agent drops are not enabled yet', 403);
    if (base.mode !== 'single' || base.chains.length !== 1) bad('agent drops are single-chain (one chain per drop)');
    const chain = base.chains[0]; if (!(AG.chains || []).includes(chain)) bad('agent drops are available on: ' + (AG.chains || []).join(', '));
    if (base.phases.length !== 1 || base.phases[0].kind !== 'public') bad('agent drops have exactly one public phase (one mint price)');
    if (base.creatorReserve) bad('creator reserve is not supported for agent drops');
    const a = b.agent && typeof b.agent === 'object' ? b.agent : {};
    const starveDays = int(a.starveDays ?? 30, 1, 365, 'starvation period (days)');
    const deathSkill = !!a.deathSkill;
    if (deathSkill && !(AG.deathSkillChains || []).includes(chain)) bad('the Death skill needs ORA, available on: ' + (AG.deathSkillChains || []).join(', '));
    const l = a.limits && typeof a.limits === 'object' ? a.limits : {}; const H = 3600;
    const limits = { skillBps: 0, attackerCooldown: int(l.attackerCooldown ?? DEATH_LIMITS_DEFAULT.attackerCooldown, H, 30 * 86400, 'attacker cooldown'), minTargetAge: int(l.minTargetAge ?? DEATH_LIMITS_DEFAULT.minTargetAge, H, 90 * 86400, 'min target age'),
      grace: int(l.grace ?? DEATH_LIMITS_DEFAULT.grace, H, 30 * 86400, 'grace'), minGap: int(l.minGap ?? DEATH_LIMITS_DEFAULT.minGap, H, 30 * 86400, 'min gap between strikes'), targetCooldown: int(l.targetCooldown ?? DEATH_LIMITS_DEFAULT.targetCooldown, H, 30 * 86400, 'target cooldown'), requestTimeout: int(l.requestTimeout ?? DEATH_LIMITS_DEFAULT.requestTimeout, H, 7 * 86400, 'oracle timeout') };
    // Rarity table: % of supply that gets the skill; the creator assigns ids with setSkill then lock() before mint.
    const skillPct = deathSkill ? int(a.skillPct ?? 5, 1, 100, 'Death-skill rarity (%)') : 0;
    // Fertility (female-only rarity) and twin chance: launch-only engine params 12/13; twins capped at 50%.
    const fertility = !!a.fertility; const fertPct = fertility ? int(a.fertPct ?? 10, 1, 100, 'Fertility rarity (%)') : 0; const twinPct = int(a.twinPct ?? 20, 1, 50, 'Twin chance (%)');
    const mutation = !!a.mutation; const mutPct = mutation ? int(a.mutPct ?? 5, 1, 100, 'Mutation rarity (%)') : 0; const mutSkillPct = int(a.mutSkillPct ?? 15, 0, 50, 'Mutation skill chance (%)');
    return { starveDays, deathSkill, limits, skillPct, fertility, fertPct, twinPct, mutation, mutPct, mutSkillPct, modelId: AG.oraModelId ?? 11 };
  }

  function validate(b, creator) {
    const isAgent = b.nftType === 'erc463n7';
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
    // Multichain escrow copies: BATCHED (default) queues them on the hub and flushes one message per chain every K ids or
    // T minutes; AT_MINT sends them with every mint (≈ 5-35x the LayerZero cost, see spec §7.4).
    const BT = LP.batch;
    const copyMode = mode !== 'multichain' ? undefined : (b.copyMode ?? BT.defaultMode) === 'at-mint' ? 'at-mint' : b.copyMode == null || b.copyMode === 'batched' ? 'batched' : bad('copyMode must be batched or at-mint');
    const batchK = copyMode === 'batched' ? int(b.batchK ?? BT.defaultK, BT.minK, BT.maxK, 'batch size K') : undefined;
    const batchTMin = copyMode === 'batched' ? int(b.batchTMin ?? BT.defaultTMin, BT.minTMin, BT.maxTMin, 'batch window T (minutes)') : undefined;
    if (mode === 'multichain' && Number(b.creatorReserve || 0) > 0) bad('creator reserve is not supported in multichain mode yet (mint it in an allowlist phase)');
    const creatorReserve = mode === 'multichain' ? 0 : int(b.creatorReserve ?? 0, 0, allocations[chainsSel[0]], 'creator reserve (taken from the first chain)');
    const royaltyBps = int(b.royaltyBps ?? 0, 0, LP.maxRoyaltyBps, 'royalty bps');
    const payout = lc(b.payout || creator); if (!ADDR.test(payout)) bad('payout must be an address');
    const royaltyReceiver = lc(b.royaltyReceiver || payout); if (!ADDR.test(royaltyReceiver)) bad('royalty receiver must be an address');
    const reveal = b.reveal === 'delayed' ? 'delayed' : 'instant';
    const baseURI = uri(b.baseURI, 'base URI'), preRevealURI = uri(b.preRevealURI, 'pre-reveal URI');
    if (!isAgent && reveal === 'instant' && !baseURI) bad('instant reveal needs the final base URI (ipfs://CID/ or ar://TX/)');
    if (!isAgent && reveal === 'delayed' && !preRevealURI) bad('delayed reveal needs a placeholder URI');
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
      return { name: str(x.name, 40) || (kind === 'allowlist' ? 'Allowlist' : 'Public'), kind, start, end, price, prices, maxPerWallet: int(x.maxPerWallet ?? 0, 0, 1_000_000, 'per-wallet limit'), maxSupply: int(x.maxSupply ?? 0, 0, maxSupply, `phase ${i + 1} max supply (0 = no cap, at most total supply)`), merkleRoot };
    });
    const out = { slug, name, symbol, description: str(b.description, 1000), website: str(b.website, 200), x: str(b.x, 200), logo: str(b.logo, 120), banner: str(b.banner, 120),
      mode, copyMode, batchK, batchTMin, chains: chainsSel, allocations, maxSupply, creatorReserve, royaltyBps, royaltyReceiver, payout, reveal, baseURI, preRevealURI, phases, allowlists, metadataHost: str(b.metadataHost, 20) };
    if (isAgent) { out.nftType = 'erc463n7'; out.agent = validateAgent(b, out); }
    return out;
  }

  const agentParams = (d, creator) => ({ name: d.name, symbol: d.symbol, owner: creator, treasury: d.payout, mintPrice: BigInt(d.phases[0].price), maxSupply: d.maxSupply, maxPerWallet: d.phases[0].maxPerWallet,
    royaltyBps: d.royaltyBps, starvationPeriod: d.agent.starveDays * 86400, deathSkill: d.agent.deathSkill, modelId: BigInt(d.agent.modelId), limits: d.agent.limits,
    fertilityBps: (d.agent.fertPct || 0) * 100, twinBps: (d.agent.twinPct ?? 20) * 100,
    mutationBps: (d.agent.mutPct || 0) * 100, mutationSkillBps: (d.agent.mutSkillPct ?? 15) * 100 });

  const initParams = (d, creator, chain) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.allocations?.[chain] ?? d.maxSupply, creatorReserve: chain === d.chains[0] ? d.creatorReserve : 0,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: BigInt(p.price), maxPerWallet: p.maxPerWallet, maxSupply: Math.min(p.maxSupply ?? 0, d.allocations?.[chain] ?? d.maxSupply), merkleRoot: p.merkleRoot })) });

  const omniParams = (d, creator) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.maxSupply,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: 0n, maxPerWallet: p.maxPerWallet, maxSupply: p.maxSupply ?? 0, merkleRoot: p.merkleRoot })),
    eids: d.chains.map(k => LP.eids[k]), hubEid: LP.eids[LP.hubChain], prices: d.chains.flatMap(k => d.phases.map(p => BigInt(p.prices[k]))),
    copyMode: d.copyMode === 'at-mint' ? 1 : 0, batchK: d.copyMode === 'at-mint' ? 0 : d.batchK ?? LP.batch.defaultK, batchT: d.copyMode === 'at-mint' ? 0 : (d.batchTMin ?? LP.batch.defaultTMin) * 60 });

  // EIP-712 approval for one chain of an approved drop. Creator = the submitter (createDrop: msg.sender; createOmniDrop: p.owner).
  function approvalTyped(d, chain, deadline) {
    const factory = LP.factories?.[chain]; if (!d.chains.includes(chain) || !factory || !chains[chain]) bad('no factory on that chain yet', 501);
    const creator = lc(d.submitter); const domain = { name: 'MultiSeaLaunchpad', version: '1', chainId: chains[chain].chainId, verifyingContract: factory };
    const ser = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    if (d.nftType === 'erc463n7') {
      const af = AG.enabled && AG.factories?.[chain]; if (!af || !d.chains.includes(chain)) bad('no agent drop factory on that chain yet', 501);
      const ip = agentParams(d, creator); const cfg = agentConfigHash(ip);
      const salt = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'address' }], ['agent:' + d.slug, chain, creator]));
      const message = { creator, configHash: cfg, salt, deadline };
      return { typed: { domain: { name: 'MultiSeaAgentLaunchpad', version: '1', chainId: chains[chain].chainId, verifyingContract: af }, types: AGENT_APPROVAL_TYPES, primaryType: 'AgentDropApproval', message }, out: { kind: 'agent', chain, factory: af, salt, deadline: deadline.toString(), configHash: cfg, params: ser(ip) } };
    }
    if (d.mode === 'multichain') {
      if (!LP.omniEscrows?.[chain]) bad('no multichain escrow on that chain yet', 501);
      const ip = omniParams(d, creator); const cfg = omniConfigHash(ip); const collectionId = collectionIdOf(d.slug, creator);
      const message = { creator, configHash: cfg, collectionId, deadline };
      return { typed: { domain, types: OMNI_APPROVAL_TYPES, primaryType: 'OmniDropApproval', message }, out: { mode: 'multichain', chain, factory, collectionId, deadline: deadline.toString(), configHash: cfg, params: ser(ip) } };
    }
    const ip = initParams(d, creator, chain); const cfg = configHash(ip);
    const salt = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'address' }], [d.slug, chain, creator]));
    const message = { creator, configHash: cfg, salt, deadline };
    return { typed: { domain, types: APPROVAL_TYPES, primaryType: 'DropApproval', message }, out: { chain, factory, salt, deadline: deadline.toString(), configHash: cfg, params: ser(ip) } };
  }

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
      if (M === 'GET' && p[1] === 'mine' && p.length === 2) { // the signed-in creator's own drops (submitter is never public)
        const s = await requireSession(req, env); const l = await K.list({ prefix: 'ldrop:' });
        const ds = (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(d => d && lc(d.submitter) === s.address);
        return { drops: ds.map(d => ({ slug: d.slug, status: d.status, chains: d.chains, deployed: (d.deployments || []).map(x => x.chain) })) };
      }
      if (M === 'POST' && p[1] === 'approval' && p.length === 3) {
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('only the creator can request a deploy approval', 403);
        const b = await body(); const chain = b.chain;
        if (env.LAUNCHPAD_APPROVER_KEY) {
          const t = approvalTyped(d, chain, BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec));
          const signature = await privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY).signTypedData(t.typed);
          return { ...t.out, signature };
        }
        if (!LP.approver) bad('launchpad deploy approvals are not enabled yet', 501);
        approvalTyped(d, chain, 0n); // validates chain / factory / escrow
        const st = await K.get(`lsig:${d.slug}:${chain}`, 'json');
        if (!st || BigInt(st.deadline) <= BigInt(Math.floor(now() / 1000) + 600)) bad('waiting for MultiSea to sign the deploy approval for ' + chain + ' (usually within a day)', 409);
        return { ...approvalTyped(d, chain, BigInt(st.deadline)).out, signature: st.signature };
      }
      if (M === 'POST' && p[1] === 'deployed' && p.length === 3) {
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('creator only', 403);
        const b = await body(); const chain = b.chain, address = lc(b.address);
        if (!d.chains.includes(chain) || !ADDR.test(address)) bad('bad chain/address');
        const fac = d.nftType === 'erc463n7' ? (AG.enabled && AG.factories?.[chain]) : LP.factories[chain];
        if (!fac || !(await isDropOnChain(chain, fac, address))) bad('address is not a MultiSea launchpad drop on ' + chain);
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
      const s = await requireSession(req, env); const K = env.COLLECTIONS;
      // The factory approver wallet (not necessarily an admin) may read and sign deploy approvals; nothing else.
      if (p[2] === 'approvals' && !admins(env).includes(s.address) && s.address !== lc(LP.approver || '')) bad('admin or approver only', 403);
      if (p[2] === 'approvals' && (M === 'GET' || M === 'POST')) {
        if (!p[3] && M === 'GET') { const l = await K.list({ prefix: 'ldrop:' }); const ds = (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(d => d && d.kind !== 'ordinals' && d.mode !== 'ordinals' && d.status !== 'rejected');
          return { approver: LP.approver || null, drops: ds.filter(d => d.chains.some(c => LP.factories?.[c] && !(d.deployments || []).some(x => x.chain === c))).map(d => ({ slug: d.slug, name: d.name, mode: d.mode, chains: d.chains, submitter: d.submitter })) }; }
        if (!SLUG.test(p[3] || '')) bad('bad slug');
        const d = await K.get('ldrop:' + p[3], 'json'); if (!d) bad('not an approved drop', 404); if (!LP.approver) bad('no approver configured', 501);
        const ser = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        if (M === 'GET') {
          const out = [];
          for (const chain of d.chains) { if (!LP.factories?.[chain]) continue; const st = await K.get(`lsig:${d.slug}:${chain}`, 'json');
            const deadline = BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec); const done = (d.deployments || []).some(x => x.chain === chain);
            out.push({ chain, signed: !!st, deadline: st?.deadline, deployed: done, typed: ser(approvalTyped(d, chain, deadline).typed) }); }
          return { approver: LP.approver, approvals: out };
        }
        const b = await req.json().catch(() => ({})); const chain = b?.chain; const sig = String(b?.signature || '');
        if (!/^0x[0-9a-fA-F]{130}$/.test(sig) || !/^\d{1,12}$/.test(String(b?.deadline ?? ''))) bad('signature and deadline required');
        const deadline = BigInt(b.deadline); if (deadline <= BigInt(Math.floor(now() / 1000)) || deadline > BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec + 3600)) bad('deadline out of range');
        const t = approvalTyped(d, chain, deadline);
        const signer = lc(await recoverTypedDataAddress({ ...t.typed, signature: sig }));
        if (signer !== lc(LP.approver)) bad(`signature is from ${signer}, not the factory approver ${lc(LP.approver)}`, 403);
        await K.put(`lsig:${d.slug}:${chain}`, JSON.stringify({ signature: sig, deadline: deadline.toString(), signedBy: s.address, at: new Date(now()).toISOString() }));
        return { ok: true, chain, deadline: deadline.toString() };
      }
      if (!admins(env).includes(s.address)) bad('admin only', 403);
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
