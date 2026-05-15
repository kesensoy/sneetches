import {
  BATCH_SIZE,
  buildBatchQuery,
  CONTRIB_CACHE_VERSION,
  CONTRIB_TTL_SECONDS,
  contribCacheKey,
  fetchContributorCount,
  fetchGraphQLBatch,
  fetchRepoDataStreaming,
  isRepoUrl,
  parseContributorCount,
  parseRepoNwo,
  RATE_LIMIT_KEY,
  RepoResponse,
  validateAccessToken,
} from '../src/github';
import { mockFetch } from './fetch.mock';
import { ACCESS_TOKEN_KEY, getAccessToken, TOKEN_VALIDATED_KEY } from '../src/settings';

// Helper: drive fetchRepoDataStreaming and collect every chunk into a
// single Map, matching the pre-1.1.3 fetchReposMap shape. Used by the
// REST-path tests and the fetchRepoDataStreaming end-to-end tests below.
// Reads the access token from chrome.storage.sync so each test can seed
// it (or not) to exercise the PAT vs unauth branches.
const fetchReposMap = async (nwos: string[]): Promise<Map<string, RepoResponse>> => {
  const accessToken = await getAccessToken();
  const results = new Map<string, RepoResponse>();
  await fetchRepoDataStreaming(nwos, accessToken || undefined, (chunk) => {
    for (const [nwo, resp] of chunk) results.set(nwo, resp);
  });
  return results;
};

// Shorthand: call the unauthenticated REST path and pull out the single
// entry. These tests exercise the REST-path behavior (caching, 404s,
// 403s, archived field population) by giving fetchRepoDataStreaming a
// one-element nwos array.
const getOneRest = async (nwo: string) => {
  const map = await fetchReposMap([nwo]);
  return map.get(nwo)!;
};

describe('fetchRepoDataStreaming REST path', () => {
  const repoInfo = { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: false };
  const repoInfo2 = { forks_count: 11, pushed_at: 12, stargazers_count: 13, archived: false };

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('resolves repo info', async () => {
    const data = { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: false };
    mockFetch({ json: data });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'ok', json: data });
  });

  test('caches repo info', async () => {
    mockFetch({ json: repoInfo });
    await getOneRest('owner/repo');
    mockFetch({ json: repoInfo2 });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'ok', json: repoInfo });
  });

  test('distinguishes repos', async () => {
    mockFetch({ json: repoInfo });
    const info1 = await getOneRest('owner/repo');
    mockFetch({ json: repoInfo2 });
    const info2 = await getOneRest('owner/repo2');
    expect(info1).toEqual({ kind: 'ok', json: repoInfo });
    expect(info2).toEqual({ kind: 'ok', json: repoInfo2 });
  });

  test('403 surfaces as per-entry status (not a throw)', async () => {
    mockFetch({ ok: false, status: 403 });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'error', status: 403 });
  });

  test("resolves 404's", async () => {
    mockFetch({ ok: false, status: 404 });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'error', status: 404 });
  });

  test("doesn't cache 403's", async () => {
    mockFetch({ ok: false, status: 403 });
    await getOneRest('owner/repo');
    mockFetch({ json: repoInfo });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'ok', json: repoInfo });
  });

  test("caches 404's", async () => {
    mockFetch({ ok: false, status: 404 });
    await getOneRest('owner/repo');
    mockFetch({ ok: false, status: 403 });
    await getOneRest('owner/repo');
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({ kind: 'error', status: 404 });
  });

  test('REST response populates archived field', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: true },
    });
    const info = await getOneRest('owner/repo');
    expect(info).toEqual({
      kind: 'ok',
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: true },
    });
  });

  test('REST response defaults archived to false when absent', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 },
    });
    const info = await getOneRest('owner/repo');
    // Narrow to the 'ok' branch so json is defined on the discriminated union.
    expect(info.kind).toBe('ok');
    if (info.kind === 'ok') {
      expect(info.json.archived).toBe(false);
    }
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

  // Pre-fix the regex was `[^/]+` which accepts `#`, `?`, `&` etc. — so
  // README anchor links like `…/ralph#live-demo` and `…/repo?tab=readme`
  // matched as repo URLs and got cached as bogus 404s.
  test('rejects URLs with a fragment or query string', () => {
    expect(isRepoUrl('https://github.com/allegro/ralph#live-demo')).toBe(false);
    expect(isRepoUrl('https://github.com/owner/name?tab=readme')).toBe(false);
    expect(isRepoUrl('https://github.com/owner/name?foo=bar#section')).toBe(false);
    expect(isRepoUrl('https://github.com/owner/name/?tab=readme')).toBe(false);
  });

  test('rejects URLs with extra path segments', () => {
    expect(isRepoUrl('https://github.com/owner/name/issues')).toBe(false);
    expect(isRepoUrl('https://github.com/owner/name/blob/main/README.md')).toBe(false);
  });
});

