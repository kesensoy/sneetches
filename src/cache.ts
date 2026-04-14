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
// github.ts already imports locallyCached from cache.ts, so importing back
// would create cache.ts ← github.ts ← cache.ts. Duplication is the lesser evil.
// Keep these two constants in sync.

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
