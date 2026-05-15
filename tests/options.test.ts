import { inputElement } from '../src/options';
import { validateAccessToken, getStoredRateLimit } from '../src/github';
jest.mock('../src/github', () => ({
  validateAccessToken: jest.fn(),
  getStoredRateLimit: jest.fn(),
}));

import {
  getCacheEntryCount,
  clearCache,
  clearOwnerCache,
  sweepCache,
  sweepContribCache,
} from '../src/cache';
jest.mock('../src/cache', () => ({
  getCacheEntryCount: jest.fn(),
  clearCache: jest.fn(),
  clearOwnerCache: jest.fn(),
  sweepCache: jest.fn(),
  sweepContribCache: jest.fn(),
}));

describe('restoreOptions', () => {
  beforeEach(() => {
    chrome.storage.sync.clear();
    chrome.storage.local.clear();
    document.body.className = '';

    // Reset call history and provide safe defaults so existing tests don't break
    // when refreshAdvancedStats is triggered (e.g. advanced_open: true or toggle click).
    (getStoredRateLimit as jest.Mock).mockReset();
    (getCacheEntryCount as jest.Mock).mockReset();
    (clearCache as jest.Mock).mockReset();
    (clearOwnerCache as jest.Mock).mockReset();
    (sweepCache as jest.Mock).mockReset();
    (sweepContribCache as jest.Mock).mockReset();
    (validateAccessToken as jest.Mock).mockReset();
    (getStoredRateLimit as jest.Mock).mockResolvedValue(null);
    (getCacheEntryCount as jest.Mock).mockResolvedValue(0);
    (clearCache as jest.Mock).mockResolvedValue(undefined);
    (clearOwnerCache as jest.Mock).mockResolvedValue(undefined);
    (sweepCache as jest.Mock).mockResolvedValue(undefined);
    (sweepContribCache as jest.Mock).mockResolvedValue(undefined);

    document.body.innerHTML = `
      <div>
        <input id="show-stars" type="checkbox">
        <input id="show-forks" type="checkbox">
        <input id="show-update" type="checkbox">
        <input id="show-contributors" type="checkbox">
        <div id="token-section-title">GitHub Access Token</div>
        <div id="token-collapsed" hidden>
          <span id="token-collapsed-token"></span>
          <span class="token-collapsed-group">
            <span class="token-collapsed-reveal" aria-hidden="true">GitHub token valid</span>
            <svg class="token-collapsed-check" role="img"><title>GitHub token valid</title></svg>
          </span>
          <button id="token-edit">edit</button>
        </div>
        <div id="token-expanded">
          <input id="access-token" type="password">
          <button id="token-eye"></button>
          <button id="token-test">Test</button>
        </div>
        <p id="token-help"></p>
        <span id="saved-indicator" hidden></span>
        <a class="star-cta" href="#">
          <span class="star-cta-text star-cta-text--unstarred">Star us?</span>
          <span class="star-cta-text star-cta-text--starred">Thanks!</span>
          <svg class="star-cta-icon"></svg>
        </a>
        <div class="advanced" id="advanced-section">
          <button id="advanced-toggle" aria-expanded="false"></button>
          <div id="advanced-content" hidden>
            <input id="ss-outline" type="radio" name="star-style">
            <input id="ss-fill" type="radio" name="star-style">
            <span id="rate-limit-value"></span>
            <div id="rate-limit-bar-fill"></div>
            <span id="cache-count"></span>
            <button id="clear-cache"></button>
            <span id="skip-owners-count"></span>
            <button id="skip-owners-toggle" aria-expanded="false"></button>
            <div id="skip-owners-panel" hidden>
              <div id="skip-owners-list"></div>
              <input id="skip-owner-input" type="text">
              <button id="skip-owner-add"></button>
            </div>
          </div>
        </div>
        <svg class="star-preview-outline"></svg>
        <svg class="star-preview-filled"></svg>
        <span id="version"></span>
      </div>`;
  });

  test('initial', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    expect(inputElement('access-token').value).toBe('');
    expect(inputElement('show-forks').checked).toBe(false);
    expect(inputElement('show-stars').checked).toBe(true);
    expect(inputElement('show-update').checked).toBe(false);
    expect(inputElement('ss-outline').checked).toBe(true);
    expect(inputElement('ss-fill').checked).toBe(false);
    expect(document.getElementById('advanced-content')?.hasAttribute('hidden')).toBe(true);
  });

  test('from storage', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        {
          access_token: '<<access token>>',
          show: { forks: true, stars: false, update: true },
          star_style: 'filled',
          advanced_open: true,
        },
        () => resolve()
      );
    });

    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    expect(inputElement('access-token').value).toBe('<<access token>>');
    expect(inputElement('show-forks').checked).toBe(true);
    expect(inputElement('show-stars').checked).toBe(false);
    expect(inputElement('show-update').checked).toBe(true);
    expect(inputElement('ss-outline').checked).toBe(false);
    expect(inputElement('ss-fill').checked).toBe(true);
    expect(document.getElementById('advanced-content')?.hasAttribute('hidden')).toBe(false);
    expect(document.body.classList.contains('star-style--filled')).toBe(true);
  });

  test('eye toggle switches input type between password and text', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    const input = inputElement('access-token');
    expect(input.type).toBe('password');

    document.getElementById('token-eye')!.click();
    expect(input.type).toBe('text');

    document.getElementById('token-eye')!.click();
    expect(input.type).toBe('password');
  });

  test('saved indicator appears after a change', () => {
    jest.useFakeTimers();
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    const indicator = document.getElementById('saved-indicator')!;
    expect(indicator.hasAttribute('hidden')).toBe(true);

    inputElement('show-forks').checked = true;
    inputElement('show-forks').dispatchEvent(new Event('change', { bubbles: true }));

    // Hidden attribute should be removed immediately
    expect(indicator.hasAttribute('hidden')).toBe(false);

    // And re-hidden after 1.5 seconds
    jest.advanceTimersByTime(2000);
    expect(indicator.hasAttribute('hidden')).toBe(true);

    jest.useRealTimers();
  });

  test('test button shows Valid when token is valid', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ valid: true });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('access-token').value = 'good-token';
    document.getElementById('token-test')!.click();
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks

    const btn = document.getElementById('token-test')!;
    expect(btn.textContent).toMatch(/Valid/);
    expect(btn.classList.contains('btn--ok')).toBe(true);
  });

  test('test button shows Invalid when token is invalid', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ valid: false, status: 401 });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('access-token').value = 'bad';
    document.getElementById('token-test')!.click();
    await new Promise((r) => setTimeout(r, 0));

    const btn = document.getElementById('token-test')!;
    expect(btn.textContent).toMatch(/Invalid/);
    expect(btn.classList.contains('btn--err')).toBe(true);
  });

  test('collapsed view renders on load when token is present and validated', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_valid', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('token-collapsed')?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('token-expanded')?.hasAttribute('hidden')).toBe(true);
    // The section title is hidden in the collapsed state so the compact
    // status row actually reclaims vertical space.
    expect(document.getElementById('token-section-title')?.hasAttribute('hidden')).toBe(true);
  });

  test('collapsed view renders dimmed dots + last-4 of the stored token', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        { access_token: 'ghp_FAKE_TOKEN_xyz_abcd', token_validated: true },
        () => resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const tokenEl = document.getElementById('token-collapsed-token');
    const spans = tokenEl?.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans![0].textContent).toBe('••••••••');
    expect(spans![0].classList.contains('mute')).toBe(true);
    expect(spans![1].textContent).toBe('abcd');
  });

  test('collapsed view exposes the status to screen readers via the SVG title', () => {
    // The reveal span is aria-hidden; the ✓ SVG is the only a11y surface
    // for "GitHub token valid". A future refactor that drops the inner
    // <title> would silently break SR users — hence this lock-in.
    const svg = document.querySelector('.token-collapsed-check');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.querySelector('title')?.textContent).toBe('GitHub token valid');
  });

  test('collapsed view treats fine-grained tokens identically (no prefix shown)', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        { access_token: 'github_pat_FAKE_TOKEN_wxyz', token_validated: true },
        () => resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const spans = document.getElementById('token-collapsed-token')?.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans![0].textContent).toBe('••••••••');
    expect(spans![1].textContent).toBe('wxyz');
  });

  test('edit button re-expands the token view', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_valid', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    document.getElementById('token-edit')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('token-collapsed')?.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('token-expanded')?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('token-section-title')?.hasAttribute('hidden')).toBe(false);
    // Help text should become visible — consistent with every other path
    // that opens the expanded view (pre-validation, post-fail, edit-click).
    expect(document.getElementById('token-help')?.hasAttribute('hidden')).toBe(false);

    // Edit is an explicit intent to change — the Test button's visual state
    // and token_validated in storage must both reset so the button/storage
    // invariant (see wireTokenEdit comment) holds across a close+reopen.
    const testBtn = document.getElementById('token-test')!;
    expect(testBtn.textContent).toBe('Test');
    expect(testBtn.classList.contains('btn--primary')).toBe(true);

    const items = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['token_validated'], (v) => resolve(v))
    );
    expect(items.token_validated).toBe(false);
  });

  test('successful Test from expanded view re-collapses', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ valid: true });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('access-token').value = 'ghp_valid';
    document.getElementById('token-test')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('token-collapsed')?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('token-expanded')?.hasAttribute('hidden')).toBe(true);
  });

  test('selecting filled star style adds star-style--filled class to body', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('ss-fill').checked = true;
    inputElement('ss-fill').dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.body.classList.contains('star-style--filled')).toBe(true);
  });

  test('selecting outline removes star-style--filled class', () => {
    document.body.classList.add('star-style--filled');
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('ss-outline').checked = true;
    inputElement('ss-outline').dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.body.classList.contains('star-style--filled')).toBe(false);
  });

  test('clicking advanced toggle reveals content and persists state', async () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    const toggle = document.getElementById('advanced-toggle')!;
    const content = document.getElementById('advanced-content')!;
    expect(content.hasAttribute('hidden')).toBe(true);

    toggle.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(content.hasAttribute('hidden')).toBe(false);

    // The change should be persisted in chrome.storage.sync
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['advanced_open'], (items) => resolve(items))
    );
    expect(stored.advanced_open).toBe(true);
  });

  test('reopening popup with stored advanced_open=true starts expanded', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const content = document.getElementById('advanced-content')!;
    expect(content.hasAttribute('hidden')).toBe(false);
  });

  test('clicking advanced toggle when open closes the tray and persists state', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const toggle = document.getElementById('advanced-toggle')!;
    const content = document.getElementById('advanced-content')!;
    expect(content.hasAttribute('hidden')).toBe(false);

    toggle.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(content.hasAttribute('hidden')).toBe(true);

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['advanced_open'], (items) => resolve(items))
    );
    expect(stored.advanced_open).toBe(false);
  });

  test('advanced stats render rate limit and cache count', async () => {
    (getStoredRateLimit as jest.Mock).mockResolvedValue({ limit: 5000, remaining: 4873 });
    (getCacheEntryCount as jest.Mock).mockResolvedValue(142);

    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0)); // double flush — two awaits inside refreshAdvancedStats

    expect(document.getElementById('rate-limit-value')!.textContent).toMatch(
      /4,873 \/ 5,000 per hour/
    );
    expect(document.getElementById('cache-count')!.textContent).toMatch(/142 entries/);

    const fill = document.getElementById('rate-limit-bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('97.46%'); // 4873/5000
  });

  test('advanced stats show dashes when no rate-limit data available', async () => {
    (getStoredRateLimit as jest.Mock).mockResolvedValue(null);
    (getCacheEntryCount as jest.Mock).mockResolvedValue(0);

    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('rate-limit-value')!.textContent).toMatch(/—/);
    expect(document.getElementById('cache-count')!.textContent).toMatch(/0 entries/);
  });

  test('rate limit bar handles limit=0 without producing NaN% width', async () => {
    // Defensive: if storage is corrupted or a future API quirk returns
    // limit=0, we should fall back to 0% rather than writing "NaN%" (which
    // the browser silently drops, leaving the bar at its previous width).
    (getStoredRateLimit as jest.Mock).mockResolvedValue({ limit: 0, remaining: 0 });
    (getCacheEntryCount as jest.Mock).mockResolvedValue(0);

    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const fill = document.getElementById('rate-limit-bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('0.00%');
    expect(fill.style.width).not.toMatch(/NaN/);
  });

  test('opening advanced tray refreshes stats', async () => {
    (getStoredRateLimit as jest.Mock).mockResolvedValue({ limit: 5000, remaining: 4500 });
    (getCacheEntryCount as jest.Mock).mockResolvedValue(50);

    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    // Initially closed → no refresh, mock not called yet
    expect(getStoredRateLimit).not.toHaveBeenCalled();

    document.getElementById('advanced-toggle')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0)); // double flush

    expect(getStoredRateLimit).toHaveBeenCalled();
    expect(getCacheEntryCount).toHaveBeenCalled();
    expect(document.getElementById('cache-count')!.textContent).toMatch(/50 entries/);
  });

  test('clear cache button calls clearCache and updates count to 0', async () => {
    (getCacheEntryCount as jest.Mock)
      .mockResolvedValueOnce(142) // initial render shows 142
      .mockResolvedValueOnce(0); // after clear, shows 0
    (clearCache as jest.Mock).mockResolvedValue(undefined);
    (getStoredRateLimit as jest.Mock).mockResolvedValue(null);

    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ advanced_open: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify initial render shows 142
    expect(document.getElementById('cache-count')!.textContent).toMatch(/142 entries/);

    document.getElementById('clear-cache')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0)); // triple flush — clearCache + refreshAdvancedStats both have awaits

    expect(clearCache).toHaveBeenCalled();
    expect(document.getElementById('cache-count')!.textContent).toMatch(/0 entries/);
  });

  test('clear cache click handler swallows errors from clearCache', async () => {
    // clearCache talks to chrome.storage.local, which can reject with
    // storage quota or IO errors. The click handler must catch and log
    // rather than leaving an unhandled promise rejection on the page.
    (clearCache as jest.Mock).mockRejectedValue(new Error('storage quota exceeded'));
    (getCacheEntryCount as jest.Mock).mockResolvedValue(100);
    (getStoredRateLimit as jest.Mock).mockResolvedValue(null);

    // Capture unhandled rejections so we can assert none escaped. Node's
    // process emits 'unhandledRejection' when a promise rejection is not
    // handled within a microtask. jest runs node, so this works.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    // Silence the console.error so the test output doesn't look alarming.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await new Promise<void>((resolve) =>
        chrome.storage.sync.set({ advanced_open: true }, () => resolve())
      );
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      document.getElementById('clear-cache')!.click();
      // Give the microtask queue plenty of ticks to settle any rejection.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 5));

      expect(clearCache).toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
      // And the error should have been logged via console.error so debugging
      // is possible.
      expect(errorSpy).toHaveBeenCalledWith('sneetches: clear cache failed', expect.any(Error));
    } finally {
      process.off('unhandledRejection', handler);
      errorSpy.mockRestore();
    }
  });

  test('renders version from manifest', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    const versionEl = document.getElementById('version')!;
    // Either "Sneetches v<something>" or just "Sneetches" depending on whether
    // the mock exposes getManifest. Both are acceptable — the test just verifies
    // textContent is non-empty and starts with "Sneetches".
    expect(versionEl.textContent).toMatch(/^Sneetches/);
  });

  test('star CTA has starred class on load when has_starred is true', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ has_starred: true }, () => resolve());
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const cta = document.querySelector('.star-cta')!;
    expect(cta.classList.contains('starred')).toBe(true);
  });

  test('star CTA has no starred class on load when has_starred is false', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    const cta = document.querySelector('.star-cta')!;
    expect(cta.classList.contains('starred')).toBe(false);
  });

  test('unstarred star CTA click does not preventDefault (lets link navigate)', async () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const cta = document.querySelector('.star-cta') as HTMLAnchorElement;
    expect(cta.classList.contains('starred')).toBe(false);

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    cta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  test('starred CTA click preventDefaults and adds spinning class to icon', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ has_starred: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const cta = document.querySelector('.star-cta') as HTMLAnchorElement;
    expect(cta.classList.contains('starred')).toBe(true);

    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    cta.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    const icon = cta.querySelector('.star-cta-icon')!;
    expect(icon.classList.contains('spinning')).toBe(true);
  });

  test('seven starred clicks flip toolbar_icon from gray to colorful', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ has_starred: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const cta = document.querySelector('.star-cta') as HTMLAnchorElement;
    for (let i = 0; i < 7; i++) {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    // The final click reads storage asynchronously then writes; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['toolbar_icon'], (items) => resolve(items))
    );
    expect(stored.toolbar_icon).toBe('colorful');
  });

  test('fourteen starred clicks flip toolbar_icon back to gray', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ has_starred: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const cta = document.querySelector('.star-cta') as HTMLAnchorElement;
    // First combo → colorful
    for (let i = 0; i < 7; i++) {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Second combo → back to gray
    for (let i = 0; i < 7; i++) {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['toolbar_icon'], (items) => resolve(items))
    );
    expect(stored.toolbar_icon).toBe('gray');
  });

  test('starred click combo resets after the timeout window', async () => {
    jest.useFakeTimers();
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ has_starred: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    // Flush the storage.get microtask that drives restoreOptions, even under fake timers.
    await Promise.resolve();
    await Promise.resolve();

    const cta = document.querySelector('.star-cta') as HTMLAnchorElement;
    // 6 clicks — not enough to trigger the combo
    for (let i = 0; i < 6; i++) {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    // Advance past reset window
    jest.advanceTimersByTime(3000);
    // Now only 1 more click — counter was reset, so this should NOT trigger
    cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['toolbar_icon'], (items) => resolve(items))
    );
    expect(stored.toolbar_icon).toBeUndefined(); // never flipped
  });

  test('body gets is-popup class in popup context (window.top === window)', () => {
    // jsdom defaults to window.top === window, matching a top-level popup frame.
    // The options page, rendered inside an about:addons/chrome://extensions iframe,
    // would have window.top !== window and therefore skip this class.
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    expect(document.body.classList.contains('is-popup')).toBe(true);
  });

  test('token help is hidden on load when token_validated is true', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_existing', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const help = document.getElementById('token-help')!;
    expect(help.hasAttribute('hidden')).toBe(true);
  });

  test('token help is visible on load when no token is stored', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    const help = document.getElementById('token-help')!;
    expect(help.hasAttribute('hidden')).toBe(false);
  });

  test('token help stays visible on load when token is stored but not validated', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_untested' }, () => resolve());
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const help = document.getElementById('token-help')!;
    expect(help.hasAttribute('hidden')).toBe(false); // token set but token_validated=false
  });

  test('token help reappears when user edits the token field', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_existing', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const help = document.getElementById('token-help')!;
    expect(help.hasAttribute('hidden')).toBe(true);

    // User edits the field — triggers input event — help should reappear
    const input = inputElement('access-token');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(help.hasAttribute('hidden')).toBe(false);
  });

  test('Test button starts as Valid when token_validated=true on load', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_existing', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const btn = document.getElementById('token-test')!;
    expect(btn.textContent).toMatch(/Valid/);
    expect(btn.classList.contains('btn--ok')).toBe(true);
  });

  test('successful Test click persists token_validated=true', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ valid: true });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('access-token').value = 'ghp_new';
    document.getElementById('token-test')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['token_validated'], (items) => resolve(items))
    );
    expect(stored.token_validated).toBe(true);
  });

  test('failed Test click persists token_validated=false', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue({ valid: false, status: 401 });
    // Pre-set to true so we can observe it flip to false
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ token_validated: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    inputElement('access-token').value = 'ghp_bad';
    document.getElementById('token-test')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['token_validated'], (items) => resolve(items))
    );
    expect(stored.token_validated).toBe(false);
  });

  test('editing token field persists token_validated=false', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ token_validated: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    const input = inputElement('access-token');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['token_validated'], (items) => resolve(items))
    );
    expect(stored.token_validated).toBe(false);
  });

  test('Test button ignores concurrent clicks while a validation is in flight', async () => {
    // Three rapid clicks while validateAccessToken is still pending should
    // only fire one real validation call. Before the guard, each click
    // would launch a parallel validateAccessToken call, wasting API quota
    // and creating a race between parallel storage writes.
    let resolveValidate: (v: { valid: boolean; status?: number }) => void = () => {};
    (validateAccessToken as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveValidate = resolve;
        })
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

    inputElement('access-token').value = 'ghp_test';
    const btn = document.getElementById('token-test') as HTMLButtonElement;
    btn.click();
    btn.click();
    btn.click();

    // Let any scheduled microtasks resolve — but the validation promise
    // is still pending because we haven't called resolveValidate yet.
    await new Promise((r) => setTimeout(r, 0));

    expect(validateAccessToken).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);

    // Let the validation resolve and confirm the button re-enables + lands
    // in the Valid state.
    resolveValidate({ valid: true });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/Valid/);
  });

  test('typing the token does not spam token_validated writes on every keystroke', async () => {
    // chrome.storage.sync has a ~120 writes/minute rate limit. Before this
    // fix, every `input` event on the token field wrote `token_validated:
    // false` to sync storage, so typing a 50-char PAT would send 50
    // redundant writes in ~10 seconds.
    //
    // The fix: on input, only write when the button is transitioning from
    // a non-idle state (Valid / Invalid / Testing…) into the idle Test
    // state. If the button is already idle, the input is a no-op for
    // storage.
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ token_validated: true }, () => resolve())
    );
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    // Spy and reset the storage.set call history AFTER restoreOptions has
    // populated fields, so we only count writes from the typing sequence.
    const setSpy = jest.spyOn(chrome.storage.sync, 'set');
    setSpy.mockClear();

    const input = inputElement('access-token');
    for (let i = 1; i <= 10; i++) {
      input.value = 'x'.repeat(i);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 0));

    // Count the calls that wrote token_validated. The first input transitions
    // the button from '✓ Valid' to idle and writes false. The remaining nine
    // inputs find the button already idle and skip.
    const tokenValidatedWrites = setSpy.mock.calls.filter(
      ([arg]) =>
        typeof arg === 'object' &&
        arg !== null &&
        Object.prototype.hasOwnProperty.call(arg, 'token_validated')
    );
    expect(tokenValidatedWrites).toHaveLength(1);

    setSpy.mockRestore();
  });

  describe('show-contributors persistence', () => {
    test('restoreOptions reflects a stored contributors flag', async () => {
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ show: { stars: true, contributors: true } }, () => resolve());
      });
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(inputElement('show-contributors').checked).toBe(true);
    });

    test('restoreOptions leaves contributors unchecked when not stored', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(inputElement('show-contributors').checked).toBe(false);
    });

    test('saveOptions writes the contributors flag on toggle', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      inputElement('show-contributors').checked = true;
      // addInputEventListeners wires `change` → saveOptions on every input.
      inputElement('show-contributors').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      const stored = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.sync.get(['show'], (items) => resolve(items))
      );
      expect((stored.show as { contributors?: boolean }).contributors).toBe(true);
    });
  });

  describe('skip owners', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));

    test('renders stored owners on load', async () => {
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ skip_owners: ['acme-corp', 'legacy-co'] }, () => resolve());
      });
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      expect(document.getElementById('skip-owners-count')?.textContent).toBe('2 owners');
      const rows = document.querySelectorAll('#skip-owners-list .skip-list-row');
      expect(rows.length).toBe(2);
      expect(rows[0].textContent).toContain('acme-corp');
      expect(rows[1].textContent).toContain('legacy-co');
    });

    test('add persists a lowercased, sorted entry to sync storage', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      const input = inputElement('skip-owner-input');
      input.value = 'ACME-Corp';
      document.getElementById('skip-owner-add')!.click();
      await flush();
      const stored = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.sync.get(['skip_owners'], (items) => resolve(items))
      );
      expect(stored.skip_owners).toEqual(['acme-corp']);
      expect(input.value).toBe('');
    });

    test('add rejects an invalid handle and marks the input invalid', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      const input = inputElement('skip-owner-input');
      input.value = '-leading-dash';
      document.getElementById('skip-owner-add')!.click();
      await flush();
      expect(input.classList.contains('is-invalid')).toBe(true);
      const stored = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.sync.get(['skip_owners'], (items) => resolve(items))
      );
      expect(stored.skip_owners).toBeUndefined();
    });

    test('remove pulls entry from storage and calls clearOwnerCache', async () => {
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ skip_owners: ['acme-corp', 'legacy-co'] }, () => resolve());
      });
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      const firstRemove = document.querySelector(
        '#skip-owners-list .skip-list-row button'
      ) as HTMLButtonElement;
      firstRemove.click();
      await flush();
      const stored = await new Promise<Record<string, unknown>>((resolve) =>
        chrome.storage.sync.get(['skip_owners'], (items) => resolve(items))
      );
      expect(stored.skip_owners).toEqual(['legacy-co']);
      expect(clearOwnerCache).toHaveBeenCalledWith('acme-corp');
    });

    test('toggle opens and closes the panel', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      const toggle = document.getElementById('skip-owners-toggle') as HTMLButtonElement;
      const panel = document.getElementById('skip-owners-panel');
      expect(panel?.hasAttribute('hidden')).toBe(true);
      toggle.click();
      expect(panel?.hasAttribute('hidden')).toBe(false);
      expect(toggle.textContent).toBe('Hide');
      toggle.click();
      expect(panel?.hasAttribute('hidden')).toBe(true);
      expect(toggle.textContent).toBe('Manage');
    });

    test('re-renders list on storage onChanged', async () => {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
      await flush();
      expect(document.getElementById('skip-owners-count')?.textContent).toBe('0 owners');
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ skip_owners: ['acme-corp'] }, () => resolve());
      });
      await flush();
      expect(document.getElementById('skip-owners-count')?.textContent).toBe('1 owner');
      expect(document.querySelectorAll('#skip-owners-list .skip-list-row').length).toBe(1);
    });
  });
});
