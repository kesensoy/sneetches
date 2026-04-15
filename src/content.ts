import { readAllCachedRepos } from './cache';
import * as probe from './debug/probe';
import {
  archiveIcon,
  bugIcon,
  clockIcon,
  hourglassIcon,
  repoForkedIcon,
  starIcon,
  unlinkIcon,
} from './icons';
import { isRepoUrl, RepoResponse, CACHE_VERSION } from './github';
import {
  ACCESS_TOKEN_KEY,
  HAS_STARRED_KEY,
  SHOW_KEY,
  STAR_STYLE_KEY,
  getSettings,
  ShowSettings,
  StarStyle,
} from './settings';
import { SNEETCHES_PORT_NAME, SneetchesRpcMsg } from './shared/rpc';
import { commafy, humanize, humanizeDate } from './utils';

// Detect and persist whether the authenticated GitHub user has starred
// this extension's repo. We scrape the star button's form action from
// github.com/kesensoy/sneetches — much cleaner than an API call (no
// token needed, no scope requirements).
//
// If the repo is ever renamed or transferred, update SNEETCHES_REPO below
// AND the href of the "Star us?" CTA in src/options.html.
const SNEETCHES_REPO = 'kesensoy/sneetches';
// Match the repo landing page with optional trailing slash and any query or
// hash suffix. Excludes subpages like /issues, /pulls, /blob/*, etc.
const SNEETCHES_REPO_URL = new RegExp(`^https?://github\\.com/${SNEETCHES_REPO}/?(?:[?#].*)?$`);

let starredObserver: MutationObserver | null = null;
let starredObserverTimeout: ReturnType<typeof setTimeout> | null = null;

function writeStarredStateFromDOM(): void {
  // Match the exact form action, not a prefix — GitHub also has `/stargazers`
  // which would false-positive a `^="/kesensoy/sneetches/star"` selector.
  const unstarForm = document.querySelector(
    `form[action="/${SNEETCHES_REPO}/unstar"], form[action^="/${SNEETCHES_REPO}/unstar?"]`
  );
  const starForm = document.querySelector(
    `form[action="/${SNEETCHES_REPO}/star"], form[action^="/${SNEETCHES_REPO}/star?"]`
  );

  let isStarred: boolean | null = null;
  if (unstarForm) isStarred = true;
  else if (starForm) isStarred = false;

  if (isStarred === null) return; // logged out or DOM changed — leave state alone
  chrome.storage.sync.set({ [HAS_STARRED_KEY]: isStarred });
}

export function detectStarredStateOnSneetchesRepo(): void {
  // Always clean up any previous observer first — important for tests where
  // this function gets called multiple times. In production it only runs once
  // at content-script init, but the cleanup is cheap and defensive.
  if (starredObserver) {
    starredObserver.disconnect();
    starredObserver = null;
  }
  if (starredObserverTimeout) {
    clearTimeout(starredObserverTimeout);
    starredObserverTimeout = null;
  }

  const url = window.location.href;
  // Match https://github.com/kesensoy/sneetches and
  // https://github.com/kesensoy/sneetches/ (optional trailing slash + query)
  // Not subpages like /issues or /pulls.
  if (!SNEETCHES_REPO_URL.test(url)) return;

  // Initial scrape — catches the state as of page load
  writeStarredStateFromDOM();

  // Set up a MutationObserver to catch in-place star/unstar actions
  // (e.g., user clicks Star on the page and GitHub mutates the form DOM).
  starredObserver = new MutationObserver(() => {
    writeStarredStateFromDOM();
  });
  starredObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['action'],
  });

  // Safety: auto-disconnect after 5 minutes to avoid a long-running observer
  // if the user leaves the tab open and idle.
  starredObserverTimeout = setTimeout(
    () => {
      starredObserver?.disconnect();
      starredObserver = null;
      starredObserverTimeout = null;
    },
    5 * 60 * 1000
  );
}

// Test-only helper: disconnects the observer and clears any pending timeout.
// Used in afterEach to prevent cross-test pollution. Not called in production.
export function __resetStarredDetectorForTests(): void {
  if (starredObserver) {
    starredObserver.disconnect();
    starredObserver = null;
  }
  if (starredObserverTimeout) {
    clearTimeout(starredObserverTimeout);
    starredObserverTimeout = null;
  }
}

const ANNOTATION_CLASS = 'data-sneetch-extension';

// Debounce window for the DOM observer. Long enough to coalesce the wave of
// mutations GitHub's React hydration fires during README insertion; short
// enough that the user doesn't notice the delay once links appear.
const LINK_SCAN_DEBOUNCE_MS = 300;

// Hard cap on how long the rolling debounce can starve. React hydration
// on awesome-list pages fires mutation bursts continuously for several
// seconds; each burst resets the rolling timer, so `setTimeout(..., 300)`
// never actually elapses until hydration quiets down. The 2026-04-14
// probe measured this starvation at 8–11 seconds on awesome-homelab.
//
// The max-wait timer is a SEPARATE setTimeout that is NOT reset by each
// mutation — it fires 500ms after the FIRST mutation in a cycle, even if
// rolling mutations keep coming in. Whichever timer fires first runs the
// scan and clears both; the next mutation starts a fresh cycle.
//
// Why 500ms specifically: long enough that React has probably inserted
// the first wave of README content (~20-50 anchors), short enough that
// the user's perceived first-annotation latency stays sub-second. A scan
// that fires early and finds 0 links is still cheap (the next mutation
// burst starts a new cycle with a new max-wait); a scan that fires early
// and finds 50 anchors annotates them immediately, then the mutation
// observer catches subsequent waves as hydration continues.
const LINK_SCAN_MAX_WAIT_MS = 500;

