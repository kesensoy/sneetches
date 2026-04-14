import { RepoResponse } from '../src/github';
import {
  createAnnotation,
  createErrorAnnotation,
  detectStarredStateOnSneetchesRepo,
  startLinkScanner,
  __resetStarredDetectorForTests,
  __resetLinkScannerForTests,
  __applySettingsChangeForTests,
  __handleSyncStorageChangeForTests,
  __setPortFetcherForTests,
} from '../src/content';

// Alias retained so the existing call sites don't all change names.
type MockBatchResponse = RepoResponse;

// Test harness for the content script's port-based transport. The real
// port/service-worker integration is covered in tests/service-worker.test.ts;
// these tests substitute a controllable fetcher via __setPortFetcherForTests
// so they can assert updateLinks' own epoch / dedup / silent-skip / rescan
// behavior in isolation, mirroring the pre-1.1.3 getRepoDataMany-mock style.
type ChunkCb = (entries: Array<readonly [string, RepoResponse]>) => void;
type PortFetcherResult = { ok: true } | { ok: false; status?: number };

// Jest mock proxy for the port fetcher. Each test can override its
// implementation (`.mockImplementation`, `.mockImplementationOnce`, etc.)
// to drive chunk delivery or hang the fetch open across settings-change
// scenarios. The mock is installed via __setPortFetcherForTests in each
// describe-block's beforeEach.
const portFetcherMock = jest.fn<Promise<PortFetcherResult>, [string[], ChunkCb]>();

// Helper: make the port fetcher answer every nwo in the requested batch
// with the given fixed response, delivering a single chunk + ok:true.
// Equivalent to the old mockBatchRespondsWith that stubbed
// getRepoDataMany's Map return.
function mockBatchRespondsWith(response: RepoResponse): void {
  portFetcherMock.mockImplementation(async (nwos, onChunk) => {
    const entries: Array<readonly [string, RepoResponse]> = nwos.map((nwo) => [nwo, response]);
    onChunk(entries);
    return { ok: true };
  });
}

