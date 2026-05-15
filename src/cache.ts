const CACHE_DUR_SECONDS = 4 * 3600;

// Hard cap on live cache entries after sweep. Each repo entry is ~215B
// on disk (probe measured 705 entries ≈ 150KB on awesome-homelab), so
// 25k repo entries ≈ 5.4MB. Each contrib entry is much smaller — the
// {kind:'count', count:n} payload + envelope is ~70B — so 25k contrib
// entries ≈ 1.75MB. The cap is applied per-namespace (repo + contrib
// sweep independently), so worst-case combined storage ≈ 7.2MB — still
// safely under chrome.storage.local's 10MB default quota. Keep below
// the 5000/h PAT rate limit by a few-x so the cap never starves
// BATCH_SIZE=10 fetches from fresh-data headroom.
const CACHE_MAX_ENTRIES = 25_000;

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

function storageGetAll(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(null, (items) =>
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(items)
    )
  );
}

function storageRemove(keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve) =>
    chrome.storage.local.remove(keys, () => {
      // Swallow lastError: eviction is best-effort. A failed remove just
      // means the next sweep picks the key up again.
      void chrome.runtime.lastError;
      resolve();
    })
  );
}

// Duplicated from github.ts rather than imported to avoid circular deps:
// github.ts already imports bulkReadCache/bulkWriteCache from cache.ts,
// so importing back would create cache.ts ← github.ts ← cache.ts.
const RATE_LIMIT_KEY = 'rate_limit';

// Contributor-count entries share chrome.storage.local with repo entries
// but live in their own namespace, keyed `owner/name\x00contrib`. NUL
// cannot occur in a GitHub nwo, so it cleanly separates the two
// "/"-containing namespaces. See docs/plans/2026-05-14-contributor-count-design.md.
export const CONTRIB_KEY_MARKER = '\x00contrib';
export function isContribKey(key: string): boolean {
  return key.endsWith(CONTRIB_KEY_MARKER);
}
// True repo-nwo keys: owner/name shape, NOT contrib-namespaced. Used by
// the repo scan path (readAllCachedRepos / sweepCache) to ignore contrib
// keys, and by content.ts's handleLocalStorageChange to avoid spurious
// preload-invalidation on contrib-key eviction.
export function isRepoNwoKey(key: string): boolean {
  return key.includes('/') && !isContribKey(key);
}

// Pure classification pass over a storage snapshot. Decides which keys
// are valid (fresh + right-version + well-shaped), which should be
// evicted (expired, wrong version, malformed), and which overflow the
// CACHE_MAX_ENTRIES cap (oldest-by-exp trimmed first). Shared between
// readAllCachedRepos / sweepCache (repo namespace) and sweepContribCache
// (contrib namespace) — each caller passes a keyFilter so the scan stays
// confined to the namespace it owns.
function scanEntries<T, V>(
  items: Record<string, unknown>,
  version: V,
  now: number,
  keyFilter: (key: string) => boolean
): { live: Map<string, T>; evict: string[] } {
  const live = new Map<string, T>();
  const evict: string[] = [];
  const liveExp: Array<{ key: string; exp: number }> = [];
  for (const [key, value] of Object.entries(items)) {
    // Each scan owns one namespace; keys outside it are out of scope.
    if (!keyFilter(key)) continue;
    const entry = value as Entry<T, V> | undefined;
    const valid =
      entry != null &&
      typeof entry.exp === 'number' &&
      entry.exp > now &&
      entry.ver === version &&
      entry.pay !== undefined;
    if (!valid) {
      evict.push(key);
      continue;
    }
    live.set(key, entry.pay);
    liveExp.push({ key, exp: entry.exp });
  }
  if (liveExp.length > CACHE_MAX_ENTRIES) {
    // Earliest exp = earliest write = "oldest". True LRU would require
    // bumping exp on read, which would defeat TTL-based staleness; this
    // is oldest-write-first, which is good enough for eviction.
    liveExp.sort((a, b) => a.exp - b.exp);
    const overflow = liveExp.length - CACHE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      const k = liveExp[i].key;
      evict.push(k);
      live.delete(k);
    }
  }
  return { live, evict };
}