export const isRepoLink = (elt: HTMLAnchorElement): boolean =>
  isRepoUrl(elt.href) && elt.childElementCount === 0;

let linkScanObserver: MutationObserver | null = null;
let linkScanTimeout: ReturnType<typeof setTimeout> | null = null;
let linkScanMaxWaitTimeout: ReturnType<typeof setTimeout> | null = null;

// Leading-edge scan throttle — tracks the most recent time we fired an
// immediate scan from inside the MutationObserver microtask in response
// to a github.com anchor being added to the DOM. Subsequent MO
// callbacks are allowed to re-fire once LEADING_EDGE_MIN_INTERVAL_MS
// has elapsed.
//
// Why throttle instead of a one-shot flag: the CSS selector we use to
// detect repo-link additions (`a[href^="https://github.com/"]`) matches
// EVERY github.com anchor, including GitHub's own chrome (user profile
// links, /login, /issues tabs, etc.). Those are filtered out by the
// stricter isRepoLink predicate inside findUnannotatedRepoLinks. A
// one-shot flag was consumed by the first false positive and then
// locked out real repo-link adds that arrived later in the same
// hydration wave. A throttle lets each subsequent MO callback retry —
// false positives cost ~1ms (findUnannotatedRepoLinks returns 0, scan
// early-exits), real positives fire a real scan. The throttle bounds
// the worst case at 1000/LEADING_EDGE_MIN_INTERVAL_MS scans per second.
//
// Why this lever exists at all: per the 2026-04-14 research + probe
// data, setTimeout callbacks are delayed multi-second under React
// hydration main-thread contention, but MutationObserver callbacks run
// as MICROTASKS drained between React's tasks. Firing updateLinks
// directly from the MO microtask (instead of going through setTimeout)
// bypasses the task queue entirely, cutting the "scan silence" window
// from 4-8 seconds down to whatever time it actually takes React to
// insert the first batch of real repo anchors.
const LEADING_EDGE_MIN_INTERVAL_MS = 100;
let lastLeadingEdgeAt = 0;

// Anchors with a port-fetched repo-data request still in flight, mapped
// to the epoch at which the fetch was started. Used for two things:
//
//   1. Prevent a second debounced scan from re-issuing fetches for links
//      the first scan is already processing (the "duplicate annotation"
//      race — a mutation burst fires a second scan inside the debounce
//      window while the first scan's cold-cache fetches are still
//      pending, and both waves try to annotate the same anchors).
//
//   2. Drop stale-settings results when `chrome.storage.onChanged` fires
//      mid-fetch. Settings changes bump `currentEpoch`, and each chunk's
//      distributeChunk loop compares its captured epoch against the
//      current map entry — if they no longer match, the chunk's entries
//      are silently dropped instead of appended, and the fresh rescan
//      (under the new settings) is allowed to produce the live annotation.
//
// WeakMap auto-releases entries if an anchor is removed from the DOM
// before its fetch resolves, so nothing to clean up on long-lived pages.
let currentEpoch = 0;
let inFlightAnchors: WeakMap<HTMLAnchorElement, number> = new WeakMap();

// Anchors whose fetch resolved as silent-skip (FORBIDDEN / scope-missing).
// Without this set, a silent-skip anchor would be re-picked-up by every
// subsequent findUnannotatedRepoLinks call — it has no annotation child
// (childElementCount === 0), and once we delete it from inFlightAnchors
// nothing else filters it out. Cache serves the result so there's no
// HTTP hit, but each scan still spends async work per private repo on
// pages with many inaccessible repos. Cleared alongside inFlightAnchors
// in applySettingsChange so a token change gets a fresh look at
// previously-forbidden repos.
let silentSkipAnchors: WeakSet<HTMLAnchorElement> = new WeakSet();

const removeLinkAnnotations = () =>
  document.querySelectorAll('.' + ANNOTATION_CLASS).forEach((node) => node.remove());

// Live DOM query for repo links that still need annotating. Must be called
// fresh on every scan — GitHub renders awesome-list READMEs client-side via
// React/Turbo hydration that completes SECONDS after `document_idle`, so a
// one-shot module-load snapshot misses every link. The `childElementCount === 0`
// filter does double duty here: it skips anchors that wrap images/badges (a
// historical concern) AND it skips links we've already annotated, because
// appending our <small> makes childElementCount ≥ 1. The `inFlightAnchors`
// check catches the narrower race of links we're still fetching for.
function findUnannotatedRepoLinks(): HTMLAnchorElement[] {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href^="https://github.com/"], a[href^="http://github.com/"]'
    )
  ).filter((a) => isRepoLink(a) && !inFlightAnchors.has(a) && !silentSkipAnchors.has(a));
}

// Open a port to the service worker and return a promise that resolves
// when the port says 'done' or 'error'. Each 'chunk' message is routed
// to `onChunk` as it arrives so progressive reveal works: cached repos
// land in the first chunk, each fetched GraphQL batch lands as its own
// chunk. The 1.1.3 perf win is that all the storage/fetch work runs in
// the SW's event loop off the page's main thread.
//
// Exported for test injection — tests/content.test.ts overrides this
// via __setPortFetcherForTests to avoid spinning up the real SW in
// tests that want to drive fetch behavior through a jest mock. The
// production path uses the default implementation below.
type PortFetcher = (
  nwos: string[],
  onChunk: (entries: ReadonlyArray<readonly [string, RepoResponse]>) => void
) => Promise<{ ok: true } | { ok: false; status?: number }>;

