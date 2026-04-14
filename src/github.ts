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
// in a LocalStorageArea.
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

  // Error path — walk errors[] in later sub-tasks. For now, throw to
  // match the existing REST path's behavior for unexpected responses.
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
