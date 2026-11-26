// Last-good collection and home-grid snapshots for stale-while-revalidate.
// Small payloads go in localStorage; larger ones (long listing/item lists) in IndexedDB.
// An LRU index evicts old entries when the store would go over the cap.
const IDX = 'ms:swr:idx';
const MAX_BYTES = 1_500_000;
const MAX_N = 24;
const IDB_NAME = 'ms-swr';
const STORE = 'snaps';

type Idx = { k: string; at: number; n: number; idb?: 1 }[];

export type ColSnap = { at: number; collection?: any; stats?: Record<string, any>; listings?: any[]; items?: any[]; chain?: string; next?: string | null };
export type HomeSnap = { at: number; cards: any[] };

export const colCacheKey = (slug: string) => 'ms:col:' + slug;
export const HOME_CACHE_KEY = 'ms:home:v1';

function readIdx(): Idx { try { return JSON.parse(localStorage.getItem(IDX) || '[]'); } catch { return []; } }
function writeIdx(x: Idx) { try { localStorage.setItem(IDX, JSON.stringify(x)); } catch {} }

function idb(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
function idbGet(k: string): Promise<string | null> {
  return idb().then(db => new Promise(res => {
    if (!db) return res(null);
    const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
    q.onsuccess = () => res(typeof q.result === 'string' ? q.result : null);
    q.onerror = () => res(null);
  }));
}
function idbPut(k: string, v: string): Promise<void> {
  return idb().then(db => new Promise((res, rej) => {
    if (!db) return rej(new Error('idb'));
    const q = db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k);
    q.onsuccess = () => res();
    q.onerror = () => rej(q.error || new Error('idb put'));
  }));
}
function idbDel(k: string) {
  idb().then(db => { if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).delete(k); }).catch(() => {});
}

function evict(idx: Idx, need: number): Idx {
  idx = [...idx].sort((a, b) => a.at - b.at);
  let total = idx.reduce((s, e) => s + e.n, 0);
  while (idx.length && (idx.length >= MAX_N || total + need > MAX_BYTES)) {
    const e = idx.shift()!;
    total -= e.n;
    try { if (e.idb) idbDel(e.k); else localStorage.removeItem(e.k); } catch {}
  }
  return idx;
}

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  try {
    const row = readIdx().find(e => e.k === key);
    if (row?.idb) {
      const raw = await idbGet(key);
      return raw ? JSON.parse(raw) as T : null;
    }
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
    // Index might be missing after a partial clear; try IDB anyway.
    const raw2 = await idbGet(key);
    return raw2 ? JSON.parse(raw2) as T : null;
  } catch { return null; }
}

export async function cachePut(key: string, val: unknown): Promise<void> {
  const raw = JSON.stringify(val);
  const n = raw.length;
  let idx = evict(readIdx().filter(e => e.k !== key), n);
  const useIdb = n > 80_000;
  try {
    if (useIdb) await idbPut(key, raw);
    else localStorage.setItem(key, raw);
    idx.push({ k: key, at: Date.now(), n, ...(useIdb ? { idb: 1 as const } : {}) });
    writeIdx(idx);
  } catch {
    idx = evict(idx, n);
    writeIdx(idx);
    try { await idbPut(key, raw); idx = evict(readIdx().filter(e => e.k !== key), n); idx.push({ k: key, at: Date.now(), n, idb: 1 }); writeIdx(idx); } catch {}
  }
}

export const getColCache = (slug: string) => cacheGet<ColSnap>(colCacheKey(slug));
export const putColCache = (slug: string, snap: ColSnap) => cachePut(colCacheKey(slug), snap);
export const getHomeCache = () => cacheGet<HomeSnap>(HOME_CACHE_KEY);
export const putHomeCache = (cards: any[]) => cachePut(HOME_CACHE_KEY, { at: Date.now(), cards });