const defaultPortFetcher: PortFetcher = (nwos, onChunk) =>
  new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: SNEETCHES_PORT_NAME });
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; status?: number }): void => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      resolve(result);
    };

    port.onMessage.addListener((rawMsg: unknown) => {
      const msg = rawMsg as SneetchesRpcMsg;
      if (msg.type === 'chunk') {
        onChunk(msg.entries);
      } else if (msg.type === 'error') {
        finish({ ok: false, status: msg.status });
      } else if (msg.type === 'done') {
        finish({ ok: true });
      }
    });
    // If the SW tears down the port without a terminal message (e.g.
    // the worker was killed mid-flight), treat that as a network-level
    // failure rather than leaving updateLinks hung forever.
    port.onDisconnect.addListener(() => finish({ ok: false, status: undefined }));

    port.postMessage({ nwos });
  });

let portFetcher: PortFetcher = defaultPortFetcher;

// Test-only hook: replace the port fetcher with a controllable
// implementation. Used by tests/content.test.ts to drive chunk/error
// delivery without depending on the service worker's message loop.
// Pass `null` to restore the default.
export function __setPortFetcherForTests(fn: PortFetcher | null): void {
  portFetcher = fn ?? defaultPortFetcher;
}

// In-memory settings cache for the scan hot path.
//
// The 2026-04-14 probe under the new 1.1.3 service-worker path showed
// `await getSettings()` taking ~5 seconds on awesome-list-scale pages,
// even though all storage work for REPO DATA was already moved to the
// SW. The reason: `getSettings()` calls `chrome.storage.sync.get(...)`
// on the content script's main thread, and the callback delivery gets
// queued behind whatever React / 1Password / GitHub are doing to that
// thread. Same starvation pattern the SW refactor fixed for local
// storage — the sync read just wasn't covered.
//
// Fix: read settings once at module load, hold in memory, serve every
// subsequent updateLinks() call from memory (zero storage reads).
// Invalidated by applySettingsChange() so the chrome.storage.onChanged
// listener — which already fires a rescan on access_token / show /
// star_style changes — gets a fresh value on the next scan.
//
// getCachedSettings() returns the in-memory copy when one exists
// (the common case after the first scan); otherwise it kicks off ONE
// storage read and memoizes the resulting promise so concurrent scans
// don't fan out into multiple storage reads while the first one is
// still in flight.
type CachedSettings = Awaited<ReturnType<typeof getSettings>>;
let cachedSettings: CachedSettings | null = null;
let cachedSettingsPromise: Promise<CachedSettings> | null = null;

// In-memory mirror of chrome.storage.local's repo-cache entries.
//
// 1.1.4 pre-reads chrome.storage.local ONCE at content-script module
// load (document_start) and holds the result here. updateLinks then
// serves cache-hit anchors synchronously from this Map inside the MO
// microtask, bypassing the service-worker port entirely for entries
// that are already cached — eliminating the ~4.5s phase-C queueing
// cost measured on awesome-list pages on 1.1.3.
//
// null = not yet populated (preload still in flight, or tests haven't
// seeded). A null check in updateLinks falls through to the port path
// for every anchor in that case. Empty Map = preload completed but
// found nothing cached; also falls through to the port. Non-empty Map
// = fast path available.
//
// The SW still writes fresh entries back to chrome.storage.local as
// it always has; those writes are NOT mirrored back into this Map
// live. Subsequent page loads re-read the updated cache via the next
// document_start preload, which is the right TTL granularity — we
// accept that the current scan's NEW cache hits stay in memory via
// the SW path (unchanged) without also populating the in-memory Map.
let inMemoryRepoCache: Map<string, RepoResponse> | null = null;

// Test-only helper: directly set (or clear with `null`) the in-memory
// repo cache. Lets tests seed a deterministic map without depending on
// chrome.storage.local timing or the async preload promise.
export function __setInMemoryRepoCacheForTests(map: Map<string, RepoResponse> | null): void {
  inMemoryRepoCache = map;
}

// Test-only helper: read the current in-memory repo cache. Used to
// verify that the preload populated it correctly and that
// invalidation clears it.
export function __getInMemoryRepoCacheForTests(): Map<string, RepoResponse> | null {
  return inMemoryRepoCache;
}

// Preload promise — tests can await this to ensure the initial
// chrome.storage.local read has completed before driving updateLinks.
// Production code never awaits it; updateLinks checks `inMemoryRepoCache`
// directly and falls through to the port path if it's still null
// (preload hasn't resolved yet).
let inMemoryRepoCachePromise: Promise<void> | null = null;

// Generation counter for in-flight preload cancellation. runPreload()
// captures this at the start of each run; if handleSyncStorageChange
// (or a test reset) bumps it while the preload is awaiting its storage
// read, the captured gen no longer matches the current value and the
// preload's pending assignment into inMemoryRepoCache is skipped.
// Without this guard, a token change firing during the ~234ms preload
// window lets the in-flight preload stomp the newly-null cache with
// stale pre-change data, defeating the invalidation.
let preloadGeneration = 0;

// Test-only helper: expose the preload promise so tests can await it
// after seeding chrome.storage.local with cache entries. Also used by
// tests that want to verify the initial preload populated correctly.
export function __getPreloadPromiseForTests(): Promise<void> | null {
  return inMemoryRepoCachePromise;
}

// Test-only helper: re-fire the preload against the current
// chrome.storage.local state. Lets a test seed storage, then trigger
// a fresh preload, then await it, and finally assert against
// inMemoryRepoCache. Without this, tests would be stuck with whatever
// the module-load preload happened to read.
export function __rerunPreloadForTests(): Promise<void> {
  inMemoryRepoCachePromise = runPreload();
  return inMemoryRepoCachePromise;
}

