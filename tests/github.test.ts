import { getRepoData, isRepoUrl, RATE_LIMIT_KEY, validateAccessToken } from '../src/github';
import { mockFetch } from './fetch.mock';
import { TOKEN_VALIDATED_KEY } from '../src/settings';

describe('getRepoData', () => {
  const repoInfo = { forks_count: 1, pushed_at: 2, stargazers_count: 3 };
  const repoInfo2 = { forks_count: 11, pushed_at: 12, stargazers_count: 13 };

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('resolves repo info', async () => {
    const data = { forks_count: 1, pushed_at: 2, stargazers_count: 3 };
    mockFetch({ json: data });
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({ ok: true, json: data });
  });

  test('caches repo info', async () => {
    mockFetch({ json: repoInfo });
    await getRepoData('owner/repo');
    mockFetch({ json: repoInfo2 });
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({ ok: true, json: repoInfo });
  });

  test('distinguishes repos', async () => {
    mockFetch({ json: repoInfo });
    const info1 = await getRepoData('owner/repo');
    mockFetch({ json: repoInfo2 });
    const info2 = await getRepoData('owner/repo2');
    expect(info1).toEqual({ ok: true, json: repoInfo });
    expect(info2).toEqual({ ok: true, json: repoInfo2 });
  });

  test("rejects 403's", async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(getRepoData('owner/repo')).rejects.toEqual({
      ok: false,
      status: 403,
    });
  });

  test("resolves 404's", async () => {
    mockFetch({ ok: false, status: 404 });
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({ ok: false, status: 404 });
  });

  test("doesn't cache 403's", async () => {
    mockFetch({ ok: false, status: 403 });
    await expect(getRepoData('owner/repo')).rejects;
    mockFetch({ json: repoInfo });
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({ ok: true, json: repoInfo });
  });

  test("caches 404's", async () => {
    mockFetch({ ok: false, status: 404 });
    await getRepoData('owner/repo');
    mockFetch({ ok: false, status: 403 });
    await getRepoData('owner/repo');
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({ ok: false, status: 404 });
  });
});

describe('isRepoUrl', () => {
  test('accepts GitHub repo urls', () => {
    expect(isRepoUrl('http://github.com/owner/name')).toBe(true);
    expect(isRepoUrl('https://github.com/owner/name')).toBe(true);
    expect(isRepoUrl('https://github.com/owner/name/')).toBe(true);
    expect(isRepoUrl('https://github.com/owner/name.git')).toBe(true);
    expect(isRepoUrl('https://github.com/owner/name.git/')).toBe(true);
  });

  test('rejects non-GitHub urls', () => {
    expect(isRepoUrl('https://example.com/owner/name')).toBe(false);
  });

  test("rejects URLs that aren't on the main site", () => {
    expect(isRepoUrl('https://diversity.github.com/')).toBe(false);
    expect(isRepoUrl('https://gist.github.com/')).toBe(false);
    expect(isRepoUrl(' https://help.github.com/articles/github-terms-of-service/')).toBe(false);
    expect(isRepoUrl('https://developer.github.com/v4/guides/')).toBe(false);
  });

  test('rejects URLs without a name and repo', () => {
    expect(isRepoUrl('https://github.com/')).toBe(false);
    expect(isRepoUrl('https://github.com/owner')).toBe(false);
    expect(isRepoUrl('https://github.com/owner/')).toBe(false);
  });

  test('rejects GitHub special pages', () => {
    expect(isRepoUrl('https://github.com/about/careers')).toBe(false);
    expect(isRepoUrl('https://github.com/blog/517-unicorn/')).toBe(false);
    expect(isRepoUrl('https://github.com/collections/github-browser-extensions')).toBe(false);
    expect(isRepoUrl('https://github.com/contact/report-abuse')).toBe(false);
    expect(isRepoUrl('https://github.com/marketplace/travis-ci')).toBe(false);
    expect(isRepoUrl('https://github.com/new/import')).toBe(false);
    expect(isRepoUrl('https://github.com/notifications/participating')).toBe(false);
    expect(isRepoUrl('https://github.com/organizations/new')).toBe(false);
    expect(isRepoUrl('https://github.com/pricing/team')).toBe(false);
    expect(isRepoUrl('https://github.com/settings/profile')).toBe(false);
    expect(isRepoUrl('https://github.com/site/something')).toBe(false);
    expect(isRepoUrl('https://github.com/topics/something')).toBe(false);
  });

  test('rejects GitHub advisory and security URLs', () => {
    expect(isRepoUrl('https://github.com/advisories/GHSA-48c2-rrv3-qjmp')).toBe(false);
    expect(isRepoUrl('https://github.com/security/something')).toBe(false);
    expect(isRepoUrl('https://github.com/sponsors/someone')).toBe(false);
    expect(isRepoUrl('https://github.com/features/actions')).toBe(false);
  });
});

describe('validateAccessToken', () => {
  test('returns valid for 200 response', async () => {
    mockFetch({ ok: true, status: 200, json: { login: 'alice' } });
    const result = await validateAccessToken('good-token');
    expect(result).toEqual({ valid: true });
  });

  test('returns invalid for 401 response', async () => {
    mockFetch({ ok: false, status: 401, json: { message: 'Bad credentials' } });
    const result = await validateAccessToken('bad-token');
    expect(result).toEqual({ valid: false, status: 401 });
  });

  test('returns network error on fetch rejection', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const result = await validateAccessToken('token');
    expect(result).toEqual({ valid: false, error: 'network' });
  });

  test('returns invalid without calling fetch when token is empty', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await validateAccessToken('');
    expect(result).toEqual({ valid: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('captureRateLimit auto-invalidates token_validated', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('flips token_validated to false when rate limit is unauthenticated', async () => {
    // Start with token_validated: true in storage
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ token_validated: true }, () => resolve())
    );
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 },
      headers: {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
      },
    });
    await getRepoData('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get([TOKEN_VALIDATED_KEY], (items) => resolve(items))
    );
    expect(stored[TOKEN_VALIDATED_KEY]).toBe(false);
  });

  test('does NOT flip token_validated when rate limit is authenticated', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ token_validated: true }, () => resolve())
    );
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
      },
    });
    await getRepoData('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get([TOKEN_VALIDATED_KEY], (items) => resolve(items))
    );
    expect(stored[TOKEN_VALIDATED_KEY]).toBe(true); // unchanged
  });
});

describe('validateAccessToken captures rate limit', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  test('stores rate limit from /user response on success', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: { login: 'alice' },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4500',
      },
    });
    await validateAccessToken('good-token');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toMatchObject({ limit: 5000, remaining: 4500 });
  });
});

describe('rate limit persistence', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('stores rate limit info from response headers', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 },
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4873',
      },
    });
    await getRepoData('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toMatchObject({
      limit: 5000,
      remaining: 4873,
    });
  });

  test('does not store rate limit when headers absent', async () => {
    mockFetch({ json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 } });
    await getRepoData('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toBeUndefined();
  });
});