describe('parseRepoNwo', () => {
  test('extracts owner/name from plain repo URLs', () => {
    expect(parseRepoNwo('https://github.com/owner/name')).toBe('owner/name');
    expect(parseRepoNwo('http://github.com/owner/name')).toBe('owner/name');
    expect(parseRepoNwo('https://github.com/owner/name/')).toBe('owner/name');
  });

  test('strips trailing .git suffix', () => {
    expect(parseRepoNwo('https://github.com/torvalds/linux.git')).toBe('torvalds/linux');
    expect(parseRepoNwo('https://github.com/torvalds/linux.git/')).toBe('torvalds/linux');
  });

  // Regression tests for the unescaped-dot bug in the old extraction
  // regex `(?:.git)?` — any repo whose name has at least one character
  // before a final `git` got truncated. jotgit → jdleesmiller/jo, megit
  // → megit/m, even git/git → git (owner only).
  test('preserves repo names containing or ending in "git"', () => {
    expect(parseRepoNwo('https://github.com/jdleesmiller/jotgit')).toBe('jdleesmiller/jotgit');
    expect(parseRepoNwo('https://github.com/git/git')).toBe('git/git');
    expect(parseRepoNwo('https://github.com/megit/megit')).toBe('megit/megit');
    expect(parseRepoNwo('https://github.com/foo/digit')).toBe('foo/digit');
    expect(parseRepoNwo('https://github.com/owner/magit')).toBe('owner/magit');
  });

  // Repo names with dots (e.g. ipfire/ipfire-2.x) must round-trip
  // unchanged; the only `.git` suffix should be stripped, never an
  // interior dot. Also pins the case-insensitive hostname behavior
  // documented in the comment in parseRepoNwo.
  test('preserves dots in repo names and accepts mixed-case hostnames', () => {
    expect(parseRepoNwo('https://github.com/ipfire/ipfire-2.x')).toBe('ipfire/ipfire-2.x');
    expect(parseRepoNwo('https://Github.com/owner/name')).toBe('owner/name');
    expect(parseRepoNwo('HTTPS://github.com/owner/name')).toBe('owner/name');
  });

  test('returns null for non-repo URLs', () => {
    expect(parseRepoNwo('https://example.com/owner/name')).toBe(null);
    expect(parseRepoNwo('https://github.com/')).toBe(null);
    expect(parseRepoNwo('https://github.com/owner')).toBe(null);
    expect(parseRepoNwo('https://github.com/owner/name/issues')).toBe(null);
    expect(parseRepoNwo('https://github.com/owner/name/blob/main/README.md')).toBe(null);
    expect(parseRepoNwo('https://github.com/owner/name#frag')).toBe(null);
    expect(parseRepoNwo('https://github.com/owner/name?q=1')).toBe(null);
    expect(parseRepoNwo('https://github.com/sponsors/someone')).toBe(null);
    expect(parseRepoNwo('not a url')).toBe(null);
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
    await getOneRest('owner/repo');

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
    await getOneRest('owner/repo');

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

  test('does NOT store rate limit on failed /user response', async () => {
    mockFetch({
      ok: false,
      status: 401,
      json: { message: 'Bad credentials' },
      headers: {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
      },
    });
    await validateAccessToken('bad-token');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get(['rate_limit'], (items) => resolve(items))
    );
    expect(stored.rate_limit).toBeUndefined();
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
    await getOneRest('owner/repo');

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
    await getOneRest('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toBeUndefined();
  });
});

describe('buildBatchQuery', () => {
  test('generates aliased query with one repository per nwo', () => {
    const { query, variables } = buildBatchQuery(['octocat/hello', 'torvalds/linux']);
    expect(query).toMatch(/r0: repository\(owner: \$owner0, name: \$name0\)/);
    expect(query).toMatch(/r1: repository\(owner: \$owner1, name: \$name1\)/);
    expect(query).toMatch(/\$owner0: String!/);
    expect(query).toMatch(/\$name0: String!/);
    expect(query).toMatch(/\$owner1: String!/);
    expect(query).toMatch(/\$name1: String!/);
    expect(variables).toEqual({
      owner0: 'octocat',
      name0: 'hello',
      owner1: 'torvalds',
      name1: 'linux',
    });
  });

  test('includes the scalar fragment fields on every aliased selection', () => {
    const { query } = buildBatchQuery(['octocat/hello']);
    expect(query).toMatch(/stargazerCount/);
    expect(query).toMatch(/forkCount/);
    expect(query).toMatch(/pushedAt/);
    expect(query).toMatch(/isArchived/);
    expect(query).toMatch(/committedDate/);
  });

  test('includes sibling rateLimit selection for empirical cost tracking', () => {
    const { query } = buildBatchQuery(['octocat/hello']);
    expect(query).toMatch(/rateLimit\s*\{[^}]*cost/);
    expect(query).toMatch(/rateLimit\s*\{[^}]*limit/);
    expect(query).toMatch(/rateLimit\s*\{[^}]*remaining/);
  });

  test('handles a single-repo batch', () => {
    const { query, variables } = buildBatchQuery(['octocat/hello']);
    expect(query).toMatch(/r0: repository/);
    expect(query).not.toMatch(/r1:/);
    expect(variables).toEqual({ owner0: 'octocat', name0: 'hello' });
  });

  test('handles a large multi-repo batch', () => {
    const nwos = Array.from({ length: 50 }, (_, i) => `owner${i}/repo${i}`);
    const { query, variables } = buildBatchQuery(nwos);
    expect(query).toMatch(/r0: repository/);
    expect(query).toMatch(/r49: repository/);
    expect(query).not.toMatch(/r50:/);
    expect(Object.keys(variables).length).toBe(100);
    expect(variables.owner49).toBe('owner49');
    expect(variables.name49).toBe('repo49');
  });
});

describe('fetchGraphQLBatch', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('happy path: two repos, both populated in returned map', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 100,
            forkCount: 20,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: { target: { committedDate: '2025-01-02T00:00:00Z' } },
          },
          r1: {
            stargazerCount: 5,
            forkCount: 1,
            pushedAt: '2018-06-01T00:00:00Z',
            isArchived: true,
            defaultBranchRef: { target: { committedDate: '2018-07-01T00:00:00Z' } },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: '2025-01-01T00:00:00Z' },
        },
      },
    });

    const result = await fetchGraphQLBatch(['octocat/hello', 'torvalds/linux'], 'ghp_fake');

    expect(result.size).toBe(2);
    expect(result.get('octocat/hello')).toEqual({
      kind: 'ok',
      json: {
        stargazers_count: 100,
        forks_count: 20,
        pushed_at: '2025-01-01T00:00:00Z',
        archived: false,
        committed_date: '2025-01-02T00:00:00Z',
      },
    });
    expect(result.get('torvalds/linux')).toEqual({
      kind: 'ok',
      json: {
        stargazers_count: 5,
        forks_count: 1,
        pushed_at: '2018-06-01T00:00:00Z',
        archived: true,
        committed_date: '2018-07-01T00:00:00Z',
      },
    });
  });

  test('POSTs to /graphql with bearer token and body containing query + variables', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    await fetchGraphQLBatch(['octocat/hello'], 'ghp_fake');
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_fake',
          'Content-Type': 'application/json',
        }),
      })
    );
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.query).toMatch(/r0: repository/);
    expect(body.variables).toEqual({ owner0: 'octocat', name0: 'hello' });
  });

  test('persists rate limit from response body', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 1,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4998, resetAt: '2025-01-01T00:00:00Z' },
        },
      },
    });
    await fetchGraphQLBatch(['octocat/hello'], 'ghp_fake');
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toEqual({ limit: 5000, remaining: 4998 });
  });

  test('handles null defaultBranchRef (empty repos) without crashing', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 0,
            forkCount: 0,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    const result = await fetchGraphQLBatch(['empty/repo'], 'ghp_fake');
    expect(result.get('empty/repo')).toEqual({
      kind: 'ok',
      json: {
        stargazers_count: 0,
        forks_count: 0,
        pushed_at: '2025-01-01T00:00:00Z',
        archived: false,
        committed_date: undefined,
      },
    });
  });

  test('empty input returns empty map without making a request', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const result = await fetchGraphQLBatch([], 'ghp_fake');
    expect(result.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('warns when rateLimit.cost is greater than 1', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 5, limit: 5000, remaining: 4995 },
        },
      },
    });
    await fetchGraphQLBatch(['octocat/hello'], 'ghp_fake');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('cost 5'));
    spy.mockRestore();
  });
});