// The actual preload work. Reads every cache entry from
// chrome.storage.local in one IPC and writes the resulting Map into
// inMemoryRepoCache. On rejection, installs an empty Map instead of
// leaving inMemoryRepoCache null — we'd rather fall through to the
// port path on the current scan than hang forever in "preload in
// flight" state.
async function runPreload(): Promise<void> {
  // Capture the generation at the start of this run. If a token
  // change (or a test-only rerun) bumps preloadGeneration while we're
  // awaiting the storage read, our captured gen will no longer match
  // and we'll skip the assignment — preventing a stale map from
  // clobbering a just-invalidated cache.
  const gen = ++preloadGeneration;
  probe.mark(probe.Phase.PRELOAD_START);
  try {
    const map = await readAllCachedRepos<RepoResponse, number>(CACHE_VERSION);
    if (gen === preloadGeneration) {
      inMemoryRepoCache = map;
      probe.mark(probe.Phase.PRELOAD_DONE, { entries: map.size });
    }
    // else: our generation was superseded (token change or test
    // rerun); drop the result on the floor.
  } catch (e) {
    console.error('[sneetches] preload failed, falling back to empty cache:', e);
    if (gen === preloadGeneration) {
      inMemoryRepoCache = new Map();
    }
  }
}

// Fire the preload at content-script module load. Not awaited —
// updateLinks handles the "not yet populated" case by falling through
// to the port path. On awesome-list pages, React hydration takes long
// enough that the 234ms preload (measured 2026-04-15) resolves well
// before the first repo anchor appears and the MO fires a scan.
inMemoryRepoCachePromise = runPreload();

async function getCachedSettings(): Promise<CachedSettings> {
  if (cachedSettings) return cachedSettings;
  if (cachedSettingsPromise) return cachedSettingsPromise;
  // Use try/finally so the promise lock is cleared on BOTH success and
  // rejection. Without the finally, a transient `chrome.storage.sync.get`
  // failure (rare in practice, but possible during browser startup or
  // extension updates) would leave `cachedSettingsPromise` pointing at a
  // permanently-rejected promise. Every subsequent scan would hit the
  // `if (cachedSettingsPromise) return` early-return and get the same
  // rejection back, silently disabling annotations until a settings
  // change fires `invalidateCachedSettings`. The finally makes the next
  // scan after a failure retry the storage read instead.
  cachedSettingsPromise = (async () => {
    try {
      const settings = await getSettings();
      cachedSettings = settings;
      return settings;
    } finally {
      cachedSettingsPromise = null;
    }
  })();
  return cachedSettingsPromise;
}

function invalidateCachedSettings(): void {
  cachedSettings = null;
  cachedSettingsPromise = null;
}

// Apply one repo response to one anchor. Shared between the in-memory
// cache fast path (1.1.4) and the port-fetcher chunk distribution loop.
// Per-entry epoch guard: a mid-flight settings change bumps
// `currentEpoch`, and any anchor still claimed under the OLD epoch
// should be silently dropped here rather than painted over. The fresh
// rescan dispatched by `applySettingsChange` is responsible for
// producing the live annotation under the new settings.
function paintResult(
  elt: HTMLAnchorElement,
  res: RepoResponse,
  show: ShowSettings,
  starStyle: StarStyle,
  accessToken: string,
  epoch: number
): void {
  if (inFlightAnchors.get(elt) !== epoch) return;
  inFlightAnchors.delete(elt);
  if (res.silent) {
    silentSkipAnchors.add(elt);
    return;
  }
  if (res.ok) {
    elt.appendChild(createAnnotation(res.json!, show, starStyle));
  } else {
    elt.appendChild(createErrorAnnotation(res, accessToken));
  }
}

