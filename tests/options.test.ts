import { inputElement } from '../src/options';

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
});
