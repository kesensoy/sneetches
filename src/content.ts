import { isRepoNwoKey, readAllCachedRepos } from './cache';
import * as probe from './probe';
import {
  archiveIcon,
  bugIcon,
  clockIcon,
  hourglassIcon,
  peopleIcon,
  repoForkedIcon,
  starIcon,
  unlinkIcon,
} from './icons';
import { CACHE_VERSION, ContribResponse, isRepoUrl, parseRepoNwo, RepoResponse } from './github';
import {
  ACCESS_TOKEN_KEY,
  GITHUB_HANDLE_RE,
  HAS_STARRED_KEY,
  SHOW_KEY,
  SKIP_OWNERS_KEY,
  STAR_STYLE_KEY,
  getSettings,
  ShowSettings,
  StarStyle,
} from './settings';
import {
  SNEETCHES_CONTRIB_PORT_NAME,
  SNEETCHES_PORT_NAME,
  SneetchesContribRpcMsg,
  SneetchesRpcMsg,
} from './rpc';
import { commafy, humanize, humanizeDate } from './utils';

// ---------------------------------------------------------------------------
// Module-level constants (pure — no closure state)
// ---------------------------------------------------------------------------

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
const LINK_SCAN_MAX_WAIT_MS = 500;

// Leading-edge scan throttle — see startLinkScanner for the full
// rationale. Short version: each MutationObserver callback is allowed to
// fire at most one direct-dispatch updateLinks() per
// LEADING_EDGE_MIN_INTERVAL_MS so false-positive matches (non-repo
// github.com anchors in GitHub's chrome) can't lock out real repo-link
// detection when they interleave.
const LEADING_EDGE_MIN_INTERVAL_MS = 100;

// Keys in chrome.storage.sync that actually affect what the content
// script renders. Any change to one of these should trigger a rescan
// (and a cache flush in the access-token case). All OTHER sync keys
// are popup/UI-only state (`token_validated`, `advanced_open`,
// `has_starred`, `toolbar_icon`) and must NOT wipe annotations in
// every open GitHub tab — doing so caused every "Test" click and every
// Advanced-tray toggle in the popup to flicker every open tab's stars.
const RESCAN_TRIGGER_KEYS: readonly string[] = [
  ACCESS_TOKEN_KEY,
  SHOW_KEY,
  SKIP_OWNERS_KEY,
  STAR_STYLE_KEY,
];

// ---------------------------------------------------------------------------
// Pure helpers (no closure state)
// ---------------------------------------------------------------------------

export const isRepoLink = (elt: HTMLAnchorElement): boolean =>
  isRepoUrl(elt.href) && elt.childElementCount === 0;

// Build a single chip span with optional text before and/or after the
// SVG icon, and append it to the parent element. Text is inserted via
// text nodes (escaped); the icon is a DOM element built by icons.ts and
// is appended directly — no HTML strings cross this boundary, so AMO's
// static linter does not flag the construction. Returns the span for
// any caller that needs further customization.
function buildChip(
  parent: HTMLElement,
  className: string,
  ariaLabel: string,
  iconEl: SVGSVGElement,
  textBefore?: string,
  textAfter?: string
): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-label', ariaLabel);
  if (textBefore) span.append(textBefore);
  span.appendChild(iconEl);
  if (textAfter) span.append(textAfter);
  parent.appendChild(span);
  return span;
}

// Common code to create presentation error and success annotations.
function _createAnnotation(extraCssClasses: string | null = null) {
  let cssClass = ANNOTATION_CLASS;
  if (extraCssClasses) {
    cssClass += ' ' + extraCssClasses;
  }
  const elt = document.createElement('small');
  elt.setAttribute('class', cssClass);
  return elt;
}

