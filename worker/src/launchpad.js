// MultiSea Launchpad: drop submissions -> admin review -> EIP-712 deploy approval -> live drop.
// KV keys (COLLECTIONS namespace):
//   lpending:<slug>  submitted drop awaiting review      ldrop:<slug>   approved / deployed drop (public)
//   lrejected:<slug> rejected drop (+reason)            lallow:<slug>:<phase>  allowlist addresses (EVM lowercased, Solana base58 as-is, sorted)
// Endpoints:
//   GET  /launchpad/solana                    { on, programId, store, escrows } Solana switch (KV lp:solana)
//   POST /launchpad/solana/enable             { message, signature } MC's signed "turn Solana on" -> on-chain check -> on
//   GET  /launchpad/drops                     public list (approved + live)
//   GET  /launchpad/drops/<slug>              one drop (phases, no allowlist contents)
//   GET  /launchpad/proof/<slug>/<phase>/<a>  { eligible, proof[] } Merkle proof for an allowlist phase
//   POST /launchpad/submit             (SIWE) creator submits a drop
//   POST /launchpad/approval/<slug>    (SIWE, creator) EIP-712 DropApproval for MultiSeaLaunchpadFactory.createDrop
//   POST /launchpad/deployed/<slug>    (SIWE, creator) { chain, address } -> verified isDrop() on the factory -> live + listed
//   GET  /admin/launchpad/pending      (admin)  review queue
//   POST /admin/launchpad/approve|reject/<slug> (admin)
//   GET  /launchpad/reveal-uri/<slug>       (session, creator) { baseURI } stored for a delayed-reveal drop
//   GET  /launchpad/mine                      (session) the caller's own approved drops
//   GET  /admin/launchpad/approvals/<slug>    (admin)  EIP-712 typed data per chain for the approver wallet to sign
//   POST /admin/launchpad/approvals/<slug>    (admin)  { chain, signature } -> verified against the on-chain approver, stored
// Approvals: with the LAUNCHPAD_APPROVER_KEY secret (testnet staging) the Worker signs on request. Without it (mainnet) the
// approver wallet signs each chain's approval in /admin (signature only, no transaction) and the Worker hands it to the creator.
import { keccak256, encodeAbiParameters, concat, recoverTypedDataAddress, recoverMessageAddress, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { solKey, solName, dropApprovalDigest as solDigest, recoverSolApprover } from './solanadrop.js';

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
export const INFECT_C = [{ name: 'skillBps', type: 'uint16' }, { name: 'cooldown', type: 'uint32' }, { name: 'maxPrice', type: 'uint128' }, { name: 'scoreReward', type: 'uint32' }];
export const AGENT_T = [{ type: 'tuple', components: [{ name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'treasury', type: 'address' }, { name: 'mintPrice', type: 'uint256' }, { name: 'maxSupply', type: 'uint32' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'royaltyBps', type: 'uint16' }, { name: 'starvationPeriod', type: 'uint32' }, { name: 'deathSkill', type: 'bool' }, { name: 'modelId', type: 'uint256' }, { name: 'limits', type: 'tuple', components: LIMITS_C }, { name: 'fertilityBps', type: 'uint16' }, { name: 'twinBps', type: 'uint16' }, { name: 'mutationBps', type: 'uint16' }, { name: 'mutationSkillBps', type: 'uint16' }, { name: 'infect', type: 'bool' }, { name: 'infectLimits', type: 'tuple', components: INFECT_C }, { name: 'repoBps', type: 'uint16' }, { name: 'queenBps', type: 'uint16' }, { name: 'queenCap', type: 'uint32' }, { name: 'zombieBps', type: 'uint16' }, { name: 'tributeFee', type: 'uint256' }, { name: 'tributePeriod', type: 'uint32' }, { name: 'kit', type: 'bytes' }] }];
// AgentInit.kit = abi.encode(string mediaBase, string mediaExt, string deathURI, Phase[] phases, uint32 traitRows,
// uint16 skillInheritanceBoostBps, bytes growthConfig) for AgentDropKit + AgentGrowth. growthConfig is ABI-encoded
// AgentGrowth.Config (uint16 mutationBps, uint16[6] xp, uint32[] levels); empty bytes select contract defaults.
// traitRows > 0 = the creator signed CSV traits for gen-0 ids 1..traitRows: mint stays closed until kit.uploadTraits seals them (or skipTraits)
// (art + MultiSeaDrop-layout phases). Phase = (uint64 start, uint64 end, uint128 price, uint32 maxPerWallet, uint32 maxSupply, bytes32 merkleRoot).
export const KIT_PHASE_C = [{ name: 'start', type: 'uint64' }, { name: 'end', type: 'uint64' }, { name: 'price', type: 'uint128' }, { name: 'maxPerWallet', type: 'uint32' }, { name: 'maxSupply', type: 'uint32' }, { name: 'merkleRoot', type: 'bytes32' }];
export const KIT_T = [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'tuple[]', components: KIT_PHASE_C }, { type: 'uint32' }, { type: 'uint16' }, { type: 'bytes' }];
export const GROWTH_T = [{ type: 'tuple', components: [{ name: 'mutationBps', type: 'uint16' }, { name: 'xp', type: 'uint16[6]' }, { name: 'levels', type: 'uint32[]' }] }];
export const DEFAULT_GROWTH = { mutationBps: 500, xp: [10, 50, 25, 100, 5, 20], levels: [0, 100, 300, 600, 1000] };
export const agentGrowth = (g) => { if (g == null || g === '') return '0x'; const v = { ...DEFAULT_GROWTH, ...g };
  if (!Number.isInteger(v.mutationBps) || v.mutationBps < 0 || v.mutationBps > 10000) badGrowth('alternate-value chance');
  if (!Array.isArray(v.xp) || v.xp.length !== 6 || v.xp.some(x => !Number.isInteger(x) || x < 0 || x > 65535)) badGrowth('XP awards');
  if (!Array.isArray(v.levels) || !v.levels.length || v.levels.length > 255 || v.levels[0] !== 0 || v.levels.some((x, i) => !Number.isInteger(x) || x < 0 || x > 0xffffffff || (i && x <= v.levels[i - 1]))) badGrowth('level thresholds');
  return encodeAbiParameters(GROWTH_T, [{ mutationBps: v.mutationBps, xp: v.xp, levels: v.levels }]);
};
const badGrowth = what => { throw new Error(`${what} is not a valid AgentGrowth config`); };
export const agentKit = ({ mediaBase = '', mediaExt = '', deathURI = '', phases = [], traitRows = 0, skillInheritanceBoostBps = 1000, growthConfig = '0x' }) => encodeAbiParameters(KIT_T, [mediaBase, mediaExt, deathURI, phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end || 0), price: BigInt(p.price), maxPerWallet: p.maxPerWallet || 0, maxSupply: p.maxSupply || 0, merkleRoot: p.merkleRoot || ZH })), traitRows, skillInheritanceBoostBps, growthConfig]);
// Death image: one direct image file (not a folder / JSON). Media base: folder of <n><ext> pinned by the create form.
export const DEATH_RE = /^(ipfs:\/\/[A-Za-z0-9]+\/[\w\-.%]+|https:\/\/[\w\-./%]+)\.(png|jpe?g|gif|webp|svg)$/i;
export const MEDIA_BASE_RE = /^(ipfs:\/\/[A-Za-z0-9]+\/|https:\/\/[\w\-./%]+\/)$/;
export const MEDIA_EXT_RE = /^\.(png|jpe?g|gif|webp|svg)$/i;

