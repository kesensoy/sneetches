import { bulkReadCache, bulkWriteCache, CONTRIB_KEY_MARKER } from './cache';
import { TOKEN_VALIDATED_KEY } from './settings';

export const CACHE_VERSION = 2;
const GITHUB_API_URL = 'https://api.github.com/repos/';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

export const RATE_LIMIT_KEY = 'rate_limit';

// Contributor-count cache namespace. Separate version from CACHE_VERSION
// so the two namespaces evolve independently — see the design doc at
// docs/plans/2026-05-14-contributor-count-design.md.
export const CONTRIB_CACHE_VERSION = 1;
// 24h — 6x the 4h repo-data TTL. Contributor counts move slowly and the
// per-repo REST fetch is expensive and unbatchable, so a long TTL is
// both more correct and far cheaper on rate limit.
export const CONTRIB_TTL_SECONDS = 24 * 3600;

export function contribCacheKey(nwo: string): string {
  return nwo + CONTRIB_KEY_MARKER;
}

// Extract the exact contributor count from a /contributors?per_page=1
// response. With per_page=1 the rel="last" page number IS the count.
// When the Link header is absent (single-page repos), GitHub returned
// every contributor in the body, so the body length is the count.
// @internal — exported for unit tests.
export function parseContributorCount(linkHeader: string | null, bodyLength: number): number {
  if (linkHeader) {
    const match = linkHeader.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (match) return Number(match[1]);
  }
  return bodyLength;
}

// The three terminal states of a contributor-count lookup:
//   count  — an exact number (from the Link header or the body fallback)
//   many   — GitHub refused to enumerate (HTTP 403 "too large"); the repo
//            is a linux-scale giant. Rendered as a qualitative "many" chip.
//   silent — transient failure (network / 5xx / rate-limit). Not painted,
//            not cached; retried on the next scan.
export type ContribResponse =
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'many' }
  | { readonly kind: 'silent' };

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

type TokenValidation = { valid: true } | { valid: false; status?: number; error?: 'network' };

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

// Shared rate-limit writer. Both the REST header path and the GraphQL
// body path end here so getStoredRateLimit() consumers don't need to
// know which source produced the data. The REST path additionally
// auto-invalidates the token flag when the observed limit looks unauth
// (see captureRateLimit); that branch lives in the caller because
// GraphQL responses always reflect an authenticated tier and shouldn't
// trigger the downgrade check.
function writeRateLimit(limit: number, remaining: number): void {
  chrome.storage.local.set({
    [RATE_LIMIT_KEY]: { limit, remaining },
  });
}

function captureRateLimit(res: HasHeaders): void {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (limit !== null && remaining !== null) {
    const limitNum = Number(limit);
    writeRateLimit(limitNum, Number(remaining));
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
    writeRateLimit(rateLimit.limit, rateLimit.remaining);
  }
}

interface RepoInfo {
  readonly forks_count: number;
  readonly pushed_at: string;
  readonly stargazers_count: number;
  readonly archived: boolean;
  readonly committed_date?: string;
}

// Discriminated union over the three states a repo lookup can terminate
// in: a populated payload, a known HTTP/status error (404 / 403 / else),
// or a silent skip (FORBIDDEN on a PAT without scope — we don't want to
// render anything at all, just remember not to retry this scan).
//
// Callers should `switch (res.kind)` rather than flag-checking, so
// TypeScript's exhaustiveness checker catches any branch that forgets a
// case if we ever add a fourth.
export type RepoResponse =
  | { readonly kind: 'ok'; readonly json: RepoInfo }
  | { readonly kind: 'error'; readonly status?: number }
  | { readonly kind: 'silent' };

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
    return { kind: 'ok', json };
  }
  if (status === 404) {
    return { kind: 'error', status };
  }
  throw { status };
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
// a batch of up to BATCH_SIZE repos and distributes the results into a Map keyed
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
    throw { status: res.status };
  }

  const body = await res.json();
  captureRateLimitFromGraphQL(body);

  // Empirically verify that scalar-only batches cost 1 point. A future
  // GitHub pricing-model change surfaces as a one-time console.warn
  // instead of a silent rate-limit slowdown.
  const cost = (body as { data?: { rateLimit?: { cost?: number } } })?.data?.rateLimit?.cost;
  if (typeof cost === 'number' && cost > 1) {
    console.warn(
      `sneetches: GraphQL batch cost ${cost} (expected 1). GitHub may have changed its pricing formula; consider reducing BATCH_SIZE.`
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
      result.set(nwo, { kind: 'ok', json });
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
        result.set(nwo, { kind: 'error', status: 404 });
      } else if (err.type === 'FORBIDDEN') {
        result.set(nwo, { kind: 'silent' });
      } else {
        console.error('sneetches: GraphQL error', err);
        result.set(nwo, { kind: 'silent' });
      }
    }
  }

  // Any nwo that ended up with neither a repo nor an error becomes a
  // silent-skip — protects updateLinks from hanging on missing Map
  // entries (e.g., path-less errors or partial responses).
  for (const nwo of nwos) {
    if (!result.has(nwo)) {
      result.set(nwo, { kind: 'silent' });
    }
  }

  return result;
}

// If we ever see 422 from GitHub on an aliased query, reduce this.
// GitHub's node-count limit is 500,000; scalar-only batches cost 1 point
// regardless of alias count and use ~BATCH_SIZE nodes per batch.
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
// @internal — exported for unit tests (tests/github.test.ts,
// tests/service-worker.test.ts). Keep exported even if no prod consumer
// imports it, so the test assertions stay in sync.
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
        if (resp.kind === 'ok' || (resp.kind === 'error' && resp.status === 404)) {
          bulkWriteCache(map, CACHE_VERSION);
        }
        onResults(map);
      } catch (err) {
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
        onResults(new Map([[nwo, { kind: 'error', status }]]));
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

// Parse a GitHub repo URL into its `owner/name` nwo, or null if the URL
// isn't a plain repo link. Used as the single source of truth for both
// `isRepoUrl` (gate) and the content script's nwo extraction (consumer)
// — they used to be two independent regexes and drifted: the extractor's
// `(?:.git)?` had an unescaped dot that truncated names containing `git`
// (jotgit → jdleesmiller/jo), and `isRepoUrl`'s `[^/]+` swallowed `#`/`?`
// into the repo segment so `#anchor` and `?tab=` URLs from awesome-list
// READMEs got cached as fake 404s. URL parsing handles both cleanly.
export function parseRepoNwo(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Hostname comparison is effectively case-insensitive: URL spec
  // lowercases the hostname during parsing, so `Github.com` becomes
  // `github.com`. The old regex was case-sensitive and would have
  // rejected mixed-case hosts; the live `findUnannotatedRepoLinks`
  // selector (`a[href^="https://github.com/"]`) is also case-sensitive
  // so this only matters for direct callers of `parseRepoNwo`.
  if (url.hostname !== 'github.com') return null;
  // Reject README-internal anchor links (e.g. `…/ralph#live-demo`) and
  // tab/query variants (`…/repo?tab=readme`) — they're not plain repo
  // URLs and shouldn't be cached as repo lookups.
  if (url.hash !== '' || url.search !== '') return null;
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length !== 2) return null;
  const [owner, rawRepo] = segs;
  if (gitHubSpecialPages.has(owner)) return null;
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!repo) return null;
  return `${owner}/${repo}`;
}

export function isRepoUrl(href: string): boolean {
  return parseRepoNwo(href) !== null;
}
