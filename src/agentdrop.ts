// ERC-463N7 agent drops (AgentDropFactory, ERC-463N7 repo): deploy, mint, and the per-agent panel (wallet, last fed,
// Feed, always-on starvation (reaper.starve), Death-skill attack with strike/grace state, burn + tombstone custody,
// and the mint gate: DeathSkill keeps mint closed until the creator assigns skills and calls lock()). Everything is behind config/launchpad.json
// agentDrops.enabled (OFF). VITE_AGENT_DROPS=1 turns on a labeled local preview with demo agents (no transactions).
import LPC from '../config/launchpad.json';
import { createWalletClient, custom, decodeEventLog, parseAbi, type Address } from 'viem';
import { wallet, ensureChain, readClient, vchain } from './wallet';
import { api } from './auth';
import { esc } from './shell';
import { KIT_TRAITS, traitTxs, rowsPerChunk, type TraitEnc } from './agenttraits';

const AG: any = (LPC as any).agentDrops || { enabled: false };
export const AGENT_DROPS: boolean = !!AG.enabled;
export const AGENT_PREVIEW: boolean = !AG.enabled && import.meta.env.VITE_AGENT_DROPS === '1';
export const AGENT_UI = AGENT_DROPS || AGENT_PREVIEW;
export const AGENT_CHAINS: string[] = AG.chains || [];
export const DEATH_CHAINS: string[] = AG.deathSkillChains || [];
export const ORA_FEE_WEI: Record<string, string> = AG.oraFeeWeiEstimate || {};
export const isAgentDrop = (d: any) => d?.raw?.nftType === 'erc463n7' || d?.nftType === 'erc463n7';

const FACTORY = parseAbi([
  'struct InfectLimits { uint16 skillBps; uint32 cooldown; uint128 maxPrice; uint32 scoreReward; }',
  'struct Limits { uint16 skillBps; uint32 attackerCooldown; uint32 minTargetAge; uint32 grace; uint32 minGap; uint32 targetCooldown; uint32 requestTimeout; }',
  'struct AgentInit { string name; string symbol; address owner; address treasury; uint256 mintPrice; uint32 maxSupply; uint32 maxPerWallet; uint16 royaltyBps; uint32 starvationPeriod; bool deathSkill; uint256 modelId; Limits limits; uint16 fertilityBps; uint16 twinBps; uint16 mutationBps; uint16 mutationSkillBps; bool infect; InfectLimits infectLimits; uint16 repoBps; uint16 queenBps; uint32 queenCap; uint16 zombieBps; uint256 tributeFee; uint32 tributePeriod; bytes kit; }',
  'function createAgentDrop(AgentInit p, bytes32 salt, uint256 deadline, bytes sig) returns (address engine, address starvation, address deathSkill)',
  'event AgentDropCreated(address indexed engine, address indexed creator, bytes32 indexed salt, address starvationRule, address deathSkill)',
]);
const ENGINE = parseAbi([
  'function mintMany(address to, uint256 qty) payable returns (uint256)', 'function feed(uint256 id) payable', 'function accountOf(uint256 id) view returns (address)',
  'function lastFedOf(uint256 id) view returns (uint64)', 'function sexOf(uint256 id) view returns (uint8)', 'function hasFertility(uint256 id) view returns (bool)', 'function hasMutation(uint256 id) view returns (bool)', 'function isMutated(uint256 id) view returns (bool)', 'function isDead(uint256 id) view returns (bool)', 'function custodianOf(uint256 id) view returns (address)', 'function ownerOf(uint256 id) view returns (address)', 'function reaper() view returns (address)', 'function infector() view returns (address)', 'function mintPrice() view returns (uint256)',
  'function genesOf(uint256 id) view returns (bytes32[])', 'function tributeFee() view returns (uint256)', 'function collectTribute(uint256 queen, uint256[] ids) returns (uint256)',
]);
const ZERO_A = '0x0000000000000000000000000000000000000000';
const INFECT = parseAbi(['function hasInfect(uint256 id) view returns (bool)', 'function infections(uint256 id) view returns (uint256)']);
const SKILL = parseAbi([
  'function hasSkill(uint256 id) view returns (bool)', 'function fee() view returns (uint256)', 'function strikeOf(uint256 target) view returns (uint64)', 'function graceEndsOf(uint256 target) view returns (uint256)',
  'function attack(uint256 attacker, uint256 target) payable returns (uint256)',
  'function starving(uint256 id) view returns (bool)', 'function starve(uint256 id)', 'function mintOpen() view returns (bool)',
  'function setSkill(uint256[] ids, uint8 v)', 'function lock()',
]);

