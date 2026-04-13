jest.mock('../src/github', () => {
  const actual = jest.requireActual('../src/github');
  return {
    ...actual,
    getRepoData: jest.fn(),
  };
});

import { getRepoData } from '../src/github';
import {
  createAnnotation,
  createErrorAnnotation,
  detectStarredStateOnSneetchesRepo,
  startLinkScanner,
  __resetStarredDetectorForTests,
  __resetLinkScannerForTests,
  __applySettingsChangeForTests,
  __handleSyncStorageChangeForTests,
} from '../src/content';

const mockedGetRepoData = getRepoData as jest.MockedFunction<typeof getRepoData>;

describe('createAnnotation', () => {
  const data = {
    forks_count: 10,
    pushed_at: '2018-09-10',
    stargazers_count: 10,
  };

  test('stars annotation uses SVG icon', () => {
    const elt = createAnnotation(data, { forks: false, stars: true, update: false }, 'outline');
    expect(elt.outerHTML).toMatch('class="data-sneetch-extension"');
    expect(elt.outerHTML).toMatch('<svg');
    expect(elt.textContent?.trim()).toBe('10');
  });

  test('stars annotation uses filled SVG when starStyle=filled', () => {
    const elt = createAnnotation(data, { forks: false, stars: true, update: false }, 'filled');
    expect(elt.outerHTML).toMatch(/<svg/);
    // Starfill path data starts differently from star-outline; simplest check is
    // that the outputs for 'outline' vs 'filled' differ:
    const outlineElt = createAnnotation(
      data,
      { forks: false, stars: true, update: false },
      'outline'
    );
    expect(elt.outerHTML).not.toBe(outlineElt.outerHTML);
  });
});

describe('createErrorAnnotation', () => {
  const headers = { get: (_s: string) => '' };
  test('with a 403 and no an access token', () => {
    const elt = createErrorAnnotation({ status: 403, headers }, '');
    expect(elt.outerHTML).toMatch('class="data-sneetch-extension"');
    expect(elt.outerHTML).toMatch('title="Please set up your Github Personal Access Token"');
    expect(elt.innerText).toBe('⏳');
  });
  test('with an access token', () => {
    const elt = createErrorAnnotation({ status: 403, headers }, 'access token');
    expect(elt.outerHTML).not.toMatch('title="Please set up your Github Personal Access Token"');
  });
  test('for a missing repo', () => {
    const elt = createErrorAnnotation({ status: 404, headers }, '');
    expect(elt.outerHTML).toMatch(/class="[^"]* missing"/);
    expect(elt.innerText).toBe('missingⓍ');
  });
  test('with a unknown error', () => {
    const elt = createErrorAnnotation({ status: 410, headers }, '', (..._: unknown[]) => null);
    expect(elt.outerHTML).toMatch(/></);
    expect(elt.innerText).toBe('');
  });
});