async function updateLinks() {
  probe.reset();
  probe.mark(probe.Phase.SCAN_START);
  // Capture the epoch BEFORE the await so that any settings change
  // that fires between here and getCachedSettings() resolving is
  // guaranteed to have bumped currentEpoch past our captured value.
  // Our per-entry epoch check below will then correctly drop stale
  // results in favor of the post-change rescan that
  // applySettingsChange dispatches.
  const epoch = currentEpoch;
  const { accessToken, show, starStyle } = await getCachedSettings();
  const links = findUnannotatedRepoLinks();

  // Collect (anchor, nwo) pairs and claim each anchor under the
  // current epoch upfront. Same semantics as pre-1.1.4: claim happens
  // before the await so a concurrent settings change invalidates
  // everything atomically.
  const pending: Array<{ elt: HTMLAnchorElement; nwo: string }> = [];
  for (const elt of links) {
    const m = elt.href.match('^https?://github.com/(.+?)(?:.git)?/?$');
    if (!m) continue;
    inFlightAnchors.set(elt, epoch);
    pending.push({ elt, nwo: m[1] });
  }

  if (pending.length === 0) return;

  // 1.1.4 fast path: check the in-memory cache preloaded at
  // document_start. Anchors whose nwo is in the Map are painted
  // synchronously from memory — zero port round-trip, runs inside
  // the MutationObserver microtask. Misses fall through to the SW
  // port path unchanged.
  //
  // The in-memory cache is read-only from the content script's
  // perspective; the SW still owns all writes to chrome.storage.local.
  // Fresh fetches from the port path populate the persistent cache
  // for NEXT page load's preload — we accept that the current scan's
  // new cache hits don't live-update inMemoryRepoCache.
  //
  // NOTE: paintResult deletes each painted anchor from inFlightAnchors
  // as a side effect. The batch-level error handler below (for the
  // port path's transport failure case) correctly re-checks
  // inFlightAnchors.get(elt) === epoch before appending an error
  // annotation, so cached-path anchors that have already been drained
  // from the map won't get a second error annotation stacked on top.
  // Preserve that guard if you refactor the error path.
  const uncachedPending: Array<{ elt: HTMLAnchorElement; nwo: string }> = [];
  if (inMemoryRepoCache) {
    for (const p of pending) {
      const cached = inMemoryRepoCache.get(p.nwo);
      if (cached) {
        paintResult(p.elt, cached, show, starStyle, accessToken, epoch);
      } else {
        uncachedPending.push(p);
      }
    }
  } else {
    // Preload hasn't resolved yet (or a token-change invalidation
    // cleared the Map). Fall through to the port path for every
    // pending anchor — same behavior as 1.1.3.
    uncachedPending.push(...pending);
  }

  const cachedCount = pending.length - uncachedPending.length;
  probe.mark(probe.Phase.PENDING_COLLECTED, {
    pending: pending.length,
    cached: cachedCount,
    uncached: uncachedPending.length,
  });

  if (uncachedPending.length === 0) {
    probe.mark(probe.Phase.FAST_PATH_PAINTED, { painted: pending.length });
    probe.mark(probe.Phase.PAINT_DONE);
    probe.dump('scan');
    return;
  }

  probe.mark(probe.Phase.FAST_PATH_PAINTED, {
    painted: pending.length - uncachedPending.length,
  });

  // Deduplicate nwos across the uncached subset — a single page can
  // have many anchors pointing at the same repo, and we only need
  // one Map entry per unique nwo.
  const uniqueNwos = Array.from(new Set(uncachedPending.map((p) => p.nwo)));

  // Group anchors by nwo so each chunk from the service worker can
  // distribute to every anchor pointing at the same repo.
  const byNwo = new Map<string, HTMLAnchorElement[]>();
  for (const { elt, nwo } of uncachedPending) {
    const list = byNwo.get(nwo);
    if (list) list.push(elt);
    else byNwo.set(nwo, [elt]);
  }

  let firstChunkSeen = false;
  const distributeChunk = (entries: ReadonlyArray<readonly [string, RepoResponse]>): void => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      probe.mark(probe.Phase.PORT_FIRST_CHUNK, { chunkSize: entries.length });
    }
    for (const [nwo, res] of entries) {
      const anchors = byNwo.get(nwo);
      if (!anchors) continue;
      for (const elt of anchors) {
        paintResult(elt, res, show, starStyle, accessToken, epoch);
      }
    }
  };

  probe.mark(probe.Phase.PORT_SEND, { unique: uniqueNwos.length });
  const result = await portFetcher(uniqueNwos, distributeChunk);
  probe.mark(probe.Phase.PORT_DONE, { ok: result.ok ? 'yes' : 'no' });

  if (!result.ok) {
    // Batch-level failure (network error, 401, 5xx): every anchor
    // still in flight under OUR epoch in the uncached subset gets an
    // error annotation. Cached-path anchors are already painted and
    // cleared from inFlightAnchors, so they're untouched here — the
    // `inFlightAnchors.get(elt) !== epoch` guard skips any anchor
    // already drained by the fast path.
    for (const { elt } of uncachedPending) {
      if (inFlightAnchors.get(elt) !== epoch) continue;
      inFlightAnchors.delete(elt);
      elt.appendChild(createErrorAnnotation({ status: result.status }, accessToken));
    }
  }

  probe.mark(probe.Phase.PAINT_DONE);
  probe.dump('scan');
}

export function createErrorAnnotation(
  res: { status?: number },
  accessToken: string,
  reportError: (_: string, ..._2: unknown[]) => void = console.error
) {
  const elt = _createAnnotation('');

  if (res.status === 404) {
    const span = document.createElement('span');
    span.className = 'sneetch-broken';
    span.setAttribute('aria-label', 'repository not found');
    span.insertAdjacentHTML('beforeend', unlinkIcon('sneetch-icon'));
    span.append(' broken');
    elt.appendChild(span);
    elt.title = 'Repository not found';
    return elt;
  }

  if (res.status === 403) {
    const span = document.createElement('span');
    span.className = 'sneetch-rate-limited';
    span.setAttribute('aria-label', 'rate limited');
    span.insertAdjacentHTML('beforeend', hourglassIcon('sneetch-icon'));
    span.append(' wait');
    elt.appendChild(span);

    if (!accessToken) {
      elt.title = 'Please set up your GitHub Personal Access Token';
    } else {
      elt.title = 'GitHub API rate limit exceeded.';
    }
    return elt;
  }

  // else — unknown error. Rare in practice (covers weird 5xx,
  // malformed responses, and any new GraphQL error code GitHub ships
  // that doesn't map to NOT_FOUND/FORBIDDEN), but render a chip
  // anyway so the user knows the extension tried and failed rather
  // than silently skipping the link.
  reportError('sneetches: request status =', res.status);
  const span = document.createElement('span');
  span.className = 'sneetch-error';
  span.setAttribute('aria-label', 'error');
  span.insertAdjacentHTML('beforeend', bugIcon('sneetch-icon'));
  span.append(' error');
  elt.appendChild(span);
  elt.title = `Couldn't fetch repository info (status ${res.status ?? 'unknown'})`;
  return elt;
}

