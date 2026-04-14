import {
  buildBatchQuery,
  fetchGraphQLBatch,
  getRepoData,
  isRepoUrl,
  RATE_LIMIT_KEY,
  validateAccessToken,
} from '../src/github';
import { mockFetch } from './fetch.mock';
import { TOKEN_VALIDATED_KEY } from '../src/settings';

describe('getRepoData', () => {
  const repoInfo = { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: false };
  const repoInfo2 = { forks_count: 11, pushed_at: 12, stargazers_count: 13, archived: false };

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('resolves repo info', async () => {
    const data = { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: false };
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

  test('REST response populates archived field', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: true },
    });
    const info = await getRepoData('owner/repo');
    expect(info).toEqual({
      ok: true,
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3, archived: true },
    });
  });

  test('REST response defaults archived to false when absent', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 2, stargazers_count: 3 },
    });
    const info = await getRepoData('owner/repo');
    expect(info.json?.archived).toBe(false);
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

describe('GraphQL path', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    mockFetch({ json: null }); // reset global.fetch to a neutral mock between tests
  });

  test('GraphQL happy path transforms response into RepoInfo', async () => {
    // Seed a PAT so the dispatcher picks GraphQL
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );

    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 612,
            forkCount: 58,
            pushedAt: '2025-11-07T00:00:00Z',
            isArchived: false,
            defaultBranchRef: {
              target: { committedDate: '2018-09-23T00:00:00Z' },
            },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: '2026-04-13T13:00:00Z' },
        },
      },
    });

    const info = await getRepoData('osteele/sneetches');
    expect(info).toEqual({
      ok: true,
      json: {
        stargazers_count: 612,
        forks_count: 58,
        pushed_at: '2025-11-07T00:00:00Z',
        archived: false,
        committed_date: '2018-09-23T00:00:00Z',
      },
    });
  });

  test('GraphQL path falls back to pushed_at when defaultBranchRef is null', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );

    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 0,
            forkCount: 0,
            pushedAt: '2024-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });

    const info = await getRepoData('empty/repo');
    expect(info.json?.committed_date).toBeUndefined();
    expect(info.json?.pushed_at).toBe('2024-01-01T00:00:00Z');
  });

  test('GraphQL isArchived: true propagates to RepoInfo.archived', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );

    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 10916,
            forkCount: 1153,
            pushedAt: '2016-08-01T00:00:00Z',
            isArchived: true,
            defaultBranchRef: {
              target: { committedDate: '2016-08-01T00:00:00Z' },
            },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });

    const info = await getRepoData('Shopify/dashing');
    expect(info.ok).toBe(true);
    expect(info.json?.archived).toBe(true);
  });

  test('GraphQL null repository with no errors throws { ok: false, status: 500 }', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    // Malformed success response: data.repository is null but errors[] is
    // absent. This shouldn't happen in practice but guard against it —
    // surfacing as 500 lets the catch-all error path render an empty
    // annotation and log to console instead of silently returning
    // corrupted data.
    mockFetch({
      ok: true,
      status: 200,
      json: { data: { repository: null } },
    });

    await expect(getRepoData('malformed/response')).rejects.toEqual({
      ok: false,
      status: 500,
    });
  });

  test('GraphQL NOT_FOUND returns { ok: false, status: 404 }', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Not found' }],
      },
    });

    const info = await getRepoData('owner/nonexistent');
    expect(info).toEqual({ ok: false, status: 404 });
  });

  test('GraphQL NOT_FOUND is cached (like REST 404s)', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Not found' }],
      },
    });
    await getRepoData('owner/nonexistent');

    // Change the mock; second call should still return cached 404
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: '2024-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    const info = await getRepoData('owner/nonexistent');
    expect(info).toEqual({ ok: false, status: 404 });
  });

  test('GraphQL path fires POST to /graphql, not REST endpoint', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          repository: {
            stargazerCount: 1,
            forkCount: 2,
            pushedAt: '2024-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      }),
      headers: { get: (): string | null => null },
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await getRepoData('owner/repo');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.github.com/graphql');
    expect(call[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      }),
    });
    const body = JSON.parse(call[1].body as string);
    expect(body.query).toContain('repository(owner: $owner, name: $name)');
    expect(body.variables).toEqual({ owner: 'owner', name: 'repo' });
  });

  test('GraphQL response writes rate_limit to chrome.storage.local', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: '2024-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4873, resetAt: '2026-04-13T13:00:00Z' },
        },
      },
    });

    await getRepoData('owner/repo');

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.local.get([RATE_LIMIT_KEY], (items) => resolve(items))
    );
    expect(stored[RATE_LIMIT_KEY]).toMatchObject({ limit: 5000, remaining: 4873 });
  });

  test('GraphQL FORBIDDEN returns { ok: false, silent: true }', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: { repository: null },
        errors: [{ type: 'FORBIDDEN', path: ['repository'], message: 'Forbidden' }],
      },
    });

    const info = await getRepoData('private/repo');
    expect(info).toEqual({ ok: false, silent: true });
  });

  test('GraphQL HTTP 403 throws { ok: false, status: 403 }', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({ ok: false, status: 403 });
    await expect(getRepoData('owner/repo')).rejects.toEqual({
      ok: false,
      status: 403,
    });
  });

  test('GraphQL network failure propagates', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(getRepoData('owner/repo')).rejects.toThrow('offline');
  });

  test('GraphQL HTTP 401 clears TOKEN_VALIDATED_KEY', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'bad-token', token_validated: true }, () => resolve())
    );
    mockFetch({ ok: false, status: 401 });

    await expect(getRepoData('owner/repo')).rejects.toEqual({
      ok: false,
      status: 401,
    });

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get([TOKEN_VALIDATED_KEY], (items) => resolve(items))
    );
    expect(stored[TOKEN_VALIDATED_KEY]).toBe(false);
  });

  test('GraphQL FORBIDDEN is cached (avoids re-hitting API on private repos)', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ access_token: 'test-token' }, () => resolve())
    );
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: { repository: null },
        errors: [{ type: 'FORBIDDEN', path: ['repository'], message: 'Forbidden' }],
      },
    });
    await getRepoData('private/repo');

    // Change the mock to a success shape; second call should still
    // return the cached silent skip. FORBIDDEN caching is intentional —
    // we avoid hammering the API on private repos that a token can't see.
    // Users who grant a new scope or make the repo public will see fresh
    // data after the 4-hour TTL or a manual cache clear.
    mockFetch({
      ok: true,
      status: 200,
      json: {
        data: {
          repository: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: '2024-01-01T00:00:00Z',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999 },
        },
      },
    });
    const info = await getRepoData('private/repo');
    expect(info).toEqual({ ok: false, silent: true });
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

  test('handles a full 50-repo batch', () => {
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
      ok: true,
      json: {
        stargazers_count: 100,
        forks_count: 20,
        pushed_at: '2025-01-01T00:00:00Z',
        archived: false,
        committed_date: '2025-01-02T00:00:00Z',
      },
    });
    expect(result.get('torvalds/linux')).toEqual({
      ok: true,
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
      ok: true,
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
    expect(result.get('octocat/hello')?.ok).toBe(true);
    expect(result.get('ghost/gone')).toEqual({ ok: false, status: 404 });
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
    expect(result.get('octocat/hello')?.ok).toBe(true);
    expect(result.get('private/repo')).toEqual({ ok: false, silent: true });
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
    expect(result.get('some/repo')).toEqual({ ok: false, silent: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('HTTP 401 clears TOKEN_VALIDATED_KEY and rejects', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: true }, () => resolve())
    );
    mockFetch({ ok: false, status: 401 });
    await expect(fetchGraphQLBatch(['octocat/hello'], 'ghp_fake')).rejects.toEqual({
      ok: false,
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
      ok: false,
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
    expect(result.get('some/repo')).toEqual({ ok: false, silent: true });
    spy.mockRestore();
  });
});
