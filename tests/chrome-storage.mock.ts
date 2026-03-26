/**
 * Custom Chrome storage mock that properly persists data between async calls.
 * Replaces jest-webextension-mock's broken storage implementation for Jest 29.
 */

type StorageData = Record<string, unknown>;
type StorageCallback = (items: StorageData) => void;

function createStorageArea() {
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
      Object.assign(store, items);
      if (callback) callback();
    },

    clear(callback?: () => void) {
      store = {};
      if (callback) callback();
    },

    remove(keys: string | string[], callback?: () => void) {
      if (typeof keys === 'string') {
        delete store[keys];
      } else {
        keys.forEach((k) => delete store[k]);
      }
      if (callback) callback();
    },
  };
}

// Override the storage APIs from jest-webextension-mock
chrome.storage.local = createStorageArea() as unknown as chrome.storage.LocalStorageArea;
chrome.storage.sync = createStorageArea() as unknown as chrome.storage.SyncStorageArea;
