# Privacy Policy

**Sneetches for GitHub** is an open-source browser extension that displays GitHub repository statistics inline next to repository links on any webpage.

## Data Collection

Sneetches collects and stores the following data **locally on your device**:

- **GitHub Personal Access Token** (optional): If you choose to provide one, it is stored in your browser's synced storage (`chrome.storage.sync`) to authenticate GitHub API requests for higher rate limits. It is never sent to any server other than the official GitHub API (`api.github.com`).
- **Cached API responses**: Repository statistics fetched from GitHub are cached locally (`chrome.storage.local`) for up to 2 hours to reduce API calls.
- **Display preferences**: Your settings for which stats to show (stars, forks, last pushed) are stored locally.

## Data Sharing

Sneetches does **not**:

- Collect or transmit any personal information
- Track your browsing history or activity
- Send data to any third-party servers
- Use analytics, telemetry, or tracking of any kind

The only external network requests the extension makes are to the **GitHub API** (`api.github.com`) to fetch public repository metadata.

## Open Source

Sneetches is fully open source. You can review the complete source code at [github.com/kesensoy/sneetches](https://github.com/kesensoy/sneetches).

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/kesensoy/sneetches/issues).
