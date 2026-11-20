// Snapshot collection holders into a launchpad allowlist (EVM + Solana). No contract or program change.
// MultiSea collections: live ownerOf (omni: one owner per token id, escrows excluded) plus Solana Core asset PDAs.
// External EVM: ERC-721 enumerable / sequential ownerOf / Transfer logs; ERC-1155 via logs or a clear CSV message.
// External Solana: DAS getAssetsByGroup when a public RPC supports it; otherwise a clear failure (public RPCs often
// refuse getProgramAccounts and have no DAS).
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { solKey } from './solanadrop.js';
import { findPda, solRpcList, b58, storePdaOf } from './solswitch.js';
import { merkle } from './launchpad.js';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const EXT_CHAINS = ['base', 'ethereum', 'apechain', 'bnb', 'robinhood'];
const IERC721 = '0x80ac58cd', IERC721_ENUM = '0x780e9d63', IERC1155 = '0xd9b67a26';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427734f4c083ea33d7ead6bc3c41';
const TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a51897d';
const AGG = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const NFT = parseAbi([
  'function supportsInterface(bytes4) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function collectionId() view returns (bytes32)',
]);
const te = new TextEncoder();
const S = s => te.encode(s);
const hex32 = h => { const t = (h.startsWith('0x') ? h.slice(2) : h).padStart(64, '0'); const u = new Uint8Array(32); for (let i = 0; i < 32; i++) u[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16); return u; };
const le32 = n => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
export const assetPdaOf = (cid, id, pid) => findPda([S('Asset'), hex32(cid), le32(id)], pid);
export const isSolAddr = s => { try { solKey(s); return true; } catch { return false; } };
export const isEvmAddr = s => /^0x[0-9a-fA-F]{40}$/.test(s);
export const normAddr = s => (isEvmAddr(s) ? s.toLowerCase() : s);
const coreOwner = d => (d && d[0] === 1 && d.length >= 33 ? b58(d.slice(1, 33)) : null);

/**
 * Union of holders who meet each source's min unique-token count. Token counts are per MultiSea profile
 * (linked wallets share a pool). Solana-only profiles are skipped unless includeSolana (the drop mints on Solana).
 */
export function qualifyFromSources(sourceHolders, { includeLinked = true, includeSolana = false, cap = 10000, exclude = new Set(), profiles = new Map() } = {}) {
  const excl = new Set([...exclude].map(normAddr));
  excl.add(ZERO);
  const skippedOwners = new Set();
  const qualified = new Map(); // profileKey -> { evmHold: Set, solHold: Set }
  for (const src of sourceHolders) {
    const counts = new Map(); // profileKey -> Set(tokenKey)
    const held = new Map(); // profileKey -> { evm: Set, sol: Set }
    for (const t of src.tokens || []) {
      const o = normAddr(t.owner || ''); if (!o) continue;
      if (excl.has(o)) { skippedOwners.add(o); continue; }
      const p = profiles.get(o);
      const key = p?.primary ? normAddr(p.primary) : o;
      if (!counts.has(key)) { counts.set(key, new Set()); held.set(key, { evm: new Set(), sol: new Set() }); }
      const id = t.id != null ? String(t.id) : 'u:' + o + ':' + (t.key || counts.get(key).size);
      // unique token ids; qty>0 (1155) still counts as one id unless no id was given, then units
      if (t.id == null && t.qty) {
        const cur = counts.get(key);
        cur._u = (cur._u || 0) + Number(t.qty);
      } else counts.get(key).add(id);
      if (isEvmAddr(o)) held.get(key).evm.add(o); else held.get(key).sol.add(o);
    }
    for (const [key, ids] of counts) {
      const n = (ids._u || 0) + ids.size - (ids._u && ids.has === undefined ? 0 : 0);
      const n2 = (ids._u || 0) + [...ids].filter(x => x !== undefined).length;
      const total = (ids._u || 0) + ids.size;
      if (total < (src.min || 1)) continue;
      if (!qualified.has(key)) qualified.set(key, { evmHold: new Set(), solHold: new Set() });
      const h = held.get(key);
      h.evm.forEach(a => qualified.get(key).evmHold.add(a));
      h.sol.forEach(a => qualified.get(key).solHold.add(a));
    }
  }
  const evm = new Set(), sol = new Set();
  let skippedSolana = 0;
  for (const [key, h] of qualified) {
    const p = profiles.get(key) || profiles.get(normAddr(key));
    const evms = new Set(h.evmHold), sols = new Set(h.solHold);
    if (p?.primary && isEvmAddr(p.primary)) evms.add(normAddr(p.primary));
    if (includeLinked && p?.wallets) for (const w of p.wallets) {
      if (w.kind === 'sol' || isSolAddr(w.addr)) sols.add(w.addr);
      else if (isEvmAddr(w.addr)) evms.add(w.addr.toLowerCase());
    }
    const evmOk = [...evms].filter(a => a && !excl.has(normAddr(a)));
    const solOk = [...sols].filter(a => a && !excl.has(a));
    evmOk.forEach(a => evm.add(normAddr(a)));
    if (includeSolana) solOk.forEach(a => sol.add(a));
    else if (!evmOk.length && solOk.length) skippedSolana++;
  }
  let addresses = (includeSolana ? [...evm, ...sol] : [...evm]).sort();
  let truncated = false, warning;
  if (addresses.length > cap) { addresses = addresses.slice(0, cap); truncated = true; warning = `Holder list hit the ${cap.toLocaleString()}-wallet cap; remaining wallets were not added. Split the phase or raise the cap.`; }
  return { addresses, count: addresses.length, evm: evm.size, solana: includeSolana ? sol.size : 0, skippedSolana, excludedEscrow: skippedOwners.size, truncated, warning };
}

