# Changelog

All notable user-facing changes to Sneetches are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-04-13

The popup and options page have been fully redesigned. This release is
backward-compatible — existing access tokens, display preferences, and cached
data all survive the update.

### Added

- **Redesigned popup / options page** with a branded dark UI, 8-color star
  constellation logo, and a wordmark header.
- **Inline Octicon SVGs** for star, fork, and last-push annotations, replacing
  the previous Unicode glyphs.
- **Star icon style preference** — pick outline or filled; the swap is applied
  live to both the inline annotations and the popup preview.
- **Token "Test" button** that validates your Personal Access Token against
  `GET /user` and remembers the result across popup sessions.
- **Show / hide eye toggle** on the token field.
- **"Saved" indicator** that appears briefly after any settings change.
- **Advanced disclosure tray** (open/close state persisted) containing:
  - **API rate-limit display** fed by captured `x-ratelimit-*` response
    headers — no extra API calls are made to render it.
  - **Cached repositories count** with a **Clear cache** button.
  - **Star style** segmented control.
- **"Star us?" CTA** in the popup header. It locks gold once you've starred
  the repo, detected by scraping the repo page DOM on
  `github.com/kesensoy/sneetches`.
- **In-place star/unstar detection** via a `MutationObserver`, so the CTA
  updates without a page reload when you click Star directly on the repo.
- **Hidden 7-click easter egg** on the gold "Thanks!" star — click it seven
  times in a row to toggle the toolbar button between the default gray star
  and the multicolor constellation.
- **Firefox popup width pinning** (324px) so the popup no longer stretches
  to Firefox's default ~800px maximum. The options-page view (inside
  `about:addons` / `chrome://extensions`) stays fluid.

### Changed

- **Cache TTL** extended from 2 hours to 4 hours. Longer TTL means your
  cache survives GitHub's hourly rate-limit reset, so a burst of unique
  pages doesn't immediately re-fetch into a fresh quota.
- **Help text** for the token field now hides automatically once a valid
  token is configured, keeping the popup tidy after first-time setup.

### Fixed

- **Footer "View on GitHub" link** now opens on a single click in both
  Chrome and Firefox. Extension popups don't navigate plain links; the
  anchor needed `target="_blank"` to open in a new tab.
- **Token saved with trailing whitespace** no longer passes the Test button
  while 401-ing on every real API call — the token is trimmed on save to
  match the validation path.
- **Starred-state detector** now matches repo URLs with `#readme` (and other
  hash fragments) and no longer false-positives on `/stargazers`.
- **Awesome-list pages showed no stars on refresh** because GitHub hydrates
  the README markdown client-side AFTER `document_idle`, and the content
  script's one-shot link scan at injection time was catching zero links.
  Replaced the module-load snapshot with a live DOM query wrapped in a
  debounced `MutationObserver` on `document.body`, so links added by
  post-load React/Turbo hydration (or cross-page Turbo navigation) get
  annotated as they appear. Verified on `awesome-homelab` (712 repo links
  rendered within ~1s of hydration, zero new API calls on a warm cache).
- **Annotation flicker in every open GitHub tab when interacting with the
  popup.** The `chrome.storage.onChanged` listener fired a full annotation
  wipe and rescan on any sync-storage change, including the new popup-only
  keys introduced by the redesign (`token_validated`, `advanced_open`,
  `has_starred`, `toolbar_icon`). Clicking the Test button, opening the
  Advanced tray, starring the repo, or flipping the toolbar icon each
  caused a visible flash in every open GitHub tab. The listener now
  filters on the content-script-relevant keys (`access_token`, `show`,
  `star_style`) and short-circuits popup-only changes.
- **Rapid double-clicks on the Test button** no longer fire parallel
  `GET /user` validations. The button disables itself while validation
  is in flight, with a reentrancy guard as belt-and-suspenders.
- **Typing into the token field** no longer spams `chrome.storage.sync`
  with a `token_validated: false` write on every keystroke (chrome.storage.sync
  is rate-limited at ~120 writes/minute; a 50-character PAT used to trip
  that limit). The input handler now short-circuits when the button is
  already in the idle state.

### Internal

- Test suite expanded from 30 to 96 tests.
- Full migration from TSLint → ESLint 9 + Prettier 3.
- New `src/icons.ts` with inline Octicon SVGs (no npm dependency added).
- Existing `chrome.storage.sync` and `chrome.storage.local` keys are
  preserved; new keys (`star_style`, `advanced_open`, `token_validated`,
  `has_starred`, `toolbar_icon`, `rate_limit`) are added with safe defaults.

## [1.0.0]

Initial public release of the Kevin Esensoy–maintained fork, based on
[Oliver Steele's original Sneetches extension](https://github.com/osteele/sneetches).

### Added
- Inline GitHub repo stats (stars, forks, last push) next to any repo link.
- GitHub Personal Access Token support for 5,000 req/hour rate limit.
- Local response caching to reduce API calls.
- Chrome and Firefox builds.

[Unreleased]: https://github.com/kesensoy/sneetches/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kesensoy/sneetches/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kesensoy/sneetches/releases/tag/v1.0.0