export function createErrorAnnotation(
  res: { status?: number },
  accessToken: string,
  reportError: (_: string, ..._2: unknown[]) => void = console.error,
  nwo?: string,
  skipOwners: readonly string[] = []
): HTMLElement | null {
  // Skip-owners filter is scoped to 404s only — the "private repo
  // masquerading as deleted" case. Transport failures (401/403/5xx)
  // still surface so the user knows the extension tried and failed.
  if (res.status === 404 && nwo && skipOwners.length > 0) {
    const owner = nwo.split('/', 1)[0].toLowerCase();
    if (skipOwners.includes(owner)) return null;
  }

  const elt = _createAnnotation();

  if (res.status === 404) {
    buildChip(elt, 'sneetch-broken', 'repository not found', unlinkIcon(), undefined, ' broken');
    elt.title = 'Repository not found';
    return elt;
  }

  if (res.status === 403) {
    buildChip(elt, 'sneetch-rate-limited', 'rate limited', hourglassIcon(), undefined, ' wait');

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
  buildChip(elt, 'sneetch-error', 'error', bugIcon(), undefined, ' error');
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
  starStyle: StarStyle,
  contrib?: ContribResponse
) {
  const displayDate = new Date(data.committed_date ?? data.pushed_at);
  const elt = _createAnnotation(data.archived ? 'is-archived' : null);
  if (show.stars) {
    buildChip(
      elt,
      'sneetch-stars',
      `${commafy(data.stargazers_count)} stars`,
      starIcon(starStyle === 'filled'),
      humanize(data.stargazers_count) + ' '
    );
  }
  if (show.forks) {
    buildChip(
      elt,
      'sneetch-forks',
      `${commafy(data.forks_count)} forks`,
      repoForkedIcon(),
      humanize(data.forks_count) + ' '
    );
  }
  if (show.update) {
    buildChip(
      elt,
      'sneetch-date',
      `last updated ${displayDate.toLocaleDateString()}`,
      clockIcon(),
      undefined,
      ' ' + humanizeDate(displayDate)
    );
  }
  // Contributor chip slots between date and archive — keeps the
  // archive chip as the last child (load-bearing for the existing
  // "archive chip is the LAST child" invariant). show.contributors
  // gates the fetch in updateLinks; here we just render whatever
  // contrib result was joined to this anchor.
  if (show.contributors && contrib) {
    const chip = createContributorChip(contrib);
    if (chip) elt.appendChild(chip);
  }
  // Archive chip is icon-only (the word "archived" lives only in the
  // tooltip + aria-label). Error chips in createErrorAnnotation deliberately
  // add visible word text alongside the icon for legibility — the asymmetry
  // is intentional, not a drift.
  if (data.archived) {
    buildChip(elt, 'sneetch-archived', 'archived', archiveIcon());
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

// Build the contributor-count chip, or null if there's nothing to show.
// 'count' → people icon + humanize(n) text; 'many' → people icon + the
// word "many" for the linux-scale giants GitHub won't enumerate;
// 'silent' / 'notfound' → null (no chip; the repo-data path paints its
// own broken chip for 404s, and silent is a transient skip).
export function createContributorChip(res: ContribResponse): HTMLSpanElement | null {
  if (res.kind === 'silent' || res.kind === 'notfound') return null;
  const span = document.createElement('span');
  span.className = 'sneetch-contributors';
  if (res.kind === 'count') {
    const label = `${commafy(res.count)} contributor${res.count === 1 ? '' : 's'}`;
    span.setAttribute('aria-label', label);
    span.title = label;
    span.appendChild(peopleIcon());
    span.append(' ' + humanize(res.count));
  } else {
    // kind === 'many'
    const label = "GitHub doesn't expose an exact count for repos this large";
    span.setAttribute('aria-label', label);
    span.title = label;
    span.appendChild(peopleIcon());
    span.append(' many');
  }
  return span;
}

const removeLinkAnnotations = () =>
  document.querySelectorAll('.' + ANNOTATION_CLASS).forEach((node) => node.remove());

// Scrape the exact-match star/unstar form action off the sneetches repo
// landing page and persist the corresponding boolean into
// chrome.storage.sync. No closure state — reads DOM directly, writes
// storage directly.
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

// ---------------------------------------------------------------------------
// PortFetcher type + default implementation
// ---------------------------------------------------------------------------

// Open a port to the service worker and return a promise that resolves
// when the port says 'done' or 'error'. Each 'chunk' message is routed
// to `onChunk` as it arrives so progressive reveal works: cached repos
// land in the first chunk, each fetched GraphQL batch lands as its own
// chunk. The 1.1.3 perf win is that all the storage/fetch work runs in
// the SW's event loop off the page's main thread.
//
// Test injection is via createContentScript({ portFetcher }) rather
// than a module-level setter. Each test drives behavior through its
// own instance.
export type PortFetcher = (
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

// ---------------------------------------------------------------------------
// ContribFetcher — same shape as PortFetcher but routes through the contrib
// port. Kept structurally separate (rather than overloading PortFetcher with
// a kind discriminator) so the type system can't conflate the two payload
// shapes and so tests can inject each pipeline independently.
// ---------------------------------------------------------------------------

export type ContribFetcher = (
  nwos: string[],
  onChunk: (entries: ReadonlyArray<readonly [string, ContribResponse]>) => void
) => Promise<{ ok: true } | { ok: false; status?: number }>;

const defaultContribFetcher: ContribFetcher = (nwos, onChunk) =>
  new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: SNEETCHES_CONTRIB_PORT_NAME });
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
      const msg = rawMsg as SneetchesContribRpcMsg;
      if (msg.type === 'chunk') {
        onChunk(msg.entries);
      } else if (msg.type === 'error') {
        finish({ ok: false, status: msg.status });
      } else if (msg.type === 'done') {
        finish({ ok: true });
      }
    });
    port.onDisconnect.addListener(() => finish({ ok: false, status: undefined }));

    port.postMessage({ nwos });
  });

