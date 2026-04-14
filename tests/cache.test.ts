import { locallyCached, locallyCachedBatch, getCacheEntryCount, clearCache } from '../src/cache';

describe('locallyCached', () => {
  let thunk: jest.Mock<string>;
  let r1: string;

  beforeEach(async () => {
    // Clear all storage before each test
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));

    thunk = jest.fn(() => 'x');
    r1 = await locallyCached('k', 1, thunk);
  });

  test('calls the thunk once', async () => {
    expect(r1).toBe('x');
    expect(thunk.mock.calls.length).toBe(1);
  });

  test('uses the cached value', async () => {
    const r2 = await locallyCached('k', 1, () => 'y');
    expect(thunk.mock.calls.length).toBe(1);
    expect(r2).toBe('x');
  });

  test('calls the thunk when the key has changed', async () => {
    const r2 = await locallyCached('k2', 1, () => 'y');
    expect(r2).toBe('y');
  });

  test('calls the thunk when the version has changed', async () => {
    const r2 = await locallyCached('k', 2, () => 'y');
    expect(r2).toBe('y');
  });

  test('calls the thunk when the cache has expired', async () => {
    // Advance time past the 4-hour cache TTL
    const fourHoursMs = 4 * 3600 * 1000 + 1;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + fourHoursMs);
    const r2 = await locallyCached('k', 1, () => 'y');
    expect(r2).toBe('y');
    jest.restoreAllMocks();
  });

  test('passes rejections through', async () => {
    const thunk2 = jest.fn(() => new Promise((_, reject) => reject('rejection')));
    await expect(locallyCached('err', 1, thunk2)).rejects.toBe('rejection');
  });
});

describe('getCacheEntryCount', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('returns 0 when empty', async () => {
    expect(await getCacheEntryCount()).toBe(0);
  });

  test('counts entries written by locallyCached', async () => {
    await locallyCached('repo1', 1, () => 'a');
    await locallyCached('repo2', 1, () => 'b');
    expect(await getCacheEntryCount()).toBe(2);
  });

  test('excludes the rate_limit key from the count', async () => {
    await locallyCached('repo1', 1, () => 'a');
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ rate_limit: { limit: 5000, remaining: 4999, at: 0 } }, () =>
        resolve()
      )
    );
    expect(await getCacheEntryCount()).toBe(1);
  });
});

describe('locallyCachedBatch', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('calls thunk with all keys on full cache miss and returns their results', async () => {
    const thunk = jest.fn(async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k, i) => map.set(k, i + 1));
      return map;
    });
    const result = await locallyCachedBatch(['a', 'b', 'c'], 1, thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(thunk).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
    expect(result.get('c')).toBe(3);
  });

  test('does not call thunk when all keys are cached', async () => {
    await locallyCachedBatch<number, number>(['a', 'b'], 1, async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k, i) => map.set(k, i + 10));
      return map;
    });

    const thunk2 = jest.fn();
    const result = await locallyCachedBatch(['a', 'b'], 1, thunk2);
    expect(thunk2).not.toHaveBeenCalled();
    expect(result.get('a')).toBe(10);
    expect(result.get('b')).toBe(11);
  });

  test('calls thunk with only the missing subset on mixed hit/miss', async () => {
    await locallyCachedBatch<number, number>(['a', 'b'], 1, async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 100));
      return map;
    });

    const thunk2 = jest.fn(async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 200));
      return map;
    });
    const result = await locallyCachedBatch(['a', 'b', 'c', 'd'], 1, thunk2);
    expect(thunk2).toHaveBeenCalledTimes(1);
    expect(thunk2).toHaveBeenCalledWith(['c', 'd']);
    expect(result.get('a')).toBe(100);
    expect(result.get('b')).toBe(100);
    expect(result.get('c')).toBe(200);
    expect(result.get('d')).toBe(200);
  });

  test('treats expired entries as missing', async () => {
    await locallyCachedBatch<number, number>(['a'], 1, async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 1));
      return map;
    });

    const fourHoursMs = 4 * 3600 * 1000 + 1;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + fourHoursMs);

    const thunk2 = jest.fn(async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 2));
      return map;
    });
    const result = await locallyCachedBatch(['a'], 1, thunk2);
    expect(thunk2).toHaveBeenCalledWith(['a']);
    expect(result.get('a')).toBe(2);

    jest.restoreAllMocks();
  });

  test('treats stale version entries as missing', async () => {
    await locallyCachedBatch<number, number>(['a'], 1, async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 1));
      return map;
    });

    const thunk2 = jest.fn(async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 2));
      return map;
    });
    const result = await locallyCachedBatch(['a'], 2, thunk2);
    expect(thunk2).toHaveBeenCalledWith(['a']);
    expect(result.get('a')).toBe(2);
  });

  test('returns empty map for empty input without calling thunk', async () => {
    const thunk = jest.fn();
    const result = await locallyCachedBatch<number, number>([], 1, thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  test('does not store keys the thunk omits from its result', async () => {
    await locallyCachedBatch<number, number>(['a', 'b'], 1, async (_missing: string[]) => {
      const map = new Map<string, number>();
      map.set('a', 1);
      return map;
    });

    const thunk2 = jest.fn(async (missing: string[]) => {
      const map = new Map<string, number>();
      missing.forEach((k) => map.set(k, 99));
      return map;
    });
    const result = await locallyCachedBatch(['a', 'b'], 1, thunk2);
    expect(thunk2).toHaveBeenCalledWith(['b']);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(99);
  });
});

describe('clearCache', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('removes cached repo entries', async () => {
    await locallyCached('repo1', 1, () => 'a');
    await clearCache();
    expect(await getCacheEntryCount()).toBe(0);
  });

  test('preserves the rate_limit key', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ rate_limit: { limit: 5000, remaining: 4999, at: 0 } }, () =>
        resolve()
      )
    );
    await locallyCached('repo1', 1, () => 'a');
    await clearCache();
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get(['rate_limit'], (items) => resolve(items))
    );
    expect(stored.rate_limit).toBeDefined();
  });
});