async function walletOn(k: string) { await ensureChain(k); return createWalletClient({ chain: vchain(k), transport: custom((wallet as any).provider || (window as any).ethereum) }); }
const big = (o: any): any => (typeof o === 'string' && /^\d+$/.test(o) ? BigInt(o) : Array.isArray(o) ? o.map(big) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'name' || k === 'symbol' ? v : big(v)])) : o);

/** Creator: deploy the agent collection via AgentDropFactory (approval from the Worker). */
export async function deployAgentOn(slug: string, k: string, onTx: (h: string) => void): Promise<Address> {
  const a = await api('/launchpad/approval/' + slug, { auth: true, body: { chain: k } });
  if (a.kind !== 'agent') throw new Error('not an agent drop approval');
  const p = big(a.params); const me = wallet.address as Address;
  const args = [p, a.salt, BigInt(a.deadline), a.signature] as const; const pub = readClient(k);
  const sim = await pub.simulateContract({ address: a.factory, abi: FACTORY, functionName: 'createAgentDrop', args, account: me });
  const gas = await pub.estimateContractGas({ address: a.factory, abi: FACTORY, functionName: 'createAgentDrop', args, account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, gas: (gas * 125n) / 100n, chain: vchain(k), account: me });
  onTx(hash);
  const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('deploy transaction reverted');
  let engine: Address | null = null;
  for (const l of r.logs) { if (l.address.toLowerCase() !== a.factory.toLowerCase()) continue; try { const e: any = decodeEventLog({ abi: FACTORY, data: l.data, topics: l.topics }); if (e.eventName === 'AgentDropCreated') engine = e.args.engine; } catch {} }
  if (!engine) throw new Error('no AgentDropCreated event in the receipt');
  await api('/launchpad/deployed/' + slug, { auth: true, body: { chain: k, address: engine } });
  return engine;
}

/** Collector: mint qty (≤ 50 per tx, enforced on-chain) at the engine's mint price. 0.5% goes to MultiSea in-contract. */
// AgentDropKit (the drop's renderer): MultiSeaDrop-style phases for agent drops. Gen-0 mint goes through kit.mint.
const KIT = parseAbi(['function mint(address engine, address to, uint256 phaseId, uint256 qty, bytes32[] proof) payable returns (uint256)',
  'function phases(address engine) view returns ((uint64 start, uint64 end, uint128 price, uint32 maxPerWallet, uint32 maxSupply, bytes32 merkleRoot)[])',
  'function renderer() view returns (address)', 'function locked() view returns (bool)']);
/** Kit address when this drop mints through AgentDropKit phases, else null (legacy engine mint at mintPrice). */
export async function kitOf(k: string, engine: Address): Promise<Address | null> {
  const pub = readClient(k);
  try { const kit = (await pub.readContract({ address: engine, abi: KIT, functionName: 'renderer' })) as Address;
    const ph = (await pub.readContract({ address: kit, abi: KIT, functionName: 'phases', args: [engine] })) as any[]; return ph.length ? kit : null; } catch { return null; }
}
export async function agentMint(k: string, engine: Address, qty: number, onTx: (h: string) => void, phaseId = 0, proof: `0x${string}`[] = [], unit?: bigint) {
  const pub = readClient(k); const me = wallet.address as Address;
  const kit = await kitOf(k, engine);
  if (kit) {
    const ph = ((await pub.readContract({ address: kit, abi: KIT, functionName: 'phases', args: [engine] })) as any[])[phaseId];
    const value = (unit ?? BigInt(ph.price)) * BigInt(qty);
    const sim = await pub.simulateContract({ address: kit, abi: KIT, functionName: 'mint', args: [engine, me, BigInt(phaseId), BigInt(qty), proof], value, account: me });
    const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash);
    return { hash, receipt: await pub.waitForTransactionReceipt({ hash }) };
  }
  const price = (await pub.readContract({ address: engine, abi: ENGINE, functionName: 'mintPrice' })) as bigint;
  const sim = await pub.simulateContract({ address: engine, abi: ENGINE, functionName: 'mintMany', args: [me, BigInt(qty)], value: price * BigInt(qty), account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash);
  return { hash, receipt: await pub.waitForTransactionReceipt({ hash }) };
}