describe('createAnnotation', () => {
  const data = {
    forks_count: 10,
    pushed_at: '2018-09-10',
    stargazers_count: 10,
    archived: false,
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

  test('prefers committed_date over pushed_at when present', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2025-11-07T00:00:00Z',
      stargazers_count: 612,
      archived: false,
      committed_date: '2018-09-23T00:00:00Z',
    };
    const elt = createAnnotation(data, { forks: false, stars: false, update: true }, 'outline');
    // Tooltip should reflect the committed_date (2018), not pushed_at (2025)
    expect(elt.title).toContain('2018');
    expect(elt.title).not.toContain('2025');
  });

  test('falls back to pushed_at when committed_date is undefined', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2024-06-15T00:00:00Z',
      stargazers_count: 612,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: false, stars: false, update: true }, 'outline');
    expect(elt.title).toContain('2024');
  });

  test('tooltip uses "last updated" wording, not "pushed"', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2018-09-10T00:00:00Z',
      stargazers_count: 10,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.title).toContain('last updated');
    expect(elt.title).not.toContain('pushed');
  });

  test('renders archive chip when data.archived === true', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 10,
      archived: true,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    const archiveChip = elt.querySelector('.sneetch-archived');
    expect(archiveChip).not.toBeNull();
    expect(archiveChip?.querySelector('svg')).not.toBeNull();
    expect(archiveChip?.getAttribute('aria-label')).toBe('archived');
  });

  test('omits archive chip when data.archived === false', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 10,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.querySelector('.sneetch-archived')).toBeNull();
  });

  test('archive chip is the LAST child of the annotation', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 10,
      archived: true,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    const children = elt.children;
    expect(children[children.length - 1].classList.contains('sneetch-archived')).toBe(true);
  });

  test('wrapper has is-archived class when archived', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 10,
      archived: true,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.classList.contains('is-archived')).toBe(true);
  });

  test('wrapper does NOT have is-archived class when not archived', () => {
    const data = {
      forks_count: 10,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 10,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.classList.contains('is-archived')).toBe(false);
  });

  test('tooltip appends "archived" for archived repos', () => {
    const data = {
      forks_count: 58,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 612,
      archived: true,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.title).toContain('; archived');
  });

  test('tooltip does NOT contain "archived" for non-archived repos', () => {
    const data = {
      forks_count: 58,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 612,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');
    expect(elt.title).not.toContain('archived');
  });

  test('each chip has an aria-label for screen readers', () => {
    const data = {
      forks_count: 58,
      pushed_at: '2021-03-14T00:00:00Z',
      stargazers_count: 612,
      archived: false,
    };
    const elt = createAnnotation(data, { forks: true, stars: true, update: true }, 'outline');

    const starsChip = elt.querySelector('.sneetch-stars');
    expect(starsChip?.getAttribute('aria-label')).toBe('612 stars');

    const forksChip = elt.querySelector('.sneetch-forks');
    expect(forksChip?.getAttribute('aria-label')).toBe('58 forks');

    const dateChip = elt.querySelector('.sneetch-date');
    expect(dateChip?.getAttribute('aria-label')).toMatch(/^last updated/);
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

  test('with a 403 and NO headers field (as thrown by fetchers)', () => {
    // fetchRepoDataRESTSingle and fetchRepoDataGraphQLSingle throw plain
    // `{ ok: false, status }` objects with no `headers` field. Before this
    // fix, createErrorAnnotation's `res.headers!.get(...)` crashed with a
    // TypeError before the accessToken branch was reached. Flagged by
    // greptile as a P2 on PR #3.
    const elt = createErrorAnnotation({ status: 403 }, '');
    expect(elt.innerText).toBe('⏳');
    // Without a headers, the title falls back to the token-setup prompt.
    expect(elt.getAttribute('title')).toBe('Please set up your Github Personal Access Token');
  });

  test('with a 403, access token, and NO headers field', () => {
    // Same defensive case but with a token configured — the title should
    // mention the rate limit but not include a bogus reset time.
    const elt = createErrorAnnotation({ status: 403 }, 'ghp_fake');
    expect(elt.innerText).toBe('⏳');
    const title = elt.getAttribute('title') ?? '';
    expect(title).toContain('rate limit');
    expect(title).not.toContain('undefined');
    expect(title).not.toContain('NaN');
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
    archived: false,
    ...overrides,
  });

  beforeAll(() => {
    __setPortFetcherForTests(portFetcherMock);
  });

  afterAll(() => {
    __setPortFetcherForTests(null);
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
    portFetcherMock.mockReset();
    mockBatchRespondsWith({ ok: true, json: makeRepoPayload() });
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  // Helper: wait for MutationObserver debounce + an extra tick for the
  // microtask from getRepoDataMany's then() to flush. Debounce is 300ms.
  const waitForScanner = () => new Promise((r) => setTimeout(r, 400));

  test('annotates repo links added AFTER the scanner is set up (SPA hydration case)', async () => {
    // Scanner starts on an empty document — this is the scenario where
    // content_scripts injection (document_idle) races ahead of GitHub's
    // client-side README hydration. The initial scan finds zero links, but
    // the observer must catch links as they appear later.
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 10));
    expect(portFetcherMock).not.toHaveBeenCalled();

    // Simulate GitHub hydrating README content into the DOM
    const container = document.createElement('div');
    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    container.appendChild(a);
    document.body.appendChild(container);

    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledWith(['ollama/ollama'], expect.any(Function));
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

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
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
    expect(portFetcherMock).toHaveBeenCalledTimes(2);
    expect(portFetcherMock).toHaveBeenLastCalledWith(
      ['anthropics/claude-code'],
      expect.any(Function)
    );
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
    expect(portFetcherMock).toHaveBeenCalledTimes(1);

    // Wait well beyond another debounce window — if the observer re-queued a
    // scan from its own annotation mutation, it would have fired by now.
    await new Promise((r) => setTimeout(r, 500));
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
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
    // Hold the fetch open until resolveFetch is called. When it fires,
    // deliver the chunk to the real onChunk callback so the content
    // script's distributeChunk path runs, then resolve the outer
    // promise with { ok: true } — matching the 'done' message the
    // production port would post in the same scenario.
    let resolveFetch: (map: Map<string, MockBatchResponse>) => void = () => {};
    portFetcherMock.mockImplementation(
      (_nwos, onChunk) =>
        new Promise<PortFetcherResult>((resolvePromise) => {
          resolveFetch = (map) => {
            onChunk(Array.from(map.entries()));
            resolvePromise({ ok: true });
          };
        })
    );

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    // First scan found the link and fired one fetch (still pending).
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();

    // Simulate unrelated GitHub DOM activity — adds a non-annotation node,
    // which the observer will classify as "real" activity and schedule a
    // second scan on. The second scan must NOT re-fetch the in-flight link.
    const marker = document.createElement('div');
    document.body.appendChild(marker);
    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledTimes(1);

    // Now let the fetch resolve and assert exactly one annotation landed.
    resolveFetch(new Map([['ollama/ollama', { ok: true, json: makeRepoPayload() }]]));
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
    // First call: hold the fetch open. When firstResolve fires, deliver
    // the chunk to the captured onChunk and resolve with ok:true — this
    // reaches the distribution loop under a stale epoch, which should
    // be silently dropped.
    let firstResolve: (map: Map<string, MockBatchResponse>) => void = () => {};
    portFetcherMock.mockImplementationOnce(
      (_nwos, onChunk) =>
        new Promise<PortFetcherResult>((resolvePromise) => {
          firstResolve = (map) => {
            onChunk(Array.from(map.entries()));
            resolvePromise({ ok: true });
          };
        })
    );
    // Second call (from the post-settings-change rescan) stays pending
    // forever so we can observe the behavior purely through the first
    // call's resolution.
    portFetcherMock.mockImplementationOnce(() => new Promise<PortFetcherResult>(() => {}));

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();

    // Simulate a settings change mid-flight (bumps epoch, clears in-flight
    // set, removes annotations, re-runs scan). The second scan fires a new
    // getRepoData for the same anchor under the new epoch.
    __applySettingsChangeForTests();
    await waitForScanner();
    expect(portFetcherMock).toHaveBeenCalledTimes(2);

    // Resolve the first (pre-change, stale-epoch) fetch. Its distribution
    // loop should see the epoch mismatch and drop the result instead of
    // appending.
    firstResolve(
      new Map([['ollama/ollama', { ok: true, json: makeRepoPayload({ stargazers_count: 9999 }) }]])
    );
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
    mockBatchRespondsWith({ ok: true, json: makeRepoPayload() });

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);

    // Simulate the popup writing a popup-only key (e.g. the user clicked
    // "Test" and the button flipped to ✓ Valid). This should NOT wipe or
    // refetch anything in open tabs.
    __handleSyncStorageChangeForTests({
      token_validated: { oldValue: false, newValue: true },
    });
    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
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

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(a.querySelectorAll('.data-sneetch-extension')).toHaveLength(1);
  });

  test('access_token change flushes the local cache in addition to rescanning', async () => {
    // access_token is unique among the rescan-trigger keys: it additionally
    // invalidates the chrome.storage.local cache when it changes, because
    // a new token may have different repo visibility (private repos the
    // old token couldn't see, etc.) and stale cached payloads would be
    // served forever otherwise. show and star_style only re-render; they
    // don't touch the cache. This test guards that branch specifically.
    mockBatchRespondsWith({ ok: true, json: makeRepoPayload() });

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(portFetcherMock).toHaveBeenCalledTimes(1);

    const clearSpy = jest.spyOn(chrome.storage.local, 'clear');
    clearSpy.mockClear();

    __handleSyncStorageChangeForTests({
      access_token: { oldValue: 'ghp_old', newValue: 'ghp_new' },
    });
    await waitForScanner();

    // Exactly one local-cache flush, triggered by the token change.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // And the rescan fired too (same path as the show/star_style case).
    expect(portFetcherMock).toHaveBeenCalledTimes(2);

    clearSpy.mockRestore();
  });

  test('relevant storage changes (show/star_style/access_token) do trigger an annotation rescan', async () => {
    // Counterpart to the popup-only test above: the three "real" trigger
    // keys still need to fire a full rescan. A show-setting toggle is a
    // sufficient sentinel — the handler is key-driven, so if show
    // triggers correctly, star_style and access_token will too (plus
    // access_token additionally flushes the local cache).
    mockBatchRespondsWith({ ok: true, json: makeRepoPayload() });

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();
    expect(portFetcherMock).toHaveBeenCalledTimes(1);

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
    expect(portFetcherMock).toHaveBeenCalledTimes(2);
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

    expect(portFetcherMock).not.toHaveBeenCalled();
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();
  });
});

