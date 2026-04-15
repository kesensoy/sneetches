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
  __handleLocalStorageChangeForTests,
  __setPortFetcherForTests,
  __getCachedSettingsForTests,
  __setInMemoryRepoCacheForTests,
  __getInMemoryRepoCacheForTests,
  __rerunPreloadForTests,
  __getPreloadPromiseForTests,
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

  describe('404 (broken)', () => {
    test('renders a .sneetch-broken chip with unlink icon and "broken" text', () => {
      const elt = createErrorAnnotation({ status: 404, headers }, '');
      expect(elt.outerHTML).toMatch('class="data-sneetch-extension"');
      expect(elt.outerHTML).not.toMatch('missing'); // old class gone
      const chip = elt.querySelector('.sneetch-broken');
      expect(chip).not.toBeNull();
      expect(chip?.querySelector('svg')).not.toBeNull();
      expect(chip?.textContent).toContain('broken');
      expect(chip?.getAttribute('aria-label')).toBe('repository not found');
    });

    test('has a "Repository not found" tooltip', () => {
      const elt = createErrorAnnotation({ status: 404, headers }, '');
      expect(elt.getAttribute('title')).toBe('Repository not found');
    });
  });

  describe('403 (rate limited)', () => {
    test('renders a .sneetch-rate-limited chip with hourglass icon and "wait" text', () => {
      const elt = createErrorAnnotation({ status: 403, headers }, '');
      const chip = elt.querySelector('.sneetch-rate-limited');
      expect(chip).not.toBeNull();
      expect(chip?.querySelector('svg')).not.toBeNull();
      expect(chip?.textContent).toContain('wait');
      expect(chip?.getAttribute('aria-label')).toBe('rate limited, wait');
    });

    test('with no access token → tooltip asks user to set up a PAT', () => {
      const elt = createErrorAnnotation({ status: 403, headers }, '');
      expect(elt.getAttribute('title')).toBe('Please set up your GitHub Personal Access Token');
    });

    test('with access token and reset header → tooltip includes reset time', () => {
      const resetTs = Math.floor(Date.now() / 1000) + 3600;
      const headersWithReset = {
        get: (s: string) => (s === 'X-RateLimit-Reset' ? String(resetTs) : ''),
      };
      const elt = createErrorAnnotation(
        { status: 403, headers: headersWithReset },
        'ghp_fake_token'
      );
      const title = elt.getAttribute('title') ?? '';
      expect(title).toContain('rate limit exceeded');
      expect(title).toContain('Resets at');
      expect(title).not.toContain('undefined');
      expect(title).not.toContain('NaN');
    });

    test('with access token and NO reset header → tooltip is the bare exceeded message', () => {
      const elt = createErrorAnnotation({ status: 403, headers }, 'ghp_fake_token');
      expect(elt.getAttribute('title')).toBe('GitHub API rate limit exceeded.');
    });

    test('with NO headers field and no token → falls back to PAT prompt without crashing', () => {
      // Defensive case: fetchers throw plain {ok, status} objects without
      // a headers field. Regression test for PR #3 greptile P2.
      const elt = createErrorAnnotation({ status: 403 }, '');
      expect(elt.getAttribute('title')).toBe('Please set up your GitHub Personal Access Token');
      const chip = elt.querySelector('.sneetch-rate-limited');
      expect(chip).not.toBeNull();
    });

    test('with NO headers field and a token → tooltip mentions rate limit without reset time', () => {
      const elt = createErrorAnnotation({ status: 403 }, 'ghp_fake');
      const title = elt.getAttribute('title') ?? '';
      expect(title).toContain('rate limit');
      expect(title).not.toContain('undefined');
      expect(title).not.toContain('NaN');
    });
  });

  describe('else (unknown error)', () => {
    test('renders a .sneetch-error chip with bug icon and "error" text', () => {
      const reportError = jest.fn();
      const elt = createErrorAnnotation({ status: 500, headers }, '', reportError);
      const chip = elt.querySelector('.sneetch-error');
      expect(chip).not.toBeNull();
      expect(chip?.querySelector('svg')).not.toBeNull();
      expect(chip?.textContent).toContain('error');
      expect(chip?.getAttribute('aria-label')).toBe('error');
    });

    test('tooltip includes the HTTP status code', () => {
      const elt = createErrorAnnotation(
        { status: 500, headers },
        '',
        (..._: unknown[]) => null
      );
      expect(elt.getAttribute('title')).toBe("Couldn't fetch repository info (status 500)");
    });

    test('tooltip falls back to "unknown" when status is missing', () => {
      const elt = createErrorAnnotation({ headers }, '', (..._: unknown[]) => null);
      expect(elt.getAttribute('title')).toBe("Couldn't fetch repository info (status unknown)");
    });

    test('logs via reportError with the status code', () => {
      const reportError = jest.fn();
      createErrorAnnotation({ status: 410, headers }, '', reportError);
      expect(reportError).toHaveBeenCalledWith('sneetches: request status =', 410);
    });

    test('does not log for 404 or 403 (those are not "unknown")', () => {
      const reportError = jest.fn();
      createErrorAnnotation({ status: 404, headers }, '', reportError);
      createErrorAnnotation({ status: 403, headers }, '', reportError);
      expect(reportError).not.toHaveBeenCalled();
    });
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
  // microtask from the port fetcher's then() to flush. Debounce is 300ms.
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
    // so updateLinks sees pending.length === 0 and returns without
    // calling the port fetcher again.
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

  test('a scan with N anchors makes ONE port fetch call with N nwos', async () => {
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

describe('in-memory repo cache hooks', () => {
  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('__setInMemoryRepoCacheForTests stores a Map', () => {
    const seed = new Map<string, RepoResponse>([
      [
        'owner/repo',
        {
          ok: true,
          json: {
            forks_count: 1,
            stargazers_count: 2,
            pushed_at: '2024-01-01',
            archived: false,
          },
        },
      ],
    ]);
    __setInMemoryRepoCacheForTests(seed);
    expect(__getInMemoryRepoCacheForTests()).toBe(seed);
  });

  test('__setInMemoryRepoCacheForTests null clears the map', () => {
    __setInMemoryRepoCacheForTests(new Map());
    __setInMemoryRepoCacheForTests(null);
    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });

  test('__resetLinkScannerForTests clears the in-memory cache', () => {
    __setInMemoryRepoCacheForTests(new Map([['a/b', { ok: true } as RepoResponse]]));
    __resetLinkScannerForTests();
    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });
});

describe('scan scheduler behavior', () => {
  // Guards the 1.1.3 scheduler rework: leading-edge MutationObserver
  // trigger + cumulative max-wait + rolling debounce. Each test isolates
  // one aspect of the scheduler without relying on wall-clock timing
  // precision (which is inherently flaky in jsdom).
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
    portFetcherMock.mockImplementation(async (_nwos, _onChunk) => ({ ok: true }));
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('leading-edge MO trigger fires a scan before the debounce window elapses', async () => {
    // The scheduler rework added a leading-edge path where the MutationObserver
    // callback fires updateLinks directly (as a microtask) when a github.com
    // anchor is added to the DOM, bypassing the 300ms rolling debounce and
    // 500ms max-wait setTimeout. This test verifies the leading-edge path
    // runs BEFORE either setTimeout could have fired, by giving it less
    // than 200ms (< both debounce and max-wait) after the mutation.
    startLinkScanner();
    // Wait a tick for startLinkScanner to attach its observer.
    await new Promise((r) => setTimeout(r, 10));
    expect(portFetcherMock).not.toHaveBeenCalled();

    // Insert a real repo-link anchor. The observer should fire a
    // microtask-scheduled scan immediately from inside the MO callback.
    const a = document.createElement('a');
    a.href = 'https://github.com/octocat/hello';
    document.body.appendChild(a);

    // 150ms is well under LINK_SCAN_DEBOUNCE_MS (300ms) and
    // LINK_SCAN_MAX_WAIT_MS (500ms). If the leading-edge path is working,
    // the port fetcher should already have been called by now.
    await new Promise((r) => setTimeout(r, 150));

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(portFetcherMock).toHaveBeenCalledWith(['octocat/hello'], expect.any(Function));
  });

  test('leading-edge throttle: rapid mutations do not fire a scan per mutation', async () => {
    // LEADING_EDGE_MIN_INTERVAL_MS throttles the leading-edge path at
    // 100ms. A burst of mutations that each contain a github.com anchor
    // should fire AT MOST one leading-edge scan per 100ms window, not
    // one per mutation. Test: insert many anchors rapidly, then assert
    // we didn't fire N scans.
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 10));

    // Insert 10 anchors in rapid succession. Each appendChild triggers
    // a MutationObserver callback. Without the throttle, each MO would
    // fire a leading-edge scan → 10 port fetcher calls.
    for (let i = 0; i < 10; i++) {
      const a = document.createElement('a');
      a.href = `https://github.com/owner${i}/repo${i}`;
      document.body.appendChild(a);
    }

    // Wait a short time — less than the 100ms throttle interval plus
    // a buffer. Some observer callbacks should have fired, but throttled.
    await new Promise((r) => setTimeout(r, 50));

    // At most 1 scan should have fired during this 50ms window.
    // findUnannotatedRepoLinks catches all 10 anchors in one pass, so
    // the single leading-edge scan sees all of them at once.
    expect(portFetcherMock.mock.calls.length).toBeLessThanOrEqual(1);
    if (portFetcherMock.mock.calls.length === 1) {
      // If a scan did fire, it should have found all 10 nwos in one call.
      const [nwos] = portFetcherMock.mock.calls[0];
      expect(nwos).toHaveLength(10);
    }
  });

  test('getCachedSettings retries after a transient storage rejection', async () => {
    // Greptile P2 from the 1.1.3 review: before the try/finally fix,
    // if `chrome.storage.sync.get` rejected once (e.g. transient
    // failure during browser startup or extension update),
    // `cachedSettingsPromise` would be stuck pointing at that rejected
    // promise forever, silently disabling all annotation scans until a
    // settings change fired `invalidateCachedSettings`. This test
    // verifies the retry-on-rejection contract: a failing first call
    // leaves no stale promise lock, so the next call attempts the
    // storage read from scratch.

    // Start clean — clear any cached settings from prior tests.
    __resetLinkScannerForTests();

    // Seed storage with some real settings so the second (successful)
    // call has something to return.
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set(
        { show: { stars: true, forks: true, update: false }, star_style: 'filled' },
        resolve
      )
    );

    // Patch chrome.storage.sync.get to reject exactly once via
    // chrome.runtime.lastError (which is how getSettings detects
    // failure), then restore to real behavior for subsequent calls.
    const originalGet = chrome.storage.sync.get;
    let callCount = 0;
    chrome.storage.sync.get = ((keys: unknown, cb: (items: unknown) => void) => {
      callCount++;
      if (callCount === 1) {
        // Simulate a transient storage failure.
        (chrome.runtime as unknown as { lastError: unknown }).lastError = {
          message: 'simulated transient storage failure',
        };
        cb({});
        (chrome.runtime as unknown as { lastError: unknown }).lastError = undefined;
        return;
      }
      return (originalGet as (keys: unknown, cb: (items: unknown) => void) => void).call(
        chrome.storage.sync,
        keys,
        cb
      );
    }) as typeof chrome.storage.sync.get;

    try {
      // First call should reject — simulating the transient failure.
      await expect(__getCachedSettingsForTests()).rejects.toBeDefined();

      // Second call MUST re-attempt the storage read and succeed.
      // Before the try/finally fix, this would return the same
      // rejected promise from the first call's `cachedSettingsPromise`
      // and the test would fail with the same rejection.
      const settings = await __getCachedSettingsForTests();
      expect(settings.starStyle).toBe('filled');
      expect(settings.show.stars).toBe(true);
      expect(settings.show.forks).toBe(true);

      // And a third call should hit the in-memory cache (cachedSettings
      // is now populated), so no additional storage read.
      const before = callCount;
      await __getCachedSettingsForTests();
      expect(callCount).toBe(before);
    } finally {
      chrome.storage.sync.get = originalGet;
      __resetLinkScannerForTests();
    }
  });

  test('fireScan clears both timers so neither can fire a second redundant scan', async () => {
    // The fireScan helper is the single entry point for running a
    // productive scan. When it runs (via leading-edge, rolling debounce,
    // OR max-wait), it must clear BOTH the rolling debounce timer and
    // the max-wait timer so the next-scheduled one of them can't fire a
    // second scan a few hundred ms later. This test triggers a scan via
    // the leading-edge path, waits long enough that both setTimeouts
    // would have fired if not cleared (300ms + 500ms + buffer), and
    // asserts only ONE scan fired.
    startLinkScanner();
    await new Promise((r) => setTimeout(r, 10));

    const a = document.createElement('a');
    a.href = 'https://github.com/octocat/hello';
    document.body.appendChild(a);

    // Wait past both debounce and max-wait deadlines.
    // LINK_SCAN_DEBOUNCE_MS = 300, LINK_SCAN_MAX_WAIT_MS = 500.
    // 800ms comfortably passes both.
    await new Promise((r) => setTimeout(r, 800));

    // Exactly one scan — leading-edge ran, cleared both timers, neither
    // subsequently fired a redundant scan.
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
  });
});

describe('in-memory repo cache preload', () => {
  const freshEntry = (nwo: string, stars: number) => ({
    [nwo]: {
      exp: Date.now() + 60_000,
      ver: 2,
      pay: {
        ok: true,
        json: {
          forks_count: 0,
          stargazers_count: stars,
          pushed_at: '2024-01-01',
          archived: false,
        },
      },
    },
  });

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    __resetLinkScannerForTests();
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('preload populates inMemoryRepoCache from storage', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        { ...freshEntry('ollama/ollama', 42), ...freshEntry('vercel/next.js', 100) },
        resolve
      )
    );
    await __rerunPreloadForTests();
    const map = __getInMemoryRepoCacheForTests();
    expect(map).not.toBeNull();
    expect(map!.size).toBe(2);
    expect(map!.get('ollama/ollama')?.json?.stargazers_count).toBe(42);
    expect(map!.get('vercel/next.js')?.json?.stargazers_count).toBe(100);
  });

  test('preload skips expired entries', async () => {
    const now = Date.now();
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/fresh': { exp: now + 60_000, ver: 2, pay: { ok: true } },
          'owner/stale': { exp: now - 60_000, ver: 2, pay: { ok: true } },
        },
        resolve
      )
    );
    await __rerunPreloadForTests();
    const map = __getInMemoryRepoCacheForTests();
    expect(map!.has('owner/fresh')).toBe(true);
    expect(map!.has('owner/stale')).toBe(false);
  });

  test('preload skips entries with wrong version', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set(
        {
          'owner/v1': { exp: Date.now() + 60_000, ver: 1, pay: { ok: true } },
          'owner/v2': { exp: Date.now() + 60_000, ver: 2, pay: { ok: true } },
        },
        resolve
      )
    );
    await __rerunPreloadForTests();
    const map = __getInMemoryRepoCacheForTests();
    expect(map!.has('owner/v2')).toBe(true);
    expect(map!.has('owner/v1')).toBe(false);
  });

  test('preload results in empty Map when storage is empty', async () => {
    await __rerunPreloadForTests();
    const map = __getInMemoryRepoCacheForTests();
    expect(map).not.toBeNull();
    expect(map!.size).toBe(0);
  });
});

