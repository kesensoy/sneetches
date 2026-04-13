import { locallyCached, getCacheEntryCount, clearCache } from '../src/cache';

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
    // Advance time past the 2-hour cache TTL
    const twoHoursMs = 2 * 3600 * 1000 + 1;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + twoHoursMs);
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
