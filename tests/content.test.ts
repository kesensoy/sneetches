import {
  createAnnotation,
  createErrorAnnotation,
  detectStarredStateOnSneetchesRepo,
} from '../src/content';

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
});