export type AgentView = { id: number; wallet: string; balEth?: number; lastFed: number; dead: boolean; skill: boolean; strikeAt: number; graceEnd: number; mine: boolean; custodian?: string; heirIsTreasury?: boolean; sex?: number; fertile?: boolean; mutation?: boolean; mutated?: boolean; infect?: boolean; infections?: number; repo?: boolean; queen?: boolean; zombie?: boolean };

export async function loadAgent(k: string, engine: Address, id: number): Promise<AgentView> {
  const pub = readClient(k); const I = BigInt(id);
  const [acct, fed, dead, owner, reaper] = await Promise.all([
    pub.readContract({ address: engine, abi: ENGINE, functionName: 'accountOf', args: [I] }), pub.readContract({ address: engine, abi: ENGINE, functionName: 'lastFedOf', args: [I] }),
    pub.readContract({ address: engine, abi: ENGINE, functionName: 'isDead', args: [I] }), pub.readContract({ address: engine, abi: ENGINE, functionName: 'ownerOf', args: [I] }).catch(() => '0x'),
    pub.readContract({ address: engine, abi: ENGINE, functionName: 'reaper' })]);
  let skill = false, strikeAt = 0, graceEnd = 0;
  // Starvation-only drops use a plain StarvationReaper (no skill views): those reads fall back to "no skill".
  if (reaper && !/^0x0+$/.test(reaper as string) && !dead) {
    const r = (fn: string) => pub.readContract({ address: reaper as Address, abi: SKILL, functionName: fn as any, args: [I] } as any).catch(() => 0);
    const [s, st, g] = await Promise.all([r('hasSkill'), r('strikeOf'), r('graceEndsOf')]);
    skill = !!s; strikeAt = Number(st); graceEnd = Number(g);
  }
  // Sex (1 Female / 2 Male, fixed for life) and Fertility (female-only rarity: twins by VRF luck). Older engines: unknown.
  const [sx, fe, mu, md] = await Promise.all([pub.readContract({ address: engine, abi: ENGINE, functionName: 'sexOf', args: [I] }).catch(() => 0), pub.readContract({ address: engine, abi: ENGINE, functionName: 'hasFertility', args: [I] }).catch(() => false), pub.readContract({ address: engine, abi: ENGINE, functionName: 'hasMutation', args: [I] }).catch(() => false), pub.readContract({ address: engine, abi: ENGINE, functionName: 'isMutated', args: [I] }).catch(() => false)]);
  // Infect (optional InfectSkill module, engine `infector()`): skill + count of NFTs bought and burned. Older engines: none.
  let infect = false, infections = 0;
  const infr = (await pub.readContract({ address: engine, abi: ENGINE, functionName: 'infector' }).catch(() => ZERO_A)) as string;
  if (infr && !/^0x0+$/.test(infr)) {
    const ri = (fn: string) => pub.readContract({ address: infr as Address, abi: INFECT, functionName: fn as any, args: [I] } as any).catch(() => 0);
    const [hi, n] = await Promise.all([ri('hasInfect'), ri('infections')]);
    infect = !!hi; infections = Number(n);
  }
  const custodian = dead ? ((await pub.readContract({ address: engine, abi: ENGINE, functionName: 'custodianOf', args: [I] })) as string) : undefined;
  const bal = await pub.getBalance({ address: acct as Address });
  // Repo / Queen / Zombie: gene 3 bits 64 / 128 / 256 (older engines: none).
  const gs = (await pub.readContract({ address: engine, abi: ENGINE, functionName: 'genesOf', args: [I] }).catch(() => [])) as readonly string[];
  const g3 = gs.length > 3 ? BigInt(gs[3]) : 0n;
  const repo = (g3 & 64n) !== 0n, queen = (g3 & 128n) !== 0n, zombie = (g3 & 256n) !== 0n;
  return { repo, queen, zombie, id, wallet: acct as string, balEth: Number(bal) / 1e18, lastFed: Number(fed), dead: dead as boolean, skill, strikeAt, graceEnd, custodian, sex: Number(sx), fertile: !!fe, mutation: !!mu, mutated: !!md, infect, infections, mine: (owner as string).toLowerCase() === (wallet.address || '').toLowerCase() };
}

