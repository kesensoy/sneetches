import { locallyCached } from './cache';
import { getAccessToken, TOKEN_VALIDATED_KEY } from './settings';

const CACHE_VERSION = 2;
const GITHUB_API_URL = 'https://api.github.com/repos/';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
}

export function getStoredRateLimit(): Promise<RateLimitInfo | null> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([RATE_LIMIT_KEY], (items) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve((items[RATE_LIMIT_KEY] as RateLimitInfo | undefined) ?? null);
    });
  });
}

export type TokenValidation =
  | { valid: true }
  | { valid: false; status?: number; error?: 'network' };

interface HasHeaders {
  headers: { get(name: string): string | null };
}

export async function validateAccessToken(token: string): Promise<TokenValidation> {
  if (!token) return { valid: false };
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        'User-Agent': 'kesensoy/sneetches',
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      captureRateLimit(res); // side effect: refresh rate-limit display on success only
      return { valid: true };
    }
    return { valid: false, status: res.status };
  } catch {
    return { valid: false, error: 'network' };
  }
}

function captureRateLimit(res: HasHeaders): void {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (limit !== null && remaining !== null) {
    const limitNum = Number(limit);
    chrome.storage.local.set({
      [RATE_LIMIT_KEY]: {
        limit: limitNum,
        remaining: Number(remaining),
      },
    });
    // If the observed limit is below the authenticated tier (5000),
    // the current token is not working. Auto-invalidate the persisted
    // "validated" flag so the popup shows the honest state on next open.
    if (limitNum < 1000) {
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    }
  }
}

// Captures rate-limit info from a GraphQL response body. Writes the same
// { limit, remaining } shape the REST path captureRateLimit writes, so
// getStoredRateLimit() and its consumers don't need to know which source
// produced the data.
function captureRateLimitFromGraphQL(body: unknown): void {
  const rateLimit = (body as { data?: { rateLimit?: { limit?: number; remaining?: number } } })
    ?.data?.rateLimit;
  if (rateLimit && typeof rateLimit.limit === 'number' && typeof rateLimit.remaining === 'number') {
    chrome.storage.local.set({
      [RATE_LIMIT_KEY]: {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
      },
    });
  }
}

interface RepoInfo {
  readonly forks_count: number;
  readonly pushed_at: string;
  readonly stargazers_count: number;
  readonly archived: boolean;
  readonly committed_date?: string;
}

interface RepoResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly json?: RepoInfo;
  readonly silent?: boolean;
}

// Transform a fetch Response into something minimal that can be stored
// in a LocalStorageArea. Only extracts the fields RepoInfo declares —
// ignores the rest of GitHub's REST payload to keep cache entries small.
// Note: committed_date is intentionally NOT set here. The REST endpoint
// doesn't return a default-branch commit date; that field is populated
// only by fetchRepoDataGraphQLSingle via defaultBranchRef.target.committedDate.
async function marshallableResponse(res: Response): Promise<RepoResponse> {
  const { ok, status } = res;
  if (ok) {
    const raw = await res.json();
    const json: RepoInfo = {
      forks_count: raw.forks_count,
      pushed_at: raw.pushed_at,
      stargazers_count: raw.stargazers_count,
      archived: raw.archived === true,
    };
    return { ok: true, json };
  }
  if (status === 404) {
    return { ok: false, status };
  }
  throw { ok: false, status };
}

// Simpler REST fetcher — no Authorization header, since the dispatcher
// now routes PAT users to the GraphQL path.
async function fetchRepoDataRESTSingle(nwo: string): Promise<RepoResponse> {
  const res = await fetch(GITHUB_API_URL + nwo, {
    headers: { 'User-Agent': 'kesensoy/sneetches' },
  });
  captureRateLimit(res);
  return marshallableResponse(res);
}

// @internal — exported for unit tests only. Builds an aliased GraphQL
// query for a batch of repos and the matching variables map. Per-alias
// variables (owner0/name0, owner1/name1, ...) for injection safety;
// GitHub's schema has no array-of-RepoInput type, so this expands
// manually. Top-level `rateLimit { cost limit remaining }` lets us
// empirically verify scalar batches cost 1 point.
export function buildBatchQuery(nwos: string[]): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const varDecls: string[] = [];
  const selections: string[] = [];

  nwos.forEach((nwo, i) => {
    const [owner, name] = nwo.split('/');
    variables[`owner${i}`] = owner;
    variables[`name${i}`] = name;
    varDecls.push(`$owner${i}: String!, $name${i}: String!`);
    selections.push(`r${i}: repository(owner: $owner${i}, name: $name${i}) { ...F }`);
  });

  const query = `
    query GetRepos(${varDecls.join(', ')}) {
      ${selections.join('\n      ')}
      rateLimit { cost limit remaining resetAt }
    }
    fragment F on Repository {
      stargazerCount
      forkCount
      pushedAt
      isArchived
      defaultBranchRef { target { ... on Commit { committedDate } } }
    }
  `;

  return { query, variables };
}

