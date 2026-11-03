// ERC-463N7 agent drops (AgentDropFactory, ERC-463N7 repo): deploy, mint, and the per-agent panel (wallet, last fed,
// Feed, always-on starvation (reaper.starve), Death-skill attack with strike/grace state, burn + tombstone custody,
// and the mint gate: DeathSkill keeps mint closed until the creator assigns skills and calls lock()). Everything is behind config/launchpad.json
// agentDrops.enabled (OFF). VITE_AGENT_DROPS=1 turns on a labeled local preview with demo agents (no transactions).
import LPC from '../config/launchpad.json';
import { createWalletClient, custom, decodeEventLog, parseAbi, type Address } from 'viem';
import { wallet, ensureChain, readClient, vchain } from './wallet';
import { api } from './auth';
import { esc } from './shell';

const AG: any = (LPC as any).agentDrops || { enabled: false };
export const AGENT_DROPS: boolean = !!AG.enabled;
export const AGENT_PREVIEW: boolean = !AG.enabled && import.meta.env.VITE_AGENT_DROPS === '1';
export const AGENT_UI = AGENT_DROPS || AGENT_PREVIEW;
export const AGENT_CHAINS: string[] = AG.chains || [];
export const DEATH_CHAINS: string[] = AG.deathSkillChains || [];
export const ORA_FEE_WEI: Record<string, string> = AG.oraFeeWeiEstimate || {};
export const isAgentDrop = (d: any) => d?.raw?.nftType === 'erc463n7' || d?.nftType === 'erc463n7';

const FACTORY = parseAbi([
  'struct Limits { uint16 skillBps; uint32 attackerCooldown; uint32 minTargetAge; uint32 grace; uint32 minGap; uint32 targetCooldown; uint32 requestTimeout; }',
  'struct AgentInit { string name; string symbol; address owner; address treasury; uint256 mintPrice; uint32 maxSupply; uint32 maxPerWallet; uint16 royaltyBps; uint32 starvationPeriod; bool deathSkill; uint256 modelId; Limits limits; }',
  'function createAgentDrop(AgentInit p, bytes32 salt, uint256 deadline, bytes sig) returns (address engine, address starvation, address deathSkill)',
  'event AgentDropCreated(address indexed engine, address indexed creator, bytes32 indexed salt, address starvationRule, address deathSkill)',
]);
const ENGINE = parseAbi([
  'function mintMany(address to, uint256 qty) payable returns (uint256)', 'function feed(uint256 id) payable', 'function accountOf(uint256 id) view returns (address)',
  'function lastFedOf(uint256 id) view returns (uint64)', 'function isDead(uint256 id) view returns (bool)', 'function custodianOf(uint256 id) view returns (address)', 'function ownerOf(uint256 id) view returns (address)', 'function reaper() view returns (address)', 'function mintPrice() view returns (uint256)',
]);
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
export async function agentMint(k: string, engine: Address, qty: number, onTx: (h: string) => void) {
  const pub = readClient(k); const me = wallet.address as Address;
  const price = (await pub.readContract({ address: engine, abi: ENGINE, functionName: 'mintPrice' })) as bigint;
  const sim = await pub.simulateContract({ address: engine, abi: ENGINE, functionName: 'mintMany', args: [me, BigInt(qty)], value: price * BigInt(qty), account: me });
  const hash = await (await walletOn(k)).writeContract({ ...sim.request, chain: vchain(k), account: me }); onTx(hash);
  return { hash, receipt: await pub.waitForTransactionReceipt({ hash }) };
}

export type AgentView = { id: number; wallet: string; balEth?: number; lastFed: number; dead: boolean; skill: boolean; strikeAt: number; graceEnd: number; mine: boolean; custodian?: string; heirIsTreasury?: boolean };

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
  const custodian = dead ? ((await pub.readContract({ address: engine, abi: ENGINE, functionName: 'custodianOf', args: [I] })) as string) : undefined;
  const bal = await pub.getBalance({ address: acct as Address });
  return { id, wallet: acct as string, balEth: Number(bal) / 1e18, lastFed: Number(fed), dead: dead as boolean, skill, strikeAt, graceEnd, custodian, mine: (owner as string).toLowerCase() === (wallet.address || '').toLowerCase() };
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

