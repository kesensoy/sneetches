# Sneetches - Project Documentation

## Overview
Sneetches is a Chrome/Firefox browser extension that adds GitHub repository statistics (stars, forks, last pushed date) inline next to GitHub repository links on any webpage.

## Technology Stack (2026)

### Core
- **Node.js**: 20+ (fnm recommended for version management)
- **TypeScript**: 5.7.2
- **Webpack**: 5.97.1 (module bundler)

### Testing
- **Jest**: 29.7.0
- **ts-jest**: 29.2.5
- **jest-webextension-mock**: 3.9.0 (Chrome extension API mocks)

### Code Quality
- **ESLint**: 9.17.0 (flat config format)
- **Prettier**: 3.4.2 (code formatting)
- **TypeScript ESLint**: 8.18.2

### Development Tools
- **Husky**: 9.1.7 (git hooks)
- **lint-staged**: 15.2.11 (pre-commit linting)
- **web-ext**: 8.3.0 (Firefox extension tooling)

## Project Structure

```
src/
  ├── cache.ts         # Local storage caching (4-hour TTL)
  ├── content.ts       # Content script (main extension logic)
  ├── github.ts        # GitHub API interaction
  ├── settings.ts      # Extension settings management
  ├── icons.ts         # Inline Octicons SVG strings (star, star-fill, repo-forked, clock)
  ├── options.ts       # Popup/options page UI logic
  ├── utils.ts         # Utility functions (number formatting, date humanization)
  ├── options.html     # Popup and options page HTML
  ├── popup.css        # Popup/options page stylesheet
  ├── style.css        # Inline annotation styles
  ├── manifest.json    # Chrome extension manifest (v3)
  └── images/          # Extension icons (32px, 128px)

tests/
  ├── cache.test.ts
  ├── content.test.ts
  ├── github.test.ts
  ├── settings.test.ts
  ├── options.test.ts
  ├── utils.test.ts
  ├── fetch.mock.ts           # Fetch API mocking helper
  └── chrome-storage.mock.ts  # Custom Chrome storage mock for Jest 29
```

## Development Commands

### Building
```bash
npm run build              # Production build (Webpack)
npm run dev                # Development build
npm run watch              # Development build with watch mode
npm run build:chrome       # Build Chrome extension (via Makefile)
npm run build:firefox      # Build Firefox extension with web-ext
```

### Code Quality
```bash
npm run lint               # Run ESLint
npm run lint:fix           # Run ESLint with auto-fix
npm run format             # Format code with Prettier
npm run format:check       # Check code formatting
npm run check              # TypeScript type checking
```

### Testing
```bash
npm test               # Run Jest tests
npm test -- --watch    # Run tests in watch mode
```

### Git Hooks
Pre-configured via Husky:
- **pre-commit**: Runs lint-staged (Prettier + ESLint on staged files), type check, and tests on changed files
- **pre-push**: Runs full lint, type check, and test suite

## Configuration Files

### TypeScript (`tsconfig.json`)
- Target: ES2020
- Module: ES2020
- Module Resolution: bundler
- Strict mode enabled
- Source maps enabled

### ESLint (`eslint.config.mjs`)
- Flat config format (ESLint 9)
- TypeScript ESLint integration
- Prettier integration (no conflicting rules)
- Custom rules:
  - No I-prefix on interfaces
  - Single quotes preferred
  - Console logging allowed
  - Unused vars starting with `_` allowed

### Prettier (`.prettierrc.json`)
- Single quotes
- Semicolons required
- 2-space indentation
- 100 character line width
- ES5 trailing commas

### Jest (`jest.config.js`)
- ts-jest preset
- jsdom test environment
- Chrome extension API mocks via jest-webextension-mock + custom storage mock (`tests/chrome-storage.mock.ts`)
- All 155 tests passing

## CI/CD

GitHub Actions (`.github/workflows/`):
- Runs on Node 20
- Parallel test jobs: linting, type checking, tests
- Builds Chrome and Firefox extensions

## Modernization History (2026)

This project was modernized from 2018-era tooling to current standards:

### Before (2018)
- Node.js 16
- TypeScript 2.9.2
- Webpack 4.16.1
- Jest 23.4.2
- TSLint 5.11.0 (deprecated)
- Husky 1.0.0-rc.13 (broken commit hooks)
- Travis CI (Node 10)
- No code formatting tool

### After (2026)
- Node.js 20+
- TypeScript 5.7.2
- Webpack 5.97.1
- Jest 29.7.0 (155/155 tests passing)
- ESLint 9.17.0 + Prettier 3.4.2
- Husky 9.1.7 (working commit hooks!)
- npm (replaced Yarn)
- GitHub Actions (Node 20)
- Modern development experience