describe('in-memory cache fast path', () => {
  const freshResponse = (stars: number): RepoResponse => ({
    ok: true,
    json: {
      forks_count: 0,
      stargazers_count: stars,
      pushed_at: '2024-01-01',
      archived: false,
    },
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
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    document.body.innerHTML = '';
    portFetcherMock.mockReset();
    // Port-path sentinel: any uncached nwo falls through and gets 999
    // stars from the mock. Cached nwos get whatever the seeded Map
    // says, NOT 999. Mismatched values are how we tell which path
    // served each anchor.
    mockBatchRespondsWith(freshResponse(999));
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  const waitForScanner = () => new Promise((r) => setTimeout(r, 400));

  test('cached anchors are painted from memory without calling the port', async () => {
    __setInMemoryRepoCacheForTests(new Map([['ollama/ollama', freshResponse(42)]]));

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    expect(portFetcherMock).not.toHaveBeenCalled();
    const annotation = a.querySelector('.data-sneetch-extension');
    expect(annotation).not.toBeNull();
    expect(annotation?.textContent).toContain('42');
  });

  test('uncached anchors fall through to the port fetcher', async () => {
    __setInMemoryRepoCacheForTests(new Map());

    const a = document.createElement('a');
    a.href = 'https://github.com/vercel/next.js';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledWith(['vercel/next.js'], expect.any(Function));
    expect(a.querySelector('.data-sneetch-extension')?.textContent).toContain('999');
  });

  test('mixed cached + uncached: only misses go through the port', async () => {
    __setInMemoryRepoCacheForTests(new Map([['ollama/ollama', freshResponse(42)]]));

    const a1 = document.createElement('a');
    a1.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a1);

    const a2 = document.createElement('a');
    a2.href = 'https://github.com/vercel/next.js';
    document.body.appendChild(a2);

    startLinkScanner();
    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(portFetcherMock).toHaveBeenCalledWith(['vercel/next.js'], expect.any(Function));
    expect(a1.querySelector('.data-sneetch-extension')?.textContent).toContain('42');
    expect(a2.querySelector('.data-sneetch-extension')?.textContent).toContain('999');
  });

  test('null in-memory cache (preload not resolved) falls through entirely to port', async () => {
    __setInMemoryRepoCacheForTests(null);

    const a = document.createElement('a');
    a.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    expect(portFetcherMock).toHaveBeenCalledWith(['ollama/ollama'], expect.any(Function));
  });

  test('silent-skip entries in the in-memory cache populate silentSkipAnchors', async () => {
    __setInMemoryRepoCacheForTests(
      // Minimal silent-skip RepoResponse — json/status/headers not needed
      // for this path; paintResult routes on `silent: true`.
      new Map([['private/repo', { ok: false, silent: true } as RepoResponse]])
    );

    const a = document.createElement('a');
    a.href = 'https://github.com/private/repo';
    document.body.appendChild(a);

    startLinkScanner();
    await waitForScanner();

    // First scan: no port call, no annotation — paintResult's silent
    // branch adds the anchor to silentSkipAnchors and returns.
    expect(portFetcherMock).not.toHaveBeenCalled();
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();

    // Trigger a second scan by adding an unrelated node. If the anchor
    // wasn't in silentSkipAnchors, findUnannotatedRepoLinks would re-pick
    // it up (childElementCount === 0 and no inFlightAnchors entry), and
    // paintResult would fire again. We verify the WeakSet population
    // indirectly: the second scan must still not touch this anchor.
    const trigger = document.createElement('div');
    document.body.appendChild(trigger);
    await waitForScanner();

    expect(portFetcherMock).not.toHaveBeenCalled();
    expect(a.querySelector('.data-sneetch-extension')).toBeNull();
  });

  test('deduplicated nwos: cached repo shared across multiple anchors paints once from memory', async () => {
    __setInMemoryRepoCacheForTests(new Map([['ollama/ollama', freshResponse(42)]]));

    const a1 = document.createElement('a');
    a1.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a1);

    const a2 = document.createElement('a');
    a2.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(a2);

    startLinkScanner();
    await waitForScanner();

    expect(portFetcherMock).not.toHaveBeenCalled();
    expect(a1.querySelector('.data-sneetch-extension')?.textContent).toContain('42');
    expect(a2.querySelector('.data-sneetch-extension')?.textContent).toContain('42');
  });

  test('port-path transport failure does not error-annotate cached-path anchors', async () => {
    // Fast path serves one anchor from memory; the port then fails for
    // the other anchor. The cached anchor must keep its successful
    // annotation and NOT get an error chip stacked on top, because
    // paintResult already drained it from inFlightAnchors and the
    // error handler's epoch guard correctly skips it.
    __setInMemoryRepoCacheForTests(new Map([['ollama/ollama', freshResponse(42)]]));

    // Override the port mock to simulate a batch-level failure
    // (network error, 5xx, 401) — the port fetcher resolves with
    // { ok: false, status: 500 } and does NOT call the chunk callback.
    portFetcherMock.mockImplementation(async () => {
      return { ok: false, status: 500 };
    });

    const cached = document.createElement('a');
    cached.href = 'https://github.com/ollama/ollama';
    document.body.appendChild(cached);

    const uncached = document.createElement('a');
    uncached.href = 'https://github.com/vercel/next.js';
    document.body.appendChild(uncached);

    startLinkScanner();
    await waitForScanner();

    // Cached anchor: one clean fast-path annotation with "42" stars.
    // No error chip, no duplicate annotation.
    const cachedAnnotations = cached.querySelectorAll('.data-sneetch-extension');
    expect(cachedAnnotations).toHaveLength(1);
    expect(cachedAnnotations[0].textContent).toContain('42');

    // Uncached anchor: exactly one error annotation from the batch-level
    // failure handler. Default error for status 500 is an empty-text
    // annotation per createErrorAnnotation's else branch.
    const uncachedAnnotations = uncached.querySelectorAll('.data-sneetch-extension');
    expect(uncachedAnnotations).toHaveLength(1);

    // Port was called with ONLY the uncached nwo (dedup + split working).
    expect(portFetcherMock).toHaveBeenCalledTimes(1);
    expect(portFetcherMock).toHaveBeenCalledWith(['vercel/next.js'], expect.any(Function));
  });
});