// ---------------------------------------------------------------------------
// Factory — all mutable state lives in this closure
// ---------------------------------------------------------------------------

type CachedSettings = Awaited<ReturnType<typeof getSettings>>;

export interface ContentScriptDeps {
  portFetcher?: PortFetcher;
  contribFetcher?: ContribFetcher;
}

export interface ContentScriptController {
  initialize(): void;
  teardown(): void;
  preload(): Promise<void>;
  getInMemoryRepoCache(): Map<string, RepoResponse> | null;
  setInMemoryRepoCache(m: Map<string, RepoResponse> | null): void;
  getCachedSettings(): Promise<CachedSettings>;
}

export function createContentScript(deps: ContentScriptDeps = {}): ContentScriptController {
  const portFetcher: PortFetcher = deps.portFetcher ?? defaultPortFetcher;
  const contribFetcher: ContribFetcher = deps.contribFetcher ?? defaultContribFetcher;

  // ------ stateful DOM observers / timers ------
  let starredObserver: MutationObserver | null = null;
  let linkScanObserver: MutationObserver | null = null;
  let linkScanTimeout: ReturnType<typeof setTimeout> | null = null;
  let linkScanMaxWaitTimeout: ReturnType<typeof setTimeout> | null = null;
  let bodyWaitObserver: MutationObserver | null = null;
  let lastLeadingEdgeAt = 0;

  // ------ epoch + in-flight tracking (see inFlightAnchors in 1.1.3 docs) ------
  let currentEpoch = 0;
  let inFlightAnchors: WeakMap<HTMLAnchorElement, number> = new WeakMap();
  let silentSkipAnchors: WeakSet<HTMLAnchorElement> = new WeakSet();

  // ------ settings cache (see 1.1.3 docs) ------
  let cachedSettings: Promise<CachedSettings> | null = null;

  // ------ in-memory repo-cache mirror (see 1.1.4 docs) ------
  let inMemoryRepoCache: Map<string, RepoResponse> | null = null;

  // ------ contributor results, addressed by anchor ----------
  // The repo-data and contrib pipelines resolve independently and in
  // either order. This WeakMap is the join point: each contrib result
  // is stored under its anchor, and either (a) appended immediately if
  // the repo annotation already exists, or (b) picked up by
  // createAnnotation when the repo paint arrives. Reset per scan epoch
  // via applySettingsChange and teardown.
  let contribResults: WeakMap<HTMLAnchorElement, ContribResponse> = new WeakMap();

  // ------ storage onChanged listener reference (for teardown) ------
  let storageChangedListener:
    | ((
        changes: { [key: string]: chrome.storage.StorageChange },
        namespace: chrome.storage.AreaName
      ) => void)
    | null = null;

  // ------ cmd-click skip-owner popover ------
  let activeSkipPopover: HTMLElement | null = null;
  let skipPopoverClickListener: ((e: MouseEvent) => void) | null = null;
  let skipPopoverKeyListener: ((e: KeyboardEvent) => void) | null = null;
  let skipPopoverScrollListener: (() => void) | null = null;
  let skipClickListener: ((e: MouseEvent) => void) | null = null;

  // -------------------------------------------------------------------------
  // stateful functions (close over the above)
  // -------------------------------------------------------------------------

  function getCachedSettings(): Promise<CachedSettings> {
    if (cachedSettings) return cachedSettings;
    // Reset the cache on rejection so the NEXT caller retries the storage
    // read instead of getting the same rejection back. Without this,
    // a transient `chrome.storage.sync.get` failure (rare but possible
    // during browser startup or extension updates) would pin every
    // subsequent scan to the same permanently-rejected promise, silently
    // disabling annotations until a settings change fired
    // `invalidateCachedSettings`.
    const promise = getSettings().catch((e) => {
      if (cachedSettings === promise) cachedSettings = null;
      throw e;
    });
    cachedSettings = promise;
    return promise;
  }

  function invalidateCachedSettings(): void {
    cachedSettings = null;
  }

  function findUnannotatedRepoLinks(): HTMLAnchorElement[] {
    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href^="https://github.com/"], a[href^="http://github.com/"]'
      )
    ).filter((a) => isRepoLink(a) && !inFlightAnchors.has(a) && !silentSkipAnchors.has(a));
  }

  function paintResult(
    elt: HTMLAnchorElement,
    nwo: string,
    res: RepoResponse,
    show: ShowSettings,
    starStyle: StarStyle,
    accessToken: string,
    skipOwners: readonly string[],
    epoch: number
  ): void {
    if (inFlightAnchors.get(elt) !== epoch) return;
    inFlightAnchors.delete(elt);
    switch (res.kind) {
      case 'silent':
        silentSkipAnchors.add(elt);
        return;
      case 'ok':
        elt.appendChild(createAnnotation(res.json, show, starStyle, contribResults.get(elt)));
        return;
      case 'error': {
        const errElt = createErrorAnnotation(
          { status: res.status },
          accessToken,
          console.error,
          nwo,
          skipOwners
        );
        if (errElt) elt.appendChild(errElt);
        return;
      }
    }
  }

  // Join the contrib result with the anchor's existing repo annotation.
  // Two arrival orders are possible: (1) repo paint already happened —
  // we append the chip in place; (2) repo paint hasn't run yet — we
  // only record the result, and createAnnotation will pick it up. The
  // epoch guard drops chunks that landed after an in-flight settings
  // change bumped the scan generation.
  function paintContribResult(
    elt: HTMLAnchorElement,
    res: ContribResponse,
    epoch: number,
    show: ShowSettings
  ): void {
    if (epoch !== currentEpoch) return;
    if (!show.contributors) return;
    contribResults.set(elt, res);
    const annotation = elt.querySelector<HTMLElement>('.' + ANNOTATION_CLASS);
    if (!annotation) return; // repo paint hasn't happened yet — createAnnotation will pick it up
    if (annotation.querySelector('.sneetch-contributors')) return; // already painted
    const chip = createContributorChip(res);
    if (!chip) return;
    // Match the in-fresh-paint chip order: stars, forks, date,
    // contributors, archive. If an archive chip exists, insert before
    // it so the "archive chip is the LAST child" invariant survives.
    const archiveChip = annotation.querySelector('.sneetch-archived');
    if (archiveChip) annotation.insertBefore(chip, archiveChip);
    else annotation.appendChild(chip);
  }

  async function runPreload(): Promise<void> {
    const frame = probe.newFrame('preload');
    // Capture the epoch before the await so any teardown or settings
    // change that bumps currentEpoch mid-flight causes us to skip the
    // assignment rather than stomp on a just-nulled mirror. Mirrors the
    // same pattern updateLinks uses for its stale-result guard.
    const epoch = currentEpoch;
    frame.mark(probe.Phase.PRELOAD_START);
    try {
      const map = await readAllCachedRepos<RepoResponse, number>(CACHE_VERSION);
      if (currentEpoch !== epoch) return;
      inMemoryRepoCache = map;
      frame.mark(probe.Phase.PRELOAD_DONE, { entries: map.size });
    } catch (e) {
      if (currentEpoch !== epoch) return;
      console.error('[sneetches] preload failed, falling back to empty cache:', e);
      inMemoryRepoCache = new Map();
    } finally {
      frame.dump();
    }
  }

  async function updateLinks() {
    const frame = probe.newFrame('scan');
    frame.mark(probe.Phase.SCAN_START);
    try {
      // Capture the epoch BEFORE the await so that any settings change
      // that fires between here and getCachedSettings() resolving is
      // guaranteed to have bumped currentEpoch past our captured value.
      // Our per-entry epoch check below will then correctly drop stale
      // results in favor of the post-change rescan that
      // applySettingsChange dispatches.
      const epoch = currentEpoch;
      const { accessToken, show, starStyle, skipOwners } = await getCachedSettings();
      const links = findUnannotatedRepoLinks();

      const pending: Array<{ elt: HTMLAnchorElement; nwo: string }> = [];
      for (const elt of links) {
        const nwo = parseRepoNwo(elt.href);
        if (!nwo) continue;
        inFlightAnchors.set(elt, epoch);
        pending.push({ elt, nwo });
      }

      if (pending.length === 0) return;

      // Kick off the contrib pipeline in parallel with the repo path.
      // Runs against ALL pending anchors (not just uncached ones) —
      // contrib data lives in its own namespace and is fetched
      // independently of the repo-data cache mirror. Fire-and-forget:
      // results land via paintContribResult, which joins them onto the
      // anchor's repo annotation in either arrival order. Disabled
      // entirely when show.contributors is off, so users who haven't
      // opted in pay zero extra cost.
      if (show.contributors) {
        const contribByNwo = new Map<string, HTMLAnchorElement[]>();
        for (const { elt, nwo } of pending) {
          const list = contribByNwo.get(nwo);
          if (list) list.push(elt);
          else contribByNwo.set(nwo, [elt]);
        }
        const contribNwos = Array.from(contribByNwo.keys());
        void contribFetcher(contribNwos, (entries) => {
          for (const [nwo, res] of entries) {
            const anchors = contribByNwo.get(nwo);
            if (!anchors) continue;
            for (const elt of anchors) {
              paintContribResult(elt, res, epoch, show);
            }
          }
        });
      }

      // 1.1.4 fast path: check the in-memory cache preloaded at
      // document_start. Anchors whose nwo is in the Map are painted
      // synchronously from memory — zero port round-trip, runs inside
      // the MutationObserver microtask. Misses fall through to the SW
      // port path unchanged.
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
            paintResult(p.elt, p.nwo, cached, show, starStyle, accessToken, skipOwners, epoch);
          } else {
            uncachedPending.push(p);
          }
        }
      } else {
        uncachedPending.push(...pending);
      }

      const cachedCount = pending.length - uncachedPending.length;
      frame.mark(probe.Phase.PENDING_COLLECTED, {
        pending: pending.length,
        cached: cachedCount,
        uncached: uncachedPending.length,
      });

      if (uncachedPending.length === 0) {
        frame.mark(probe.Phase.FAST_PATH_PAINTED, { painted: pending.length });
        frame.mark(probe.Phase.PAINT_DONE);
        return;
      }

      frame.mark(probe.Phase.FAST_PATH_PAINTED, {
        painted: cachedCount,
      });

      const uniqueNwos = Array.from(new Set(uncachedPending.map((p) => p.nwo)));

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
          frame.mark(probe.Phase.PORT_FIRST_CHUNK, { chunkSize: entries.length });
        }
        for (const [nwo, res] of entries) {
          const anchors = byNwo.get(nwo);
          if (!anchors) continue;
          for (const elt of anchors) {
            paintResult(elt, nwo, res, show, starStyle, accessToken, skipOwners, epoch);
          }
        }
      };

      frame.mark(probe.Phase.PORT_SEND, { unique: uniqueNwos.length });
      const result = await portFetcher(uniqueNwos, distributeChunk);
      frame.mark(probe.Phase.PORT_DONE, { ok: result.ok ? 'yes' : 'no' });

      if (!result.ok) {
        // Batch-level failure (network error, 401, 5xx): every anchor
        // still in flight under OUR epoch in the uncached subset gets an
        // error annotation. Cached-path anchors are already painted and
        // cleared from inFlightAnchors, so they're untouched here — the
        // `inFlightAnchors.get(elt) !== epoch` guard skips any anchor
        // already drained by the fast path.
        for (const { elt, nwo } of uncachedPending) {
          if (inFlightAnchors.get(elt) !== epoch) continue;
          inFlightAnchors.delete(elt);
          // Batch failures are 401/5xx/network, never 404 — so the skip
          // filter in createErrorAnnotation never fires here today. Thread
          // nwo + skipOwners anyway so this stays correct if the batch
          // path ever synthesizes a 404.
          const errElt = createErrorAnnotation(
            { status: result.status },
            accessToken,
            console.error,
            nwo,
            skipOwners
          );
          if (errElt) elt.appendChild(errElt);
        }
      }

      frame.mark(probe.Phase.PAINT_DONE);
    } finally {
      frame.dump();
    }
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
  function startLinkScanner(): void {
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

    const scheduleScan = () => {
      if (linkScanTimeout) clearTimeout(linkScanTimeout);
      linkScanTimeout = setTimeout(fireScan, LINK_SCAN_DEBOUNCE_MS);
      if (!linkScanMaxWaitTimeout) {
        linkScanMaxWaitTimeout = setTimeout(fireScan, LINK_SCAN_MAX_WAIT_MS);
      }
    };

    linkScanObserver = new MutationObserver((mutations) => {
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
          if (
            !repoLinkAdded &&
            (el.matches?.('a[href^="https://github.com/"]') ||
              el.querySelector?.('a[href^="https://github.com/"]'))
          ) {
            repoLinkAdded = true;
          }
        }
      }

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

  function detectStarredStateOnSneetchesRepo(): void {
    if (starredObserver) {
      starredObserver.disconnect();
      starredObserver = null;
    }

    const url = window.location.href;
    if (!SNEETCHES_REPO_URL.test(url)) return;

    writeStarredStateFromDOM();

    starredObserver = new MutationObserver(() => {
      writeStarredStateFromDOM();
    });
    starredObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['action'],
    });
  }

  function applySettingsChange(): void {
    currentEpoch++;
    inFlightAnchors = new WeakMap();
    silentSkipAnchors = new WeakSet();
    contribResults = new WeakMap();
    lastLeadingEdgeAt = 0;
    invalidateCachedSettings();
    // If the popover is open, the chip it was anchored to may be about to
    // be removed by removeLinkAnnotations — drop the popover so it doesn't
    // float untethered over empty space.
    dismissSkipPopover();
    removeLinkAnnotations();
    updateAnnotationsFromSettings();
  }

  function handleSyncStorageChange(changes: { [key: string]: chrome.storage.StorageChange }): void {
    const relevantChanged = RESCAN_TRIGGER_KEYS.some((k) => k in changes);
    if (!relevantChanged) return;

    const accessTokenChange = changes[ACCESS_TOKEN_KEY];
    if (accessTokenChange && accessTokenChange.oldValue !== accessTokenChange.newValue) {
      chrome.storage.local.clear();
      inMemoryRepoCache = null;
    }
    applySettingsChange();
  }

  function handleLocalStorageChange(changes: {
    [key: string]: chrome.storage.StorageChange;
  }): void {
    for (const [key, change] of Object.entries(changes)) {
      // Only true repo-nwo keys invalidate the mirror. Contrib-namespace
      // removals (owner/name\x00contrib) live in their own cache layer
      // and must not re-trigger the preload — otherwise every contrib
      // sweep would spuriously wipe the repo-data mirror.
      if (!isRepoNwoKey(key)) continue;
      if (change.oldValue !== undefined && change.newValue === undefined) {
        inMemoryRepoCache = null;
        return;
      }
    }
  }

  function initializeDomDependentFeatures(): void {
    startLinkScanner();
    detectStarredStateOnSneetchesRepo();
    wireSkipOwnerClickHandler();
  }

  // ---------------------------------------------------------------------
  // Cmd/Ctrl-click on a .sneetch-broken chip → prompt to skip the owner.
  // Uses a capture-phase delegated listener on document so we see the
  // click before any ancestor link handler can swallow or navigate.
  // The popover itself is fixed-positioned relative to the viewport
  // (NOT absolute-to-body) so ancestor transforms on host pages like
  // Notion/Linear/Confluence don't re-anchor it incorrectly.
  // ---------------------------------------------------------------------
  function dismissSkipPopover(): void {
    if (activeSkipPopover) {
      activeSkipPopover.remove();
      activeSkipPopover = null;
    }
    if (skipPopoverClickListener) {
      document.removeEventListener('click', skipPopoverClickListener, true);
      skipPopoverClickListener = null;
    }
    if (skipPopoverKeyListener) {
      document.removeEventListener('keydown', skipPopoverKeyListener, true);
      skipPopoverKeyListener = null;
    }
    if (skipPopoverScrollListener) {
      window.removeEventListener('scroll', skipPopoverScrollListener, true);
      window.removeEventListener('resize', skipPopoverScrollListener, true);
      skipPopoverScrollListener = null;
    }
  }

  function openSkipPopover(chip: HTMLElement, owner: string): void {
    dismissSkipPopover();
    const rect = chip.getBoundingClientRect();

    const popover = document.createElement('div');
    // Inline styles only — content script isolation prevents host
    // stylesheets from affecting us, but keeps the feature self-contained
    // without needing an injected <style> per-page.
    const style = popover.style;
    style.position = 'fixed';
    // Position-once-measured: append hidden so we can read the popover's
    // actual rendered size, then flip above/clamp horizontally if it would
    // clip the viewport. Avoids a hardcoded height guess and keeps the
    // popover on-screen for broken chips near the edges.
    style.visibility = 'hidden';
    style.top = '0px';
    style.left = '0px';
    style.zIndex = '2147483647';
    style.background = '#0a0e1a';
    style.color = '#e6edf3';
    style.border = '1px solid #2e3650';
    style.borderRadius = '8px';
    style.boxShadow = '0 12px 32px rgba(0,0,0,0.6)';
    style.padding = '10px 12px';
    style.width = '260px';
    style.font = '12px/1.4 -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
    style.cursor = 'default';

    const title = document.createElement('div');
    title.style.fontWeight = '500';
    title.style.marginBottom = '2px';
    title.append('Skip ');
    const ownerSpan = document.createElement('span');
    ownerSpan.textContent = owner;
    ownerSpan.style.font = '12px/1 ui-monospace, "SF Mono", Menlo, monospace';
    ownerSpan.style.color = '#7aa2ff';
    title.append(ownerSpan, '?');

    const sub = document.createElement('div');
    sub.style.color = '#5d6678';
    sub.style.fontSize = '10.5px';
    sub.style.margin = '4px 0 10px';
    sub.append('Hides the broken chip for every ');
    const code = document.createElement('code');
    code.textContent = `${owner}/*`;
    code.style.font = '10.5px/1 ui-monospace, Menlo, monospace';
    sub.append(code, ' link. Undo in Advanced.');

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.justifyContent = 'flex-end';

    const mkBtn = (label: string, primary: boolean): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.font = '500 11px/1 -apple-system, sans-serif';
      btn.style.padding = '6px 10px';
      btn.style.borderRadius = '5px';
      btn.style.cursor = 'pointer';
      btn.style.border = primary ? '1px solid #5b8def' : '1px solid #2e3650';
      btn.style.background = primary ? '#5b8def' : '#131826';
      btn.style.color = primary ? 'white' : '#8a96aa';
      return btn;
    };

    const cancelBtn = mkBtn('Cancel', false);
    const skipBtn = mkBtn('Skip owner', true);
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissSkipPopover();
    });
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void confirmSkipOwner(owner);
    });
    actions.append(cancelBtn, skipBtn);

    popover.append(title, sub, actions);
    // Prefer body: on pages where <html> has overflow:hidden + a transform
    // (some Docusaurus variants), a fixed element inside <html> can still
    // be clipped by the html-level containing block. Fall back to
    // documentElement only if body isn't ready (e.g. pre-DOMContentLoaded).
    (document.body ?? document.documentElement).appendChild(popover);
    // Measure + position now that layout is resolved. Flip above if below
    // would clip; clamp horizontally to keep it inside the viewport with
    // an 8px gutter.
    const popRect = popover.getBoundingClientRect();
    const GUTTER = 8;
    const GAP = 6;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipAbove = spaceBelow < popRect.height + GAP && rect.top > popRect.height + GAP;
    const top = flipAbove ? rect.top - popRect.height - GAP : rect.bottom + GAP;
    const maxLeft = Math.max(GUTTER, window.innerWidth - popRect.width - GUTTER);
    const left = Math.min(Math.max(rect.left, GUTTER), maxLeft);
    style.top = `${top}px`;
    style.left = `${left}px`;
    style.visibility = '';
    activeSkipPopover = popover;

    // Dismissal wiring. Capture-phase so we win against host-page
    // click handlers that stopPropagation at bubble.
    skipPopoverClickListener = (e: MouseEvent): void => {
      if (!activeSkipPopover) return;
      if (e.target instanceof Node && activeSkipPopover.contains(e.target)) return;
      dismissSkipPopover();
    };
    skipPopoverKeyListener = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissSkipPopover();
    };
    skipPopoverScrollListener = (): void => dismissSkipPopover();
    document.addEventListener('click', skipPopoverClickListener, true);
    document.addEventListener('keydown', skipPopoverKeyListener, true);
    window.addEventListener('scroll', skipPopoverScrollListener, true);
    window.addEventListener('resize', skipPopoverScrollListener, true);
  }

  async function confirmSkipOwner(owner: string): Promise<void> {
    dismissSkipPopover();
    // Symmetric with the options-UI Add path. The click path already
    // requires an https://github.com/ anchor with ≥2 path segments, so a
    // failing handle here is near-unreachable — but we gate anyway so a
    // pathological URL (percent-encoded spaces, weird unicode) can't leak
    // into sync storage.
    if (!GITHUB_HANDLE_RE.test(owner)) return;
    // Abort the whole flow on sync-get failure — without this, a transient
    // runtime.lastError would leave `current` as [] and the subsequent set
    // would silently overwrite an existing list with just the new owner.
    let current: string[];
    try {
      current = await new Promise<string[]>((resolve, reject) =>
        chrome.storage.sync.get([SKIP_OWNERS_KEY], (items) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
            return;
          }
          const raw = items[SKIP_OWNERS_KEY];
          resolve(Array.isArray(raw) ? (raw as string[]) : []);
        })
      );
    } catch (err) {
      console.error('sneetches: skip_owners read failed, aborting add', err);
      return;
    }
    const lower = owner.toLowerCase();
    if (current.includes(lower)) return;
    const next = [...current, lower].sort();
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [SKIP_OWNERS_KEY]: next }, () => resolve())
    );
    // The storage onChanged listener bumps currentEpoch via
    // applySettingsChange, which invalidates cachedSettings and kicks
    // off a rescan; the 404 cache entry remains but createErrorAnnotation
    // now returns null for it.
  }

  function wireSkipOwnerClickHandler(): void {
    // Defensive cleanup — matches the pattern in initialize() for the
    // storageChangedListener. A second initialize() call would otherwise
    // double-register the capture-phase listener.
    if (skipClickListener) {
      document.removeEventListener('click', skipClickListener, true);
      skipClickListener = null;
    }
    skipClickListener = (e: MouseEvent): void => {
      // Platform-aware modifier: Cmd on Mac, Ctrl elsewhere. metaKey also
      // fires on Windows' "Windows key" but that's a non-issue — no native
      // browser gesture competes there.
      if (!e.metaKey && !e.ctrlKey) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const chip = target.closest('.sneetch-broken');
      if (!chip) return;
      // Extract the owner from the enclosing anchor. Use URL parsing
      // instead of a string→regex coerce (which treats unescaped `.` as
      // "any char" and would match e.g. github-com.evil.tld) — this
      // handler writes to storage on confirm, so the hostname check has
      // to be precise. Also require >=2 path segments so profile/settings
      // links (github.com/settings/profile) don't masquerade as a repo.
      const anchor = chip.parentElement?.closest('a[href^="https://github.com/"]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }
      if (url.hostname !== 'github.com') return;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return;
      const owner = parts[0];
      if (!owner) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openSkipPopover(chip as HTMLElement, owner);
    };
    // Capture phase so ancestor <a> click handlers can't stopPropagation
    // away our chance to see this event.
    document.addEventListener('click', skipClickListener, true);
  }

  // -------------------------------------------------------------------------
  // Public controller surface
  // -------------------------------------------------------------------------

  function initialize(): void {
    // Defensive cleanup — production only calls this once, but a second
    // call would otherwise orphan the previous storageChangedListener
    // (leaked forever, since teardown() only knows about the current ref).
    // Matches the disconnect-then-recreate pattern in startLinkScanner.
    if (storageChangedListener) {
      chrome.storage.onChanged.removeListener(storageChangedListener);
      storageChangedListener = null;
    }

    // Fire the preload against chrome.storage.local. Not awaited —
    // updateLinks handles the "not yet populated" case by falling through
    // to the port path. On awesome-list pages, React hydration takes long
    // enough that the 234ms preload (measured 2026-04-15) resolves well
    // before the first repo anchor appears and the MO fires a scan.
    void runPreload();

    // Wire up the chrome.storage.onChanged listener. Save the reference
    // so teardown() can detach it cleanly.
    storageChangedListener = (changes, namespace) => {
      if (namespace === 'sync') handleSyncStorageChange(changes);
      else if (namespace === 'local') handleLocalStorageChange(changes);
    };
    chrome.storage.onChanged.addListener(storageChangedListener);

    if (document.body) {
      // Body already exists — either a legacy document_idle injection
      // timing or a jsdom test environment that pre-creates body. Run
      // synchronously.
      initializeDomDependentFeatures();
    } else {
      // document_start injection: body hasn't parsed yet. Watch
      // documentElement for the first childList mutation that adds body,
      // then fire init and disconnect. This is a microtask-scoped signal
      // that fires the moment the HTML parser inserts <body>, with no
      // task-queue delay.
      bodyWaitObserver = new MutationObserver(() => {
        if (document.body) {
          bodyWaitObserver?.disconnect();
          bodyWaitObserver = null;
          initializeDomDependentFeatures();
        }
      });
      bodyWaitObserver.observe(document.documentElement, { childList: true });
    }
  }

  function teardown(): void {
    if (linkScanObserver) {
      linkScanObserver.disconnect();
      linkScanObserver = null;
    }
    if (starredObserver) {
      starredObserver.disconnect();
      starredObserver = null;
    }
    if (bodyWaitObserver) {
      bodyWaitObserver.disconnect();
      bodyWaitObserver = null;
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
    contribResults = new WeakMap();
    invalidateCachedSettings();
    inMemoryRepoCache = null;
    // Bump rather than reset so any lingering .then/.catch from a prior
    // fetch can't coincidentally match a fresh epoch=0.
    currentEpoch++;
    if (storageChangedListener) {
      chrome.storage.onChanged.removeListener(storageChangedListener);
      storageChangedListener = null;
    }
    if (skipClickListener) {
      document.removeEventListener('click', skipClickListener, true);
      skipClickListener = null;
    }
    dismissSkipPopover();
  }

  return {
    initialize,
    teardown,
    preload: runPreload,
    getInMemoryRepoCache: () => inMemoryRepoCache,
    setInMemoryRepoCache: (m) => {
      inMemoryRepoCache = m;
    },
    getCachedSettings,
  };
}

// Production boot lives in src/content-entry.ts — webpack's content
// entry loads content-entry.ts which calls createContentScript().initialize().
// This module intentionally has no module-level side effects.
