export const ACCESS_TOKEN_KEY = 'access_token';
export const SHOW_KEY = 'show';
export const STAR_STYLE_KEY = 'star_style';
export const ADVANCED_OPEN_KEY = 'advanced_open';
export const TOKEN_VALIDATED_KEY = 'token_validated';

export type StarStyle = 'outline' | 'filled';

interface Settings {
  accessToken: string;
  show: ShowSettings;
  starStyle: StarStyle;
  advancedOpen: boolean;
  tokenValidated: boolean;
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

export function getSettings(): Promise<Settings> {
  return new Promise((resolve, reject) =>
    chrome.storage.sync.get(
      [ACCESS_TOKEN_KEY, SHOW_KEY, STAR_STYLE_KEY, ADVANCED_OPEN_KEY, TOKEN_VALIDATED_KEY],
      (object) =>
        chrome.runtime.lastError
          ? reject(chrome.runtime.lastError)
          : resolve({
              accessToken: object[ACCESS_TOKEN_KEY],
              show: { ...DefaultShowSettings, ...object[SHOW_KEY] },
              starStyle: object[STAR_STYLE_KEY] ?? DefaultStarStyle,
              advancedOpen: object[ADVANCED_OPEN_KEY] ?? DefaultAdvancedOpen,
              tokenValidated: object[TOKEN_VALIDATED_KEY] ?? DefaultTokenValidated,
            })
    )
  );
}

export async function getAccessToken(): Promise<string> {
  const { accessToken } = await getSettings();
  return accessToken;
}
