const CACHE_DUR_SECONDS = 4 * 3600;

interface Entry<T, V> {
  readonly exp: number;
  readonly pay: T;
  readonly ver: V;
}

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(keys, (items) =>
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(items)
    )
  );
}

const RATE_LIMIT_KEY = 'rate_limit';
// Duplicated from github.ts rather than imported to avoid circular deps:
// github.ts already imports bulkReadCache/bulkWriteCache from cache.ts,
// so importing back would create cache.ts ← github.ts ← cache.ts.
// Duplication is the lesser evil. Keep these two constants in sync.

// If local storage contains an unexpired cache entry for `key` with the
// specified version, return its value. Otherwise call `thunk`, store its
// value in the cache, and return that value.
//
// If there's an error storing the value, it clears the local storage area.
// This is fine since persistent settings live in the sync storage area.
export async function locallyCached<T, V>(
  key: string,
  version: V,
  thunk: () => T | PromiseLike<T>
): Promise<T> {
  const items = await storageGet([key]);
  const entry = items[key] as Entry<T, V>;
  if (entry && entry.exp > Date.now() && entry.ver === version) {
    return entry.pay;
  }
  const pay = await thunk();
  chrome.storage.local.set(
    { [key]: { exp: Date.now() + CACHE_DUR_SECONDS * 1000, pay, ver: version } },
    () => chrome.runtime.lastError && chrome.storage.local.clear()
  );
  return pay;
}

// Array-in / Map-out batch variant of locallyCached. Looks up every key in
// local storage, calls `thunk` with only the subset that's missing or
// expired, stores each returned value under its key, and returns a merged
// Map of all hits (cached + freshly fetched). Keys that the thunk omits
// from its result are NOT cached — that lets callers distinguish silent-
// skip responses (FORBIDDEN, etc.) from happy-path hits.
export async function locallyCachedBatch<T, V>(
  keys: string[],
  version: V,
  thunk: (missing: string[]) => Promise<Map<string, T>>
): Promise<Map<string, T>> {
  if (keys.length === 0) return new Map();

  const items = await storageGet(keys);
  const now = Date.now();
  const result = new Map<string, T>();
  const missing: string[] = [];

  for (const key of keys) {
    const entry = items[key] as Entry<T, V> | undefined;
    if (entry && entry.exp > now && entry.ver === version) {
      result.set(key, entry.pay);
    } else {
      missing.push(key);
    }
  }

  if (missing.length === 0) return result;

  const fresh = await thunk(missing);
  const toStore: Record<string, Entry<T, V>> = {};
  const exp = Date.now() + CACHE_DUR_SECONDS * 1000;
  for (const [key, pay] of fresh) {
    result.set(key, pay);
    toStore[key] = { exp, pay, ver: version };
  }

  // Unconditional set — matches the single-key locallyCached above. An
  // empty toStore (thunk returned nothing) is a no-op in the Chrome API.
  chrome.storage.local.set(toStore, () => chrome.runtime.lastError && chrome.storage.local.clear());

  return result;
}

// Read many keys from local storage in a SINGLE chrome.storage.local.get
// call and partition them into valid-cached entries vs missing keys
// (expired, wrong version, or absent).
//
// This exists separately from locallyCachedBatch because the service-worker
// repo-data path needs to fire the cached subset to the client BEFORE it
// kicks off the network fetch for the missing entries — progressive reveal
// requires the two phases to be separable. locallyCachedBatch collapses
// them into a single promise-resolving round trip, which is the right
// shape for call sites that can't (or don't need to) stream results.
//
// Returned Map/array are mutable so the caller can feed them straight into
// downstream postMessage / merge loops without a defensive copy.
export async function bulkReadCache<T, V>(
  keys: string[],
  version: V
): Promise<{ cached: Map<string, T>; missing: string[] }> {
  if (keys.length === 0) return { cached: new Map(), missing: [] };
  const items = await storageGet(keys);
  const now = Date.now();
  const cached = new Map<string, T>();
  const missing: string[] = [];
  for (const key of keys) {
    const entry = items[key] as Entry<T, V> | undefined;
    if (entry && entry.exp > now && entry.ver === version) {
      cached.set(key, entry.pay);
    } else {
      missing.push(key);
    }
  }
  return { cached, missing };
}

// Write many entries back to local storage in a SINGLE
// chrome.storage.local.set call, wrapping each payload in the
// { exp, pay, ver } envelope. No-op for an empty map. Matches the
// fire-and-forget write semantics of locallyCached above: on storage
// error, clear the cache area (persistent settings live in sync).
export function bulkWriteCache<T, V>(fresh: Map<string, T>, version: V): void {
  if (fresh.size === 0) return;
  const exp = Date.now() + CACHE_DUR_SECONDS * 1000;
  const toStore: Record<string, Entry<T, V>> = {};
  for (const [key, pay] of fresh) {
    toStore[key] = { exp, pay, ver: version };
  }
  chrome.storage.local.set(toStore, () => chrome.runtime.lastError && chrome.storage.local.clear());
}

// Read EVERY cached repo entry from chrome.storage.local in a single
// get(null) call and return a Map keyed by the repo key. Filters:
//   - skips non-cache keys (rate_limit, anything without a "/")
//   - skips entries whose `ver` differs from the requested version
//   - skips expired entries (exp <= now)
//   - silently drops malformed entries (missing exp / pay / ver)
//
// Used by the 1.1.4 content-script preload path at document_start,
// where the DOM is still empty and we can't scope the read to a
// specific nwo list. The full-read cost is bounded by storage size —
// 2026-04-15 probe measured 234ms for 705 entries / 150KB on
// awesome-homelab, which comfortably beats React's hydration latency
// under normal conditions.
export async function readAllCachedRepos<T, V>(version: V): Promise<Map<string, T>> {
  const items = await new Promise<Record<string, unknown>>((resolve, reject) =>
    chrome.storage.local.get(null, (result) =>
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(result)
    )
  );
  const now = Date.now();
  const map = new Map<string, T>();
  for (const [key, value] of Object.entries(items)) {
    // Cache keys are always nwo-shaped ("owner/name"). The only other
    // key `cache.ts` consumers write today is `rate_limit`, but guard
    // by the "/" shape so new non-cache keys don't leak in.
    if (!key.includes('/')) continue;
    const entry = value as Entry<T, V> | undefined;
    if (!entry) continue;
    if (entry.ver !== version) continue;
    if (typeof entry.exp !== 'number' || entry.exp <= now) continue;
    if (entry.pay === undefined) continue;
    map.set(key, entry.pay);
  }
  return map;
}

export function getCacheEntryCount(): Promise<number> {
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(null, (items) =>
      chrome.runtime.lastError
        ? reject(chrome.runtime.lastError)
        : resolve(Object.keys(items).filter((k) => k !== RATE_LIMIT_KEY).length)
    )
  );
}

export function clearCache(): Promise<void> {
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(null, (items) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      const keysToRemove = Object.keys(items).filter((k) => k !== RATE_LIMIT_KEY);
      if (keysToRemove.length === 0) return resolve();
      chrome.storage.local.remove(keysToRemove, () =>
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      );
    })
  );
}
