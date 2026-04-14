import { locallyCached } from './cache';
import { getAccessToken, TOKEN_VALIDATED_KEY } from './settings';

const CACHE_VERSION = 1;
const GITHUB_API_URL = 'https://api.github.com/repos/';

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
    const json = await res.json();
    return { ok: true, json };
  }
  if (status === 404) {
    return { ok: false, status };
  }
  throw { ok: false, status };
}

// Retrieve repo info from GitHub or from the cache. Successful responses
// and 404's are cached. Other errors (e.g. 403) are transient and not cached.
export function getRepoData(nwo: string): Promise<RepoResponse> {
  return locallyCached(nwo, CACHE_VERSION, async () => {
    const accessToken = await getAccessToken();
    const headers: Record<string, string> = {
      'User-Agent': 'kesensoy/sneetches',
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const res = await fetch(GITHUB_API_URL + nwo, { headers });
    captureRateLimit(res);
    return marshallableResponse(res);
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
