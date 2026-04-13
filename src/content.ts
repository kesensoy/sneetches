import { clockIcon, repoForkedIcon, starIcon } from './icons';
import { getRepoData, isRepoUrl } from './github';
import {
  ACCESS_TOKEN_KEY,
  HAS_STARRED_KEY,
  SHOW_KEY,
  STAR_STYLE_KEY,
  getSettings,
  ShowSettings,
  StarStyle,
} from './settings';
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
const MISSING_SYMBOL = 'missingⓍ';

// Debounce window for the DOM observer. Long enough to coalesce the wave of
// mutations GitHub's React hydration fires during README insertion; short
// enough that the user doesn't notice the delay once links appear.
const LINK_SCAN_DEBOUNCE_MS = 300;

export const isRepoLink = (elt: HTMLAnchorElement): boolean =>
  isRepoUrl(elt.href) && elt.childElementCount === 0;

let linkScanObserver: MutationObserver | null = null;
let linkScanTimeout: ReturnType<typeof setTimeout> | null = null;

// Anchors with a getRepoData() fetch still in flight, mapped to the epoch
// at which the fetch was started. Used for two things:
//
//   1. Prevent a second debounced scan from re-issuing fetches for links
//      the first scan is already processing (the "duplicate annotation"
//      race — a mutation burst fires a second scan inside the debounce
//      window while the first scan's cold-cache fetches are still
//      pending, and both waves try to annotate the same anchors).
//
//   2. Drop stale-settings results when `chrome.storage.onChanged` fires
//      mid-fetch. Settings changes bump `currentEpoch`, and each fetch's
//      .then/.catch compares its captured epoch against the current map
//      entry — if they no longer match, the result is dropped rather
//      than appended, and the fresh rescan (under the new settings) is
//      allowed to produce the live annotation.
//
// WeakMap auto-releases entries if an anchor is removed from the DOM
// before its fetch resolves, so nothing to clean up on long-lived pages.
let currentEpoch = 0;
let inFlightAnchors: WeakMap<HTMLAnchorElement, number> = new WeakMap();

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
  ).filter((a) => isRepoLink(a) && !inFlightAnchors.has(a));
}

async function updateLinks() {
  // Capture the epoch BEFORE the await so that any settings change that
  // fires between here and getSettings() resolving is guaranteed to have
  // bumped currentEpoch past our captured value. Our .then/.catch epoch
  // check will then correctly drop our (potentially mixed-state) results
  // in favor of the post-change rescan that applySettingsChange dispatches.
  //
  // Subtle detail: capturing AFTER the await is almost always fine in
  // practice because Chrome delivers chrome.storage.onChanged as an async
  // task (not a microtask), so it cannot interleave with the synchronous
  // continuation between the await resolving and the next line executing.
  // But capturing BEFORE the await is provably safe regardless of the
  // implementation's microtask-vs-task boundary, so we do it that way.
  const epoch = currentEpoch;
  const { accessToken, show, starStyle } = await getSettings();
  const links = findUnannotatedRepoLinks();
  links.forEach((elt) => {
    const href = elt.href;
    const m = href.match('^https?://github.com/(.+?)(?:.git)?/?$');
    if (m) {
      inFlightAnchors.set(elt, epoch);
      getRepoData(m[1])
        .then((res) => {
          // If our epoch no longer matches, settings changed mid-flight
          // and a newer scan has taken over (or no scan has rebound the
          // anchor yet). Either way, silently drop: don't appendChild
          // with stale closure, and don't delete the map entry (it may
          // belong to the newer scan's in-flight fetch).
          if (inFlightAnchors.get(elt) !== epoch) return;
          inFlightAnchors.delete(elt);
          if (res.ok) {
            elt.appendChild(createAnnotation(res.json!, show, starStyle));
          } else {
            elt.appendChild(createErrorAnnotation(res, accessToken));
          }
        })
        .catch((err) => {
          if (inFlightAnchors.get(elt) !== epoch) return;
          inFlightAnchors.delete(elt);
          elt.appendChild(createErrorAnnotation(err, accessToken));
        });
    }
  });
}