export function createAnnotation(
  data: {
    forks_count: number;
    stargazers_count: number;
    pushed_at: string;
    archived: boolean;
    committed_date?: string;
  },
  show: ShowSettings,
  starStyle: StarStyle
) {
  const displayDate = new Date(data.committed_date ?? data.pushed_at);
  const elt = _createAnnotation('', data.archived ? 'is-archived' : null);
  // Build each stat span by splitting text content from SVG markup: text
  // goes through a text node (escaped) while the SVG icon string is the
  // only thing ever handed to innerHTML-style insertion. Keeps the SVG
  // markup working without trusting humanize() / humanizeDate() output as
  // HTML, even though today those functions only ever emit digits.
  if (show.stars) {
    const span = document.createElement('span');
    span.className = 'sneetch-stars';
    span.setAttribute('aria-label', `${commafy(data.stargazers_count)} stars`);
    span.append(humanize(data.stargazers_count) + ' ');
    span.insertAdjacentHTML('beforeend', starIcon('sneetch-icon', starStyle === 'filled'));
    elt.appendChild(span);
  }
  if (show.forks) {
    const span = document.createElement('span');
    span.className = 'sneetch-forks';
    span.setAttribute('aria-label', `${commafy(data.forks_count)} forks`);
    span.append(humanize(data.forks_count) + ' ');
    span.insertAdjacentHTML('beforeend', repoForkedIcon('sneetch-icon'));
    elt.appendChild(span);
  }
  if (show.update) {
    const span = document.createElement('span');
    span.className = 'sneetch-date';
    span.setAttribute('aria-label', `last updated ${displayDate.toLocaleDateString()}`);
    span.insertAdjacentHTML('beforeend', clockIcon('sneetch-icon'));
    span.append(' ' + humanizeDate(displayDate));
    elt.appendChild(span);
  }
  // Archive chip is icon-only (the word "archived" lives only in the
  // tooltip + aria-label). Error chips in createErrorAnnotation deliberately
  // add visible word text alongside the icon for legibility — the asymmetry
  // is intentional, not a drift.
  if (data.archived) {
    const span = document.createElement('span');
    span.className = 'sneetch-archived';
    span.setAttribute('aria-label', 'archived');
    span.insertAdjacentHTML('beforeend', archiveIcon('sneetch-icon'));
    elt.appendChild(span);
  }
  const segments = [
    `${commafy(data.stargazers_count)} stars`,
    `${commafy(data.forks_count)} forks`,
    `last updated ${displayDate.toLocaleDateString()}`,
  ];
  if (data.archived) {
    segments.push('archived');
  }
  elt.title = segments.join('; ') + ' — Sneetches';
  return elt;
}

// Common code to create presentation error and success annotations.
function _createAnnotation(str: string, extraCssClasses: string | null = null) {
  let cssClass = ANNOTATION_CLASS;
  if (extraCssClasses) {
    cssClass += ' ' + extraCssClasses;
  }
  const elt = document.createElement('small');
  elt.setAttribute('class', cssClass);
  elt.innerText = str;
  return elt;
}

async function updateAnnotationsFromSettings() {
  const { show } = await getCachedSettings();
  if (Object.values(show).some(Boolean)) {
    updateLinks();
  }
}

