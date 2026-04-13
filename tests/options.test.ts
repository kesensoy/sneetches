import { inputElement } from '../src/options';
import { validateAccessToken } from '../src/github';
jest.mock('../src/github', () => ({
  validateAccessToken: jest.fn(),
}));

describe('restoreOptions', () => {
  beforeEach(() => {
    chrome.storage.sync.clear();
    chrome.storage.local.clear();
    document.body.className = '';

    document.body.innerHTML = `
      <div>
        <input id="show-stars" type="checkbox">
        <input id="show-forks" type="checkbox">
        <input id="show-update" type="checkbox">
        <input id="access-token" type="password">
        <button id="token-eye"></button>
        <button id="token-test">Test</button>
        <span id="saved-indicator" hidden></span>
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
});
