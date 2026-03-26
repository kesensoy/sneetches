import { getSettings } from '../src/settings';

describe('settingsP', () => {
  beforeEach(() => {
    chrome.storage.sync.clear();
    chrome.storage.local.clear();
  });

  test('uses defaults', async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      accessToken: undefined,
      show: { stars: true, forks: false, update: false },
    });
  });

  test('honors storage settings', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set(
        {
          access_token: '<<token value>>',
          enabled: false,
          show: { stars: false, forks: true, update: false },
        },
        () => resolve()
      );
    });

    const settings = await getSettings();
    expect(settings).toEqual({
      accessToken: '<<token value>>',
      show: { stars: false, forks: true, update: false },
    });
  });
});
