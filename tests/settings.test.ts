import { DefaultShowSettings, getSettings, SHOW_KEY } from '../src/settings';

describe('settingsP', () => {
  beforeEach(() => {
    chrome.storage.sync.clear();
    chrome.storage.local.clear();
  });

  test('uses defaults', async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      accessToken: undefined,
      show: { stars: true, forks: false, update: false, contributors: false },
      starStyle: 'outline',
      advancedOpen: false,
      tokenValidated: false,
      hasStarred: false,
      toolbarIcon: 'gray',
      skipOwners: [],
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
      show: { stars: false, forks: true, update: false, contributors: false },
      starStyle: 'outline',
      advancedOpen: false,
      tokenValidated: false,
      hasStarred: false,
      toolbarIcon: 'gray',
      skipOwners: [],
    });
  });

  test('round-trips skip_owners array', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ skip_owners: ['acme-corp', 'legacy-co'] }, () => resolve());
    });
    const settings = await getSettings();
    expect(settings.skipOwners).toEqual(['acme-corp', 'legacy-co']);
  });

  test('defends against non-array skip_owners values', async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.sync.set({ skip_owners: 'not-an-array' }, () => resolve());
    });
    const settings = await getSettings();
    expect(settings.skipOwners).toEqual([]);
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

describe('ShowSettings.contributors', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('DefaultShowSettings.contributors is false', () => {
    expect(DefaultShowSettings.contributors).toBe(false);
  });

  test('getSettings fills contributors from the default when absent', async () => {
    const { show } = await getSettings();
    expect(show.contributors).toBe(false);
  });

  test('getSettings reads a stored contributors flag', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [SHOW_KEY]: { stars: true, contributors: true } }, () => resolve())
    );
    const { show } = await getSettings();
    expect(show.contributors).toBe(true);
  });
});