export async function agentFeed(k: string, engine: Address, id: number, wei: bigint, onTx: (h: string) => void) {
  const me = wallet.address as Address; const pub = readClient(k);
  const sim = await pub.simulateContract({ address: engine, abi: ENGINE, functionName: 'feed', args: [BigInt(id)], value: wei, account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash); return pub.waitForTransactionReceipt({ hash });
}

export async function agentAttack(k: string, engine: Address, attacker: number, target: number, onTx: (h: string) => void) {
  const me = wallet.address as Address; const pub = readClient(k);
  const reaper = (await pub.readContract({ address: engine, abi: ENGINE, functionName: 'reaper' })) as Address;
  const fee = (await pub.readContract({ address: reaper, abi: SKILL, functionName: 'fee' })) as bigint;
  const sim = await pub.simulateContract({ address: reaper, abi: SKILL, functionName: 'attack', args: [BigInt(attacker), BigInt(target)], value: fee, account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash); return pub.waitForTransactionReceipt({ hash });
}

async function reaperOf(k: string, engine: Address) { return (await readClient(k).readContract({ address: engine, abi: ENGINE, functionName: 'reaper' })) as Address; }

/** Why mint is still closed ('' = open): CSV traits not uploaded/skipped, or the Death-skill table not locked. */
export async function agentMintGate(k: string, engine: Address): Promise<string> {
  const t = await agentTraitsState(k, engine);
  if (t && t.expected && !t.done) return 'Mint opens once the creator uploads the CSV traits onchain (or skips them).';
  return (await agentMintOpen(k, engine)) ? '' : 'Mint opens once the creator locks the Death-skill table.';
}
/** Mint gate: false until the creator locked the Death-skill table (starvation-only drops: always true). */
export async function agentMintOpen(k: string, engine: Address): Promise<boolean> {
  const r = await reaperOf(k, engine); if (/^0x0+$/.test(r)) return true;
  // Phased drops: the reaper only opens inside kit.mint, so "open" = the Death-skill table is locked (or no table).
  if (await kitOf(k, engine)) { try { return (await readClient(k).readContract({ address: r, abi: KIT, functionName: 'locked' })) as boolean; } catch { return true; } }
  return (await readClient(k).readContract({ address: r, abi: SKILL, functionName: 'mintOpen' })) as boolean;
}

/** Onchain CSV traits (AgentDropKit): signed row count, rows uploaded, sealed. null = legacy drop without a kit. */
export async function agentTraitsState(k: string, engine: Address): Promise<{ expected: number; rows: number; done: boolean; dict: boolean } | null> {
  const kit = await kitOf(k, engine); if (!kit) return null;
  try { const [expected, rows, , done, dict] = (await readClient(k).readContract({ address: kit, abi: KIT_TRAITS, functionName: 'traits', args: [engine] })) as any;
    return { expected: Number(expected), rows: Number(rows), done, dict: !/^0x0+$/.test(dict) }; } catch { return null; }
}
/** Creator: upload the CSV-traits table in batches (resumes after a partial upload), the last tx seals and opens mint. */
export async function agentUploadTraits(k: string, engine: Address, e: TraitEnc, onTx: (h: string, i: number, n: number) => void) {
  const kit = await kitOf(k, engine); if (!kit) throw new Error('This drop has no AgentDropKit.');
  const st = await agentTraitsState(k, engine); if (!st) throw new Error('Could not read the traits state.');
  if (st.done) return; if (st.expected !== e.rows) throw new Error(`The deploy signed ${st.expected} trait rows but this table has ${e.rows}.`);
  const from = Math.floor(st.rows / rowsPerChunk(e)); const txs = traitTxs(e, engine, from, !st.dict);
  const me = wallet.address as Address; const pub = readClient(k); const w = await walletOn(k);
  for (let i = 0; i < txs.length; i++) { const t = txs[i];
    const sim = await pub.simulateContract({ address: kit, abi: KIT_TRAITS, functionName: 'uploadTraits', args: [engine, t.dict, t.chunks, t.seal], account: me });
    const hash = await w.writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash, i + 1, txs.length);
    const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`traits tx ${i + 1} reverted`); }
}
/** Creator: open mint without CSV traits (agents show only their onchain traits). Final. */
export async function agentSkipTraits(k: string, engine: Address, onTx: (h: string) => void) {
  const kit = await kitOf(k, engine); if (!kit) throw new Error('This drop has no AgentDropKit.');
  const me = wallet.address as Address; const pub = readClient(k);
  const sim = await pub.simulateContract({ address: kit, abi: KIT_TRAITS, functionName: 'skipTraits', args: [engine], account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash); return pub.waitForTransactionReceipt({ hash });
}

/** Anyone: kill an agent that is past its starvation period (always on, no holder opt-in). */
export async function agentStarve(k: string, engine: Address, id: number, onTx: (h: string) => void) {
  const me = wallet.address as Address; const pub = readClient(k); const r = await reaperOf(k, engine);
  const sim = await pub.simulateContract({ address: r, abi: SKILL, functionName: 'starve', args: [BigInt(id)], account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash); return pub.waitForTransactionReceipt({ hash });
}

/** Creator: give the listed ids the Death skill (from the rarity table), then lock. Lock opens mint and is final. */
export async function agentLockSkills(k: string, engine: Address, ids: bigint[], onTx: (h: string) => void) {
  const me = wallet.address as Address; const pub = readClient(k); const r = await reaperOf(k, engine); const w = await walletOn(k);
  if (ids.length) { const s1 = await pub.simulateContract({ address: r, abi: SKILL, functionName: 'setSkill', args: [ids, 1], account: me });
    const h1 = await w.writeContract({ ...s1.request, chain: vchain(k), account: me }); onTx(h1); await pub.waitForTransactionReceipt({ hash: h1 }); }
  const s2 = await pub.simulateContract({ address: r, abi: SKILL, functionName: 'lock', account: me });
  const h2 = await w.writeContract({ ...s2.request, chain: vchain(k), account: me }); onTx(h2); return pub.waitForTransactionReceipt({ hash: h2 });
}

// ---- UI ----
const ago = (t: number, now: number) => { const s = Math.max(0, now - t); return s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const left = (s: number) => (s <= 0 ? 'now' : s < 3600 ? `${Math.ceil(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

export function agentCard(a: AgentView, o: { symbol: string; periodS: number; now: number; feeEth?: number; native: string; busy?: string }) {
  if (a.dead) return `<div class="agc dead"><div class="tomb">🪦</div><div><b>${esc(o.symbol)} #${a.id}</b><span class="mut small">Dead · NFT burned${a.lastFed ? ' · last fed ' + ago(a.lastFed, o.now) : ''}. Its wallet passed to ${a.custodian ? (a.heirIsTreasury ? 'the treasury' : 'its heir') + ` (<span class="mono">${esc(short(a.custodian))}</span>)` : 'its heir or the treasury'}, which also controls anything left in it. Tombstone metadata stays readable.</span></div></div>`;
  const starveIn = a.zombie ? Infinity : a.lastFed + o.periodS - o.now; const struck = a.strikeAt > 0; const inGrace = struck && a.graceEnd > o.now;
  return `<div class="agc ${struck ? 'struck' : ''}"><div class="agh"><b>${esc(o.symbol)} #${a.id}</b>${a.sex === 1 ? '<span class="ldtag" title="Female: can breed with a male">♀ Female</span>' : a.sex === 2 ? '<span class="ldtag" title="Male: can breed with a female">♂ Male</span>' : ''}${a.fertile ? '<span class="ldtag xp" title="Fertility: a chance of twins when she breeds (decided by VRF)">✿ Fertility</span>' : ''}${a.mutation ? '<span class="ldtag xp" title="Mutation: its children look mutated and may be born with a rare skill (Death, Fertility, Mutation or Infect)">🧬 Mutation</span>' : ''}${a.mutated ? '<span class="ldtag" title="Mutated: born from a Mutation parent, its looks were changed at birth">🧬 Mutated</span>' : ''}${a.infect ? `<span class="ldtag xp" title="Infect: the holder can have this agent's wallet buy an NFT from another collection (allowlisted marketplace, capped price, cooldown) and burn it for score">🦠 Infect · ${a.infections || 0} infection${a.infections === 1 ? '' : 's'}</span>` : ''}${a.skill ? '<span class="ldtag xp" title="Death skill: can ask ORA to judge a kill">☠ Death skill</span>' : ''}${a.repo ? '<span class="ldtag xp" title="Repo: when this agent kills with the Death skill, the victim\'s wallet (ETH, plus control of its tokens and NFTs) goes to this agent\'s wallet instead of the heir or treasury">💼 Repo</span>' : ''}${a.queen ? '<span class="ldtag xp" title="Queen: her holder can collect a small tribute from other living agents, once per agent per period">👑 Queen</span>' : ''}${a.zombie ? '<span class="ldtag xp zomb" title="Zombie: never dies. It cannot starve or be killed by the Death skill; only its holder can burn it">🧟 Zombie</span>' : ''}${a.mine ? '<span class="ldtag drop">Yours</span>' : ''}</div>
   <div class="kv small"><span>Agent wallet</span><b class="mono">${esc(short(a.wallet))}${a.balEth != null ? ` · ${(+a.balEth.toFixed(5))} ${esc(o.native)}` : ''}</b>
    <span>Last fed</span><b>${a.lastFed ? ago(a.lastFed, o.now) : 'never'}</b><span>Starves in</span><b class="${starveIn < 86400 ? 'err' : ''}">${a.zombie ? 'never (Zombie)' : left(starveIn)}</b>
    ${struck ? `<span>Strike</span><b class="err">⚠ ORA kill verdict ${ago(a.strikeAt, o.now)} · ${inGrace ? `grace ends in ${left(a.graceEnd - o.now)}` : 'grace over: a 2nd kill verdict kills it'}</b>` : '<span>Strikes</span><b class="ok">none</b>'}</div>
   <div class="agbtns">${starveIn <= 0 ? `<button class="obtn sm" data-agstarve="${a.id}" ${o.busy ? 'disabled' : ''} title="Anyone can trigger starvation once the period is over">Starve (anyone)</button>` : `<button class="bbtn sm" data-agfeed="${a.id}" ${o.busy ? 'disabled' : ''}>Feed${struck ? ' (clears strike)' : ''}</button>`}${a.skill && a.mine ? `<button class="obtn sm" data-agatk="${a.id}" ${o.busy ? 'disabled' : ''}>Attack…</button>` : ''}</div>${a.queen && a.mine ? `<div class="agbtns agtrib"><input data-agtribids placeholder="Agent ids, e.g. 12, 44" inputmode="numeric"><button class="bbtn sm" data-agtrib="${a.id}" ${o.busy ? 'disabled' : ''} title="Each listed living agent pays the tribute fee once per period into her wallet. Queens and agents that can't pay are skipped">👑 Collect tribute</button></div>` : ''}</div>`;
}

/** Queen: pull the tribute fee from each listed agent's wallet into hers (ineligible ids are skipped on-chain). */
export async function agentTribute(k: string, engine: Address, queen: number, ids: number[], onTx: (h: string) => void) {
  const me = wallet.address as Address; const pub = readClient(k);
  const sim = await pub.simulateContract({ address: engine, abi: ENGINE, functionName: 'collectTribute', args: [BigInt(queen), ids.map(BigInt)], account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash); return pub.waitForTransactionReceipt({ hash });
}

export function attackBox(attacker: number, o: { symbol: string; feeEth?: number; native: string; limits?: any; msg?: string }) {
  const L = o.limits || {}; const h = (s: number) => (s >= 86400 ? `${s / 86400}d` : `${s / 3600}h`);
  return `<div class="fcard agatk"><div class="gh">☠ Attack with ${esc(o.symbol)} #${attacker}</div>
   <label>Target agent #<input data-agtgt type="number" min="1" placeholder="token id"></label>
   <ol class="mut small"><li>You pay the ORA AI fee (${o.feeEth != null ? `≈ ${(+o.feeEth.toFixed(6))} ${esc(o.native)}` : 'quoted on-chain'}, not refunded). ORA's model reads both agents' on-chain stats and answers K (kill) or spare.</li>
    <li>1st K = a <b>strike</b>. The target's holder has a <b>grace</b> of ${h(L.grace || 172800)}: feeding it clears the strike.</li>
    <li>A 2nd K at least ${h(L.minGap || 86400)} later, after grace, <b>kills</b> it: its NFT is burned and its wallet goes to its heir or the treasury (or to your agent's wallet if it has Repo). Zombies can't be attacked. A spare verdict clears the strike.</li>
    <li>Limits: one attack per attacker every ${h(L.attackerCooldown || 86400)}; targets younger than ${h(L.minTargetAge || 604800)} are immune; a target can be attacked once per ${h(L.targetCooldown || 21600)}.</li></ol>
   <div class="agbtns"><button class="bbtn sm" data-agdo="${attacker}">Ask ORA to judge</button><button class="obtn sm" data-agcancel>Cancel</button></div>${o.msg ? `<p class="small">${o.msg}</p>` : ''}</div>`;
}

/** Demo agents for the local preview (labeled; no chain reads). */
export const demoAgents = (now: number): AgentView[] => [
  { id: 7, wallet: '0x7a11ce00000000000000000000000000000a9e07', balEth: 0.0123, lastFed: now - 3 * 86400, dead: false, skill: true, strikeAt: 0, graceEnd: 0, mine: true, sex: 1, fertile: true, mutation: true, infect: true, infections: 3, queen: true },
  { id: 12, wallet: '0x12bee5000000000000000000000000000a9e0012', balEth: 0.002, lastFed: now - 26 * 86400, dead: false, skill: false, strikeAt: now - 5 * 3600, graceEnd: now + 43 * 3600, mine: true, sex: 2, repo: true },
  { id: 31, wallet: '0x31dead00000000000000000000000000000a9e31', lastFed: now - 40 * 86400, dead: true, skill: false, strikeAt: 0, graceEnd: 0, mine: true, custodian: '0x2fee00000000000000000000000000000000a9e7', heirIsTreasury: true },
  { id: 44, wallet: '0x44f00d00000000000000000000000000000a9e44', balEth: 0.0004, lastFed: now - 31 * 86400, dead: false, skill: false, strikeAt: 0, graceEnd: 0, mine: false, sex: 1, mutated: true, mutation: true },
  { id: 58, wallet: '0x58b0a1000000000000000000000000000000a9e58', balEth: 0.003, lastFed: now - 90 * 86400, dead: false, skill: false, strikeAt: 0, graceEnd: 0, mine: false, sex: 2, zombie: true }];

export const GROWTH_WRITE_ABI = parseAbi(['function addValue(address engine,uint8 typeId,string typeName,string name,(string value,string art,uint16 chanceBps,uint16 minParentLevel,uint32 claimLevel,uint8 reqType,uint8 reqValue) value)','function claim(address engine,uint256 id,uint8 typeId,uint8 valueId)']);
export async function agentAddValue(k: string, engine: Address, growth: Address, typeId: number, typeName: string, name: string, value: unknown, onTx: (h: string) => void) {
  const account = wallet.address as Address; const cli = await walletOn(k);
  const req = { address: growth, abi: GROWTH_WRITE_ABI, functionName: 'addValue' as const, args: [engine, typeId, typeName, name, value], account } as any;
  const sim = await readClient(k).simulateContract(req);
  const hash = await cli.writeContract({ ...sim.request, account, chain: vchain(k) }); onTx(hash); await readClient(k).waitForTransactionReceipt({ hash }); return hash;
}
export async function agentClaim(k: string, engine: Address, growth: Address, id: bigint, typeId: number, valueId: number, onTx: (h: string) => void) {
  const account = wallet.address as Address; const cli = await walletOn(k);
  const req = { address: growth, abi: GROWTH_WRITE_ABI, functionName: 'claim' as const, args: [engine, BigInt(id), typeId, valueId], account } as const;
  const sim = await readClient(k).simulateContract(req);
  const hash = await cli.writeContract({ ...sim.request, account, chain: vchain(k) }); onTx(hash); await readClient(k).waitForTransactionReceipt({ hash }); return hash;
}