describe('fetchGraphQLBatch error distribution', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('NOT_FOUND path maps to a 404 response for that repo', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 1,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          r1: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['r1'],
            message: 'Could not resolve to a Repository with the name...',
          },
        ],
      },
    });
    const result = await fetchGraphQLBatch(['octocat/hello', 'ghost/gone'], 'ghp_fake');
    expect(result.get('octocat/hello')?.kind).toBe('ok');
    expect(result.get('ghost/gone')).toEqual({ kind: 'error', status: 404 });
  });

  test('FORBIDDEN path maps to a silent-skip response for that repo', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 1,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          r1: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
        errors: [
          {
            type: 'FORBIDDEN',
            path: ['r1'],
            message: 'Resource not accessible by integration',
          },
        ],
      },
    });
    const result = await fetchGraphQLBatch(['octocat/hello', 'private/repo'], 'ghp_fake');
    expect(result.get('octocat/hello')?.kind).toBe('ok');
    expect(result.get('private/repo')).toEqual({ kind: 'silent' });
  });

  test('other error types become silent-skip + console.error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch({
      json: {
        data: {
          r0: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
        errors: [
          {
            type: 'INTERNAL',
            path: ['r0'],
            message: 'Something went wrong',
          },
        ],
      },
    });
    const result = await fetchGraphQLBatch(['some/repo'], 'ghp_fake');
    expect(result.get('some/repo')).toEqual({ kind: 'silent' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('HTTP 401 clears TOKEN_VALIDATED_KEY and rejects', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: true }, () => resolve())
    );
    mockFetch({ ok: false, status: 401 });
    await expect(fetchGraphQLBatch(['octocat/hello'], 'ghp_fake')).rejects.toEqual({
      status: 401,
    });
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get([TOKEN_VALIDATED_KEY], (items) => resolve(items))
    );
    expect(stored[TOKEN_VALIDATED_KEY]).toBe(false);
  });

  test('HTTP 5xx propagates as a rejection for the whole batch', async () => {
    mockFetch({ ok: false, status: 503 });
    await expect(fetchGraphQLBatch(['octocat/hello'], 'ghp_fake')).rejects.toEqual({
      status: 503,
    });
  });

  test('errors without a recognized path become silent-skip on all missing entries', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch({
      json: {
        data: { rateLimit: { cost: 1, limit: 5000, remaining: 4999 } },
        errors: [{ message: 'Catastrophic failure', type: 'SERVICE_UNAVAILABLE' }],
      },
    });
    const result = await fetchGraphQLBatch(['some/repo'], 'ghp_fake');
    expect(result.get('some/repo')).toEqual({ kind: 'silent' });
    spy.mockRestore();
  });

  test('network failure (fetch rejects) propagates as a rejection', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(fetchGraphQLBatch(['octocat/hello'], 'ghp_fake')).rejects.toThrow('offline');
  });
});

