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
      tokenValidated: false,
      hasStarred: false,
      toolbarIcon: 'gray',
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
      tokenValidated: false,
      hasStarred: false,
      toolbarIcon: 'gray',
    });
  });

  describe.each([
    {
      storageKey: 'star_style',
      settingKey: 'starStyle',
      defaultValue: 'outline',
      overrideValue: 'filled',
    },
    {
      storageKey: 'advanced_open',
      settingKey: 'advancedOpen',
      defaultValue: false,
      overrideValue: true,
    },
    {
      storageKey: 'token_validated',
      settingKey: 'tokenValidated',
      defaultValue: false,
      overrideValue: true,
    },
    {
      storageKey: 'has_starred',
      settingKey: 'hasStarred',
      defaultValue: false,
      overrideValue: true,
    },
    {
      storageKey: 'toolbar_icon',
      settingKey: 'toolbarIcon',
      defaultValue: 'gray',
      overrideValue: 'colorful',
    },
  ] as const)('$storageKey', ({ storageKey, settingKey, defaultValue, overrideValue }) => {
    test(`defaults to ${JSON.stringify(defaultValue)}`, async () => {
      const settings = await getSettings();
      expect(settings[settingKey]).toBe(defaultValue);
    });

    test(`honors stored value ${JSON.stringify(overrideValue)}`, async () => {
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set({ [storageKey]: overrideValue }, () => resolve());
      });
      const settings = await getSettings();
      expect(settings[settingKey]).toBe(overrideValue);
    });
  });
});