export function parseSources(arr, { bad, ADDR }) {
  if (!Array.isArray(arr) || !arr.length) bad('add at least one collection to snapshot');
  if (arr.length > 20) bad('at most 20 holder sources');
  return arr.map((s, i) => {
    const min = Number(s.min ?? 1); if (!Number.isInteger(min) || min < 1 || min > 1_000_000) bad(`source ${i + 1}: min held must be an integer 1+`);
    if (s.slug) { if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(s.slug)) bad(`source ${i + 1}: bad collection slug`); return { slug: s.slug, min }; }
    if (s.chain === 'solana' && s.address) { try { solKey(s.address); } catch { bad(`source ${i + 1}: bad Solana collection or mint address`); } return { chain: 'solana', address: s.address, min }; }
    if (s.chain && s.address) {
      if (!EXT_CHAINS.includes(s.chain)) bad(`source ${i + 1}: pick Base, Ethereum, ApeChain, BNB or Robinhood`);
      if (!ADDR.test(s.address)) bad(`source ${i + 1}: bad contract address`);
      return { chain: s.chain, address: s.address.toLowerCase(), min };
    }
    bad(`source ${i + 1}: needs a MultiSea slug or a chain + contract`);
  });
}

export function makeHolderAllow({ CFG, chains, lc, bad, ADDR, rpcFanout, LP, getCollection, walletLink, now = () => Date.now() }) {
  const cache = new Map();
  const cap = () => Number(LP.maxAllowlist || 10000);
  async function call(chain, to, data, allowFail = false) {
    const c = chains[chain]; if (!c) { if (allowFail) return null; bad('unsupported chain', 400); }
    const j = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
    if (j.error || !j.result || j.result === '0x') { if (allowFail) return null; bad((j.error && j.error.message) || 'rpc empty', 502); }
    return j.result;
  }
  async function aggregate(chain, calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 250) {
      const data = encodeFunctionData({ abi: AGG, functionName: 'aggregate3', args: [calls.slice(i, i + 250)] });
      const res = await call(chain, MC, data);
      out.push(...decodeFunctionResult({ abi: AGG, functionName: 'aggregate3', data: res }));
    }
    return out;
  }
  const iface = (chain, token, id) => call(chain, token, encodeFunctionData({ abi: NFT, functionName: 'supportsInterface', args: [id] }), true)
    .then(r => !!(r && r !== '0x' && BigInt(r) === 1n)).catch(() => false);
  const uint = (r) => { try { return r && r !== '0x' ? Number(BigInt(r)) : null; } catch { return null; } };
  const addrOf = (r) => (r && r.length >= 66 ? ('0x' + r.slice(-40)).toLowerCase() : null);

  async function evmOwners(chain, token, ids) {
    const calls = ids.map(id => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: NFT, functionName: 'ownerOf', args: [BigInt(id)] }) }));
    const res = await aggregate(chain, calls);
    return ids.map((id, i) => ({ id, owner: res[i]?.success ? addrOf(res[i].returnData) : null }));
  }

  async function collectionCid(col) {
    const orig = (col.deployments || []).find(d => d.original) || (col.deployments || [])[0];
    if (!orig || !chains[orig.chain]) return null;
    const r = await call(orig.chain, orig.address, encodeFunctionData({ abi: NFT, functionName: 'collectionId' }), true);
    return r && r !== '0x' && r.length >= 66 ? r : null;
  }

  async function solRpc(method, params) {
    const urls = solRpcList(LP); let last = 'no rpc';
    for (const u of urls) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
        if (!r.ok) { last = u + ' HTTP ' + r.status; continue; }
        const j = await r.json();
        if (j.error) { last = u + ' ' + (j.error.message || j.error.code); continue; }
        return j.result;
      } catch (e) { last = u + ' ' + (e.message || e); }
    }
    throw new Error('all Solana RPCs failed: ' + String(last).slice(0, 160));
  }

  async function solOwnersByPdas(pdas, store) {
    const out = [];
    for (let i = 0; i < pdas.length; i += 10) {
      const part = pdas.slice(i, i + 10);
      const res = await solRpc('getMultipleAccounts', [part.map(x => x.pda), { encoding: 'base64' }]);
      const vals = res?.value || [];
      part.forEach((x, j) => {
        const raw = vals[j]?.data?.[0]; if (!raw) return;
        const d = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
        const o = coreOwner(d); if (!o || (store && o === store)) return;
        out.push({ id: x.id, owner: o });
      });
    }
    return out;
  }

  async function solProgramId(env) {
    if (LP.solana?.programId) return LP.solana.programId;
    const rec = await env.COLLECTIONS?.get('lp:solana', 'json').catch(() => null);
    return rec?.programId || null;
  }

  async function snapshotMultiSea(env, col, notes) {
    const tokens = [];
    const deployments = (col.deployments || []).filter(d => chains[d.chain] && EXT_CHAINS.includes(d.chain) || chains[d.chain]);
    const evmDeps = deployments.filter(d => d.chain !== 'solana' && isEvmAddr(d.address));
    const start = Number(col.idStart ?? 1);
    const end = Number(col.idEnd || (col.supply ? start + Number(col.supply) - 1 : 0));
    const ids = end >= start ? Array.from({ length: Math.min(end - start + 1, 20000) }, (_, i) => start + i) : [];
    const escrow = new Set((col.escrow || []).map(e => lc(e.address)));
    const byId = new Map(); // id -> evm owner or 'escrow' or null
    if (evmDeps.length && ids.length) {
      const orig = evmDeps.find(d => d.original) || evmDeps[0];
      const first = await evmOwners(orig.chain, lc(orig.address), ids);
      first.forEach(t => { if (!t.owner || t.owner === ZERO) byId.set(t.id, null); else if (escrow.has(t.owner) || t.owner === lc(orig.address)) byId.set(t.id, 'escrow'); else byId.set(t.id, t.owner); });
      const missing = ids.filter(id => byId.get(id) == null || byId.get(id) === 'escrow');
      for (const d of evmDeps.filter(d => d !== orig)) {
        if (!missing.length) break;
        const part = await evmOwners(d.chain, lc(d.address), missing);
        for (const t of part) {
          if (!t.owner || t.owner === ZERO || escrow.has(t.owner) || t.owner === lc(d.address)) continue;
          byId.set(t.id, t.owner);
        }
      }
    }
    // Solana MultiSea copies: fill ids still escrowed / missing
    const needSol = ids.filter(id => !evmDeps.length || byId.get(id) == null || byId.get(id) === 'escrow');
    if (needSol.length) {
      try {
        const pid = await solProgramId(env);
        const cid = await collectionCid(col);
        if (pid && cid) {
          const store = storePdaOf(pid);
          const pdas = needSol.map(id => ({ id, pda: assetPdaOf(cid, id, pid) }));
          const sol = await solOwnersByPdas(pdas, store);
          sol.forEach(t => byId.set(t.id, t.owner));
        } else if (needSol.length && evmDeps.length) notes.push((col.name || col.slug) + ': some tokens are in escrow and Solana was not readable (program or collection id missing).');
      } catch (e) { notes.push((col.name || col.slug) + ' on Solana: ' + (e.message || e)); }
    }
    for (const [id, owner] of byId) {
      if (!owner || owner === 'escrow') continue;
      tokens.push({ id, owner });
    }
    return { tokens, exclude: escrow };
  }

  async function snapshotExternalEvm(chain, address, notes) {
    const token = lc(address);
    const [is721, isEnum, is1155] = await Promise.all([iface(chain, token, IERC721), iface(chain, token, IERC721_ENUM), iface(chain, token, IERC1155)]);
    if (is1155 && !is721) return snapshot1155(chain, token, notes);
    if (!is721 && !isEnum) {
      // some older 721s don't support ERC165; still try supply + ownerOf
    }
    const supplyRaw = await call(chain, token, encodeFunctionData({ abi: NFT, functionName: 'totalSupply' }), true);
    const supply = uint(supplyRaw);
    if (isEnum && supply && supply <= 20000) {
      const idxCalls = Array.from({ length: supply }, (_, i) => ({ target: token, allowFailure: true, callData: encodeFunctionData({ abi: NFT, functionName: 'tokenByIndex', args: [BigInt(i)] }) }));
      const idx = await aggregate(chain, idxCalls);
      const ids = idx.map((r, i) => (r?.success ? uint(r.returnData) : i)).filter(id => id != null);
      const own = await evmOwners(chain, token, ids);
      return { tokens: own.filter(t => t.owner && t.owner !== ZERO && t.owner !== token).map(t => ({ id: t.id, owner: t.owner })), exclude: new Set([token]) };
    }
    if (supply && supply <= 20000) {
      // sequential: try 1..supply, then 0..supply-1 for whichever returned more owners
      let own = await evmOwners(chain, token, Array.from({ length: supply }, (_, i) => i + 1));
      let ok = own.filter(t => t.owner && t.owner !== ZERO);
      if (ok.length < supply * 0.5) {
        const z = await evmOwners(chain, token, Array.from({ length: supply }, (_, i) => i));
        const okz = z.filter(t => t.owner && t.owner !== ZERO);
        if (okz.length > ok.length) ok = okz;
      }
      if (ok.length) return { tokens: ok.filter(t => t.owner !== token).map(t => ({ id: t.id, owner: t.owner })), exclude: new Set([token]) };
    }
    const fromLogs = await transferOwners(chain, token);
    if (fromLogs.tokens.length) return fromLogs;
    notes.push('Could not read holders of ' + token + ' on ' + chain + ' (not enumerable, no totalSupply, and Transfer logs were empty or refused). Paste a CSV of holder addresses instead.');
    return { tokens: [], exclude: new Set([token]), failed: true };
  }

  async function transferOwners(chain, token) {
    const c = chains[chain];
    const latestJ = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const latest = Number(BigInt(latestJ.result || latestJ));
    const owners = new Map(); // id -> owner
    const step = chain === 'ethereum' ? 50_000 : 200_000;
    let from = 0;
    // Prefer recent windows if the node refuses huge ranges: walk from 0 in chunks, stop after too many failures or 40 chunks (huge collections should use enumerable/supply).
    let fails = 0, chunks = 0;
    while (from <= latest && chunks < 40) {
      const to = Math.min(latest, from + step - 1);
      try {
        const j = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: token, topics: [TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }] });
        const logs = j.result || j; if (!Array.isArray(logs)) throw new Error('bad logs');
        for (const L of logs) {
          const id = Number(BigInt(L.topics[3] || L.data || '0'));
          const toA = ('0x' + String(L.topics[2] || '').slice(-40)).toLowerCase();
          if (toA && toA !== ZERO) owners.set(id, toA); else owners.delete(id);
        }
        fails = 0; chunks++;
      } catch { fails++; chunks++; if (fails >= 8) break; }
      from = to + 1;
    }
    return { tokens: [...owners].filter(([, o]) => o !== token).map(([id, owner]) => ({ id, owner })), exclude: new Set([token]) };
  }

  async function snapshot1155(chain, token, notes) {
    const c = chains[chain];
    const latestJ = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const latest = Number(BigInt(latestJ.result || latestJ));
    const bal = new Map(); // owner -> Map(id -> qty)
    const add = (from, to, id, qty) => {
      const q = Number(qty); if (!q) return;
      if (from && from !== ZERO) { const m = bal.get(from) || new Map(); m.set(id, (m.get(id) || 0) - q); bal.set(from, m); }
      if (to && to !== ZERO && to !== token) { const m = bal.get(to) || new Map(); m.set(id, (m.get(to) || 0) + q); bal.set(to, m); }
    };
    // fix typo in add(): m.get(id)
    const apply = (from, to, id, qty) => {
      const q = Number(qty); if (!q) return;
      if (from && from !== ZERO) { const m = bal.get(from) || new Map(); m.set(id, (m.get(id) || 0) - q); bal.set(from, m); }
      if (to && to !== ZERO && to !== token) { const m = bal.get(to) || new Map(); m.set(id, (m.get(id) || 0) + q); bal.set(to, m); }
    };
    const step = chain === 'ethereum' ? 50_000 : 200_000;
    let fromBlk = 0, fails = 0, any = false;
    while (fromBlk <= latest) {
      const toBlk = Math.min(latest, fromBlk + step - 1);
      try {
        const j = await rpcFanout(c, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: token, topics: [[TRANSFER_SINGLE, TRANSFER_BATCH]], fromBlock: '0x' + fromBlk.toString(16), toBlock: '0x' + toBlk.toString(16) }] });
        const logs = j.result || j; if (!Array.isArray(logs)) throw new Error('bad logs');
        for (const L of logs) {
          const topic = (L.topics[0] || '').toLowerCase();
          const fromA = ('0x' + String(L.topics[2] || '').slice(-40)).toLowerCase();
          const toA = ('0x' + String(L.topics[3] || '').slice(-40)).toLowerCase();
          const data = (L.data || '0x').slice(2);
          if (topic === TRANSFER_SINGLE) {
            const id = Number(BigInt('0x' + data.slice(0, 64)));
            const qty = Number(BigInt('0x' + data.slice(64, 128)));
            apply(fromA, toA, id, qty); any = true;
          } else if (topic === TRANSFER_BATCH && data.length >= 192) {
            // decode id[] qty[] — loose: skip if messy
            try {
              const word = i => BigInt('0x' + data.slice(i * 64, i * 64 + 64));
              const n = Number(word(4));
              for (let i = 0; i < n; i++) apply(fromA, toA, Number(word(5 + i)), Number(word(5 + n + 1 + i)));
              any = true;
            } catch {}
          }
        }
        fails = 0;
      } catch { fails++; if (fails >= 8) break; }
      fromBlk = toBlk + 1;
    }
    if (!any) {
      notes.push('This looks like an ERC-1155, and Transfer logs could not be read on ' + chain + '. Paste a CSV of holder addresses instead.');
      return { tokens: [], exclude: new Set([token]), failed: true };
    }
    const tokens = [];
    for (const [owner, m] of bal) for (const [id, qty] of m) if (qty > 0) tokens.push({ id, owner, qty });
    return { tokens, exclude: new Set([token]) };
  }

  async function snapshotExternalSol(address, notes) {
    // DAS first (free public RPCs often lack it). Fall back to a clear message — gPA is refused on public nodes.
    const tryDas = async (group) => {
      const tokens = [];
      for (let page = 1; page <= 20; page++) {
        let result;
        try { result = await solRpc('getAssetsByGroup', { groupKey: 'collection', groupValue: group, page, limit: 1000 }); }
        catch (e) {
          try { result = await solRpc('getAssetsByGroup', [{ groupKey: 'collection', groupValue: group, page, limit: 1000 }]); }
          catch { throw e; }
        }
        const items = result?.items || result?.assets || (Array.isArray(result) ? result : []);
        if (!items.length) break;
        for (const a of items) {
          const owner = a.ownership?.owner || a.owner || a.holding?.owner;
          const id = a.id || a.mint || a.token || a.interface;
          if (owner) tokens.push({ id: id || tokens.length, owner });
        }
        if (items.length < 1000) break;
      }
      return tokens;
    };
    try {
      let tokens = await tryDas(address);
      if (!tokens.length) {
        // Maybe the address is a Core asset mint: read it and use its collection key.
        try {
          const acc = await solRpc('getAccountInfo', [address, { encoding: 'base64' }]);
          const raw = acc?.value?.data?.[0];
          if (raw) {
            const d = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
            if (d[0] === 1 && d.length >= 66 && d[33] === 2) {
              const col = b58(d.slice(34, 66));
              tokens = await tryDas(col);
            }
          }
        } catch {}
      }
      if (tokens.length) return { tokens, exclude: new Set() };
      notes.push('No holders came back from DAS for ' + address + '. Public Solana RPCs often have no DAS and refuse getProgramAccounts; paste a CSV of holder addresses, or use a MultiSea collection.');
      return { tokens: [], exclude: new Set(), failed: true };
    } catch (e) {
      notes.push('Solana collection ' + address + ': ' + (e.message || e) + '. Public RPCs often have no DAS and refuse getProgramAccounts; paste a CSV, or use a MultiSea collection.');
      return { tokens: [], exclude: new Set(), failed: true };
    }
  }

  async function resolveProfiles(env, owners) {
    const map = new Map();
    if (!walletLink || !owners.length) return map;
    const uniq = [...new Set(owners.map(normAddr))];
    for (let i = 0; i < uniq.length; i += 80) {
      const part = uniq.slice(i, i + 80);
      await Promise.all(part.map(async a => {
        try {
          const primary = await walletLink.profileOf(env, a);
          if (!primary) return;
          const wallets = isEvmAddr(primary) ? await walletLink.list(env, primary) : [];
          const rec = { primary, wallets: wallets || [] };
          map.set(a, rec);
          map.set(normAddr(primary), rec);
          for (const w of rec.wallets) map.set(normAddr(w.addr), rec);
        } catch {}
      }));
    }
    return map;
  }

  async function colConfig(env, slug) {
    const staticCol = (CFG.collections || []).find(c => c.slug === slug);
    if (staticCol) return staticCol;
    const listed = getCollection ? await getCollection(env, slug) : await env.COLLECTIONS?.get('col:' + slug, 'json');
    if (listed && (listed.status === 'approved' || listed.deployments)) return listed;
    return null;
  }

  async function snapshot(env, { sources, includeLinked = true, includeSolana = false }) {
    const src = parseSources(sources, { bad, ADDR });
    const notes = [];
    const exclude = new Set();
    const sourceHolders = [];
    const sourceOut = [];
    let failed = 0;
    for (const s of src) {
      let got;
      try {
        if (s.slug) {
          const col = await colConfig(env, s.slug);
          if (!col) { notes.push('Unknown MultiSea collection: ' + s.slug); failed++; continue; }
          got = await snapshotMultiSea(env, col, notes);
          sourceOut.push({ slug: s.slug, name: col.name, min: s.min, tokens: got.tokens.length });
        } else if (s.chain === 'solana') {
          got = await snapshotExternalSol(s.address, notes);
          sourceOut.push({ chain: 'solana', address: s.address, min: s.min, tokens: got.tokens.length });
        } else {
          got = await snapshotExternalEvm(s.chain, s.address, notes);
          sourceOut.push({ chain: s.chain, address: s.address, min: s.min, tokens: got.tokens.length });
        }
      } catch (e) {
        notes.push((s.slug || s.address) + ': ' + (e.message || e));
        failed++; continue;
      }
      if (got.failed) failed++;
      (got.exclude || []).forEach?.(a => exclude.add(normAddr(typeof a === 'string' ? a : a)));
      if (got.exclude instanceof Set) got.exclude.forEach(a => exclude.add(normAddr(a)));
      sourceHolders.push({ min: s.min, tokens: got.tokens || [] });
    }
    if (!sourceHolders.length) bad(notes.join(' ') || 'could not read any collection holders', 502);
    const owners = sourceHolders.flatMap(s => s.tokens.map(t => t.owner));
    const profiles = await resolveProfiles(env, owners);
    const q = qualifyFromSources(sourceHolders, { includeLinked, includeSolana, cap: cap(), exclude, profiles });
    return { ...q, sources: sourceOut, notes, at: new Date(now()).toISOString(), includeLinked, includeSolana };
  }

  async function cachedSnap(env, body) {
    const key = JSON.stringify({ s: body.sources, l: !!body.includeLinked, sol: !!body.includeSolana });
    const hit = cache.get(key); if (hit && now() - hit.t < 90_000) return hit.v;
    const v = await snapshot(env, { sources: body.sources, includeLinked: body.includeLinked !== false, includeSolana: !!body.includeSolana });
    cache.set(key, { t: now(), v }); if (cache.size > 50) cache.clear();
    return v;
  }

  async function resnapDrop(env, d) {
    const allowlists = { ...(d.allowlists || {}) };
    if (!Object.keys(allowlists).length && d.slug) {
      for (let i = 0; i < (d.phases || []).length; i++) {
        const list = await env.COLLECTIONS?.get(`lallow:${d.slug}:${i}`, 'json').catch(() => null);
        if (list) allowlists[i] = list;
      }
    }
    const phases = (d.phases || []).map(p => ({ ...p }));
    let changed = false;
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i];
      if (ph.kind !== 'allowlist' || !ph.holderSources?.length || ph.holderFrozen) continue;
      const snap = await snapshot(env, { sources: ph.holderSources, includeLinked: ph.includeLinked !== false, includeSolana: !!d.solana });
      if (!snap.addresses.length) bad(`holder snapshot for phase “${ph.name || i + 1}” was empty`);
      allowlists[i] = snap.addresses;
      ph.merkleRoot = merkle(snap.addresses).root;
      changed = true;
    }
    return { ...d, phases, allowlists, _resnapped: changed };
  }

  async function listCollections(env) {
    const statics = (CFG.collections || []).map(c => ({ slug: c.slug, name: c.name, standard: c.standard, supply: c.supply, chains: (c.deployments || []).map(d => d.chain), escrow: !!(c.escrow && c.escrow.length), static: true }));
    let listed = [];
    try {
      const keys = await env.COLLECTIONS.list({ prefix: 'col:' });
      listed = (await Promise.all(keys.keys.map(k => env.COLLECTIONS.get(k.name, 'json')))).filter(c => c && c.status === 'approved' && c.slug && !statics.some(s => s.slug === c.slug))
        .map(c => ({ slug: c.slug, name: c.name, standard: c.standard || 'ERC721', supply: c.supply || c.maxSupply, chains: (c.deployments || []).map(d => d.chain), static: false }));
    } catch {}
    return { collections: [...statics, ...listed], extChains: EXT_CHAINS };
  }

  async function handle(req, env, url, p, M, body) {
    if (M === 'GET' && p[1] === 'holder-collections' && p.length === 2) return listCollections(env);
    if (M === 'POST' && p[1] === 'holder-allowlist' && p.length === 2) {
      const b = await body();
      return cachedSnap(env, b || {});
    }
  }

  return { handle, snapshot, cachedSnap, resnapDrop, listCollections, qualifyFromSources };
}