/** Mint gate: false until the creator locked the Death-skill table (starvation-only drops: always true). */
export async function agentMintOpen(k: string, engine: Address): Promise<boolean> {
  const r = await reaperOf(k, engine); if (/^0x0+$/.test(r)) return true;
  return (await readClient(k).readContract({ address: r, abi: SKILL, functionName: 'mintOpen' })) as boolean;
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
  const starveIn = a.lastFed + o.periodS - o.now; const struck = a.strikeAt > 0; const inGrace = struck && a.graceEnd > o.now;
  return `<div class="agc ${struck ? 'struck' : ''}"><div class="agh"><b>${esc(o.symbol)} #${a.id}</b>${a.skill ? '<span class="ldtag xp" title="Death skill: can ask ORA to judge a kill">☠ Death skill</span>' : ''}${a.mine ? '<span class="ldtag drop">Yours</span>' : ''}</div>
   <div class="kv small"><span>Agent wallet</span><b class="mono">${esc(short(a.wallet))}${a.balEth != null ? ` · ${(+a.balEth.toFixed(5))} ${esc(o.native)}` : ''}</b>
    <span>Last fed</span><b>${a.lastFed ? ago(a.lastFed, o.now) : 'never'}</b><span>Starves in</span><b class="${starveIn < 86400 ? 'err' : ''}">${left(starveIn)}</b>
    ${struck ? `<span>Strike</span><b class="err">⚠ ORA kill verdict ${ago(a.strikeAt, o.now)} · ${inGrace ? `grace ends in ${left(a.graceEnd - o.now)}` : 'grace over: a 2nd kill verdict kills it'}</b>` : '<span>Strikes</span><b class="ok">none</b>'}</div>
   <div class="agbtns">${starveIn <= 0 ? `<button class="obtn sm" data-agstarve="${a.id}" ${o.busy ? 'disabled' : ''} title="Anyone can trigger starvation once the period is over">Starve (anyone)</button>` : `<button class="bbtn sm" data-agfeed="${a.id}" ${o.busy ? 'disabled' : ''}>Feed${struck ? ' (clears strike)' : ''}</button>`}${a.skill && a.mine ? `<button class="obtn sm" data-agatk="${a.id}" ${o.busy ? 'disabled' : ''}>Attack…</button>` : ''}</div></div>`;
}

export function attackBox(attacker: number, o: { symbol: string; feeEth?: number; native: string; limits?: any; msg?: string }) {
  const L = o.limits || {}; const h = (s: number) => (s >= 86400 ? `${s / 86400}d` : `${s / 3600}h`);
  return `<div class="fcard agatk"><div class="gh">☠ Attack with ${esc(o.symbol)} #${attacker}</div>
   <label>Target agent #<input data-agtgt type="number" min="1" placeholder="token id"></label>
   <ol class="mut small"><li>You pay the ORA AI fee (${o.feeEth != null ? `≈ ${(+o.feeEth.toFixed(6))} ${esc(o.native)}` : 'quoted on-chain'}, not refunded). ORA's model reads both agents' on-chain stats and answers K (kill) or spare.</li>
    <li>1st K = a <b>strike</b>. The target's holder has a <b>grace</b> of ${h(L.grace || 172800)}: feeding it clears the strike.</li>
    <li>A 2nd K at least ${h(L.minGap || 86400)} later, after grace, <b>kills</b> it: its NFT is burned and its wallet goes to its heir or the treasury. A spare verdict clears the strike.</li>
    <li>Limits: one attack per attacker every ${h(L.attackerCooldown || 86400)}; targets younger than ${h(L.minTargetAge || 604800)} are immune; a target can be attacked once per ${h(L.targetCooldown || 21600)}.</li></ol>
   <div class="agbtns"><button class="bbtn sm" data-agdo="${attacker}">Ask ORA to judge</button><button class="obtn sm" data-agcancel>Cancel</button></div>${o.msg ? `<p class="small">${o.msg}</p>` : ''}</div>`;
}

/** Demo agents for the local preview (labeled; no chain reads). */
export const demoAgents = (now: number): AgentView[] => [
  { id: 7, wallet: '0x7a11ce00000000000000000000000000000a9e07', balEth: 0.0123, lastFed: now - 3 * 86400, dead: false, skill: true, strikeAt: 0, graceEnd: 0, mine: true },
  { id: 12, wallet: '0x12bee5000000000000000000000000000a9e0012', balEth: 0.002, lastFed: now - 26 * 86400, dead: false, skill: false, strikeAt: now - 5 * 3600, graceEnd: now + 43 * 3600, mine: true },
  { id: 31, wallet: '0x31dead00000000000000000000000000000a9e31', lastFed: now - 40 * 86400, dead: true, skill: false, strikeAt: 0, graceEnd: 0, mine: true, custodian: '0x2fee00000000000000000000000000000000a9e7', heirIsTreasury: true },
  { id: 44, wallet: '0x44f00d00000000000000000000000000000a9e44', balEth: 0.0004, lastFed: now - 31 * 86400, dead: false, skill: false, strikeAt: 0, graceEnd: 0, mine: false }];