describe('fetchRepoDataStreaming', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('unauthenticated: falls back to per-repo REST', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: '2025-01-01', stargazers_count: 100, archived: false },
    });
    const result = await fetchReposMap(['octocat/hello']);
    expect(result.size).toBe(1);
    expect(result.get('octocat/hello')).toEqual({
      kind: 'ok',
      json: { forks_count: 1, pushed_at: '2025-01-01', stargazers_count: 100, archived: false },
    });
  });

  test('unauthenticated: REST 403 surfaces as per-entry status (not a throw)', async () => {
    mockFetch({ ok: false, status: 403 });
    const result = await fetchReposMap(['octocat/hello']);
    expect(result.get('octocat/hello')).toEqual({ kind: 'error', status: 403 });
  });

  test('authenticated: routes to GraphQL batch path', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [ACCESS_TOKEN_KEY]: 'ghp_fake' }, () => resolve())
    );
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 100,
            forkCount: 20,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: { target: { committedDate: '2025-01-02T00:00:00Z' } },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    const result = await fetchReposMap(['octocat/hello']);
    expect(result.get('octocat/hello')).toEqual({
      kind: 'ok',
      json: {
        stargazers_count: 100,
        forks_count: 20,
        pushed_at: '2025-01-01T00:00:00Z',
        archived: false,
        committed_date: '2025-01-02T00:00:00Z',
      },
    });
  });

  test(`authenticated: chunks into batches of ${BATCH_SIZE}`, async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [ACCESS_TOKEN_KEY]: 'ghp_fake' }, () => resolve())
    );
    // Use a count that doesn't divide evenly so the last batch is smaller.
    const totalNwos = BATCH_SIZE * 2 + Math.floor(BATCH_SIZE / 2);
    const nwos = Array.from({ length: totalNwos }, (_, i) => `owner${i}/repo${i}`);
    const expectedChunks = Math.ceil(totalNwos / BATCH_SIZE);

    const makeBatchResponse = (count: number) => {
      const data: Record<string, unknown> = {
        rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
      };
      for (let i = 0; i < count; i++) {
        data[`r${i}`] = {
          stargazerCount: i,
          forkCount: 0,
          pushedAt: '2025-01-01T00:00:00Z',
          isArchived: false,
          defaultBranchRef: null,
        };
      }
      return { data };
    };

    // Round-robin distributes nwos across expectedChunks equal-ish chunks.
    // Each chunk's size is ceil(totalNwos / expectedChunks) or one less.
    const chunkSizes: number[] = [];
    for (let c = 0; c < expectedChunks; c++) {
      let size = 0;
      for (let i = c; i < totalNwos; i += expectedChunks) size++;
      chunkSizes.push(size);
    }

    const fetchMock = jest.fn();
    for (const size of chunkSizes) {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeBatchResponse(size),
        headers: { get: () => null },
      });
    }
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchReposMap(nwos);
    expect(fetchMock).toHaveBeenCalledTimes(expectedChunks);
    expect(result.size).toBe(totalNwos);
  });

  test('authenticated: caches results, second call hits cache', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [ACCESS_TOKEN_KEY]: 'ghp_fake' }, () => resolve())
    );
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 100,
            forkCount: 20,
            pushedAt: '2025-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    await fetchReposMap(['octocat/hello']);

    global.fetch = jest.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const result = await fetchReposMap(['octocat/hello']);
    expect(result.get('octocat/hello')?.kind).toBe('ok');
  });

  test('returns empty map for empty input', async () => {
    const result = await fetchReposMap([]);
    expect(result.size).toBe(0);
  });

  test('authenticated: FORBIDDEN silent-skip is cached on second scan', async () => {
    // Matches 1.1.1 behavior: private-repo silent skips get cached for
    // the 4-hour TTL so awesome-list pages with many private repos don't
    // re-POST on every scan.
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [ACCESS_TOKEN_KEY]: 'ghp_fake' }, () => resolve())
    );
    mockFetch({
      json: {
        data: {
          r0: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
        errors: [{ type: 'FORBIDDEN', path: ['r0'], message: 'Forbidden' }],
      },
    });
    const first = await fetchReposMap(['private/repo']);
    expect(first.get('private/repo')).toEqual({ kind: 'silent' });

    // Second call: mock fetch to throw so we'd notice a re-fetch.
    global.fetch = jest.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const second = await fetchReposMap(['private/repo']);
    expect(second.get('private/repo')).toEqual({ kind: 'silent' });
  });
});

