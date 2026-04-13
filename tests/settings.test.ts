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
      starStyle: 'outline',
      advancedOpen: false,
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
      starStyle: 'outline',
      advancedOpen: false,
    });
  });

  test('star style defaults to outline', async () => {
    const settings = await getSettings();
    expect(settings.starStyle).toBe('outline');
  });

  test('honors stored star style', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ star_style: 'filled' }, () => resolve());
    });
    const settings = await getSettings();
    expect(settings.starStyle).toBe('filled');
  });

  test('advanced_open defaults to false', async () => {
    const settings = await getSettings();
    expect(settings.advancedOpen).toBe(false);
  });

  test('honors stored advanced_open', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ advanced_open: true }, () => resolve());
    });
    const settings = await getSettings();
    expect(settings.advancedOpen).toBe(true);
  });
});
