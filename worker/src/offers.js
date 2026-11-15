// Collection offers: index CollectionOffers events into KV; serve /offers/:slug and /offers/:slug/best.
// When no contract is configured for a chain, those endpoints return empty lists (safe to deploy ahead of the contracts).
import { createPublicClient, http, fallback, parseEventLogs, parseAbi, keccak256, encodePacked } from 'viem';
import ART from '../../config/collection-offers-artifact.json';

export const OFFER_CHAINS = ['ethereum', 'base', 'apechain', 'bnb', 'robinhood'];
export const OFFER_FEE_BPS = 50;
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const EV_ABI = ART.abi.filter(x => x.type === 'event');
const VIEW_ABI = parseAbi([
  'function offers(uint256) view returns (address buyer, address collection, address royaltyRecipient, uint96 pricePerItem, uint32 remaining, uint40 expiry, uint16 royaltyBps, bool cancelled)',
]);

export function offersContracts(CFG) {
  const m = CFG.collectionOffers || {};
  const out = {};
  for (const k of OFFER_CHAINS) {
    const a = String(m[k] || '').toLowerCase();
    if (ADDR.test(a) && a !== ZERO) out[k] = a;
  }
  return out;
}

const evName = ev => ev.eventName;
const lc = s => String(s || '').toLowerCase();

