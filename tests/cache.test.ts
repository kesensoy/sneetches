import {
  bulkReadCache,
  bulkWriteCache,
  getCacheEntryCount,
  clearCache,
  readAllCachedRepos,
} from '../src/cache';

describe('getCacheEntryCount', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('returns 0 when empty', async () => {
    expect(await getCacheEntryCount()).toBe(0);
  });

  test('counts entries written by bulkWriteCache', async () => {
    bulkWriteCache(
      new Map<string, string>([
        ['repo1', 'a'],
        ['repo2', 'b'],
      ]),
      1
    );
    expect(await getCacheEntryCount()).toBe(2);
  });

  test('excludes the rate_limit key from the count', async () => {
    bulkWriteCache(new Map<string, string>([['repo1', 'a']]), 1);
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ rate_limit: { limit: 5000, remaining: 4999, at: 0 } }, () =>
        resolve()
      )
    );
    expect(await getCacheEntryCount()).toBe(1);
  });
});

describe('bulkReadCache / bulkWriteCache', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('bulkReadCache returns empty partition for empty input', async () => {
    const { cached, missing } = await bulkReadCache<number, number>([], 1);
    expect(cached.size).toBe(0);
    expect(missing).toEqual([]);
  });

  test('bulkReadCache reports every key as missing when storage is empty', async () => {
    const { cached, missing } = await bulkReadCache<number, number>(['a', 'b', 'c'], 1);
    expect(cached.size).toBe(0);
    expect(missing).toEqual(['a', 'b', 'c']);
  });

  test('bulkWriteCache + bulkReadCache round-trip', async () => {
    const fresh = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    bulkWriteCache(fresh, 1);

    const { cached, missing } = await bulkReadCache<number, number>(['a', 'b'], 1);
    expect(missing).toEqual([]);
    expect(cached.get('a')).toBe(1);
    expect(cached.get('b')).toBe(2);
  });

  test('bulkReadCache partitions mixed hit/miss', async () => {
    bulkWriteCache(new Map<string, number>([['a', 100]]), 1);
    const { cached, missing } = await bulkReadCache<number, number>(['a', 'b'], 1);
    expect(cached.get('a')).toBe(100);
    expect(cached.has('b')).toBe(false);
    expect(missing).toEqual(['b']);
  });

  test('bulkReadCache treats expired entries as missing', async () => {
    bulkWriteCache(new Map<string, number>([['a', 1]]), 1);
    const fourHoursMs = 4 * 3600 * 1000 + 1;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + fourHoursMs);
    const { cached, missing } = await bulkReadCache<number, number>(['a'], 1);
    expect(cached.size).toBe(0);
    expect(missing).toEqual(['a']);
    jest.restoreAllMocks();
  });

  test('bulkReadCache treats stale version entries as missing', async () => {
    bulkWriteCache(new Map<string, number>([['a', 1]]), 1);
    const { cached, missing } = await bulkReadCache<number, number>(['a'], 2);
    expect(cached.size).toBe(0);
    expect(missing).toEqual(['a']);
  });

  test('bulkWriteCache is a no-op for an empty map', async () => {
    bulkWriteCache(new Map<string, number>(), 1);
    expect(await getCacheEntryCount()).toBe(0);
  });

  test('bulkWriteCache written entries show up in getCacheEntryCount', async () => {
    bulkWriteCache(
      new Map<string, number>([
        ['repo1', 1],
        ['repo2', 2],
      ]),
      1
    );
    expect(await getCacheEntryCount()).toBe(2);
  });
});

describe('clearCache', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('removes cached repo entries', async () => {
    bulkWriteCache(new Map<string, string>([['repo1', 'a']]), 1);
    await clearCache();
    expect(await getCacheEntryCount()).toBe(0);
  });

  test('preserves the rate_limit key', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ rate_limit: { limit: 5000, remaining: 4999, at: 0 } }, () =>
        resolve()
      )
    );
    bulkWriteCache(new Map<string, string>([['repo1', 'a']]), 1);
    await clearCache();
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get(['rate_limit'], (items) => resolve(items))
    );
    expect(stored.rate_limit).toBeDefined();
  });
});

describe('readAllCachedRepos', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('returns empty Map when storage is empty', async () => {
    const result = await readAllCachedRepos<string, number>(1);
    expect(result.size).toBe(0);
  });

  test('returns only entries matching the requested version', async () => {
    const now = Date.now();
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/repo-v1': { exp: now + 60_000, pay: 'v1-payload', ver: 1 },
          'owner/repo-v2': { exp: now + 60_000, pay: 'v2-payload', ver: 2 },
        },
        resolve
      )
    );
    const result = await readAllCachedRepos<string, number>(2);
    expect(result.size).toBe(1);
    expect(result.get('owner/repo-v2')).toBe('v2-payload');
    expect(result.has('owner/repo-v1')).toBe(false);
  });

  test('drops expired entries', async () => {
    const now = Date.now();
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/fresh': { exp: now + 60_000, pay: 'fresh', ver: 1 },
          'owner/stale': { exp: now - 60_000, pay: 'stale', ver: 1 },
        },
        resolve
      )
    );
    const result = await readAllCachedRepos<string, number>(1);
    expect(result.get('owner/fresh')).toBe('fresh');
    expect(result.has('owner/stale')).toBe(false);
  });

  test('skips non-cache keys (rate_limit, etc.)', async () => {
    const now = Date.now();
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/repo': { exp: now + 60_000, pay: 'repo-data', ver: 1 },
          rate_limit: { limit: 5000, remaining: 4999 },
        },
        resolve
      )
    );
    const result = await readAllCachedRepos<string, number>(1);
    expect(result.size).toBe(1);
    expect(result.get('owner/repo')).toBe('repo-data');
    expect(result.has('rate_limit')).toBe(false);
  });

  test('silently skips malformed entries (missing fields)', async () => {
    const now = Date.now();
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/good': { exp: now + 60_000, pay: 'good', ver: 1 },
          'owner/noexp': { pay: 'bad', ver: 1 },
          'owner/nover': { exp: now + 60_000, pay: 'bad' },
          'owner/nopay': { exp: now + 60_000, ver: 1 },
        },
        resolve
      )
    );
    const result = await readAllCachedRepos<string, number>(1);
    expect(result.size).toBe(1);
    expect(result.get('owner/good')).toBe('good');
  });
});