// @internal — exported for unit tests. Fires one aliased GraphQL POST for
// a batch of up to ~50 repos, distributes the results into a Map keyed by
// "owner/name". Caller (getRepoDataMany) is responsible for chunking.
// Error distribution via errors[] is added in the next commit.
export async function fetchGraphQLBatch(
  nwos: string[],
  accessToken: string
): Promise<Map<string, RepoResponse>> {
  const result = new Map<string, RepoResponse>();
  if (nwos.length === 0) return result;

  const { query, variables } = buildBatchQuery(nwos);
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'kesensoy/sneetches',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    }
    throw { ok: false, status: res.status };
  }

  const body = await res.json();
  captureRateLimitFromGraphQL(body);

  // Empirically verify that scalar-only batches cost 1 point. A future
  // GitHub pricing-model change surfaces as a one-time console.warn
  // instead of a silent rate-limit slowdown.
  const cost = (body as { data?: { rateLimit?: { cost?: number } } })?.data?.rateLimit?.cost;
  if (typeof cost === 'number' && cost > 1) {
    console.warn(
      `sneetches: GraphQL batch cost ${cost} (expected 1). GitHub may have changed its pricing formula; consider halving the batch size.`
    );
  }

  const data = (body as { data?: Record<string, unknown> })?.data ?? {};

  nwos.forEach((nwo, i) => {
    const repo = data[`r${i}`] as
      | {
          stargazerCount: number;
          forkCount: number;
          pushedAt: string;
          isArchived: boolean;
          defaultBranchRef?: { target?: { committedDate?: string } } | null;
        }
      | null
      | undefined;
    if (repo) {
      const json: RepoInfo = {
        stargazers_count: repo.stargazerCount,
        forks_count: repo.forkCount,
        pushed_at: repo.pushedAt,
        archived: repo.isArchived === true,
        committed_date: repo.defaultBranchRef?.target?.committedDate,
      };
      result.set(nwo, { ok: true, json });
    }
  });

  // Walk errors[] and apply per-path distribution rules. Each error's
  // `path[0]` is the aliased field (r0, r1, ...) — map back to nwo via
  // index. See GraphQL spec Section 7 for the shape.
  const errors = (
    body as {
      errors?: Array<{ type?: string; path?: (string | number)[]; message?: string }>;
    }
  )?.errors;
  if (errors) {
    for (const err of errors) {
      const alias = err.path?.[0];
      if (typeof alias !== 'string' || !alias.startsWith('r')) {
        console.error('sneetches: GraphQL error without recognized path', err);
        continue;
      }
      const idx = Number(alias.slice(1));
      const nwo = nwos[idx];
      if (!nwo) continue;
      if (err.type === 'NOT_FOUND') {
        result.set(nwo, { ok: false, status: 404 });
      } else if (err.type === 'FORBIDDEN') {
        result.set(nwo, { ok: false, silent: true });
      } else {
        console.error('sneetches: GraphQL error', err);
        result.set(nwo, { ok: false, silent: true });
      }
    }
  }

  // Any nwo that ended up with neither a repo nor an error becomes a
  // silent-skip — protects updateLinks from hanging on missing Map
  // entries (e.g., path-less errors or partial responses).
  for (const nwo of nwos) {
    if (!result.has(nwo)) {
      result.set(nwo, { ok: false, silent: true });
    }
  }

  return result;
}

// GraphQL-path fetcher used by the getRepoData dispatcher when a token is
// configured. Does NOT interact with the cache — the dispatcher handles
// that via locallyCached().
async function fetchRepoDataGraphQLSingle(nwo: string, accessToken: string): Promise<RepoResponse> {
  const [owner, name] = nwo.split('/');
  const query = `
    query GetRepo($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        stargazerCount
        forkCount
        pushedAt
        isArchived
        defaultBranchRef {
          target { ... on Commit { committedDate } }
        }
      }
      rateLimit { cost limit remaining resetAt }
    }
  `;
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'kesensoy/sneetches',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { owner, name } }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      // Token is invalid or revoked. Clear the persisted "validated"
      // flag so the popup shows the honest state on next open — mirrors
      // the same auto-invalidation captureRateLimit does on the REST path
      // when it observes an unauthenticated-tier rate limit.
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    }
    throw { ok: false, status: res.status };
  }

  const body = await res.json();
  captureRateLimitFromGraphQL(body);

  const repo = body?.data?.repository;
  if (repo) {
    const json: RepoInfo = {
      stargazers_count: repo.stargazerCount,
      forks_count: repo.forkCount,
      pushed_at: repo.pushedAt,
      archived: repo.isArchived === true,
      committed_date: repo.defaultBranchRef?.target?.committedDate,
    };
    return { ok: true, json };
  }

  // Repository is null — walk errors[] to determine why.
  const errors = (body as { errors?: Array<{ type?: string; path?: string[] }> })?.errors;
  if (errors && errors.length > 0) {
    const err = errors[0];
    if (err.type === 'NOT_FOUND') {
      return { ok: false, status: 404 };
    }
    if (err.type === 'FORBIDDEN') {
      return { ok: false, silent: true };
    }
  }
  throw { ok: false, status: 500 };
}

// Retrieve repo info from GitHub or from the cache. Successful responses
// and 404's are cached. Other errors (e.g. 403) are transient and not cached.
//
// Dispatches based on token state: GraphQL for PAT users (richer data
// including committed_date), REST for everyone else.
export function getRepoData(nwo: string): Promise<RepoResponse> {
  return locallyCached(nwo, CACHE_VERSION, async () => {
    const accessToken = await getAccessToken();
    if (accessToken) {
      return fetchRepoDataGraphQLSingle(nwo, accessToken);
    }
    return fetchRepoDataRESTSingle(nwo);
  });
}

// Paths that start with one of these components aren't repo URLs.
// For example, `https://github.com/about/careers` isn't a repo.
const gitHubSpecialPages = new Set([
  'about',
  'advisories',
  'blog',
  'collections',
  'contact',
  'features',
  'marketplace',
  'new',
  'login',
  'logout',
  'join',
  'notifications',
  'organizations',
  'pricing',
  'security',
  'settings',
  'site',
  'sponsors',
  'trending',
  'topics',
]);

export function isRepoUrl(href: string): boolean {
  const match = href && href.match('^https?://github.com/([^/]+)/[^/]+/?$');
  return Boolean(match && !gitHubSpecialPages.has(match[1]));
}