export function makeOffers({ CFG, chains, bad, HASH, getCollection, feeWallet, cached, hooks, royaltyFor }) {
  const client = k => createPublicClient({
    transport: fallback((chains[k].rpcs?.length ? chains[k].rpcs : [chains[k].rpc]).map(u => http(u, { timeout: 8000, retryCount: 1 }))),
  });
  const contracts = () => offersContracts(CFG);
  const hasAny = () => Object.keys(contracts()).length > 0;

  const deployments = () => {
    const map = {}; // `${chain}:${token}` -> slug
    for (const c of CFG.collections || []) for (const d of c.deployments || []) {
      if (!d?.address || !d.chain) continue;
      map[`${d.chain}:${lc(d.address)}`] = c.slug;
    }
    return map;
  };
  const slugOf = (chain, token) => deployments()[`${chain}:${lc(token)}`] || null;

  const keyOf = (k, id) => `off:${k}:${id}`;
  const idxKey = (slug, k) => `offidx:${slug}:${k}`;

  async function putOffer(env, rec) {
    await env.COLLECTIONS.put(keyOf(rec.chain, rec.id), JSON.stringify(rec));
    const ik = idxKey(rec.slug, rec.chain);
    const ids = JSON.parse((await env.COLLECTIONS.get(ik)) || '[]');
    if (!ids.includes(rec.id)) { ids.push(rec.id); await env.COLLECTIONS.put(ik, JSON.stringify(ids)); }
  }

  async function getOffer(env, k, id) {
    return await env.COLLECTIONS.get(keyOf(k, id), 'json');
  }

  function royaltyOk(roy, rec) {
    if (roy) return lc(rec.royaltyRecipient) === lc(roy.recipient) && Number(rec.royaltyBps) === Number(roy.bps);
    return !Number(rec.royaltyBps) && (!rec.royaltyRecipient || rec.royaltyRecipient === ZERO);
  }

  function openOf(rec, now = Math.floor(Date.now() / 1000)) {
    return rec && !rec.cancelled && Number(rec.remaining) > 0 && Number(rec.expiry) > now;
  }

  async function applyLogs(env, k, logs) {
    const evs = parseEventLogs({ abi: EV_ABI, logs, strict: false });
    const out = { made: 0, accepted: 0, cancelled: 0, refunded: 0, skipped: 0 };
    for (const ev of evs) {
      const name = evName(ev);
      const a = ev.args || {};
      const id = String(a.id ?? a[0] ?? '');
      if (!id) continue;
      if (name === 'OfferMade') {
        const collection = lc(a.collection);
        const slug = slugOf(k, collection);
        if (!slug) { out.skipped++; continue; }
        const roy = royaltyFor ? await royaltyFor(env, slug) : null;
        const rec = {
          id, chain: k, slug, buyer: lc(a.buyer), collection,
          pricePerItem: String(a.pricePerItem), quantity: String(a.quantity), remaining: String(a.quantity),
          expiry: Number(a.expiry), royaltyRecipient: lc(a.royaltyRecipient || ZERO), royaltyBps: Number(a.royaltyBps || 0),
          feeBps: OFFER_FEE_BPS, feeRecipient: lc(feeWallet(env)), cancelled: false, fills: [],
          createdTx: ev.transactionHash, createdAt: new Date().toISOString(),
        };
        if (!royaltyOk(roy, rec)) { out.skipped++; continue; }
        const prev = await getOffer(env, k, id);
        await putOffer(env, prev ? { ...rec, remaining: prev.remaining, cancelled: prev.cancelled, fills: prev.fills || [] } : rec);
        out.made++;
      } else if (name === 'OfferAccepted') {
        const rec = await getOffer(env, k, id);
        if (!rec) { out.skipped++; continue; }
        rec.remaining = String(a.remaining);
        rec.fills = rec.fills || [];
        rec.fills.push({ seller: lc(a.seller), tokenId: String(a.tokenId), txHash: ev.transactionHash, at: new Date().toISOString() });
        await putOffer(env, rec);
        out.accepted++;
        if (hooks?.onSale) {
          const price = BigInt(rec.pricePerItem);
          const feeWei = price * BigInt(rec.feeBps || OFFER_FEE_BPS) / 10000n;
          const royaltyWei = rec.royaltyBps ? price * BigInt(rec.royaltyBps) / 10000n : 0n;
          const hash = keccak256(encodePacked(['bytes32', 'uint256', 'uint256'], [ev.transactionHash, BigInt(id), BigInt(a.tokenId)]));
          await hooks.onSale(env, {
            chain: k, orderHash: hash, txHash: ev.transactionHash, buyer: rec.buyer, seller: lc(a.seller),
            priceWei: price.toString(), feeWei: feeWei.toString(), royaltyWei: royaltyWei.toString(),
            items: [{ token: rec.collection, id: String(a.tokenId), slug: rec.slug }], source: 'multisea-offer',
          }).catch(() => {});
        }
      } else if (name === 'OfferCancelled' || name === 'OfferRefunded') {
        const rec = await getOffer(env, k, id);
        if (!rec) { out.skipped++; continue; }
        rec.remaining = '0'; rec.cancelled = true; rec.closedTx = ev.transactionHash;
        rec.closedAt = new Date().toISOString(); rec.closeReason = name === 'OfferCancelled' ? 'cancel' : 'expired';
        await putOffer(env, rec);
        if (name === 'OfferCancelled') out.cancelled++; else out.refunded++;
      }
    }
    return out;
  }

  async function sync(env, k, txHash) {
    if (!contracts()[k]) bad('offers not deployed on this chain', 404);
    if (!HASH.test(txHash || '')) bad('invalid input');
    const c = client(k);
    let rc = null;
    for (let i = 0; i < 4 && !rc; i++) {
      rc = await c.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!rc && i < 3) await new Promise(r => setTimeout(r, 1500));
    }
    if (!rc || rc.status !== 'success') bad('transaction not found or failed', 404);
    const to = lc(contracts()[k]);
    const logs = rc.logs.filter(g => lc(g.address) === to);
    if (!logs.length) bad('no offer events in transaction', 404);
    return { ok: true, ...(await applyLogs(env, k, logs)) };
  }

  async function loadSlug(env, slug) {
    const col = slug ? await getCollection(env, slug) : null;
    if (!col) return null;
    const cons = contracts();
    const offers = [];
    for (const k of Object.keys(cons)) {
      const dep = (col.deployments || []).find(d => d.chain === k);
      if (!dep) continue;
      const ids = JSON.parse((await env.COLLECTIONS.get(idxKey(slug, k))) || '[]');
      const recs = (await Promise.all(ids.map(id => getOffer(env, k, id)))).filter(Boolean);
      offers.push(...recs);
    }
    return { col, offers, contracts: cons };
  }

  async function liveCheck(env, recs) {
    // Re-read remaining/cancelled/expiry for open-looking offers. Failures keep the cached record.
    const byChain = {};
    for (const r of recs) {
      if (!openOf(r) && r.cancelled) continue;
      (byChain[r.chain] ??= []).push(r);
    }
    await Promise.all(Object.entries(byChain).map(async ([k, list]) => {
      const to = contracts()[k]; if (!to) return;
      const c = client(k);
      await Promise.all(list.map(async rec => {
        try {
          const o = await c.readContract({ address: to, abi: VIEW_ABI, functionName: 'offers', args: [BigInt(rec.id)] });
          rec.remaining = String(o.remaining);
          rec.cancelled = !!o.cancelled;
          rec.expiry = Number(o.expiry);
          rec.pricePerItem = String(o.pricePerItem);
          if (rec.cancelled || Number(rec.remaining) === 0) await putOffer(env, rec);
        } catch {}
      }));
    }));
    return recs;
  }

  function publicOffer(r) {
    return {
      id: r.id, chain: r.chain, slug: r.slug, buyer: r.buyer, collection: r.collection,
      pricePerItem: r.pricePerItem, quantity: r.quantity, remaining: r.remaining,
      expiry: r.expiry, royaltyBps: r.royaltyBps, feeBps: r.feeBps, cancelled: !!r.cancelled,
    };
  }

  async function list(env, slug, ctx) {
    const cons = contracts();
    if (!Object.keys(cons).length) return { offers: [], contracts: {}, best: {} };
    return cached(`offers:${slug}`, 60, async () => {
      const packed = await loadSlug(env, slug);
      if (!packed) bad('not found', 404);
      const recs = await liveCheck(env, packed.offers);
      const open = recs.filter(r => openOf(r)).map(publicOffer);
      return { offers: open, contracts: cons, best: bestFrom(open) };
    }, 60, ctx);
  }

  function bestFrom(open) {
    const best = {};
    for (const o of open) {
      const cur = best[o.chain];
      if (!cur || BigInt(o.pricePerItem) > BigInt(cur.pricePerItem)) best[o.chain] = o;
    }
    return best;
  }

  async function best(env, slug, ctx) {
    const j = await list(env, slug, ctx);
    return { contracts: j.contracts, best: j.best };
  }

  async function sweep(env) {
    if (!hasAny()) return { ok: true, skipped: true };
    return { ok: true };
  }

  return { list, best, sync, sweep, contracts, hasAny };
}