// Run an initial scan plus wire up a MutationObserver that re-runs the scan
// (debounced) whenever new DOM arrives. This is what makes Sneetches work on
// modern GitHub pages where the README is React-hydrated AFTER the content
// script's default document_idle injection point — a one-shot scan at load
// time would catch none of the 700+ repo links on an awesome-list page, and
// the extension would stay silent. Also handles Turbo cross-page navigation
// within github.com, where only the article DOM is swapped without a reload.
export function startLinkScanner(): void {
  // Defensive cleanup — production only calls this once, but tests call it
  // many times and we must not leak observers or debounce timers.
  if (linkScanObserver) {
    linkScanObserver.disconnect();
    linkScanObserver = null;
  }
  if (linkScanTimeout) {
    clearTimeout(linkScanTimeout);
    linkScanTimeout = null;
  }
  if (linkScanMaxWaitTimeout) {
    clearTimeout(linkScanMaxWaitTimeout);
    linkScanMaxWaitTimeout = null;
  }

  // Initial scan for whatever links are present at injection time (may be
  // zero on awesome-list pages, but will find them on regular repo pages).
  updateAnnotationsFromSettings();

  // Fire a productive scan immediately and clear both timers so the other
  // one (whichever is still armed) can't fire a duplicate scan right after.
  // Nulls out linkScanMaxWaitTimeout so the NEXT mutation burst starts a
  // fresh max-wait cycle.
  const fireScan = () => {
    if (linkScanTimeout) {
      clearTimeout(linkScanTimeout);
      linkScanTimeout = null;
    }
    if (linkScanMaxWaitTimeout) {
      clearTimeout(linkScanMaxWaitTimeout);
      linkScanMaxWaitTimeout = null;
    }
    updateAnnotationsFromSettings();
  };

  // Two-timer scheduling strategy. The rolling debounce handles the
  // common case (mutations arrive in bursts, then quiet down, scan fires
  // shortly after the burst). The max-wait is a hard cap that fires
  // regardless of rolling resets, breaking out of starvation when React
  // hydration produces continuous mutations for seconds on end.
  const scheduleScan = () => {
    // Rolling debounce: every call resets the 300ms timer.
    if (linkScanTimeout) clearTimeout(linkScanTimeout);
    linkScanTimeout = setTimeout(fireScan, LINK_SCAN_DEBOUNCE_MS);

    // Max-wait: armed once per cycle on the FIRST mutation that arrives
    // after the previous scan fired. Subsequent mutations in the same
    // cycle don't reset it — that's the whole point, it's the rolling-
    // debounce-starvation escape hatch.
    if (!linkScanMaxWaitTimeout) {
      linkScanMaxWaitTimeout = setTimeout(fireScan, LINK_SCAN_MAX_WAIT_MS);
    }
  };

  linkScanObserver = new MutationObserver((mutations) => {
    // Walk the mutation list once, computing two things:
    //
    //  (1) `nonAnnotationActivity` — any real DOM mutation that isn't
    //      just our own annotation nodes being added. This is the
    //      existing filter — it's what keeps the observer from spinning
    //      forever on its own output. Checking the top-level added node
    //      is sufficient: when the extension attaches a pre-built
    //      <small class="data-sneetch-extension"> subtree to an anchor,
    //      the observer reports exactly one added node (the <small>);
    //      its inner <span>/<svg>/<path> descendants are NOT reported
    //      as separate additions, because they were already part of
    //      the subtree when the top-level element was appended
    //      (MutationObserver childList spec). The detached <span>
    //      construction inside createAnnotation — including the
    //      insertAdjacentHTML call for the SVG icon — fires no observer
    //      callbacks at all, because the span isn't in document.body
    //      yet.
    //
    //  (2) `repoLinkAdded` — any added subtree is-or-contains a
    //      github.com anchor. When this is true and we haven't yet
    //      fired the leading-edge scan, run updateAnnotationsFromSettings
    //      synchronously (in the MO microtask) instead of scheduling a
    //      debounced scan. See the leadingEdgeFired declaration for the
    //      full rationale — the short version is that MO callbacks run
    //      as microtasks between React tasks, so firing a scan from
    //      inside one lets us bypass the multi-second setTimeout
    //      starvation we'd otherwise see on React-hydrating pages.
    let nonAnnotationActivity = false;
    let repoLinkAdded = false;
    for (const m of mutations) {
      if (m.type !== 'childList') {
        nonAnnotationActivity = true;
        continue;
      }
      if (m.removedNodes.length > 0) {
        nonAnnotationActivity = true;
      }
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.classList && el.classList.contains(ANNOTATION_CLASS)) continue;
        nonAnnotationActivity = true;
        // Cheap check first: is this node itself a github.com anchor?
        // Then subtree query for the much more common case (React
        // inserting a container that contains anchors below). Note
        // this selector is intentionally LOOSE — it matches every
        // github.com anchor, not just `/owner/name` repo URLs.
        // findUnannotatedRepoLinks applies the strict filter; a false
        // positive here just costs a sub-millisecond early-exit scan.
        if (
          !repoLinkAdded &&
          (el.matches?.('a[href^="https://github.com/"]') ||
            el.querySelector?.('a[href^="https://github.com/"]'))
        ) {
          repoLinkAdded = true;
        }
      }
    }

    // Leading-edge fire: attempt an immediate scan whenever an added
    // subtree contains any github.com anchor, throttled to at most once
    // per LEADING_EDGE_MIN_INTERVAL_MS. Each attempt that finds no real
    // repo links exits in ~1ms via updateLinks' pending.length === 0
    // guard; attempts that find work annotate immediately. The
    // throttle keeps the worst case bounded while still letting every
    // hydration wave get a fresh shot at an early scan.
    if (repoLinkAdded) {
      const now = performance.now();
      if (now - lastLeadingEdgeAt >= LEADING_EDGE_MIN_INTERVAL_MS) {
        lastLeadingEdgeAt = now;
        updateAnnotationsFromSettings();
      }
    }

    if (nonAnnotationActivity) scheduleScan();
  });

  linkScanObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Respond to a settings change: invalidate in-flight fetches, clear any
// existing annotations, and re-run the scan under the new settings. The
// epoch bump is what causes stale .then/.catch callbacks from the
// previous scan to drop their results instead of appending them. The
// WeakMap reset ensures the new scan actually re-fetches the anchors
// the old scan had claimed (rather than skipping them as already
// in-flight). See the inFlightAnchors declaration for the full rationale.
function applySettingsChange(): void {
  currentEpoch++;
  inFlightAnchors = new WeakMap();
  silentSkipAnchors = new WeakSet();
  // Reset the leading-edge throttle so the next mutation wave (e.g.
  // the rescan this function is about to dispatch, or any subsequent
  // React hydration under the new settings) gets a fresh immediate-fire
  // without waiting out the throttle interval.
  lastLeadingEdgeAt = 0;
  // Invalidate the in-memory settings cache before the rescan so the
  // post-change updateLinks() re-reads from chrome.storage.sync and
  // picks up whatever just changed.
  invalidateCachedSettings();
  removeLinkAnnotations();
  updateAnnotationsFromSettings();
}

// Test-only helper: disconnect the observer, clear any pending debounce,
// reset the in-flight anchor tracker, and bump the epoch counter. Used
// in afterEach to prevent cross-test pollution. Not called in production.
export function __resetLinkScannerForTests(): void {
  if (linkScanObserver) {
    linkScanObserver.disconnect();
    linkScanObserver = null;
  }
  if (linkScanTimeout) {
    clearTimeout(linkScanTimeout);
    linkScanTimeout = null;
  }
  if (linkScanMaxWaitTimeout) {
    clearTimeout(linkScanMaxWaitTimeout);
    linkScanMaxWaitTimeout = null;
  }
  lastLeadingEdgeAt = 0;
  inFlightAnchors = new WeakMap();
  silentSkipAnchors = new WeakSet();
  invalidateCachedSettings();
  inMemoryRepoCache = null;
  inMemoryRepoCachePromise = null;
  // Bump the preload generation so any in-flight runPreload from a
  // previous test's module-load (or __rerunPreloadForTests call) will
  // see gen mismatch and drop its result instead of stomping state
  // that the next test is about to seed.
  preloadGeneration++;
  // Bump rather than reset so any lingering .then/.catch from a prior
  // test's fetch can't coincidentally match a fresh epoch=0.
  currentEpoch++;
}

// Test-only helper: invoke the settings-changed code path without firing
// a chrome.storage.onChanged event. Needed because the custom Chrome
// storage mock in tests does not propagate `set()` to `onChanged`
// listeners, so tests verifying the mid-flight invalidation behavior
// would otherwise have no way to trigger the production path.
export function __applySettingsChangeForTests(): void {
  applySettingsChange();
}

