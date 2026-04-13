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
