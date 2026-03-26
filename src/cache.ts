const CACHE_DUR_SECONDS = 2 * 3600;

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