export function createErrorAnnotation(
  res: { status?: number; headers?: { get: (_: string) => string } },
  accessToken: string,
  reportError: (_: string, ..._2: unknown[]) => void = console.error
) {
  if (res.status === 403) {
    const elt = _createAnnotation('⏳');
    const when = new Date(Number(res.headers!.get('X-RateLimit-Reset')) * 1000);
    const title = accessToken
      ? 'The GitHub API rate limit has been exceeded.' + `No API calls are available until ${when}.`
      : 'Please set up your Github Personal Access Token';
    elt.setAttribute('title', title);
    return elt;
  } else if (res.status === 404) {
    return _createAnnotation(MISSING_SYMBOL, 'missing');
  } else {
    reportError('sneetches: request status =', res.status);
    return _createAnnotation('');
  }
}

export function createAnnotation(
  data: { forks_count: number; stargazers_count: number; pushed_at: string },
  show: ShowSettings,
  starStyle: StarStyle
) {
  const pushedAt = new Date(data.pushed_at);
  const elt = _createAnnotation('');
  // Build each stat span by splitting text content from SVG markup: text
  // goes through a text node (escaped) while the SVG icon string is the
  // only thing ever handed to innerHTML-style insertion. Keeps the SVG
  // markup working without trusting humanize() / humanizeDate() output as
  // HTML, even though today those functions only ever emit digits.
  if (show.stars) {
    const span = document.createElement('span');
    span.className = 'sneetch-stars';
    span.append(humanize(data.stargazers_count) + ' ');
    span.insertAdjacentHTML('beforeend', starIcon('sneetch-icon', starStyle === 'filled'));
    elt.appendChild(span);
  }
  if (show.forks) {
    const span = document.createElement('span');
    span.className = 'sneetch-forks';
    span.append(humanize(data.forks_count) + ' ');
    span.insertAdjacentHTML('beforeend', repoForkedIcon('sneetch-icon'));
    elt.appendChild(span);
  }
  if (show.update) {
    const span = document.createElement('span');
    span.className = 'sneetch-date';
    span.insertAdjacentHTML('beforeend', clockIcon('sneetch-icon'));
    span.append(' ' + humanizeDate(pushedAt));
    elt.appendChild(span);
  }
  elt.title =
    [
      `${commafy(data.stargazers_count)} stars`,
      `${commafy(data.forks_count)} forks`,
      `pushed ${pushedAt.toLocaleDateString()}`,
    ].join('; ') + ' — Sneetches';
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
  const { show } = await getSettings();
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

  // Initial scan for whatever links are present at injection time (may be
  // zero on awesome-list pages, but will find them on regular repo pages).
  updateAnnotationsFromSettings();

  const scheduleScan = () => {
    if (linkScanTimeout) clearTimeout(linkScanTimeout);
    linkScanTimeout = setTimeout(() => {
      linkScanTimeout = null;
      updateAnnotationsFromSettings();
    }, LINK_SCAN_DEBOUNCE_MS);
  };

  linkScanObserver = new MutationObserver((mutations) => {
    // Ignore mutations that only added our own annotation nodes — otherwise
    // each appendChild(createAnnotation(...)) would re-trigger a scan and
    // spin forever. Checking the top-level added node is sufficient: when
    // the extension attaches a pre-built <small class="data-sneetch-extension">
    // subtree to an anchor, the observer reports exactly one added node (the
    // <small>); its inner <span>/<svg>/<path> descendants are NOT reported as
    // separate additions, because they were already part of the subtree when
    // the top-level element was appended (MutationObserver childList spec).
    // The detached <span> construction inside createAnnotation — including
    // the insertAdjacentHTML call for the SVG icon — fires no observer
    // callbacks at all, because the span isn't in document.body yet.
    const nonAnnotationActivity = mutations.some((m) => {
      if (m.type !== 'childList') return true;
      if (m.removedNodes.length > 0) return true;
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.classList && el.classList.contains(ANNOTATION_CLASS)) continue;
        return true;
      }
      return false;
    });
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
  inFlightAnchors = new WeakMap();
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

startLinkScanner();
detectStarredStateOnSneetchesRepo();

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') handleSyncStorageChange(changes);
});