describe('contrib constants', () => {
  test('CONTRIB_CACHE_VERSION is a number', () => {
    expect(typeof CONTRIB_CACHE_VERSION).toBe('number');
  });
  test('CONTRIB_TTL_SECONDS is 24h', () => {
    expect(CONTRIB_TTL_SECONDS).toBe(24 * 3600);
  });
  test('contribCacheKey appends the NUL-delimited contrib marker', () => {
    expect(contribCacheKey('facebook/react')).toBe('facebook/react\x00contrib');
  });
});

describe('fetchContributorCount', () => {
  test('200 with Link header → exact count', async () => {
    mockFetch({
      json: [{}],
      headers: { link: '<...&page=411>; rel="last"' },
    });
    expect(await fetchContributorCount('facebook/react', undefined)).toEqual({
      kind: 'count',
      count: 411,
    });
  });

  test('200 without Link header → body-length count', async () => {
    mockFetch({ json: [{}] }); // single contributor, no Link
    expect(await fetchContributorCount('solo/repo', undefined)).toEqual({
      kind: 'count',
      count: 1,
    });
  });

  test('403 "too large" → many (quota remaining)', async () => {
    mockFetch({ ok: false, status: 403, headers: { 'x-ratelimit-remaining': '57' } });
    expect(await fetchContributorCount('torvalds/linux', undefined)).toEqual({ kind: 'many' });
  });

  test('403 rate-limited → silent (no quota)', async () => {
    mockFetch({ ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect(await fetchContributorCount('owner/repo', undefined)).toEqual({ kind: 'silent' });
  });

  test('network error → silent', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(await fetchContributorCount('owner/repo', undefined)).toEqual({ kind: 'silent' });
  });

  test('5xx → silent', async () => {
    mockFetch({ ok: false, status: 502 });
    expect(await fetchContributorCount('owner/repo', undefined)).toEqual({ kind: 'silent' });
  });
});

describe('parseContributorCount', () => {
  test('reads the rel="last" page number from a Link header', () => {
    const link =
      '<https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/contributors?per_page=1&page=411>; rel="last"';
    expect(parseContributorCount(link, 1)).toBe(411);
  });

  test('falls back to the body length when there is no Link header', () => {
    expect(parseContributorCount(null, 1)).toBe(1);
    expect(parseContributorCount('', 3)).toBe(3);
  });

  test('falls back to the body length when Link has no rel="last"', () => {
    const link = '<https://api.github.com/...?page=2>; rel="next"';
    expect(parseContributorCount(link, 2)).toBe(2);
  });
});