// Read many keys from local storage in a SINGLE chrome.storage.local.get
// call and partition them into valid-cached entries vs missing keys
// (expired, wrong version, or absent). Opportunistically evicts any
// expired/wrong-version keys encountered in THIS request — cheap,
// since the caller already holds the key list.
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
  const evict: string[] = [];
  for (const key of keys) {
    const entry = items[key] as Entry<T, V> | undefined;
    // Validity predicate must mirror scanEntries (readAllCachedRepos /
    // sweepCache) — entry.pay !== undefined guards against externally-
    // corrupted storage where the envelope lost its payload.
    if (entry && entry.exp > now && entry.ver === version && entry.pay !== undefined) {
      cached.set(key, entry.pay);
    } else {
      missing.push(key);
      if (entry !== undefined) evict.push(key);
    }
  }
  void storageRemove(evict);
  return { cached, missing };
}

// Write many entries back to local storage in a SINGLE
// chrome.storage.local.set call, wrapping each payload in the
// { exp, pay, ver } envelope. No-op for an empty map. Fire-and-forget:
// on storage error, clear the cache area (persistent settings live in sync).
// `ttlSeconds` defaults to the 4h repo-data TTL; the contributor-count
// path passes a longer TTL since counts move slowly and the per-repo
// REST fetch is expensive and unbatchable.
export function bulkWriteCache<T, V>(
  fresh: Map<string, T>,
  version: V,
  ttlSeconds: number = CACHE_DUR_SECONDS
): void {
  if (fresh.size === 0) return;
  const exp = Date.now() + ttlSeconds * 1000;
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
//   - trims to CACHE_MAX_ENTRIES, oldest-by-exp first, when over cap
//
// Used by the 1.1.4 content-script preload path at document_start,
// where the DOM is still empty and we can't scope the read to a
// specific nwo list. The full-read cost is bounded by storage size —
// 2026-04-15 probe measured 234ms for 705 entries / 150KB on
// awesome-homelab, which comfortably beats React's hydration latency
// under normal conditions. document_start is also our natural GC tick:
// any evicted keys are fire-and-forget removed here rather than waiting
// for a dedicated sweep, since the get(null) snapshot already knows
// everything we'd need to re-read.
export async function readAllCachedRepos<T, V>(version: V): Promise<Map<string, T>> {
  const items = await storageGetAll();
  const { live, evict } = scanEntries<T, V>(items, version, Date.now(), isRepoNwoKey);
  void storageRemove(evict);
  return live;
}

// On-demand sweep for callers (e.g. the options page) that want a clean
// cache state BEFORE they read something derived from it — most notably
// getCacheEntryCount, which counts raw keys and would otherwise include
// expired / wrong-version cruft. Awaits the remove so a subsequent
// getCacheEntryCount call sees the post-sweep state.
export async function sweepCache<V>(version: V): Promise<void> {
  const items = await storageGetAll();
  const { evict } = scanEntries<unknown, V>(items, version, Date.now(), isRepoNwoKey);
  await storageRemove(evict);
}

// Contrib-namespace counterpart to sweepCache. Evicts expired /
// wrong-version / malformed / over-cap contributor entries. The repo
// sweep (sweepCache) deliberately skips contrib keys, so this is the
// only GC path for the contrib namespace besides bulkReadCache's
// opportunistic eviction. Caps the contrib namespace at
// CACHE_MAX_ENTRIES independently of the repo namespace.
export async function sweepContribCache<V>(contribVersion: V): Promise<void> {
  const items = await storageGetAll();
  const { evict } = scanEntries<unknown, V>(items, contribVersion, Date.now(), isContribKey);
  await storageRemove(evict);
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

// Remove every cached entry under a given owner (keys of shape `owner/name`),
// regardless of kind — broken-404s, valid repos, and silent-FORBIDDENs alike.
// Called when a user un-skips an owner, so broken chips reappear immediately
// instead of waiting out the 4h TTL. Case-insensitive match on the owner
// prefix since GitHub owner names are case-insensitive but storage keys
// preserve whatever case the link used.
export function clearOwnerCache(owner: string): Promise<void> {
  const prefix = owner.toLowerCase() + '/';
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(null, (items) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      const keysToRemove = Object.keys(items).filter(
        (k) => k.includes('/') && k.toLowerCase().startsWith(prefix)
      );
      if (keysToRemove.length === 0) return resolve();
      chrome.storage.local.remove(keysToRemove, () =>
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()
      );
    })
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
