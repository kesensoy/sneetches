export const ACCESS_TOKEN_KEY = 'access_token';
export const SHOW_KEY = 'show';
export const STAR_STYLE_KEY = 'star_style';
export const ADVANCED_OPEN_KEY = 'advanced_open';
export const TOKEN_VALIDATED_KEY = 'token_validated';
export const HAS_STARRED_KEY = 'has_starred';
export const TOOLBAR_ICON_KEY = 'toolbar_icon';
export const SKIP_OWNERS_KEY = 'skip_owners';

export type StarStyle = 'outline' | 'filled';
export type ToolbarIconMode = 'gray' | 'colorful';

interface Settings {
  accessToken: string;
  show: ShowSettings;
  starStyle: StarStyle;
  advancedOpen: boolean;
  tokenValidated: boolean;
  hasStarred: boolean;
  toolbarIcon: ToolbarIconMode;
  skipOwners: string[];
}

export interface ShowSettings {
  forks: boolean;
  stars: boolean;
  update: boolean;
}

export const DefaultShowSettings: ShowSettings = {
  forks: false,
  stars: true,
  update: false,
};

export const DefaultStarStyle: StarStyle = 'outline';
export const DefaultAdvancedOpen: boolean = false;
export const DefaultTokenValidated: boolean = false;
export const DefaultHasStarred: boolean = false;
export const DefaultToolbarIcon: ToolbarIconMode = 'gray';
export const DefaultSkipOwners: string[] = [];

// GitHub username/org handle grammar, case-insensitive:
//   1–39 chars, [a-z0-9], hyphens allowed but not at start/end or doubled.
// Gates every write into `skip_owners` — both the options-UI Add flow and
// the cmd-click confirm flow — so malformed URL segments can't leak into
// sync storage.
export const GITHUB_HANDLE_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function getSettings(): Promise<Settings> {
  return new Promise((resolve, reject) =>
    chrome.storage.sync.get(
      [
        ACCESS_TOKEN_KEY,
        SHOW_KEY,
        STAR_STYLE_KEY,
        ADVANCED_OPEN_KEY,
        TOKEN_VALIDATED_KEY,
        HAS_STARRED_KEY,
        TOOLBAR_ICON_KEY,
        SKIP_OWNERS_KEY,
      ],
      (object) =>
        chrome.runtime.lastError
          ? reject(chrome.runtime.lastError)
          : resolve({
              accessToken: object[ACCESS_TOKEN_KEY],
              show: { ...DefaultShowSettings, ...object[SHOW_KEY] },
              starStyle: object[STAR_STYLE_KEY] ?? DefaultStarStyle,
              advancedOpen: object[ADVANCED_OPEN_KEY] ?? DefaultAdvancedOpen,
              tokenValidated: object[TOKEN_VALIDATED_KEY] ?? DefaultTokenValidated,
              hasStarred: object[HAS_STARRED_KEY] ?? DefaultHasStarred,
              toolbarIcon: object[TOOLBAR_ICON_KEY] ?? DefaultToolbarIcon,
              // Normalize to lowercase on read so the paint-path filter
              // (hot loop) can skip the toLowerCase-per-anchor cost, and
              // so options-UI Remove-by-exact-match still works even if
              // a mixed-case entry slipped in via DevTools.
              skipOwners: Array.isArray(object[SKIP_OWNERS_KEY])
                ? (object[SKIP_OWNERS_KEY] as string[]).map((o) => o.toLowerCase())
                : DefaultSkipOwners,
            })
    )
  );
}

export async function getAccessToken(): Promise<string> {
  const { accessToken } = await getSettings();
  return accessToken;
}