describe('detectStarredStateOnSneetchesRepo', () => {
  const originalHref = window.location.href;

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    document.body.innerHTML = '';
  });

  afterEach(() => {
    __resetStarredDetectorForTests();
    // Restore original location
    Object.defineProperty(window, 'location', {
      value: new URL(originalHref),
      writable: true,
      configurable: true,
    });
  });

  function setHref(href: string) {
    Object.defineProperty(window, 'location', {
      value: { href },
      writable: true,
      configurable: true,
    });
  }

  function expectStoredStarred(expected: boolean | undefined) {
    return new Promise<void>((resolve) => {
      chrome.storage.sync.get(['has_starred'], (items) => {
        expect(items.has_starred).toBe(expected);
        resolve();
      });
    });
  }

  test('detects starred state from /unstar form and writes true', async () => {
    setHref('https://github.com/kesensoy/sneetches');
    document.body.innerHTML = `
      <form action="/kesensoy/sneetches/unstar?location=repo_overview_page" method="post">
        <button>Unstar</button>
      </form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(true);
  });

  test('detects unstarred state from /star form and writes false', async () => {
    setHref('https://github.com/kesensoy/sneetches');
    document.body.innerHTML = `
      <form action="/kesensoy/sneetches/star?location=repo_overview_page" method="post">
        <button>Star</button>
      </form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(false);
  });

  test('does nothing when neither form matches (logged out)', async () => {
    setHref('https://github.com/kesensoy/sneetches');
    document.body.innerHTML = `<div>no star form here</div>`;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(undefined);
  });

  test('does nothing when URL is not the sneetches repo page', async () => {
    setHref('https://github.com/kesensoy/sneetches/issues');
    document.body.innerHTML = `
      <form action="/kesensoy/sneetches/unstar" method="post"><button>Unstar</button></form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(undefined);
  });

  test('matches sneetches repo URL with trailing slash', async () => {
    setHref('https://github.com/kesensoy/sneetches/');
    document.body.innerHTML = `
      <form action="/kesensoy/sneetches/unstar" method="post"><button>Unstar</button></form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(true);
  });

  test('does nothing on other github pages', async () => {
    setHref('https://github.com/someoneelse/somerepo');
    document.body.innerHTML = `
      <form action="/someoneelse/somerepo/star"><button>Star</button></form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(undefined);
  });

  test('observer updates state when form action attribute mutates in place', async () => {
    setHref('https://github.com/kesensoy/sneetches');
    document.body.innerHTML = `
      <form action="/kesensoy/sneetches/star?location=repo_overview_page" method="post">
        <button>Star</button>
      </form>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(false);

    // Simulate user clicking the Star button — GitHub mutates the form action
    const form = document.querySelector('form')!;
    form.setAttribute('action', '/kesensoy/sneetches/unstar?location=repo_overview_page');
    // Let the MutationObserver callback fire (it runs as a microtask)
    await new Promise((r) => setTimeout(r, 10));

    await expectStoredStarred(true);
  });

  test('observer updates state when form element is replaced via DOM mutation', async () => {
    setHref('https://github.com/kesensoy/sneetches');
    document.body.innerHTML = `
      <div id="star-container">
        <form action="/kesensoy/sneetches/unstar" method="post"><button>Unstar</button></form>
      </div>
    `;
    detectStarredStateOnSneetchesRepo();
    await new Promise((r) => setTimeout(r, 0));
    await expectStoredStarred(true);

    // Simulate form element replacement (user clicks Unstar, GitHub swaps the DOM)
    const container = document.getElementById('star-container')!;
    container.innerHTML = `
      <form action="/kesensoy/sneetches/star" method="post"><button>Star</button></form>
    `;
    await new Promise((r) => setTimeout(r, 10));

    await expectStoredStarred(false);
  });
});