### Key Improvements
1. **Fixed broken commit hooks** - Husky 1.0-rc → 9.x
2. **Modern linting** - Migrated from deprecated TSLint to ESLint 9
3. **Code formatting** - Added Prettier for consistency
4. **Updated build tools** - Webpack 4 → 5, TypeScript 2 → 5
5. **Modern testing** - Jest 23 → 29 with custom Chrome storage mocks (all tests passing)
6. **CI/CD** - Replaced Travis CI with GitHub Actions
7. **Removed hacks** - No more `NODE_OPTIONS=--openssl-legacy-provider`
8. **Package manager** - Migrated from Yarn to npm
9. **Bug fix** - Added missing GitHub special page exclusions (advisories, security, etc.)

## Popup & Options Page Redesign (2026)

The extension popup and options page were fully redesigned as part of the 1.1.0 release, moving from the plain browser-default look to a branded, feature-rich UI.

### What changed
- **`src/options.html`** — full rewrite with branded dark header (8-color star constellation logo, "Sneetches" wordmark, tagline), horizontal pill toggles for Stars/Forks/Last push, token field with eye toggle and Test button, Advanced disclosure tray, rate-limit bar, cache stats + Clear cache button, footer with version.
- **`src/options.ts`** — full rewrite; new wire functions for all new controls: `wireTokenEye`, `wireTokenTest`, `wireStarStylePreview`, `wireAdvancedToggle`, `wireClearCache`, plus `showSavedIndicator`, `updateTokenHelpVisibility`, `applyStarredState`, `refreshAdvancedStats`, `renderVersion`.
- **`src/popup.css`** — new file; replaces inline styles that were previously embedded in `options.html`.
- **`src/icons.ts`** — new file; inline Octicons SVG strings (star, star-fill, repo-forked, clock). No npm dependency added.
- **`src/style.css`** — added `.sneetch-icon` rule for SVG glyphs; removed obsolete `.sneetch-fork-sym` rule.
- **`src/content.ts`** — replaced Unicode glyphs with Octicons SVGs from `icons.ts`; added `starStyle` parameter to `createAnnotation`; added `detectStarredStateOnSneetchesRepo` (scrapes star button state on `github.com/kesensoy/sneetches`, MutationObserver for in-place updates).
- **`src/github.ts`** — added `captureRateLimit` (persists `x-ratelimit-*` headers to `chrome.storage.local`), `getStoredRateLimit`, `validateAccessToken` (hits `GET /user` for the Test button). User-Agent corrected from `osteele/sneetches` to `kesensoy/sneetches`.
- **`src/cache.ts`** — added `getCacheEntryCount()` and `clearCache()` helpers (both exclude the `rate_limit` key).
- **`src/settings.ts`** — four new settings: `star_style`, `advanced_open`, `token_validated`, `has_starred`.
- **Version bumped to 1.1.0.**
- **Test suite grew from 30 to 107 tests** (all passing). Subsequently expanded to 134 in 1.1.1 — see next section.

### New chrome.storage keys
- `chrome.storage.sync`: `star_style`, `advanced_open`, `token_validated`, `has_starred`, `toolbar_icon`
- `chrome.storage.local`: `rate_limit` (stores `{limit, remaining}` from GitHub response headers)

## GraphQL Path + Archived Indicator (1.1.1, 2026)

The 1.1.1 release adds a GraphQL data path for PAT users, an archived-repo indicator, an industry-standard tooltip wording, and closes a screen-reader accessibility gap. No popup UI changes — 1.1.0's visual surface is untouched.

### What changed
- **`src/github.ts`** — `getRepoData` becomes a dispatcher wrapped by `locallyCached`. When a PAT is present it routes to a new private `fetchRepoDataGraphQLSingle(nwo, token)` which hits `POST https://api.github.com/graphql` with parameterized `$owner`/`$name` variables and extracts `stargazerCount`, `forkCount`, `pushedAt`, `isArchived`, and `defaultBranchRef.target.committedDate`. Unauthenticated users still hit REST via `fetchRepoDataRESTSingle`, which now also passes through the pre-existing `archived` field from the REST response. Added `captureRateLimitFromGraphQL(body)` to persist `{limit, remaining}` from the GraphQL response body (sibling to the existing header-based `captureRateLimit`). GraphQL error handling: `NOT_FOUND` → cached 404, `FORBIDDEN` → silent skip via new `RepoResponse.silent` field, HTTP 401 → clear `TOKEN_VALIDATED_KEY` then throw. `CACHE_VERSION` bumped 1 → 2.
- **`src/content.ts`** — `createAnnotation` prefers `committed_date ?? pushed_at` for the displayed date, relabels the tooltip from "pushed DATE" to "last updated DATE", sets `aria-label` on every chip for screen reader accessibility, and appends a trailing `.sneetch-archived` chip plus `.is-archived` wrapper modifier when `data.archived === true`. `updateLinks` handles the `res.silent` branch by cleaning up the in-flight entry without appending any annotation.
- **`src/icons.ts`** — adds `archiveIcon` Octicon export (sits alphabetically first in the path-constants block).
- **`src/style.css`** — adds `.sneetch-archived` base rule (branded amber `#d97706` on `rgba(217, 119, 6, 0.15)` wash) and `.is-archived` modifier that dims the stars/forks/date siblings to cool `#8a96aa` gray. Design comment explicitly warns against rewriting as a wrapper-level `opacity` rule (which would dim the archive chip too due to CSS opacity cascading).
- **Version bumped to 1.1.1.**
- **Test suite grew from 107 to 134 tests** (27 new: 15 in `tests/github.test.ts` for the GraphQL path, 12 in `tests/content.test.ts` for the display-date preference, aria-labels, archive chip rendering, modifier class, and silent-skip handling).

