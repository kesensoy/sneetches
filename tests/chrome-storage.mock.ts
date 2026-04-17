/**
 * Custom Chrome storage mock that properly persists data between async calls
 * and fires `onChanged` events when `set` / `remove` / `clear` mutate the
 * store. Replaces jest-webextension-mock's broken storage implementation for
 * Jest 29 AND its unlinked `onChanged` stub (which has `addListener` but
 * never dispatches).
 *
 * Semantics match real Chrome:
 *   - `chrome.storage.onChanged` fires with (changes, areaName) for every
 *     mutation in any area.
 *   - `chrome.storage.sync.onChanged` / `chrome.storage.local.onChanged`
 *     fire with just (changes) for their own area.
 *   - Only keys whose value actually changed appear in `changes`; set X=1
 *     twice produces no event on the second call.
 *   - Events fire after the callback returns, delivered via a microtask so
 *     tests can `await Promise.resolve()` (or an explicit flush) to observe
 *     the handler side effects.
 */

type StorageData = Record<string, unknown>;
type StorageCallback = (items: StorageData) => void;

// chrome.storage.StorageChange in @types/chrome. Avoid pulling the global
// type here so this file compiles standalone.
type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ChangesMap = Record<string, StorageChange>;
type AreaName = 'sync' | 'local';
type AreaListener = (changes: ChangesMap) => void;
type GlobalListener = (changes: ChangesMap, areaName: AreaName) => void;

// Deep-ish equality check so re-setting an identically-shaped object value
// doesn't fire a spurious change. Handles primitives, arrays, and plain
// objects — which is everything the extension actually stores. Falls back
// to JSON for the object case because chrome.storage values are already
// required to be JSON-serializable.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function createAreaListeners() {
  const listeners: AreaListener[] = [];
  return {
    listeners,
    addListener: jest.fn((l: AreaListener) => {
      listeners.push(l);
    }),
    removeListener: jest.fn((l: AreaListener) => {
      const i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
    }),
    hasListener: jest.fn((l: AreaListener) => listeners.includes(l)),
    hasListeners: jest.fn(() => listeners.length > 0),
  };
}

function createGlobalListeners() {
  const listeners: GlobalListener[] = [];
  return {
    listeners,
    addListener: jest.fn((l: GlobalListener) => {
      listeners.push(l);
    }),
    removeListener: jest.fn((l: GlobalListener) => {
      const i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
    }),
    hasListener: jest.fn((l: GlobalListener) => listeners.includes(l)),
    hasListeners: jest.fn(() => listeners.length > 0),
  };
}

const syncAreaListeners = createAreaListeners();
const localAreaListeners = createAreaListeners();
const globalListeners = createGlobalListeners();

function dispatchChanges(changes: ChangesMap, areaName: AreaName): void {
  if (Object.keys(changes).length === 0) return;
  // Defer to a microtask so listeners fire after the set/remove/clear
  // callback has returned, matching real Chrome semantics and avoiding
  // listener-observes-intermediate-state bugs.
  Promise.resolve().then(() => {
    const areaListeners =
      areaName === 'sync' ? syncAreaListeners.listeners : localAreaListeners.listeners;
    for (const l of areaListeners.slice()) l(changes);
    for (const l of globalListeners.listeners.slice()) l(changes, areaName);
  });
}

function createStorageArea(areaName: AreaName) {
  let store: StorageData = {};

  return {
    get(keys: string | string[] | StorageData | null, callback: StorageCallback) {
      const result: StorageData = {};
      if (keys === null) {
        Object.assign(result, store);
      } else if (typeof keys === 'string') {
        if (keys in store) result[keys] = store[keys];
      } else if (Array.isArray(keys)) {
        keys.forEach((k) => {
          if (k in store) result[k] = store[k];
        });
      } else {
        Object.keys(keys).forEach((k) => {
          result[k] = k in store ? store[k] : keys[k];
        });
      }
      callback(result);
    },

    set(items: StorageData, callback?: () => void) {
      const changes: ChangesMap = {};
      for (const [k, newValue] of Object.entries(items)) {
        const hadOld = k in store;
        const oldValue = store[k];
        if (hadOld && valuesEqual(oldValue, newValue)) continue;
        const change: StorageChange = { newValue };
        if (hadOld) change.oldValue = oldValue;
        changes[k] = change;
        store[k] = newValue;
      }
      if (callback) callback();
      dispatchChanges(changes, areaName);
    },

    clear(callback?: () => void) {
      const changes: ChangesMap = {};
      for (const [k, oldValue] of Object.entries(store)) {
        changes[k] = { oldValue };
      }
      store = {};
      if (callback) callback();
      dispatchChanges(changes, areaName);
    },

    remove(keys: string | string[], callback?: () => void) {
      const keyList = typeof keys === 'string' ? [keys] : keys;
      const changes: ChangesMap = {};
      for (const k of keyList) {
        if (k in store) {
          changes[k] = { oldValue: store[k] };
          delete store[k];
        }
      }
      if (callback) callback();
      dispatchChanges(changes, areaName);
    },
  };
}

// Override the storage APIs from jest-webextension-mock.
const syncArea = createStorageArea('sync');
const localArea = createStorageArea('local');
chrome.storage.local = {
  ...localArea,
  onChanged: localAreaListeners,
} as unknown as chrome.storage.LocalStorageArea;
chrome.storage.sync = {
  ...syncArea,
  onChanged: syncAreaListeners,
} as unknown as chrome.storage.SyncStorageArea;
chrome.storage.onChanged = globalListeners as unknown as chrome.events.Event<
  (changes: ChangesMap, areaName: chrome.storage.AreaName) => void
>;
