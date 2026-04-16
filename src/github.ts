import { bulkReadCache, bulkWriteCache } from './cache';
import { TOKEN_VALIDATED_KEY } from './settings';

export const CACHE_VERSION = 2;
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

export interface RepoResponse {
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
// only by fetchGraphQLBatch via defaultBranchRef.target.committedDate.
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
// a batch of up to ~50 repos and distributes the results into a Map keyed
// by "owner/name". Applies per-path error distribution (NOT_FOUND → cached
// 404, FORBIDDEN → silent skip, other → silent + console.error) via the
// errors[] walker below. Caller (fetchRepoDataStreaming) is responsible
// for chunking batches that exceed BATCH_SIZE.
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
      // Match only the exact alias shape our buildBatchQuery emits ("r0",
      // "r1", …). A looser `startsWith('r')` check would false-match
      // sibling paths like `rateLimit` and silently swallow their errors.
      const aliasMatch = typeof alias === 'string' ? alias.match(/^r(\d+)$/) : null;
      if (!aliasMatch) {
        console.error('sneetches: GraphQL error without recognized path', err);
        continue;
      }
      const idx = Number(aliasMatch[1]);
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

// If we ever see 422 from GitHub on an aliased query, halve this.
// GitHub's node-count limit is 500,000; scalar-only batches cost 1 point
// regardless of alias count and use ~50 nodes per batch (4 orders of
// magnitude of headroom).
// Smaller batches resolve faster at GitHub's GraphQL endpoint because
// per-query processing time scales superlinearly with alias count.
// Measured on awesome-homelab (705 repos, 2026-04-16):
//   BATCH_SIZE=5:   SW fetch 1.7s, wall clock 2.4s
//   BATCH_SIZE=10:  SW fetch 2.2s, wall clock 2.9s
//   BATCH_SIZE=25:  SW fetch 2.6s, wall clock 3.3s
//   BATCH_SIZE=50:  SW fetch 4.6s, wall clock 6.1s
//   BATCH_SIZE=200: SW fetch 7.4s, wall clock 8.7s
// 10 is the sweet spot: 52% faster than 50, uses 71 rate-limit points
// on the worst-case page (vs 15 at 50), and HTTP/2 multiplexes the
// requests on a single TCP connection.
export const BATCH_SIZE = 10;

// Streaming repo-data fetcher. Called by the service worker's port
// handler; does ONE chrome.storage.local.get for all nwos up front,
// fires the onResults callback immediately with every valid cached
// entry, then fetches the missing entries in parallel chunks and fires
// onResults again per chunk as each POST resolves.
//
// Why a streaming callback rather than a resolved Map? Because 1.1.3
// needs progressive reveal on big awesome-list pages: we want the
// cache-hit subset (and each fresh chunk as it lands) to start
// annotating immediately, not wait on the slowest chunk. The service
// worker forwards each onResults call into its own port.postMessage,
// so the content script gets a stream of chunks in the order they
// resolve — not in chunk-index order.
//
// Contract:
//   - `onResults` is called synchronously once with the cached subset
//     as soon as the bulk cache read resolves, ONLY if the cached
//     subset is non-empty. An empty cache hit skips the first call so
//     the caller doesn't have to filter zero-entry chunks.
//   - Each fetched chunk fires its own `onResults` call once its POST
//     resolves. Chunks run in parallel; callback order matches resolve
//     order, not chunk index.
//   - On transport-level failure (HTTP 401 / 5xx / network), the
//     returned Promise rejects. The caller's catch branch can decide
//     how to surface the error — in the service worker's case, it
//     posts a terminal `{type:'error', status}` message.
//   - Per-entry errors (NOT_FOUND, FORBIDDEN silent-skip) surface as
//     RepoResponse map entries in the callback, NOT as rejections.
//
// Chunking strategy: round-robin into ceil(missing / BATCH_SIZE)
// equal-sized chunks. This matches 1.1.2 content.ts chunking for the
// "chunks each span the whole input" property — the first chunk to
// resolve paints across the full input range, not a contiguous tail.
export async function fetchRepoDataStreaming(
  nwos: readonly string[],
  accessToken: string | undefined,
  onResults: (chunkResults: Map<string, RepoResponse>) => void
): Promise<void> {
  if (nwos.length === 0) return;

  // Phase 1: ONE bulk cache read. Every valid entry fires the callback
  // as a single batch before any fetches start.
  const { cached, missing } = await bulkReadCache<RepoResponse, number>(
    nwos as string[],
    CACHE_VERSION
  );
  if (cached.size > 0) onResults(cached);
  if (missing.length === 0) return;

  // Phase 2: fetch missing. PAT users get the GraphQL batch path;
  // unauth users fall back to per-repo REST (parallel).
  if (accessToken) {
    // Round-robin into equal-sized chunks so whichever chunk resolves
    // first paints annotations across the full input range, not a
    // contiguous slice at one end.
    const chunkCount = Math.ceil(missing.length / BATCH_SIZE);
    const chunks: string[][] = Array.from({ length: chunkCount }, () => []);
    for (let i = 0; i < missing.length; i++) {
      chunks[i % chunkCount].push(missing[i]);
    }
    await Promise.all(
      chunks.map(async (chunk) => {
        const chunkResults = await fetchGraphQLBatch(chunk, accessToken);
        // Write every result — including FORBIDDEN silent-skips — to
        // the cache. Matches 1.1.1 behavior of avoiding repeated API
        // hits on private repos within the 4-hour TTL.
        bulkWriteCache(chunkResults, CACHE_VERSION);
        onResults(chunkResults);
      })
    );
    return;
  }

  // Unauthenticated path: parallel per-repo REST. Each resolves with
  // its own singleton Map. Per-entry transport errors (403 rate-limit,
  // network failures) surface as RepoResponse map entries rather than
  // rejecting the whole promise.
  await Promise.all(
    missing.map(async (nwo) => {
      try {
        const resp = await fetchRepoDataRESTSingle(nwo);
        const map = new Map([[nwo, resp]]);
        // Only cache 200 OK and 404 responses. Don't cache 403s — they
        // represent transient rate-limit state and should retry next
        // scan.
        if (resp.ok || resp.status === 404) {
          bulkWriteCache(map, CACHE_VERSION);
        }
        onResults(map);
      } catch (err) {
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
        onResults(new Map([[nwo, { ok: false, status }]]));
      }
    })
  );
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