### Key design decisions (locked in during 2026-04-13 brainstorm)
- **No GraphQL query batching in 1.1.1.** Deferred to 1.1.2 as a focused optimization release. See the `project_1_1_2_graphql_batcher.md` project memory for the pre-locked batching architecture.
- **Archive chip is unconditional** (not gated on a `show.archived` setting). Small footprint, high signal — promoting to a toggle would be disproportionate.
- **Visual treatment is Variant M** from the brainstorm mockup (trailing chip position, branded orange color, cool-gray muted siblings, no italic, no strikethrough). The full variant comparison lives at `docs/plans/mockups/archived-annotation-variants.html`.
- **Tooltip wording is "last updated"** — the convergent industry term across npm/PyPI/crates.io/pkg.go.dev.
- **`archived: boolean` is required on `RepoInfo`**, populated by both REST and GraphQL paths. `committed_date?: string` is optional and populated only by the GraphQL path.

### Backward compatibility
Existing 1.1.0 `chrome.storage.local` cache entries at `ver: 1` are silently discarded on first post-upgrade access via `locallyCached`'s version check. The PAT-toggle flush at `handleSyncStorageChange` is also unchanged, so switching tokens after upgrade continues to flush local cache cleanly.

## GraphQL Batching + CSS Isolation (1.1.2, 2026)

The 1.1.2 release ships two focused changes: a GraphQL query batching layer for PAT users (optimization, not correctness) and a pre-existing host-page CSS robustness fix. Both were deferred from 1.1.1 so its review surface stayed scoped to the GraphQL-path correctness work.

### What changed
- **`src/cache.ts`** — new `locallyCachedBatch<T, V>(keys, version, thunk)` export. Array-in / Map-out variant of `locallyCached`: looks up every key, calls the thunk with only the missing subset, stores everything the thunk returns, and merges cached + freshly-fetched entries into one Map. Used by the new batched dispatcher. Thunk-omitted keys are deliberately NOT cached (lets callers distinguish silent-skip from happy-path hits).
- **`src/github.ts`** — restructured around batching:
  - New private helper `buildBatchQuery(nwos)`: turns an nwo array into `{ query, variables }` with per-alias variables (`owner0`/`name0`, `owner1`/`name1`, ...) for injection safety. Scalar fragment `F` shared across aliases; top-level `rateLimit { cost limit remaining resetAt }` sibling lets the fetcher empirically verify scalar batches cost 1 point.
  - New private helper `fetchGraphQLBatch(nwos, token)`: fires one aliased POST for up to 50 repos, parses each `r0..rN` selection back into a `Map<nwo, RepoResponse>`, and applies GraphQL error-distribution rules per the 2026-04-13 research pass: walk `errors[]`, map `path[0]` → alias → nwo, then NOT_FOUND → cached 404, FORBIDDEN → silent skip, any other error type → silent + `console.error`. Emits a one-time `console.warn` if `rateLimit.cost > 1` so a future GitHub pricing-model change surfaces in DevTools. HTTP 401 clears `TOKEN_VALIDATED_KEY` and throws; HTTP 5xx / network failures throw for the whole batch.
  - New public export `getRepoDataMany(nwos): Promise<Map<string, RepoResponse>>`: the sole public entry point since 1.1.2. PAT users get `locallyCachedBatch` + chunked `fetchGraphQLBatch` at `BATCH_SIZE = 50`. Unauthenticated users get `Promise.all` of per-repo `locallyCached` + `fetchRepoDataRESTSingle` (no REST batch endpoint exists). Per-entry errors surface as Map entries rather than top-level throws — a single bad repo never aborts the whole scan.
  - Deleted: `getRepoData(nwo)` and `fetchRepoDataGraphQLSingle` — both are dead code once `updateLinks` switches to the batch path.