export const PACK_RARITY_C = [{ name: 'name', type: 'string' }, { name: 'weight', type: 'uint32' }, { name: 'cap', type: 'uint32' }];
export const PACK_CARD_C = [{ name: 'rarityId', type: 'uint8' }, { name: 'weight', type: 'uint32' }];
export const PACK_TIER_C = [{ name: 'name', type: 'string' }, { name: 'cardsPerPack', type: 'uint8' }, { name: 'guaranteedRarity', type: 'uint8' }, { name: 'maxPacks', type: 'uint32' }, { name: 'price', type: 'uint128' }];
export const PACK_INIT_T = [{ type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'packName', type: 'string' }, { name: 'packSymbol', type: 'string' },
  { name: 'owner', type: 'address' }, { name: 'payout', type: 'address' }, { name: 'feeWallet', type: 'address' }, { name: 'platformFeeBps', type: 'uint16' },
  { name: 'royaltyReceiver', type: 'address' }, { name: 'royaltyBps', type: 'uint96' }, { name: 'cardBaseURI', type: 'string' }, { name: 'packBaseURI', type: 'string' },
  { name: 'rarities', type: 'tuple[]', components: PACK_RARITY_C }, { name: 'cards', type: 'tuple[]', components: PACK_CARD_C },
  { name: 'tiers', type: 'tuple[]', components: PACK_TIER_C }, { name: 'phases', type: 'tuple[]', components: PHASE_T },
  { name: 'eids', type: 'uint32[]' }, { name: 'hubEid', type: 'uint32' }, { name: 'prices', type: 'uint128[]' }] }];
export const packConfigHash = p => keccak256(encodeAbiParameters(PACK_INIT_T, [{ ...p, feeWallet: ZERO, platformFeeBps: 0 }]));
export const PACK_APPROVAL_TYPES = { PackDropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'collectionId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
export const AGENT_APPROVAL_TYPES = { AgentDropApproval: [{ name: 'creator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }] };
export const agentConfigHash = p => keccak256(encodeAbiParameters(AGENT_T, [p]));
export const DEATH_LIMITS_DEFAULT = { attackerCooldown: 86400, minTargetAge: 604800, grace: 172800, minGap: 86400, targetCooldown: 21600, requestTimeout: 86400 };
export const isSolAddr = a => { try { solKey(a); return true; } catch { return false; } };
export const isEvmAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a);
export const normAllow = a => (isEvmAddr(a) ? a.toLowerCase() : a);
export const leafOf = a => isEvmAddr(a)
  ? keccak256(keccak256(encodeAbiParameters([{ type: 'address' }], [a])))
  : keccak256(keccak256(solKey(a)));
const hpair = (a, b) => keccak256(a < b ? concat([a, b]) : concat([b, a]));
export function merkle(addrs) {
  let lvl = [...new Set(addrs.map(normAllow))].map(leafOf).sort();
  if (!lvl.length) return { root: ZH, layers: [[]] };
  const layers = [lvl];
  while (lvl.length > 1) { const n = []; for (let i = 0; i < lvl.length; i += 2) n.push(i + 1 < lvl.length ? hpair(lvl[i], lvl[i + 1]) : lvl[i]); layers.push(lvl = n); }
  return { root: lvl[0], layers };
}
export function proofFor(layers, addr) {
  let i = layers[0].indexOf(leafOf(normAllow(addr))); if (i < 0) return null; const out = [];
  for (let l = 0; l < layers.length - 1; l++) { const sib = i ^ 1; if (sib < layers[l].length) out.push(layers[l][sib]); i >>= 1; }
  return out;
}
/** Mirrors MultiSeaLaunchpadFactory.configHash: abi.encode(InitParams) with feeWallet/platformFeeBps zeroed. */
/** Mirrors MultiSeaLaunchpadFactory.omniConfigHash for multichain (escrow) drops. */
export const omniConfigHash = p => keccak256(encodeAbiParameters(OMNI_T, [{ ...p, feeWallet: ZERO, platformFeeBps: 0 }]));
/** Same collection id on every chain: routes LayerZero messages between the drop's clones. */
export const collectionIdOf = (slug, creator) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], [slug, creator]));
export const configHash = p => keccak256(encodeAbiParameters(INIT_T, [{ ...p, feeWallet: ZERO, platformFeeBps: 0 }]));

