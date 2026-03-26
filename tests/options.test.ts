import { inputElement } from '../src/options';

describe('restoreOptions', () => {
  beforeEach(() => {
    chrome.storage.sync.clear();
    chrome.storage.local.clear();

    document.body.innerHTML = `<div>
      <input id='show-stars' type="checkbox">
      <input id='show-forks' type="checkbox">
      <input id='show-update' type="checkbox">
      <input id='access-token' type="text">
    </div>`;
  });

  test('initial', () => {
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    expect(inputElement('access-token').value).toBe('');
    expect(inputElement('show-forks').checked).toBe(false);
    expect(inputElement('show-stars').checked).toBe(true);
    expect(inputElement('show-update').checked).toBe(false);
  });

  test('from storage', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        {
          access_token: '<<access token>>',
          show: { forks: true, stars: false, update: true },
        },
        () => resolve()
      );
    });

    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    expect(inputElement('access-token').value).toBe('<<access token>>');
    expect(inputElement('show-forks').checked).toBe(true);
    expect(inputElement('show-stars').checked).toBe(false);
    expect(inputElement('show-update').checked).toBe(true);
  });
});