describe('in-memory cache invalidation on settings change', () => {
  const freshResponse = (): RepoResponse => ({
    ok: true,
    json: {
      forks_count: 0,
      stargazers_count: 1,
      pushed_at: '2024-01-01',
      archived: false,
    },
  });

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    __resetLinkScannerForTests();
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('access-token change clears inMemoryRepoCache', () => {
    __setInMemoryRepoCacheForTests(new Map([['a/b', freshResponse()]]));
    __handleSyncStorageChangeForTests({
      access_token: { oldValue: 'old', newValue: 'new' },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });

  test('show-setting change does NOT clear inMemoryRepoCache', () => {
    const seeded = new Map([['a/b', freshResponse()]]);
    __setInMemoryRepoCacheForTests(seeded);
    __handleSyncStorageChangeForTests({
      show: {
        oldValue: { stars: true, forks: false, update: false },
        newValue: { stars: true, forks: true, update: false },
      },
    });
    // Repo data is still valid — only rendering changed. Map is
    // unchanged; applySettingsChange's rescan reads the same Map and
    // re-paints with the new toggles.
    expect(__getInMemoryRepoCacheForTests()).toBe(seeded);
  });

  test('star_style change does NOT clear inMemoryRepoCache', () => {
    const seeded = new Map([['a/b', freshResponse()]]);
    __setInMemoryRepoCacheForTests(seeded);
    __handleSyncStorageChangeForTests({
      star_style: { oldValue: 'outline', newValue: 'filled' },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(seeded);
  });

  test('in-flight preload from before token change does not stomp invalidated cache', async () => {
    // Seed chrome.storage.local with stale token-era data that the
    // in-flight preload will read.
    const staleData = {
      exp: Date.now() + 60_000,
      ver: 2,
      pay: {
        ok: true,
        json: {
          forks_count: 0,
          stargazers_count: 999,
          pushed_at: '2024-01-01',
          archived: false,
        },
      },
    };
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ 'stale/repo': staleData }, resolve)
    );

    // Kick off a preload — this is the "in-flight" preload that will
    // read the stale data.
    const inflightPreload = __rerunPreloadForTests();

    // Simulate a token-change event firing BEFORE the in-flight preload
    // resolves. handleSyncStorageChange clears storage, nulls the
    // in-memory cache, and (with the fix) invalidates the in-flight
    // preload's generation so its pending assignment becomes a no-op.
    __handleSyncStorageChangeForTests({
      access_token: { oldValue: 'old-token', newValue: 'new-token' },
    });

    // Now drain the in-flight preload. Without the generation guard,
    // this would stomp inMemoryRepoCache back to { 'stale/repo': ... }.
    // With the guard, the assignment is skipped and inMemoryRepoCache
    // stays null.
    await inflightPreload;

    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });
});

describe('in-memory cache invalidation on local storage clear', () => {
  const freshResponse = (): RepoResponse => ({
    ok: true,
    json: {
      forks_count: 0,
      stargazers_count: 1,
      pushed_at: '2024-01-01',
      archived: false,
    },
  });

  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    __resetLinkScannerForTests();
  });

  afterEach(() => {
    __resetLinkScannerForTests();
  });

  test('removal of a repo-cache entry clears inMemoryRepoCache', () => {
    __setInMemoryRepoCacheForTests(new Map([['a/b', freshResponse()]]));
    __handleLocalStorageChangeForTests({
      'a/b': { oldValue: { exp: 123, pay: {}, ver: 2 }, newValue: undefined },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });

  test('full cache clear (multiple removals) clears inMemoryRepoCache', () => {
    __setInMemoryRepoCacheForTests(
      new Map([
        ['a/b', freshResponse()],
        ['c/d', freshResponse()],
      ])
    );
    __handleLocalStorageChangeForTests({
      'a/b': { oldValue: { exp: 123, pay: {}, ver: 2 }, newValue: undefined },
      'c/d': { oldValue: { exp: 123, pay: {}, ver: 2 }, newValue: undefined },
      rate_limit: { oldValue: { limit: 5000, remaining: 4999 }, newValue: undefined },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(null);
  });

  test('fresh cache write (SW bulkWriteCache) does NOT clear inMemoryRepoCache', () => {
    // A fresh write has both oldValue and newValue set (or only
    // newValue for a brand-new key). The SW's bulkWriteCache path
    // fires this shape on every scan — it must NOT invalidate the
    // in-memory mirror, otherwise every scan would wipe the cache
    // we're trying to use.
    const seeded = new Map([['a/b', freshResponse()]]);
    __setInMemoryRepoCacheForTests(seeded);
    __handleLocalStorageChangeForTests({
      'new/repo': { newValue: { exp: 123, pay: {}, ver: 2 } },
      'existing/repo': {
        oldValue: { exp: 100, pay: {}, ver: 2 },
        newValue: { exp: 456, pay: {}, ver: 2 },
      },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(seeded);
  });

  test('rate_limit removal alone does NOT clear inMemoryRepoCache', () => {
    // rate_limit is not a cache key (no slash). If it's the only key
    // in a change batch, do not invalidate — rate_limit removals
    // don't represent a cache clear semantics.
    const seeded = new Map([['a/b', freshResponse()]]);
    __setInMemoryRepoCacheForTests(seeded);
    __handleLocalStorageChangeForTests({
      rate_limit: { oldValue: { limit: 5000, remaining: 4999 }, newValue: undefined },
    });
    expect(__getInMemoryRepoCacheForTests()).toBe(seeded);
  });
});