export const SOL_SWITCH_TITLE = 'MultiSea: turn Solana on';
/** The text MC's wallet signs on /deploy-solana (free signature, no transaction). */
export const solSwitchMessage = (programId, issued) => `${SOL_SWITCH_TITLE}\nProgram: ${programId}\nIssued: ${issued}`;
export function makeLaunchpad({ LP, chains, lc, bad, ADDR, admins, requireSession, isDropOnChain, onDeployed, verifySolana, resnapAuto, now = () => Date.now() }) {
  // Solana switch: config/launchpad.json solana.programId (tests / staging) or the KV record written by POST /launchpad/solana/enable
  // after MC's signed "Turn Solana on" and the on-chain check. Until then SOLP is null: Solana drops are refused.
  let SOLP = LP.solana?.programId || null; let solAt = 0; let solRec = null;
  async function loadSol(env, force) {
    if (LP.solana?.programId) return;
    if (!force && now() - solAt < 30_000) return;
    solRec = await env.COLLECTIONS?.get('lp:solana', 'json').catch(() => null) || null; SOLP = solRec?.programId || null; solAt = now();
  }
  const SLUG = /^[a-z0-9-]{3,40}$/;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const int = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) bad(`${what} must be an integer ${lo}-${hi}`); return n; };
  const wei = (v, what) => { if (!/^\d{1,30}$/.test(String(v ?? ''))) bad(`${what} must be a wei integer string`); return String(v); };
  const uri = (v, what) => { const s = str(v, 200); if (s && !/^(ipfs:\/\/|ar:\/\/|https:\/\/)[\w\-./?=&%#]+$/.test(s)) bad(`${what} must be ipfs://, ar:// or https://`); return s; };
  // deployed: true only once POST /launchpad/deployed verified a contract on-chain against a factory (status 'live').
  // Approved drops without one stay deployed: false, and the site shows them as "Coming soon". (Additive field.)
  // Delayed reveal: the revealed baseURI stays private until the creator reveals (GET /launchpad/reveal-uri/<slug>).
  const pub = d => ({ ...d, creator: d.creator || d.submitter, bridgePrepay: undefined, baseURI: d.reveal === 'delayed' ? undefined : d.baseURI, submitter: undefined, approval: undefined, allowlists: undefined, deployed: d.status === 'live' && Array.isArray(d.deployments) && d.deployments.length > 0 });

  const AG = LP.agentDrops || { enabled: false };
  // Agent drop: single chain; full phases via AgentDropKit; art = uploaded media folder (+ optional death image), metadata JSON onchain.
  function validateAgent(b, base) {
    if (!AG.enabled) bad('ERC-463N7 agent drops are not enabled yet', 403);
    if (base.mode !== 'single' || base.chains.length !== 1) bad('agent drops are single-chain (one chain per drop)');
    const chain = base.chains[0]; if (!(AG.chains || []).includes(chain)) bad('agent drops are available on: ' + (AG.chains || []).join(', '));
    base.phases.forEach((p, i) => { if (i && p.start < base.phases[i - 1].start) bad(`phase ${i + 1} starts before phase ${i}`); });
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
    // Infect (InfectSkill module): rarity % (0 = creator table only), per-agent cooldown, max ETH per infection, score per infection.
    const infect = !!a.infect; const infPct = infect ? int(a.infPct ?? 5, 0, 100, 'Infect rarity (%)') : 0;
    const infCooldownH = infect ? int(a.infCooldownH ?? 1, 1, 720, 'Infect cooldown (hours)') : 0;
    const infScore = infect ? int(a.infScore ?? 25, 1, 1000, 'Infect score reward') : 0;
    let infMaxWei = '0';
    if (infect) { const m = String(a.infMaxEth ?? '0.05').trim(); if (!/^\d{1,4}(\.\d{1,18})?$/.test(m)) bad('Infect max price (ETH) must be a decimal number'); const [w, f = ''] = m.split('.'); infMaxWei = (BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString(); if (BigInt(infMaxWei) === 0n || BigInt(infMaxWei) > 1000n * 10n ** 18n) bad('Infect max price (ETH) must be above 0 and at most 1000'); }
    // Repo (Death kills take the victim's wallet; needs Death), Queen (female, collects tribute), Zombie (never dies).
    const repo = !!a.repo; if (repo && !deathSkill) bad('Repo needs the Death skill');
    const repoPct = repo ? int(a.repoPct ?? 5, 0, 100, 'Repo rarity (%)') : 0;
    const queen = !!a.queen; const queenPct = queen ? int(a.queenPct ?? 2, 0, 100, 'Queen rarity (%)') : 0;
    const queenCap = queen ? int(a.queenCap ?? 10, 1, 10000, 'Queen cap') : 0;
    const tribDays = queen ? int(a.tribDays ?? 7, 1, 365, 'Tribute period (days)') : 0;
    let tribWei = '0';
    if (queen) { const m = String(a.tribEth ?? '0.0005').trim(); if (!/^\d{1,2}(\.\d{1,18})?$/.test(m)) bad('Tribute fee (ETH) must be a decimal number'); const [w, f = ''] = m.split('.'); tribWei = (BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString(); if (BigInt(tribWei) === 0n || BigInt(tribWei) > 5n * 10n ** 15n) bad('Tribute fee (ETH) must be above 0 and at most 0.005'); }
    const zombie = !!a.zombie; const zombiePct = zombie ? int(a.zombiePct ?? 1, 0, 100, 'Zombie rarity (%)') : 0;
    const mediaBase = str(a.mediaBase, 200), mediaExt = str(a.mediaExt, 8).toLowerCase(), deathURI = str(a.deathURI, 200);
    if (mediaBase && !MEDIA_BASE_RE.test(mediaBase)) bad('agent media base must be a folder: ipfs://CID/ or https://…/');
    if (mediaBase ? !MEDIA_EXT_RE.test(mediaExt) : mediaExt) bad('agent media extension must be .png, .jpg, .gif, .webp or .svg (with a media base)');
    if (deathURI && !DEATH_RE.test(deathURI)) bad('death image must be one image file: ipfs://CID/death.png or https://….png (png, jpg, gif, webp, svg), not a folder or JSON');
    // CSV traits stored onchain by AgentDropKit (dictionary + 1 byte per trait per token); rows = gen-0 tokens 1..N with a CSV line.
    const traitRows = int(a.traitRows ?? 0, 0, base.maxSupply, 'CSV trait rows');
    const skillInheritanceBoostBps = int(a.skillInheritanceBoostBps ?? 1000, 0, 2000, 'skill inheritance boost (bps)');
    let growthConfig;
    try { growthConfig = agentGrowth(a.growthConfig); } catch (e) { bad(e.message); }
    // Pinned copy of the encoded table (dashboard re-loads it for the post-deploy upload); not signed, display only.
    const traitsURI = traitRows ? str(a.traitsURI, 120) : '';
    if (traitsURI && !/^ipfs:\/\/[A-Za-z0-9]+\/[\w.-]+\.json$/.test(traitsURI)) bad('traits table must be one pinned JSON file: ipfs://CID/traits.json');
    return { mediaBase, mediaExt, deathURI, traitRows, skillInheritanceBoostBps, growthConfig, traitsURI, starveDays, deathSkill, limits, skillPct, fertility, fertPct, twinPct, mutation, mutPct, mutSkillPct, infect, infPct, infCooldownH, infScore, infMaxWei, repo, repoPct, queen, queenPct, queenCap, tribDays, tribWei, zombie, zombiePct, modelId: AG.oraModelId ?? 11 };
  }

  function validate(b, creator) {
    const isAgent = b.nftType === 'erc463n7'; const isPack = b.nftType === 'packs';
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
    // Solana (multichain only, last chain): enabled once SOLP (the mainnet program) is configured. The creator's
    // Solana wallet creates and owns the Solana side; copies go out with every mint (AT_MINT), never batched.
    let solana;
    if (b.solana) {
      if (!SOLP) bad('Solana is not available yet');
      if (mode !== 'multichain') bad('Solana is only available for multichain drops');
      if (isAgent) bad('Solana is not available for agent drops');
      if (b.copyMode === 'batched') bad('drops with Solana send copies at mint (copyMode at-mint)');
      try { solKey(b.solanaCreator); solKey(b.solanaPayout || b.solanaCreator); } catch { bad('Solana wallet must be a Solana address'); }
      solana = { creator: b.solanaCreator, payout: b.solanaPayout || b.solanaCreator };
    }
    const BT = LP.batch;
    const copyMode = mode !== 'multichain' ? undefined : solana ? 'at-mint' : (b.copyMode ?? BT.defaultMode) === 'at-mint' ? 'at-mint' : b.copyMode == null || b.copyMode === 'batched' ? 'batched' : bad('copyMode must be batched or at-mint');
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
    if (preRevealURI && !/^https:\/\//.test(preRevealURI) && !/\.json$/i.test(preRevealURI)) bad('pre-reveal URI must point to one .json file (e.g. ipfs://CID/placeholder.json), not a folder');
    const ph = Array.isArray(b.phases) ? b.phases : []; if (!ph.length || ph.length > LP.maxPhases) bad(`1-${LP.maxPhases} phases`);
    const allowlists = {}; let totalAllow = 0;
    const phases = ph.map((x, i) => {
      const start = int(x.start, 0, 2 ** 40, 'phase start'), end = int(x.end ?? 0, 0, 2 ** 40, 'phase end'); if (end && end <= start) bad(`phase ${i + 1}: end before start`);
      const kind = x.kind === 'allowlist' ? 'allowlist' : 'public'; let merkleRoot = ZH;
      const holderSources = Array.isArray(x.holderSources) && x.holderSources.length ? x.holderSources : undefined;
      const includeLinked = x.includeLinked !== false;
      const holderFrozen = !!x.holderFrozen;
      if (kind === 'allowlist') {
        const raw = Array.isArray(x.allowlist) ? x.allowlist : [];
        const list = [];
        for (const a of raw) {
          if (ADDR.test(a)) list.push(lc(a));
          else if (solana && isSolAddr(a)) list.push(a);
          else if (a) bad(`phase ${i + 1}: allowlist needs valid 0x addresses` + (solana ? ' or Solana wallets' : ''));
        }
        if (!list.length && !(holderSources && !holderFrozen)) bad(`phase ${i + 1}: allowlist needs valid 0x addresses` + (solana ? ' or Solana wallets' : '') + (holderSources ? ' (or a holder snapshot)' : ''));
        totalAllow += list.length; if (totalAllow > LP.maxAllowlist) bad(`allowlists capped at ${LP.maxAllowlist} addresses in this version`);
        const u = [...new Set(list)].sort(); if (u.length) { allowlists[i] = u; merkleRoot = merkle(u).root; }
      }
      const price = wei(x.price, `phase ${i + 1} price`);
      // Multichain: one price per chain in that chain's native token (ETH / APE / BNB); defaults to `price` for ETH chains.
      const prices = mode === 'multichain' ? Object.fromEntries(chainsSel.map(k => [k, wei(x.prices?.[k] ?? (chains[k].native === 'ETH' ? price : undefined), `phase ${i + 1} price on ${k}`)])) : undefined;
      if (solana) prices.solana = wei(x.prices?.solana, `phase ${i + 1} price on Solana (lamports)`);
      return { name: str(x.name, 40) || (kind === 'allowlist' ? 'Allowlist' : 'Public'), kind, start, end, price, prices, maxPerWallet: int(x.maxPerWallet ?? 0, 0, 1_000_000, 'per-wallet limit'), maxSupply: int(x.maxSupply ?? 0, 0, maxSupply, `phase ${i + 1} max supply (0 = no cap, at most total supply)`), merkleRoot, ...(holderSources ? { holderSources, includeLinked, holderFrozen } : {}) };
    });
    const out = { slug, name, symbol, description: str(b.description, 1000), website: str(b.website, 200), x: str(b.x, 200), logo: str(b.logo, 120), banner: str(b.banner, 120),
      mode, copyMode, solana, batchK, batchTMin, chains: chainsSel, allocations, maxSupply, creatorReserve, royaltyBps, royaltyReceiver, payout, reveal, baseURI, preRevealURI, phases, allowlists, metadataHost: str(b.metadataHost, 20) };
    if (isAgent) { out.nftType = 'erc463n7'; out.agent = validateAgent(b, out); }
    if (isPack) { if (solana) bad('Card packs are EVM only in this release');
      out.nftType = 'packs'; out.packs = validatePacks(b, out); out.maxSupply = out.packs.rarities.reduce((a, r) => a + r.cap, 0); }
    // MultiSea bridge: the creator prepaid the gas-only listing fee on-chain at review; the server lists it once deployed.
    const bp = b.bridgePrepay;
    if (bp && !isAgent && mode === 'single' && typeof bp.chain === 'string' && chainsSel.includes(bp.chain) && bp.dropId === keccak256(toBytes(slug)) && /^0x[0-9a-fA-F]{64}$/.test(String(bp.tx || '')))
      out.bridgePrepay = { chain: bp.chain, dropId: bp.dropId, eids: (Array.isArray(bp.eids) ? bp.eids : []).map(Number).filter(Number.isInteger).slice(0, 10), tx: bp.tx };
    return out;
  }

  // Phases live in AgentDropKit; the engine price is the lowest phase price so every phase can pay it (no spawn: it is only the mint price).
  const agentParams = (d, creator) => ({ name: d.name, symbol: d.symbol, owner: creator, treasury: d.payout, mintPrice: d.phases.reduce((m, p) => (BigInt(p.price) < m ? BigInt(p.price) : m), BigInt(d.phases[0].price)), maxSupply: d.maxSupply, maxPerWallet: 0,
    royaltyBps: d.royaltyBps, starvationPeriod: d.agent.starveDays * 86400, deathSkill: d.agent.deathSkill, modelId: BigInt(d.agent.modelId), limits: d.agent.limits,
    fertilityBps: (d.agent.fertPct || 0) * 100, twinBps: (d.agent.twinPct ?? 20) * 100,
    mutationBps: (d.agent.mutPct || 0) * 100, mutationSkillBps: (d.agent.mutSkillPct ?? 15) * 100,
    infect: !!d.agent.infect, infectLimits: { skillBps: (d.agent.infPct || 0) * 100, cooldown: (d.agent.infCooldownH || 0) * 3600, maxPrice: BigInt(d.agent.infMaxWei || '0'), scoreReward: d.agent.infScore || 0 },
    repoBps: (d.agent.repoPct || 0) * 100, queenBps: (d.agent.queenPct || 0) * 100, queenCap: d.agent.queenCap || 0, zombieBps: (d.agent.zombiePct || 0) * 100,
    tributeFee: BigInt(d.agent.tribWei || '0'), tributePeriod: (d.agent.tribDays || 0) * 86400,
    kit: agentKit({ mediaBase: d.agent.mediaBase || '', mediaExt: d.agent.mediaBase ? d.agent.mediaExt : '', deathURI: d.agent.deathURI || '', phases: d.phases, traitRows: d.agent.traitRows || 0, skillInheritanceBoostBps: d.agent.skillInheritanceBoostBps ?? 1000, growthConfig: d.agent.growthConfig || '0x' }) });

  const initParams = (d, creator, chain) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.allocations?.[chain] ?? d.maxSupply, creatorReserve: chain === d.chains[0] ? d.creatorReserve : 0,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: BigInt(p.price), maxPerWallet: p.maxPerWallet, maxSupply: Math.min(p.maxSupply ?? 0, d.allocations?.[chain] ?? d.maxSupply), merkleRoot: p.merkleRoot })) });

  const omniParams = (d, creator) => ({ name: d.name, symbol: d.symbol, owner: creator, payout: d.payout, feeWallet: ZERO, platformFeeBps: 0, maxSupply: d.maxSupply,
    royaltyReceiver: d.royaltyReceiver, royaltyBps: BigInt(d.royaltyBps), baseURI: d.reveal === 'instant' ? d.baseURI : '', preRevealURI: d.reveal === 'delayed' ? d.preRevealURI : '',
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), price: 0n, maxPerWallet: p.maxPerWallet, maxSupply: p.maxSupply ?? 0, merkleRoot: p.merkleRoot })),
    eids: solChains(d).map(k => (k === 'solana' ? LP.solana.eid : LP.eids[k])), hubEid: LP.eids[LP.hubChain], prices: solChains(d).flatMap(k => d.phases.map(p => BigInt(p.prices[k]))),
    copyMode: d.copyMode === 'at-mint' ? 1 : 0, batchK: d.copyMode === 'at-mint' ? 0 : d.batchK ?? LP.batch.defaultK, batchT: d.copyMode === 'at-mint' ? 0 : (d.batchTMin ?? LP.batch.defaultTMin) * 60 });

  const solChains = d => (d.solana ? [...d.chains, 'solana'] : d.chains); // Solana is always the last chain
  // The Solana program's DropParams (prices in lamports). Allowlist roots may mix EVM leaves and Solana-pubkey leaves; the program verifies the latter as keccak(keccak(32-byte pubkey)).
  const solParams = d => ({ name: solName(d.name), collectionUri: d.preRevealURI || '', baseUri: d.reveal === 'instant' ? d.baseURI : '', preRevealUri: d.reveal === 'delayed' ? d.preRevealURI : '',
    payout: d.solana.payout, royaltyBps: d.royaltyBps, maxSupply: d.maxSupply, hubEid: LP.eids[LP.hubChain], eids: solChains(d).map(k => (k === 'solana' ? LP.solana.eid : LP.eids[k])),
    phases: d.phases.map(p => ({ start: BigInt(p.start), end: BigInt(p.end), maxPerWallet: p.maxPerWallet, maxSupply: p.maxSupply ?? 0, merkleRoot: p.merkleRoot, price: BigInt(p.prices.solana) })) });
  // Solana approval: { raw digest } the approver signs as an EIP-191 message; create_drop checks it on-chain.
  function solApproval(d, deadline) {
    if (!d.solana || !SOLP) bad('no Solana program yet', 501);
    const sp = solParams(d); const collectionId = collectionIdOf(d.slug, lc(d.submitter));
    const digest = solDigest(SOLP, d.solana.creator, collectionId, sp, deadline);
    const ser = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return { digest, out: { chain: 'solana', programId: SOLP, creator: d.solana.creator, collectionId, deadline: deadline.toString(), params: ser(sp) } };
  }

  // EIP-712 approval for one chain of an approved drop. Creator = the submitter (createDrop: msg.sender; createOmniDrop: p.owner).
  function validatePacks(b, base) {
      const src = b.packs || {};
      const rarities = Array.isArray(src.rarities) ? src.rarities : [];
      if (!rarities.length || rarities.length > 16) bad('Card packs: 1–16 rarity tiers');
      const outR = rarities.map((r, i) => {
        const name = str(r.name, 24) || bad(`rarity ${i + 1}: name`);
        const weight = int(r.weight, 1, 1_000_000, `rarity ${i + 1} weight`);
        const cap = int(r.cap, 1, 1_000_000, `rarity ${i + 1} cap`);
        return { name, weight, cap };
      });
      const cards = Array.isArray(src.cards) ? src.cards : [];
      if (!cards.length || cards.length > 256) bad('Card packs: 1–256 cards in the set');
      const used = new Set();
      const outC = cards.map((c, i) => {
        const rarityId = int(c.rarityId, 1, outR.length, `card ${i + 1} rarity`);
        used.add(rarityId);
        return { rarityId, weight: int(c.weight ?? 0, 0, 1_000_000, `card ${i + 1} weight`) };
      });
      outR.forEach((r, i) => { if (!used.has(i + 1)) bad(`rarity “${r.name}” needs at least one card`); });
      const tiers = Array.isArray(src.tiers) ? src.tiers : [];
      if (!tiers.length || tiers.length > 8) bad('Card packs: 1–8 pack tiers');
      const outT = tiers.map((x, i) => {
        const name = str(x.name, 32) || bad(`pack tier ${i + 1}: name`);
        const cardsPerPack = int(x.cardsPerPack, 1, 20, `pack tier ${i + 1} cards per pack`);
        const guaranteedRarity = int(x.guaranteedRarity ?? 0, 0, outR.length, `pack tier ${i + 1} guaranteed rarity`);
        const maxPacks = int(x.maxPacks ?? 0, 0, 1_000_000, `pack tier ${i + 1} max packs`);
        const price = wei(x.price ?? 0, `pack tier ${i + 1} price`);
        return { name, cardsPerPack, guaranteedRarity, maxPacks, price, priceUsd: x.priceUsd !== undefined ? Number(x.priceUsd) : undefined };
      });
      return { packName: str(src.packName, 60) || (base.name + ' Packs'), packSymbol: str(src.packSymbol, 12) || ((base.symbol || 'PACK').slice(0, 8) + 'P'),
        rarities: outR, cards: outC, tiers: outT, cardBaseURI: str(src.cardBaseURI || base.baseURI, 200), packBaseURI: str(src.packBaseURI, 200) };
    }
    function packParams(d, creator) {
      const p = d.packs;
      const eids = d.chains.map(k => LP.eids?.[k] || LP.mainnet?.chains?.[k]?.eid).filter(Boolean);
      if (eids.length !== d.chains.length) bad('missing LayerZero eid for a selected chain', 501);
      const hubEid = LP.eids?.[LP.hubChain || 'base'] || LP.mainnet?.chains?.base?.eid;
      const phases = (d.phases || []).map(x => ({ start: BigInt(x.start), end: BigInt(x.end || 0), price: BigInt(x.price || 0), maxPerWallet: x.maxPerWallet || 0, maxSupply: x.maxSupply || 0, merkleRoot: x.merkleRoot || ZH }));
      const nP = phases.length, nT = p.tiers.length, nC = d.chains.length;
      const prices = [];
      for (let i = 0; i < nC; i++) {
        const k = d.chains[i];
        for (let ph = 0; ph < nP; ph++) {
          for (let t = 0; t < nT; t++) {
            const tier = p.tiers[t];
            const fallback = phases[ph].price;
            const v = d.mode === 'multichain' && tier.prices?.[k] != null ? tier.prices[k] : (tier.price ?? fallback);
            prices.push(BigInt(v || 0));
          }
        }
      }
      return {
        name: d.name, symbol: d.symbol, packName: p.packName, packSymbol: p.packSymbol,
        owner: creator, payout: d.payout || creator, feeWallet: ZERO, platformFeeBps: 0,
        royaltyReceiver: d.royaltyReceiver || d.payout || creator, royaltyBps: d.royaltyBps || 0,
        cardBaseURI: p.cardBaseURI || d.baseURI || '', packBaseURI: p.packBaseURI || '',
        rarities: p.rarities, cards: p.cards,
        tiers: p.tiers.map(x => ({ name: x.name, cardsPerPack: x.cardsPerPack, guaranteedRarity: x.guaranteedRarity || 0, maxPacks: x.maxPacks || 0, price: BigInt(x.price || 0) })),
        phases, eids, hubEid, prices,
      };
    }
  function approvalTyped(d, chain, deadline) {
    const creator = lc(d.submitter);
    const ser = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    if (d.nftType === 'packs') {
      const pf = LP.packDrops?.factories?.[chain]; if (!d.chains.includes(chain) || !pf || !chains[chain]) bad('no pack factory on that chain yet — MultiSea will deploy it first', 501);
      const ip = packParams(d, creator); const cfg = packConfigHash(ip); const collectionId = collectionIdOf(d.slug, creator);
      const message = { creator, configHash: cfg, collectionId, deadline };
      return { typed: { domain: { name: 'MultiSeaPacks', version: '1', chainId: chains[chain].chainId, verifyingContract: pf }, types: PACK_APPROVAL_TYPES, primaryType: 'PackDropApproval', message }, out: { kind: 'packs', mode: d.mode === 'multichain' ? 'packs' : 'packs', chain, factory: pf, collectionId, deadline: deadline.toString(), configHash: cfg, params: ser(ip), slug: d.slug } };
    }
    const factory = LP.factories?.[chain]; if (!d.chains.includes(chain) || !factory || !chains[chain]) bad('no factory on that chain yet', 501);
    const domain = { name: 'MultiSeaLaunchpad', version: '1', chainId: chains[chain].chainId, verifyingContract: factory };
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
    if (p[0] === 'launchpad' || (p[0] === 'admin' && p[1] === 'launchpad')) await loadSol(env);
    if (p[0] === 'launchpad') {
      const K = env.COLLECTIONS;
      if (M === 'GET' && p[1] === 'solana' && p.length === 2) return { on: !!SOLP, programId: SOLP, store: solRec?.store || null, escrows: SOLP ? LP.solana?.v2?.escrows || null : null, enabledAt: solRec?.enabledAt || null, signer: LP.solana?.switchSigner || null };
      // Read-only dry run of the switch's on-chain check (public data, no signature, writes nothing).
      if (M === 'GET' && p[1] === 'solana' && p[2] === 'check' && p.length === 3) {
        const pid = String(url.searchParams.get('program') || ''); try { solKey(pid); } catch { bad('bad program id'); }
        if (!verifySolana) bad('on-chain check unavailable', 501);
        const v = await verifySolana(pid); return { ok: !!v?.ok, problems: v?.problems || [], store: v?.store || null, rpcErrors: v?.tried || [], solanaRpc: v?.rpc || null };
      }
      if (M === 'POST' && p[1] === 'solana' && p[2] === 'enable' && p.length === 3) {
        const b = await body(); const msg = String(b.message || ''); const sig = String(b.signature || '');
        if (msg.length > 400 || !/^0x[0-9a-fA-F]{130}$/.test(sig)) bad('message and signature required');
        const m = msg.match(/^MultiSea: turn Solana on\nProgram: ([1-9A-HJ-NP-Za-km-z]{32,44})\nIssued: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/);
        if (!m || msg !== solSwitchMessage(m[1], m[2])) bad('not a "turn Solana on" message');
        const t = Date.parse(m[2]); if (!(t <= now() + 120_000 && t >= now() - 15 * 60_000)) bad('message expired: sign again', 401);
        try { solKey(m[1]); } catch { bad('bad program id'); }
        const signer = lc(await recoverMessageAddress({ message: msg, signature: sig }).catch(() => ''));
        if (!LP.solana?.switchSigner || signer !== lc(LP.solana.switchSigner)) bad('only the MultiSea owner wallet can turn Solana on', 403);
        if (!verifySolana) bad('on-chain check unavailable', 501);
        const v = await verifySolana(m[1]);
        if (!v?.ok) bad('Not ready: ' + (v?.problems || ['check failed']).join('; '), 409);
        const rec = { programId: m[1], store: v.store, enabledAt: new Date(now()).toISOString(), signedBy: signer, message: msg, signature: sig };
        await K.put('lp:solana', JSON.stringify(rec)); await loadSol(env, true);
        return { ok: true, on: true, programId: m[1], store: v.store };
      }
      if (M === 'GET' && p[1] === 'drops' && p.length === 2) { const l = await K.list({ prefix: 'ldrop:' }); return { drops: (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(Boolean).map(pub) }; }
      if (M === 'GET' && p[1] === 'drops' && p.length === 3) { const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404); return { drop: pub(d) }; }
      if (M === 'GET' && p[1] === 'proof' && p.length === 5) {
        const ph = Number(p[3]); const raw = decodeURIComponent(p[4] || '');
        const a = ADDR.test(raw) ? lc(raw) : raw;
        if ((!ADDR.test(a) && !isSolAddr(a)) || !Number.isInteger(ph)) bad('bad request');
        const list = await K.get(`lallow:${p[2]}:${ph}`, 'json'); if (!list) return { eligible: false, proof: [] };
        const pr = proofFor(merkle(list).layers, a); return { eligible: !!pr, proof: pr || [] };
      }
      if (M === 'POST' && p[1] === 'submit') {
        const s = await requireSession(req, env); let d = validate(await body(), s.address);
        if ((await K.get('ldrop:' + d.slug)) || (await K.get('lpending:' + d.slug)) || (await K.get('col:' + d.slug))) bad('slug already used');
        if (resnapAuto) d = await resnapAuto(env, d);
        for (const [i, ph] of (d.phases || []).entries()) if (ph.kind === 'allowlist' && !(d.allowlists || {})[i]?.length) bad(`phase ${i + 1}: allowlist is empty`);
        await K.put('lpending:' + d.slug, JSON.stringify({ ...d, kind: 'drop', submitter: s.address, status: 'pending', submittedAt: new Date(now()).toISOString() }));
        return { ok: true, status: 'pending', slug: d.slug };
      }
      if (M === 'GET' && p[1] === 'mine' && p.length === 2) { // the signed-in creator's own drops (submitter is never public)
        const s = await requireSession(req, env); const l = await K.list({ prefix: 'ldrop:' });
        const ds = (await Promise.all(l.keys.map(k => K.get(k.name, 'json')))).filter(d => d && lc(d.submitter) === s.address);
        return { drops: ds.map(d => ({ slug: d.slug, status: d.status, chains: d.chains, deployed: (d.deployments || []).map(x => x.chain) })) };
      }
      if (M === 'GET' && p[1] === 'reveal-uri' && p.length === 3) { // creator only: the stored revealed base URI for reveal(baseURI)
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('only the creator can read the reveal URI', 403);
        return { baseURI: d.baseURI || '' };
      }
      if (M === 'POST' && p[1] === 'approval' && p.length === 3) {
        const s = await requireSession(req, env); const d = await K.get('ldrop:' + p[2], 'json'); if (!d) bad('not found', 404);
        if (lc(d.submitter) !== s.address) bad('only the creator can request a deploy approval', 403);
        const b = await body(); const chain = b.chain;
        if (chain === 'solana') {
          if (env.LAUNCHPAD_APPROVER_KEY) { const t = solApproval(d, BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec));
            return { ...t.out, signature: await privateKeyToAccount(env.LAUNCHPAD_APPROVER_KEY).signMessage({ message: { raw: t.digest } }) }; }
          if (!LP.approver) bad('launchpad deploy approvals are not enabled yet', 501);
          solApproval(d, 0n); const st = await K.get(`lsig:${d.slug}:solana`, 'json');
          if (!st || BigInt(st.deadline) <= BigInt(Math.floor(now() / 1000) + 600)) bad('waiting for MultiSea to sign the deploy approval for solana (usually within a day)', 409);
          return { ...solApproval(d, BigInt(st.deadline)).out, signature: st.signature };
        }
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
        if (chain === 'solana') { // the Drop account must be owned by the MultiSea program and carry this drop's collection id
          if (!d.solana || !SOLP) bad('no Solana side for this drop');
          const acct = String(b.address || ''); try { solKey(acct); } catch { bad('bad Solana address'); }
          const r = await fetch(LP.solana.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [acct, { encoding: 'base64', commitment: 'confirmed' }] }) }).then(x => x.json()).catch(() => null);
          const v = r?.result?.value; const raw = v ? Uint8Array.from(atob(v.data[0]), c => c.charCodeAt(0)) : null;
          const cid = collectionIdOf(d.slug, lc(d.submitter)).slice(2); const got = raw && raw.length >= 40 ? [...raw.slice(8, 40)].map(x => x.toString(16).padStart(2, '0')).join('') : '';
          if (!v || v.owner !== SOLP || got !== cid) bad('address is not this drop on the MultiSea Solana program');
          const live = { ...d, solana: { ...d.solana, drop: acct } }; await K.put('ldrop:' + d.slug, JSON.stringify(live));
          return { ok: true, drop: pub(live) };
        }
        if (!d.chains.includes(chain) || !ADDR.test(address)) bad('bad chain/address');
        const fac = d.nftType === 'erc463n7' ? (AG.enabled && AG.factories?.[chain]) : d.nftType === 'packs' ? (LP.packDrops?.factories?.[chain]) : LP.factories[chain];
        if (!fac || !(await isDropOnChain(chain, fac, address))) bad('address is not a MultiSea launchpad drop on ' + chain);
        const deployments = [...(d.deployments || []).filter(x => x.chain !== chain), { chain, address, ...(b.cards && ADDR.test(lc(b.cards)) ? { cards: lc(b.cards) } : {}) }];
        const live = { ...d, deployments, status: 'live' }; await K.put('ldrop:' + d.slug, JSON.stringify(live));
        // Auto-list on MultiSea: the drop becomes a normal approved collection page /c/<slug> (trading uses the 0.5% marketplace fee).
        const col = (await K.get('col:' + d.slug, 'json')) || { slug: d.slug, name: d.name, description: d.description, website: d.website, x: d.x, logo: d.logo, banner: d.banner, escrow: [], submitter: d.submitter, status: 'approved', approvedAt: new Date(now()).toISOString(), source: 'launchpad' };
        col.deployments = deployments;
        if (d.nftType === 'packs') { col.standard = 'erc1155'; col.nftType = 'packs'; col.cardDeployments = deployments.filter(x => x.cards).map(x => ({ chain: x.chain, address: x.cards })); if (d.mode === 'multichain') col.escrow = (col.escrow || []).concat(d.chains.map(k => LP.packDrops?.escrows?.[k]).filter(Boolean).map(address => ({ chain: Object.keys(LP.packDrops?.escrows || {}).find(k => lc(LP.packDrops.escrows[k]) === lc(address)), address: lc(address) })).filter(x => x.chain && x.address && x.address !== ZERO)); }
        // Multichain: the shared per-chain escrow holds every non-Active copy, so it is excluded from holder counts.
        if (d.mode === 'multichain') col.escrow = deployments.flatMap(x => [...new Set([LP.omniEscrows?.[x.chain], LP.solana?.v2?.escrows?.[x.chain]].filter(Boolean).map(lc))].map(address => ({ chain: x.chain, address }))).filter(x => x.address !== ZERO && x.chain !== 'solana');
        await K.put('col:' + d.slug, JSON.stringify(col));
        if (onDeployed) await onDeployed(env, live, chain, address).catch(e => console.log('bridge enqueue failed', e?.message));
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
        let d = await K.get('ldrop:' + p[3], 'json'); if (!d) bad('not an approved drop', 404); if (!LP.approver) bad('no approver configured', 501);
        const ser = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        if (M === 'GET') {
          const sigKeys = [...d.chains.map(c => `lsig:${d.slug}:${c}`), ...(d.solana ? [`lsig:${d.slug}:solana`] : [])];
          const anySig = (await Promise.all(sigKeys.map(k => K.get(k, 'json')))).some(Boolean);
          if (resnapAuto && !anySig) {
            const fresh = await resnapAuto(env, d);
            if (fresh?._resnapped) {
              const { allowlists, _resnapped, ...rest } = fresh;
              d = rest; await K.put('ldrop:' + d.slug, JSON.stringify(d));
              for (const [i, list] of Object.entries(allowlists || {})) await K.put(`lallow:${d.slug}:${i}`, JSON.stringify(list));
            } else d = fresh;
          }
          const out = [];
          for (const chain of d.chains) { if (!LP.factories?.[chain]) continue; const st = await K.get(`lsig:${d.slug}:${chain}`, 'json');
            const deadline = BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec); const done = (d.deployments || []).some(x => x.chain === chain);
            out.push({ chain, signed: !!st, deadline: st?.deadline, deployed: done, typed: ser(approvalTyped(d, chain, deadline).typed) }); }
          if (d.solana && SOLP) { const st = await K.get(`lsig:${d.slug}:solana`, 'json'); const deadline = BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec);
            out.push({ chain: 'solana', signed: !!st, deadline: st?.deadline, deployed: (d.deployments || []).some(x => x.chain === 'solana'), deadlineNew: deadline.toString(), raw: solApproval(d, deadline).digest }); }
          return { approver: LP.approver, approvals: out };
        }
        const b = await req.json().catch(() => ({})); const chain = b?.chain; const sig = String(b?.signature || '');
        if (!/^0x[0-9a-fA-F]{130}$/.test(sig) || !/^\d{1,12}$/.test(String(b?.deadline ?? ''))) bad('signature and deadline required');
        const deadline = BigInt(b.deadline); if (deadline <= BigInt(Math.floor(now() / 1000)) || deadline > BigInt(Math.floor(now() / 1000) + LP.approvalTtlSec + 3600)) bad('deadline out of range');
        const signer = lc(chain === 'solana' ? await recoverSolApprover(solApproval(d, deadline).digest, sig) : await recoverTypedDataAddress({ ...approvalTyped(d, chain, deadline).typed, signature: sig }));
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
