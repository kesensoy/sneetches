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

// Duplicated from github.ts rather than imported to avoid circular deps:
// github.ts already imports bulkReadCache/bulkWriteCache from cache.ts,
// so importing back would create cache.ts ← github.ts ← cache.ts.
const RATE_LIMIT_KEY = 'rate_limit';

// Read many keys from local storage in a SINGLE chrome.storage.local.get
// call and partition them into valid-cached entries vs missing keys
// (expired, wrong version, or absent).
//
// Returned Map/array are mutable so the caller can feed them straight into
// downstream postMessage / merge loops without a defensive copy. On storage
// error (fire-and-forget write path), clears the cache area — persistent
// settings live in sync storage.
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
// { exp, pay, ver } envelope. No-op for an empty map. Fire-and-forget:
// on storage error, clear the cache area (persistent settings live in sync).
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
