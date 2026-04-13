import { clockIcon, repoForkedIcon, starIcon } from './icons';
import { getRepoData, isRepoUrl } from './github';
import { ACCESS_TOKEN_KEY, getSettings, ShowSettings, StarStyle } from './settings';
import { commafy, humanize, humanizeDate } from './utils';

// Detect and persist whether the authenticated GitHub user has starred
// this extension's repo. We scrape the star button's form action from
// github.com/kesensoy/sneetches — much cleaner than an API call (no
// token needed, no scope requirements).

let starredObserver: MutationObserver | null = null;
let starredObserverTimeout: ReturnType<typeof setTimeout> | null = null;

function writeStarredStateFromDOM(): void {
  const unstarForm = document.querySelector('form[action^="/kesensoy/sneetches/unstar"]');
  const starForm = document.querySelector('form[action^="/kesensoy/sneetches/star"]');

  let isStarred: boolean | null = null;
  if (unstarForm) isStarred = true;
  else if (starForm) isStarred = false;

  if (isStarred === null) return; // logged out or DOM changed — leave state alone
  chrome.storage.sync.set({ has_starred: isStarred });
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
  if (!/^https?:\/\/github\.com\/kesensoy\/sneetches\/?(?:\?.*)?$/.test(url)) return;

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

const Symbols = {
  missing: 'missingⓍ',
};

export const isRepoLink = (elt: HTMLAnchorElement): boolean =>
  isRepoUrl(elt.href) && elt.childElementCount === 0;

const repoLinks = Array.from(
  document.querySelectorAll<HTMLAnchorElement>(
    'a[href^="https://github.com/"], a[href^="http://github.com/"]'
  )
).filter(isRepoLink);

const removeLinkAnnotations = () =>
  document.querySelectorAll('.' + ANNOTATION_CLASS).forEach((node) => node.remove());

async function updateLinks() {
  const { accessToken, show, starStyle } = await getSettings();
  repoLinks.forEach((elt) => {
    const href = elt.href;
    const m = href.match('^https?://github.com/(.+?)(?:.git)?/?$');
    if (m) {
      getRepoData(m[1])
        .then((res) => {
          if (res.ok) {
            elt.appendChild(createAnnotation(res.json!, show, starStyle));
          } else {
            elt.appendChild(createErrorAnnotation(res, accessToken));
          }
        })
        .catch((err) => {
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
    return _createAnnotation(Symbols.missing, 'missing');
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
  if (show.stars) {
    const span = document.createElement('span');
    span.className = 'sneetch-stars';
    span.innerHTML =
      humanize(data.stargazers_count) + ' ' + starIcon('sneetch-icon', starStyle === 'filled');
    elt.appendChild(span);
  }
  if (show.forks) {
    const span = document.createElement('span');
    span.className = 'sneetch-forks';
    span.innerHTML = humanize(data.forks_count) + ' ' + repoForkedIcon('sneetch-icon');
    elt.appendChild(span);
  }
  if (show.update) {
    const span = document.createElement('span');
    span.className = 'sneetch-date';
    span.innerHTML = clockIcon('sneetch-icon') + ' ' + humanizeDate(pushedAt);
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

updateAnnotationsFromSettings();
detectStarredStateOnSneetchesRepo(); // NEW: scrape starred state if we're on the sneetches repo page

chrome.storage.onChanged.addListener((object, namespace) => {
  if (namespace === 'sync') {
    const accessTokenChange = object[ACCESS_TOKEN_KEY];
    if (accessTokenChange && accessTokenChange.oldValue !== accessTokenChange.newValue) {
      chrome.storage.local.clear();
    }
    removeLinkAnnotations();
    updateAnnotationsFromSettings();
  }
});