describe('startLinkScanner', () => {
  const makeRepoPayload = (overrides: Partial<{ stargazers_count: number }> = {}) => ({
    forks_count: 1,
    pushed_at: '2024-01-01',
    stargazers_count: 42,
    ...overrides,
  });

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set(
        { show: { stars: true, forks: false, update: false }, star_style: 'outline' },
        resolve
      )
    );
    document.body.innerHTML = '';
    mockedGetRepoData.mockReset();
    mockedGetRepoData.mockResolvedValue({ ok: true, json: makeRepoPayload() });
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  // Helper: wait for MutationObserver debounce + an extra tick for the
  // microtask from getRepoData's then() to flush. Debounce is 300ms.
  const waitForScanner = () => new Promise((r) => setTimeout(r, 400));

  test('annotates repo links added AFTER the scanner is set up (SPA hydration case)', async () => {
    // Scanner starts on an empty document — this is the scenario where
    // content_scripts injection (document_idle) races ahead of GitHub's
    // client-side README hydration. The initial scan finds zero links, but
    // the observer must catch links as they appear later.
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockedGetRepoData).not.toHaveBeenCalled();

    // Simulate GitHub hydrating README content into the DOM
    const container = document.createElement('div');
    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    container.appendChild(a);
    document.body.appendChild(container);

    await waitForScanner();

    expect(mockedGetRepoData).toHaveBeenCalledWith('ollama/ollama');
    expect(a.querySelector('.data-sneetch-extension')).not.toBeNull();
  });

  test('does not re-annotate links that already have an annotation', async () => {
    // Seed the DOM with a link BEFORE starting the scanner so the initial
    // scan processes it. Then trigger another scan via a new mutation and
    // verify the same link isn't touched twice.
    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);

    // Trigger another mutation — a NEW link so the observer schedules a scan.
    // The already-annotated 'ollama/ollama' link must not be fetched again.
    const b = document.createElement('a');
    b.href = 'https://github.com/anthropics/claude-code';
    document.body.appendChild(b);

    await waitForScanner();

    // Exactly two fetches total — one per distinct link. The ollama link
    // must not have been re-fetched, and it must still have exactly one
    // annotation child.
    expect(mockedGetRepoData).toHaveBeenCalledTimes(2);
    expect(mockedGetRepoData).toHaveBeenLastCalledWith('anthropics/claude-code');
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);
    expect(b.querySelector('.data-sneetch-extension')).not.toBeNull();
  });

  test('observer does not reschedule on its own annotation additions (no infinite loop)', async () => {
    // Put a link in the DOM, let the scanner annotate it, then ensure no
    // further scans fire. This guards against the footgun where appending
    // an annotation via elt.appendChild(...) triggers the observer again.
    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);

    // Wait well beyond another debounce window — if the observer re-queued a
    // scan from its own annotation mutation, it would have fired by now.
    await new Promise((r) => setTimeout(r, 500));
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
  });

  test('does not double-fetch when a second scan fires while the first is still in flight', async () => {
    // Race scenario: the first scan fires getRepoData for an anchor, the
    // promise takes a while to resolve (cold cache + slow network), and
    // some unrelated GitHub DOM activity (hovercards, lazy-loaded content,
    // whatever) mutates the page during the debounce window. That mutation
    // reschedules a second scan. Before the fix, the second scan would find
    // the same still-empty anchor (childElementCount === 0 because the
    // promise hasn't resolved) and fire a SECOND getRepoData. Both promises
    // would eventually resolve and each append an annotation — double-up.
    let resolveFetch: (v: {
      ok: boolean;
      json: { forks_count: number; pushed_at: string; stargazers_count: number };
    }) => void = () => {};
    mockedGetRepoData.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    // First scan found the link and fired one fetch (still pending).
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();

    // Simulate unrelated GitHub DOM activity — adds a non-annotation node,
    // which the observer will classify as "real" activity and schedule a
    // second scan on. The second scan must NOT re-fetch the in-flight link.
    const marker = document.createElement('div');
    document.body.appendChild(marker);
    await waitForScanner();

    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);

    // Now let the fetch resolve and assert exactly one annotation landed.
    resolveFetch({ ok: true, json: makeRepoPayload() });
    await waitForScanner();

    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);
  });

  test('drops in-flight fetch result when settings change mid-flight', async () => {
    // Scenario: a scan is in progress (fetch pending), the user toggles a
    // display setting in the popup, chrome.storage.onChanged fires. The
    // extension responds by clearing annotations and re-running the scan.
    // Before this fix, the original fetch's .then() closure captured the
    // OLD show/starStyle/accessToken, and when it eventually resolved it
    // would appendChild an annotation reflecting the pre-change settings
    // — a stale annotation that survives until the next page load.
    //
    // The fix: bump an epoch counter on every settings change, capture the
    // epoch at fetch-start, and drop the result on epoch mismatch.
    //
    // The custom Chrome storage mock doesn't fire onChanged events, so the
    // test invokes the settings-changed code path via a test-only helper
    // rather than by setting a storage key. The production listener and
    // the helper share the same implementation.
    let firstResolve: (v: {
      ok: boolean;
      json: { forks_count: number; pushed_at: string; stargazers_count: number };
    }) => void = () => {};
    mockedGetRepoData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          firstResolve = resolve;
        })
    );
    // Second call (from the post-settings-change rescan) stays pending forever
    // so we can observe the behavior purely through the first call's resolution.
    mockedGetRepoData.mockImplementationOnce(() => new Promise(() => {}));

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();

    // Simulate a settings change mid-flight (bumps epoch, clears in-flight
    // set, removes annotations, re-runs scan). The second scan fires a new
    // getRepoData for the same anchor under the new epoch.
    __applySettingsChangeForTests();
    await waitForScanner();
    expect(mockedGetRepoData).toHaveBeenCalledTimes(2);

    // Resolve the first (pre-change, stale-epoch) fetch. Its .then should
    // see the epoch mismatch and drop the result instead of appending.
    firstResolve({
      ok: true,
      json: makeRepoPayload({ stargazers_count: 9999 }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(0);
  });

  test('popup-only storage changes do not trigger an annotation rescan', async () => {
    // The chrome.storage.onChanged listener is fired on ANY sync key
    // change, not just the ones the content script cares about. Before
    // this fix, clicking "Test" in the popup (which writes
    // token_validated), opening the Advanced tray (advanced_open),
    // starring the repo (has_starred), or flipping the toolbar icon
    // (toolbar_icon) would cause every open GitHub tab to wipe its
    // annotations and re-render — a visible flicker on every popup
    // interaction. The fix filters the listener so only the keys
    // ACCESS_TOKEN_KEY, SHOW_KEY, and STAR_STYLE_KEY trigger a rescan.
    mockedGetRepoData.mockResolvedValue({ ok: true, json: makeRepoPayload() });

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);

    // Simulate the popup writing a popup-only key (e.g. the user clicked
    // "Test" and the button flipped to ✓ Valid). This should NOT wipe or
    // refetch anything in open tabs.
    __handleSyncStorageChangeForTests({
      token_validated: { oldValue: false, newValue: true },
    });
    await waitForScanner();

    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);

    // Same check for the other popup-only keys — belt and suspenders.
    __handleSyncStorageChangeForTests({
      advanced_open: { oldValue: false, newValue: true },
    });
    __handleSyncStorageChangeForTests({
      has_starred: { oldValue: false, newValue: true },
    });
    __handleSyncStorageChangeForTests({
      toolbar_icon: { oldValue: 'gray', newValue: 'colorful' },
    });
    await waitForScanner();

    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);
  });

  test('relevant storage changes (show/star_style/access_token) do trigger an annotation rescan', async () => {
    // Counterpart to the popup-only test above: the three "real" trigger
    // keys still need to fire a full rescan. A show-setting toggle is a
    // sufficient sentinel — the handler is key-driven, so if show
    // triggers correctly, star_style and access_token will too (plus
    // access_token additionally flushes the local cache).
    mockedGetRepoData.mockResolvedValue({ ok: true, json: makeRepoPayload() });

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(mockedGetRepoData).toHaveBeenCalledTimes(1);

    __handleSyncStorageChangeForTests({
      show: {
        oldValue: { stars: true, forks: false, update: false },
        newValue: { stars: true, forks: true, update: false },
      },
    });
    await waitForScanner();

    // Rescan should have fired: removeLinkAnnotations() wipes the first
    // annotation, then updateLinks() re-fetches + re-appends with the
    // new settings. Exactly one annotation on the anchor, and a second
    // getRepoData call.
    expect(mockedGetRepoData).toHaveBeenCalledTimes(2);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);
  });

  test('does nothing when all show settings are off', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ show: { stars: false, forks: false, update: false } }, resolve)
    );

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    expect(mockedGetRepoData).not.toHaveBeenCalled();
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();
  });
});
