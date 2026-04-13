import { inputElement } from '../src/options';
import { validateAccessToken, getStoredRateLimit, checkStarredStatus } from '../src/github';
jest.mock('../src/github', () => ({
  validateAccessToken: jest.fn(),
  getStoredRateLimit: jest.fn(),
  checkStarredStatus: jest.fn(),
}));

import { getCacheEntryCount, clearCache } from '../src/cache';
jest.mock('../src/cache', () => ({
  getCacheEntryCount: jest.fn(),
  clearCache: jest.fn(),
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
    (checkStarredStatus as jest.Mock).mockReset();
    (getStoredRateLimit as jest.Mock).mockResolvedValue(null);
    (getCacheEntryCount as jest.Mock).mockResolvedValue(0);
    (clearCache as jest.Mock).mockResolvedValue(undefined);
    (checkStarredStatus as jest.Mock).mockResolvedValue(null); // default: unknown

    document.body.innerHTML = `
      <div>
        <input id="show-stars" type="checkbox">
        <input id="show-forks" type="checkbox">
        <input id="show-update" type="checkbox">
        <input id="access-token" type="password">
        <button id="token-eye"></button>
        <button id="token-test">Test</button>
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

  test('background check updates has_starred and applies starred class when user has starred', async () => {
    (checkStarredStatus as jest.Mock).mockResolvedValue(true);
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_existing', token_validated: true }, () =>
        resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    // Let restoreOptions + async background check settle
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(checkStarredStatus).toHaveBeenCalledWith('ghp_existing');
    const cta = document.querySelector('.star-cta')!;
    expect(cta.classList.contains('starred')).toBe(true);

    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(['has_starred'], (items) => resolve(items))
    );
    expect(stored.has_starred).toBe(true);
  });

  test('background check updates has_starred to false when user has unstarred', async () => {
    (checkStarredStatus as jest.Mock).mockResolvedValue(false);
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        { access_token: 'ghp_existing', token_validated: true, has_starred: true },
        () => resolve()
      );
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(checkStarredStatus).toHaveBeenCalled();
    const cta = document.querySelector('.star-cta')!;
    expect(cta.classList.contains('starred')).toBe(false);
  });

  test('background check is skipped when no token is present', async () => {
    (checkStarredStatus as jest.Mock).mockResolvedValue(true);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(checkStarredStatus).not.toHaveBeenCalled();
  });

  test('null result from background check does not touch current state', async () => {
    (checkStarredStatus as jest.Mock).mockResolvedValue(null);
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: 'ghp_existing', has_starred: true }, () => resolve());
    });
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Started starred, null result, should still be starred
    const cta = document.querySelector('.star-cta')!;
    expect(cta.classList.contains('starred')).toBe(true);
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
});