- **`src/content.ts`** — `updateLinks` rewrite:
  - Collect all pending `(anchor, nwo)` pairs in one pass, claim each under the current epoch upfront.
  - Deduplicate nwos (a page can have many anchors pointing at the same repo).
  - Call `getRepoDataMany(uniqueNwos)` exactly once per scan.
  - Distribution loop iterates `pending`, rechecks epoch per entry, and annotates from the returned Map — preserves the 1.1.1 mid-flight-settings-change invalidation semantics.
  - Batch-level failures (network, 401, 5xx) fall through to the same `createErrorAnnotation` path as the per-repo implementation did.
- **`src/style.css`** — `font-size: 0.9em` → `font-size: 12px` absolute on both the shared chip rule (`.sneetch-stars`/`.sneetch-forks`/`.sneetch-date`) and the `.sneetch-archived` rule. Pre-existing issue since 2018: on a host page with a 28px base font, 0.9em rendered the chips at ~25px. The `.sneetch-icon` rule stays at `0.9em` because it sizes relative to the chip (now 12px), which is the intended behavior.
- **Version bumped to 1.1.2.**
- **Test suite grew from 134 to 155 tests** (21 new: 7 in `tests/cache.test.ts` for `locallyCachedBatch`, 12 in `tests/github.test.ts` split across `buildBatchQuery`/`fetchGraphQLBatch`/`fetchGraphQLBatch error distribution`/`getRepoDataMany`, and 2 in `tests/content.test.ts` for the batching + dedup behavior). The entire `describe('GraphQL path')` block was deleted because its coverage now lives in the `fetchGraphQLBatch` blocks.

### Key design decisions (locked in during 2026-04-13 brainstorm, not re-litigated for 1.1.2)
- **Architecture B** — `github.ts` owns dispatch via `getRepoDataMany`; `content.ts:updateLinks` doesn't know which transport ran. Precedent: uBlock Origin's content-script-is-DOM-operator pattern.
- **Batch size 50**, hard-coded constant. Comment next to `BATCH_SIZE` says "if we ever see 422 from GitHub on an aliased query, halve this." GitHub's node-count limit is 500,000; scalar-only batches cost 1 point and use ~50 nodes, giving four orders of magnitude of headroom.
- **Per-scan flush, no extra coalescing window.** The existing 300ms MutationObserver debounce already coalesces React hydration bursts.
- **FORBIDDEN silent-skip responses are cached** for the 4-hour TTL, matching 1.1.1 single-repo behavior. Rationale: an awesome-list page with many private repos under a limited-scope PAT should not re-POST on every scan. Users who grant a new scope will see fresh data after the TTL or a manual Clear cache click.
- **Tests preserve REST-path coverage via a `getOneRest` helper** that calls `getRepoDataMany(['nwo']).get('nwo')` — lets the existing REST tests for caching / 404 / 403 / archived-field semantics ride on the new public API without modification to their assertions.

### Backward compatibility
`CACHE_VERSION` stays at `2`. The on-disk cache entry shape is unchanged (still `{exp, pay, ver}`), so existing 1.1.1 cache entries are reused as-is — no invalidation required. `RepoInfo` / `RepoResponse` types are unchanged.

## Extension Features

- Displays GitHub repository stats inline next to repo links using Octicons SVGs
- Shows: stars, forks, last pushed date (each individually toggleable)
- Star style preference: outline or filled icon, applied both inline and in popup preview
- Caches API responses (4-hour TTL)
- Branded dark popup/options page with horizontal pill toggles and "Saved" indicator
- Token field with show/hide eye toggle and Test button (validates against `GET /user`; persists result across sessions)
- Advanced disclosure tray (open/close state persisted) with:
  - Rate-limit display (X / 5,000 per hour, with gradient bar) fed by captured response headers
  - Cache entry count and Clear cache button
- "Star us?" CTA in popup header: gray at rest, gold on hover, locks gold when user has starred `github.com/kesensoy/sneetches` (detected via DOM scrape with MutationObserver)
- Footer shows version from `chrome.runtime.getManifest().version`
- Supports GitHub Personal Access Tokens for higher API rate limits (5,000/hour vs 60/hour)
- Works on both Chrome and Firefox
- Backward-compatible: existing users' `access_token` and `show` settings survive updates

## Rate Limiting

The extension makes a GitHub API call for each repo link on a page:
- **Without token**: 60 requests/hour
- **With token**: 5,000 requests/hour

Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new) and add it in the extension options to avoid rate limiting. Current usage is displayed in the Advanced tray of the popup as a gradient bar showing remaining requests out of the limit.

## License

MIT