// Test-only helper: call getCachedSettings directly. Lets tests verify
// the retry-after-rejection contract (the promise lock must be cleared
// on rejection so the next call re-attempts the storage read) without
// routing through the whole updateLinks → port → annotation pipeline.
export function __getCachedSettingsForTests(): Promise<Awaited<ReturnType<typeof getSettings>>> {
  return getCachedSettings();
}

// Keys in chrome.storage.sync that actually affect what the content
// script renders. Any change to one of these should trigger a rescan
// (and a cache flush in the access-token case). All OTHER sync keys
// are popup/UI-only state (`token_validated`, `advanced_open`,
// `has_starred`, `toolbar_icon`) and must NOT wipe annotations in
// every open GitHub tab — doing so caused every "Test" click and every
// Advanced-tray toggle in the popup to flicker every open tab's stars.
const RESCAN_TRIGGER_KEYS: readonly string[] = [ACCESS_TOKEN_KEY, SHOW_KEY, STAR_STYLE_KEY];

// Handle a sync-storage change batch. Bail out early if none of the
// keys the content script cares about changed.
function handleSyncStorageChange(changes: { [key: string]: chrome.storage.StorageChange }): void {
  const relevantChanged = RESCAN_TRIGGER_KEYS.some((k) => k in changes);
  if (!relevantChanged) return;

  const accessTokenChange = changes[ACCESS_TOKEN_KEY];
  if (accessTokenChange && accessTokenChange.oldValue !== accessTokenChange.newValue) {
    chrome.storage.local.clear();
    inMemoryRepoCache = null;
    // Cancel any in-flight preload from before the token change — its
    // pending assignment into inMemoryRepoCache would otherwise stomp
    // the null we just set with stale pre-change data.
    preloadGeneration++;
  }
  applySettingsChange();
}

// Test-only helper: drive the sync-storage-changed code path with a
// synthetic changes object. The custom Chrome storage mock doesn't
// fire onChanged events from set() calls, so tests exercising the
// key filter need to invoke the handler directly.
export function __handleSyncStorageChangeForTests(changes: {
  [key: string]: chrome.storage.StorageChange;
}): void {
  handleSyncStorageChange(changes);
}

// Handle a local-storage-change batch. We only care about repo-cache
// entry REMOVALS — if any nwo-shaped key (one that contains "/") was
// removed (oldValue present, newValue undefined), invalidate the
// in-memory mirror because it's now out of sync with disk.
//
// Only removals trigger invalidation. Fresh writes from the SW's
// bulkWriteCache path fire onChanged with `newValue` set (either
// oldValue+newValue for updates, or just newValue for new keys) —
// those are the normal cache-population flow and must NOT wipe the
// in-memory mirror, otherwise every scan would clobber the cache we
// just populated.
//
// rate_limit (the only non-cache key in chrome.storage.local today)
// is filtered out via the slash check. If it were removed alone, we
// wouldn't want to invalidate the repo cache over a rate-limit
// tombstone.
//
// Greptile P2 (2026-04-15): without this branch, the options-page
// "Clear cache" button wipes disk state but the current page keeps
// painting from stale in-memory data until the tab reloads.
function handleLocalStorageChange(changes: { [key: string]: chrome.storage.StorageChange }): void {
  for (const [key, change] of Object.entries(changes)) {
    if (!key.includes('/')) continue;
    if (change.oldValue !== undefined && change.newValue === undefined) {
      inMemoryRepoCache = null;
      // Cancel any in-flight preload so it can't stomp this null
      // with data it read before the removal event fired. Same
      // mechanism handleSyncStorageChange uses for the access-token
      // invalidation path.
      preloadGeneration++;
      return;
    }
  }
}

// Test-only helper: drive the local-storage-changed code path with a
// synthetic changes object. The custom Chrome storage mock doesn't
// fire onChanged events from remove() calls, so tests exercising the
// clear-cache invalidation need to invoke the handler directly.
export function __handleLocalStorageChangeForTests(changes: {
  [key: string]: chrome.storage.StorageChange;
}): void {
  handleLocalStorageChange(changes);
}

// DOM-dependent initialization: wait for <body> before installing the
// MutationObserver that startLinkScanner and
// detectStarredStateOnSneetchesRepo need. At run_at: "document_start"
// (1.1.4), the parser may not have reached <body> yet when this script
// runs. Per feedback_main_thread_contention_timing.md, use a MO on
// documentElement instead of DOMContentLoaded / setTimeout — MO
// callbacks drain as microtasks between React's tasks, reliably under
// main-thread contention, while setTimeout-based scheduling can delay
// multi-second.
function initializeDomDependentFeatures(): void {
  startLinkScanner();
  detectStarredStateOnSneetchesRepo();
}

if (document.body) {
  // Body already exists — either run_at: "document_idle" injection
  // (legacy) or a jsdom test environment that pre-creates body. Run
  // synchronously.
  initializeDomDependentFeatures();
} else {
  // document_start injection: body hasn't parsed yet. Watch
  // documentElement for the first childList mutation that adds body,
  // then fire init and disconnect. This is a microtask-scoped signal
  // that fires the moment the HTML parser inserts <body>, with no
  // task-queue delay.
  const bodyWaitObserver = new MutationObserver(() => {
    if (document.body) {
      bodyWaitObserver.disconnect();
      initializeDomDependentFeatures();
    }
  });
  bodyWaitObserver.observe(document.documentElement, { childList: true });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') handleSyncStorageChange(changes);
  else if (namespace === 'local') handleLocalStorageChange(changes);
});