describe('updateLinks silent-skip handling', () => {
  beforeAll(() => {
    __setPortFetcherForTests(portFetcherMock);
  });

  afterAll(() => {
    __setPortFetcherForTests(null);
  });

  beforeEach(async () => {
    document.body.innerHTML = '';
    portFetcherMock.mockReset();
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('FORBIDDEN silent-skip does not append annotation to anchor', async () => {
    document.body.innerHTML = '<a href="https://github.com/private/repo">private/repo</a>';
    mockBatchRespondsWith({ ok: false, silent: true });

    // Need to trigger a scan
    startLinkScanner();
    // Wait for the debounce + async fetch resolution
    await new Promise((resolve) => setTimeout(resolve, 400));

    const anchor = document.querySelector('a');
    expect(anchor?.querySelector('.data-sneetch-extension')).toBeNull();
  });

  test('silent-skip anchor is NOT re-fetched on subsequent mutation-triggered scans', async () => {
    // Guards the greptile P2 finding: after a FORBIDDEN response, the anchor
    // has no annotation, so a naive findUnannotatedRepoLinks filter would
    // pick it back up on every DOM mutation and refetch (cache-hit, but
    // ongoing async overhead on pages with many private repos). The fix
    // is a silentSkipAnchors WeakSet that permanently excludes the anchor
    // from subsequent scans until settings change.
    document.body.innerHTML = '<a href="https://github.com/private/repo">private/repo</a>';
    mockBatchRespondsWith({ ok: false, silent: true });

    startLinkScanner();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(portFetcherMock).toHaveBeenCalledTimes(1);

    // Trigger a second scan via a new mutation. The silent-skipped anchor
    // must not be re-fetched — findUnannotatedRepoLinks filters it out,
    // so updateLinks sees pending.length === 0 and returns without calling
    // getRepoDataMany again.
    const marker = document.createElement('div');
    document.body.appendChild(marker);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
  });
});

describe('updateLinks batching', () => {
  beforeAll(() => {
    __setPortFetcherForTests(portFetcherMock);
  });

  afterAll(() => {
    __setPortFetcherForTests(null);
  });

  beforeEach(async () => {
    document.body.innerHTML = '';
    portFetcherMock.mockReset();
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set(
        { show: { stars: true, forks: false, update: false }, star_style: 'outline' },
        resolve
      )
    );
    mockBatchRespondsWith({
      ok: true,
      json: {
        forks_count: 1,
        pushed_at: '2025-01-01T00:00:00Z',
        stargazers_count: 10,
        archived: false,
      },
    });
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('a scan with N anchors makes ONE getRepoDataMany call with N nwos', async () => {
    document.body.innerHTML = `
      <a href="https://github.com/octocat/hello"></a>
      <a href="https://github.com/torvalds/linux"></a>
      <a href="https://github.com/anthropics/claude-code"></a>
    `;
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 400));

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(portFetcherMock).toHaveBeenCalledWith(
      ['octocat/hello', 'torvalds/linux', 'anthropics/claude-code'],
      expect.any(Function)
    );
    expect(document.querySelectorAll('.data-sneetch-extension')).toHaveLength(3);
  });

  test('deduplicates repeated nwos in a single scan', async () => {
    document.body.innerHTML = `
      <a href="https://github.com/octocat/hello">one</a>
      <a href="https://github.com/octocat/hello">two</a>
      <a href="https://github.com/octocat/hello">three</a>
    `;
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 400));

    // Only one unique nwo, so the batch call receives an array of 1.
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(portFetcherMock).toHaveBeenCalledWith(['octocat/hello'], expect.any(Function));
    // But all three anchors get annotated.
    expect(document.querySelectorAll('.data-sneetch-extension')).toHaveLength(3);
  });
});
