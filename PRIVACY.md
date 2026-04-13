# Privacy Policy

**Sneetches for GitHub** is an open-source browser extension that displays GitHub repository statistics inline next to repository links on any webpage.

## Data Collection

Sneetches collects and stores the following data **locally on your device**:

- **GitHub Personal Access Token** (optional): If you choose to provide one, it is stored in your browser's synced storage (`chrome.storage.sync`) to authenticate GitHub API requests for higher rate limits. It is never sent to any server other than the official GitHub API (`api.github.com`).
- **Cached API responses**: Repository statistics fetched from GitHub are cached locally (`chrome.storage.local`) for up to 4 hours to reduce API calls.
- **Rate-limit state**: After each GitHub API response, the `x-ratelimit-limit` and `x-ratelimit-remaining` header values are stored locally (`chrome.storage.local`, key `rate_limit`) so the popup can display current usage. This data never leaves your device.
- **Display preferences**: Your settings for which stats to show (stars, forks, last pushed), star icon style, and Advanced tray open/close state are stored in `chrome.storage.sync`.
- **Token validation state**: Whether your token was last confirmed valid is stored in `chrome.storage.sync` (`token_validated`) so the popup can show the correct indicator without re-testing on every open.
- **"Star us?" state**: Whether you have starred the `github.com/kesensoy/sneetches` repository is stored in `chrome.storage.sync` (`has_starred`). This is detected by reading the star button in the GitHub page DOM — no data is sent anywhere.
- **Toolbar icon preference**: Whether the toolbar button displays the default gray star or the multicolor constellation is stored in `chrome.storage.sync` (`toolbar_icon`). This is a purely cosmetic preference with no external side effects.

## Data Sharing

Sneetches does **not**:

- Collect or transmit any personal information
- Track your browsing history or activity
- Send data to any third-party servers
- Use analytics, telemetry, or tracking of any kind

The only external network requests the extension makes are to the **GitHub API** (`api.github.com`):
- `GET /repos/{owner}/{name}` — fetches public repository metadata for each repo link found on a page.
- `GET /user` — called once when you click the **Test** button in the token field, to verify your Personal Access Token. This call is user-initiated and does not happen automatically.

## Open Source

Sneetches is fully open source. You can review the complete source code at [github.com/kesensoy/sneetches](https://github.com/kesensoy/sneetches).

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/kesensoy/sneetches/issues).
