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

## Service Worker Refactor + Scheduler Rework (1.1.3, 2026)

The 1.1.3 release moves the repo-data hot path out of the content script and into a Manifest V3 service worker, then adds a handful of content-script scheduling changes to break out of React-hydration starvation on awesome-list pages. The motivating measurement: on `github.com/miantiao-me/awesome-homelab` (712 repo links, PAT configured, 1Password + GitHub's own scripts active), the 1.1.2 build took ~18–20 seconds on cold cache and ~12–13 seconds on warm cache to paint all annotations. 1.1.3 cuts warm cache to ~6 seconds (−53%) and cold cache to ~11–12 seconds (−40%). The remaining cost is dominated by (a) React's own hydration latency and (b) content-script main-thread queueing of port-message replies, both of which are architectural and not fixable without spawning a dedicated Worker (deferred to 1.1.4+).

### What changed
- **`src/service-worker.ts`** — new file. Manifest V3 background entry point. `chrome.runtime.onConnect` handler accepts `SNEETCHES_PORT_NAME` connections, reads the access token from `chrome.storage.sync`, and delegates to `fetchRepoDataStreaming` in github.ts. Each `onResults` chunk becomes a `{type:'chunk', entries: [[nwo, RepoResponse], ...]}` postMessage to the content script. Terminal `{type:'done'}` or `{type:'error', status}` tears down the port. Single-shot connection: the worker disconnects after one request, so the content script opens a fresh port per scan. Handler is exported as `handleFetchReposRequest` for direct test invocation.
- **`src/shared/rpc.ts`** — new file. Shared protocol types: `SNEETCHES_PORT_NAME`, `FetchReposRequest`, `ChunkMsg | DoneMsg | ErrorMsg` discriminated union. Imported by both sides.
- **`src/cache.ts`** — adds `bulkReadCache<T, V>(keys, version)` and `bulkWriteCache<T, V>(fresh, version)` primitives. Array-in / partition-out and Map-in / fire-and-forget-write respectively. These sit alongside `locallyCached` / `locallyCachedBatch` (still exported for any future caller) because 1.1.3's progressive reveal needs the cache-read and network-fetch phases separable — `locallyCachedBatch`'s single-thunk shape collapses them.
- **`src/github.ts`** — new exported `fetchRepoDataStreaming(nwos, accessToken, onResults)`: one `bulkReadCache` up front, fire `onResults` with the cached subset, then parallel round-robin-chunked `fetchGraphQLBatch` calls (`BATCH_SIZE = 50`) with each chunk posting its own `onResults` via `bulkWriteCache + onResults`. PAT users get the GraphQL path; unauth users get parallel per-repo REST with per-entry error surfacing. Transport failures (HTTP 401, 5xx, network) throw out of the streaming function; per-entry errors (NOT_FOUND, FORBIDDEN) surface as `RepoResponse` Map entries so a single bad repo never aborts the scan. `getRepoDataMany` is **deleted** — dead since updateLinks moved to the port path. `locallyCached` / `locallyCachedBatch` / `getAccessToken` imports are dropped.
- **`src/content.ts`** — `updateLinks` rewired onto a `PortFetcher` helper that opens `chrome.runtime.connect({name: SNEETCHES_PORT_NAME})`, posts `{nwos}`, and routes chunks through the existing byNwo-grouped `distributeChunk` logic. Epoch / silent-skip / in-flight-WeakMap invariants all preserved. New `__setPortFetcherForTests` hook lets `tests/content.test.ts` substitute a jest.fn without spinning up the real service worker.
  - **Settings cache (Fix D)**: `getCachedSettings()` reads settings once into a module-level variable and serves all subsequent `updateLinks` calls from memory. `invalidateCachedSettings()` is called in `applySettingsChange()` so the onChanged listener still works. The 2026-04-14 probe measured `chrome.storage.sync.get` taking ~5 seconds on awesome-homelab because its callback queues behind React hydration on the content-script main thread — same starvation pattern the SW refactor fixed for `local.get`. Caching wipes that cost.
  - **Scheduler rework**: `LINK_SCAN_MAX_WAIT_MS = 500` cumulative cap. A separate un-resettable setTimeout armed on the first mutation in a cycle, not reset by subsequent mutations like the rolling 300ms debounce is. Whichever timer fires first wins and clears both. `fireScan` is the shared entry point. This breaks rolling-debounce starvation under continuous React hydration bursts.
  - **Leading-edge MutationObserver trigger**: the MO callback walks added nodes, and when any subtree is-or-contains an `a[href^="https://github.com/"]` anchor, calls `updateAnnotationsFromSettings()` immediately from inside the MO microtask. This bypasses `setTimeout` entirely — MO callbacks run as microtasks at the end of every JS task, so they drain between React's hydration tasks rather than waiting for a scheduler slot that may be 4+ seconds late. Throttled to once per 100ms via `lastLeadingEdgeAt` so false positives (matching github.com anchors that aren't `/owner/name` repo URLs — user profile links, /login, /issues tabs) don't lock out real retries.
- **`src/manifest.json`** — adds `"background": { "service_worker": "service-worker.js", "type": "module" }`. Firefox 121+ supports module SWs (Dec 2023), so no compatibility concern as of 2026.
- **`webpack.config.js`** — new `'service-worker'` entry point, builds `build/service-worker.js` (~4.8 KiB minified).
- **`tests/port.mock.ts`** — new file. Hand-rolled linked-pair port mock. jest-webextension-mock's `runtime.js` ships unlinked stubs where `connect()` returns a port disconnected from the `onConnect` listener bag — unusable for service-worker integration tests. This mock creates a real client↔server port pair with working `postMessage` delivery, `onMessage` / `onDisconnect` listeners, and `disconnect()` semantics that fire listeners on the partner.
- **`tests/service-worker.test.ts`** — 13 tests covering onConnect routing, cold-cache GraphQL path, warm-cache cached-chunk path, empty-nwos, NOT_FOUND / FORBIDDEN error distribution, HTTP 401 terminal error + token invalidation, HTTP 500, network error, unauth REST, unauth 403 per-entry status, port disconnect on done / error.
- **`tests/cache.test.ts`** — 8 new tests for `bulkReadCache` / `bulkWriteCache` (empty input, full miss, round-trip, mixed hit/miss, expired, stale version, empty write, entry count).
- **`tests/content.test.ts`** — migrated from `jest.mock('../src/github')` + `getRepoDataMany` stub to `__setPortFetcherForTests(portFetcherMock)`. All 40 existing behavior tests ported (epoch invalidation, silent-skip WeakSet, popup-only key filter, access_token cache flush, batching + dedup) — nothing lost.
- **`tests/github.test.ts`** — `getRepoDataMany` describe blocks renamed to `fetchRepoDataStreaming`, tests migrated via a new `fetchReposMap` helper that drives streaming and collects chunks into a Map. Preserves all REST-path and PAT-path test coverage.
- **Version bumped to 1.1.3.**
- **Test suite grew from 158 to 184** (26 new: 14 service-worker protocol tests including the partial-chunk-then-error scenario, 8 `bulkReadCache` / `bulkWriteCache` tests, 4 content-script scheduler / settings-cache-retry tests). `tests/port.mock.ts` is infrastructure, not a test file — no `test()` calls. The 158 baseline matches the pre-1.1.3 jest count on branch `1.1.3` at merge commit `4d42d12`; the 155 mentioned in the 1.1.2 CLAUDE.md section was a slight undercount. The +1 in greploop iteration 2 is the rejection-retry test for `getCachedSettings`.

### Measured impact
- **Warm cache on awesome-homelab**: 12.9s → **6.1s** (−6.8s, −53%). The scan-silence window dropped from 8.7s to ~1s; the 5s port round-trip remains as the dominant ceiling.
- **Cold cache on awesome-homelab**: 20.5s → **11.5s** (−9.0s, −44%). GitHub's GraphQL response time (3–5s for the 15 parallel chunks) is now the biggest cost; everything before it is fast.
- **Settings cache alone**: 4942ms → 0ms on the `await getSettings()` step.
- **Scheduler rework alone**: 8.7s scan silence → ~1.3s (varies with React hydration variance).

### Key design decisions
- **Port-based, not `chrome.runtime.sendMessage`**. Long-lived port supports progressive reveal — cache-hit subset fires first, then one chunk per fresh GraphQL batch as each resolves. A single-shot `sendMessage` would have to wait for all chunks before returning.
- **SW delegates to `fetchRepoDataStreaming` in github.ts**, not reimplementing the pipeline. Keeps all repo-data knowledge in one place; the SW is pure transport glue (~100 lines).
- **Settings are read from the content script, not the SW**. The settings-cache fix avoids the storage-callback-starvation cost, and settings are needed synchronously at render time (the annotation's `show` / `starStyle` parameters), so piping them through the port round-trip for every scan would be slower than caching them in memory.
- **Leading-edge throttle (100ms), not one-shot flag**. A one-shot flag gets consumed by false positives (non-repo github links in GitHub's chrome). The throttle lets subsequent MO callbacks retry, and false-positive scans cost ~1ms via the `pending.length === 0` early-exit guard in `updateLinks`.
- **Not doing content-script Worker architecture in 1.1.3**. The 2026-04-14 research pass identified this as the only lever that could theoretically escape content-script main-thread contention for port-reply delivery. But the expected savings are small (~500ms–1s, not 4s) because `worker.postMessage` replies still queue on the content script's main thread. The architectural cost is high. Deferred to 1.1.4+.
- **Not doing SW keepalive in 1.1.3**. The SW cold-start might contribute to the 4–5s phase-C port round-trip but we can't distinguish it from content-script main-thread contention without another probe cycle. Deferred to 1.1.4+ if warranted by measurement.

### Backward compatibility
`CACHE_VERSION` stays at `2`. On-disk cache entries from 1.1.2 are reused as-is. `RepoInfo` / `RepoResponse` types are unchanged. The old `getRepoDataMany` entry point is removed from the public API; no extension consumers existed outside the test suite, which has been migrated. Firefox users on versions older than 121 (Dec 2023) will see the SW fail to load due to `"type": "module"` — acceptable per the 2026 release timeline.

## document_start Cache Preload (1.1.4, 2026)

The 1.1.4 release eliminates the ~4.5-second phase-C port round-trip measured on 1.1.3 for warm-cache scans on awesome-list pages. After 1.1.3 moved the repo-data hot path to a service worker and added settings caching + scheduler rework + leading-edge MO triggers, the remaining ceiling was content-script main-thread queueing of incoming `port.postMessage` delivery: the SW was already finished with its work in ~130ms, but the 'done' message's delivery task sat in the page's main-thread queue for ~4.4 seconds behind React hydration. 1.1.4 removes the port entirely for cache-hit anchors, serving them synchronously from an in-memory Map populated at `document_start`.

### What changed
- **`src/manifest.json`** — `content.js` moves from `run_at: "document_idle"` (the default) to `run_at: "document_start"`. The content script now runs before the HTML parser has fully walked the document, which gives the storage preload a free main-thread window before React / 1Password / GitHub chrome start contending.
- **`src/cache.ts`** — new exported `readAllCachedRepos<T, V>(version)` helper reads every repo-cache entry from `chrome.storage.local` in a single `get(null)` IPC and returns a filtered `Map` (unexpired, matching version, skipping non-cache keys like `rate_limit`). Lives next to `bulkReadCache` / `bulkWriteCache` / `locallyCached`.
- **`src/github.ts`** — `CACHE_VERSION` is now exported so `content.ts`'s preload can validate cache entries without hard-coding the version.
- **`src/content.ts`**:
  - Module-level `inMemoryRepoCache: Map<string, RepoResponse> | null` mirrors the disk cache. Populated at module load via `runPreload()` which fires `readAllCachedRepos(CACHE_VERSION)`. On preload error, falls back to an empty Map rather than leaving the mirror null forever, and now logs via `console.error` so a genuinely broken storage layer is diagnosable in DevTools.
  - A `preloadGeneration` counter prevents an in-flight preload from stomping the null that `handleSyncStorageChange` sets when the access token changes. `runPreload` captures the generation at start and checks it before writing the result; if the generation was bumped mid-flight, the assignment is skipped.
  - `updateLinks` splits `pending[]` into cached + uncached: cached anchors are painted synchronously via a new extracted `paintResult` helper (the same epoch / silent-skip / ok-vs-error decision tree `distributeChunk` uses for port-fetcher chunks), uncached anchors flow into the existing SW port path with a reduced `uniqueNwos` list.
  - Deferred body-dependent initialization: `startLinkScanner` and `detectStarredStateOnSneetchesRepo` wait for `<body>` to parse via a `MutationObserver` on `document.documentElement`. Per `feedback_main_thread_contention_timing.md`, MO microtasks drain reliably under React contention while `DOMContentLoaded` / `setTimeout` scheduling can delay multi-second.
  - `handleSyncStorageChange` now clears `inMemoryRepoCache` and bumps `preloadGeneration` alongside the existing `chrome.storage.local.clear()` on access-token change — without this, the next scan would paint from stale pre-token data that no longer exists on disk. Show/starStyle changes do NOT invalidate the mirror because the repo data is still valid; only rendering changes.
  - New test hooks: `__setInMemoryRepoCacheForTests`, `__getInMemoryRepoCacheForTests`, `__rerunPreloadForTests`, `__getPreloadPromiseForTests`. `__resetLinkScannerForTests` now also clears the in-memory mirror and bumps the preload generation for cross-test isolation.
- **`tests/cache.test.ts`** — 5 new tests for `readAllCachedRepos` (empty storage, version filtering, expiry filtering, non-cache-key skipping, malformed-entry skipping).
- **`tests/content.test.ts`** — 18 new tests covering: test hook round-trips, preload populates from storage with expiry/version filters, fast-path single hit (no port call), fast-path multi hit, mixed hit/miss (port called only with misses), null cache falls through, silent-skip fast path with second-scan verification, dedup fast path, partial-cache port-failure handling, access-token invalidation clears the mirror, show/starStyle changes preserve the mirror, and the in-flight-preload-after-token-change race regression test.
- **Version bumped to 1.1.4.**
- **Test suite grew from 184 to 207** (23 new: 5 in `tests/cache.test.ts` for `readAllCachedRepos`, 18 in `tests/content.test.ts` for the preload + fast-path behavior).

### Measured impact
All numbers measured on `github.com/miantiao-me/awesome-homelab` (712 repo links, 705 unique nwos, PAT configured, 1Password + GitHub's own scripts active) on 2026-04-15.

- **Warm cache wall clock**: 6.1s → **~2.3s** (floor = React's own hydration latency until repo anchors appear in the DOM). The 4.5s phase-C port round-trip is eliminated entirely for cache hits.
- **Cold cache wall clock**: unchanged at ~11.5s. The SW path handles misses; everything 1.1.3 did still applies for first visits.
- **Validation scan recorded 712/712 fast-path hits** with zero port calls — the in-memory Map held 705 entries at scan time (deduplicated from 712 anchors), matched every pending anchor, and painted all 712 annotations synchronously inside the MutationObserver microtask.
- **Storage read cost at document_start**: 129-258ms for 705 entries / 150KB on awesome-homelab (measured across multiple probe runs) — comfortably below React's hydration floor, so `inMemoryRepoCache` is populated by the time the MO leading-edge fire triggers the first scan on real repo anchors.
- **Mixed hit/miss pages**: strictly faster than 1.1.3 — the cached subset paints synchronously during the MO microtask, misses go through the port path with a reduced `uniqueNwos` list.
- **Regular github.com/owner/repo pages** with a handful of repo links: modest improvement (fewer port round-trips for the handful of cached nwos in the README's "related repos" section).

### Key design decisions
- **`document_start` run timing, not document_idle.** The 234ms storage read is only cheap because it fires before React starts contending for the main thread. At `document_idle`, the content script runs AFTER the HTML parser is idle, by which point 1Password / GitHub chrome / React have already started task-queuing work — the same starvation that made 1.1.2's settings reads take 5 seconds.
- **Read-only in-memory mirror.** The SW still owns all writes to `chrome.storage.local`. Fresh fetches from the port path populate the persistent cache for NEXT page-load's preload. The current scan's new cache hits do NOT live-update `inMemoryRepoCache` — we accept that as a simplicity / correctness trade-off, because the alternative (writing back from content.ts) would introduce a dual-writer race with the SW's `bulkWriteCache` calls.
- **Generation-counter cancellation for the in-flight preload race.** If `handleSyncStorageChange` fires during the ~234ms preload window, the in-flight `runPreload`'s pending assignment would otherwise stomp the newly-null `inMemoryRepoCache` with stale pre-change data. The generation counter lets `runPreload` detect that its generation was superseded and drop the result on the floor.
- **No invalidation on show/starStyle settings changes.** The repo data is still valid, only rendering changes. `applySettingsChange`'s rescan re-reads the same in-memory Map and re-paints with the new settings.
- **`MutationObserver` on `documentElement` for body-wait, not `DOMContentLoaded` or `setTimeout`.** Microtask-scoped signaling that fires the moment the HTML parser inserts `<body>`, with no task-queue delay under main-thread contention. Per `feedback_main_thread_contention_timing.md`.
- **`readAllCachedRepos` lives in `cache.ts`, not `content.ts`.** Keeps storage-schema knowledge centralized next to `bulkReadCache` / `bulkWriteCache`. The in-memory Map itself lives in `content.ts` because it's a content-script concern — the SW never reads it.
- **`CACHE_VERSION` imported from `github.ts`, not re-declared in `content.ts`.** `cache.ts` still can't import from `github.ts` (would create a cycle with `github.ts → cache.ts`), but `content.ts` already imports from `github.ts` so one-way import is fine. Keeps the version constant single-sourced.

### Backward compatibility
`CACHE_VERSION` stays at `2`. The on-disk cache entry shape is unchanged (still `{exp, pay, ver}`), so existing 1.1.3 cache entries are reused as-is by the new preload path — no invalidation required. `RepoInfo` / `RepoResponse` types are unchanged. The test hooks (`__setInMemoryRepoCacheForTests`, etc.) are new, but all existing `__set*ForTests` hooks are preserved. `handleSyncStorageChange`'s `chrome.storage.local.clear()` on access-token change is unchanged; the new additions are the sibling `inMemoryRepoCache = null` line and the `preloadGeneration++` bump.

## Error Annotation Redesign (1.1.5, 2026)

The 1.1.5 release rewrites the three error branches in `createErrorAnnotation` to match the existing chip design language. The motivating issue: on any webpage with broken GitHub links, 1.1.4 rendered bare red `missingⓍ` text mashed against the URL with no padding or chip wrapper. The same function also rendered 403 rate-limited links as a literal `⏳` emoji and the catch-all `else` branch as an empty annotation (no user feedback at all).

### What changed
- **`src/icons.ts`** — adds three new Octicon exports: `unlinkIcon` (broken chain, for 404), `hourglassIcon` (for 403 rate-limited), `bugIcon` (for the else branch). Path constants sit alphabetized in the existing block alongside `ARCHIVE_PATH` / `STAR_PATH` / etc.
- **`src/style.css`** — adds three new chip rules paralleling `.sneetch-archived`: `.sneetch-broken` (red wash `#d1242f`), `.sneetch-rate-limited` (amber wash `#d97706`, same hue as archived), `.sneetch-error` (green wash `#1a7f37`). Deletes the old `.data-sneetch-extension.missing { color: red; }` rule. All three use absolute `12px` font-size per the 1.1.2 CSS isolation fix.
- **`src/content.ts`** — rewrites `createErrorAnnotation` end to end. Deletes `MISSING_SYMBOL`. Each error branch now builds a child `<span>` with className + aria-label + svg + text + tooltip, mirroring the `.sneetch-archived` pattern in `createAnnotation`. Tooltips tightened: "Repository not found" for 404, two sub-states for 403 (PAT-setup prompt vs. bare "exceeded" message), "Couldn't fetch repository info (status N)" for else. Every chip gets an `aria-label` for screen reader support. Capital-H "GitHub" spelling restored across all 403 tooltip strings (the pre-1.1.5 implementation used lowercase "Github"). The `headers` parameter was also deleted — `RepoResponse` has no `headers` field and no real call site ever populated it, so the pre-existing reset-time tooltip branch was unreachable in production (Greptile P2 on PR #7).
- **Version bumped to 1.1.5** in both `package.json` and `src/manifest.json`.
- **Test suite grew from 207 to 215 tests** (net +8). The `describe('createErrorAnnotation', ...)` block was rewritten end to end, splitting the single flat block into three nested describe blocks (404, 403, else) with tighter per-branch assertions including chip class, svg presence, aria-label, and tooltip. The four `headers`-based tests (reset-time tooltip, no-headers-field defensive cases) were removed alongside the `headers` parameter itself.

### Key design decisions (locked in during 2026-04-15 brainstorm)
- **Three-wash system**: red wash / amber wash / green wash, keyed by hue not by visual weight. All three use the same `.sneetch-archived`-style padded-span pattern. Rejected: solid red treatment (too loud, breaks chip-family consistency), gray wash for else (collides with `.is-archived` cool gray).
- **Glyph + word**: `unlink` + "broken" (404), `hourglass` + "wait" (403), `bug` + "error" (else). Word choices rejected in brainstorm: "missing" / "dead link" / "404" / "gone" for 404; "rate limit" / "throttled" for 403; "unknown" / "failed" for else.
- **Green-as-success collision is accepted** — the else branch is rare (it covers weird 5xx responses, malformed responses, and any new GraphQL error code GitHub ships that doesn't map to NOT_FOUND/FORBIDDEN), so the green/success semantic clash rarely bites. The bug icon + "error" wording disambiguates if a user does see it. Gray was the obvious alternative but collides with `.is-archived`'s cool-gray sibling dim, so green wins by elimination.
- **Amber collision with `.sneetch-archived` is intentional** — both are "not fully available" states. They won't appear on the same anchor (a rate-limited request never returns archived metadata).
- **`link-slash` Octicon doesn't exist** in current Octicons; `unlink` is the closest broken-chain glyph the upstream ships. Verified via curl against `raw.githubusercontent.com/primer/octicons/main/icons/` during the 2026-04-15 brainstorm.

### Backward compatibility
`CACHE_VERSION` stays at `2`. Cached 404 responses from prior versions are reused; only the rendering of those payloads changes. No new `chrome.storage` keys, no new settings, no migration required.

## Dev Instrumentation Harness (1.1.6, 2026)

The 1.1.6 release is a developer-experience bump. No user-visible changes. Adds a permanent perf probe module and a Node-based measurement script so every future perf investigation can use a one-command loop (`npm run probe`) instead of re-inventing instrumentation from scratch. Every prior perf release (1.1.3, 1.1.4) involved sprinkling `performance.now()` + `console.log('[probe]')` calls, measuring once, then ripping them all out before commit so prod stays clean. 1.1.6 ends that pattern.

### What changed
- **`src/debug/probe.ts`** — new file. Exports `Phase` constants (12 phase names covering preload/scan/pending/fast-path/port/paint on the content-script side and handler-entry/fetch-start/fetch-done on the service worker side), plus `mark(phase, extra?)`, `reset()`, `dump(label?)`, and a `__getEntriesForTests` accessor. Module-level `entries: Entry[]` array; `mark` pushes `{phase, t: performance.now(), ctx, extra}`; `dump` emits exactly one `console.log('SNEETCHES_PROBE', JSON.stringify(payload))`. Every exported function guards on `__DEBUG__` so production builds are fully stripped. Debug builds also mount `globalThis.sneetchesProbe = { mark, dump, reset, Phase }` for manual invocation from DevTools on any page without reloading.
- **`src/globals.d.ts`** — new file. `declare const __DEBUG__: boolean;` — the build-time flag substituted by webpack `DefinePlugin`. Picked up automatically by `tsconfig.json`'s `include: ["src/**/*"]`.
- **`webpack.config.js`** — rewritten from plain-object form to function form `(_env, argv) => config` so it can read `argv.mode`. Adds `DefinePlugin` substituting `__DEBUG__` for `true` (development) or `false` (production). Adds `TerserPlugin` in `optimization.minimizer` with `terserOptions.compress.pure_funcs: ['probe.mark', 'probe.dump', 'probe.reset']` and `passes: 2` so call sites are deleted entirely from the prod bundle — not just their bodies. `devtool` is now keyed off `isProd` rather than the old `process.env.NODE_ENV` check. Verified via `npm run test:dce` that no `SNEETCHES_PROBE` string literal survives in `build/*.js`.
- **`jest.config.js`** — adds `globals: { __DEBUG__: true }` so unit tests see the live code path at the same value as development builds.
- **`src/content.ts`** — adds `import * as probe from './debug/probe';` and inserts 11 mark calls at strategic sites: `PRELOAD_START`/`PRELOAD_DONE` in `runPreload`, then inside `updateLinks`: `probe.reset()` and `SCAN_START` outside the try block (so SCAN_START is always the first entry even on thrown scans), `PENDING_COLLECTED` after the cached/uncached split, `FAST_PATH_PAINTED` on both the full-hit early-return branch and the mixed-case split, `PORT_SEND` before the portFetcher call, `PORT_FIRST_CHUNK` inside the `distributeChunk` closure on first invocation (gated by a closure-scoped `firstChunkSeen` flag), `PORT_DONE` after the portFetcher resolves, and `PAINT_DONE` before the final `probe.dump('scan')`. The entire body of `updateLinks` post-reset is wrapped in `try { ... } finally { probe.dump('scan'); }` so every scan — success, exception, or early return — produces exactly one envelope.
- **`src/service-worker.ts`** — adds the probe import and restructures `handleFetchReposRequest` with the same try/finally pattern: `probe.reset()` and `probe.mark(SW_HANDLER_ENTRY, { nwos })` outside the try block, `SW_FETCH_START` after `getAccessToken()`, `SW_FETCH_DONE` after `fetchRepoDataStreaming`, and `probe.dump('sw')` in a `finally` block so the SW's envelope fires exactly once per request regardless of success or failure.
- **`scripts/probe-run.ts`** — new file (~300 lines). Node CLI that: (1) loads `.env.probe` at the repo root for `SNEETCHES_PROBE_GITHUB_PAT`, (2) parses `--url` / `--label` args, (3) rebuilds in dev mode if `build/content.js` is missing, stale (>60s), or a production bundle (no `SNEETCHES_PROBE` envelope), (4) launches **Chrome for Testing** via **Puppeteer 24.41+** with `enableExtensions: [buildPath]` + `pipe: true` (required for the path-list form) and a persistent `userDataDir` at `~/.sneetches-probe/profile/`, (5) locates the extension's service-worker target via `browser.waitForTarget(t => t.type() === 'service_worker')`, (6) injects the PAT into `chrome.storage.sync` via `worker.evaluate(async (token) => chrome.storage.sync.set({ access_token: token, token_validated: true }))` — only if not already set, so repeat runs don't wipe the extension's persistent cache through `handleSyncStorageChange`, (7) opens a new page, wires `page.on('console', ...)` filtered on the `SNEETCHES_PROBE` envelope, (8) navigates to the target URL with `waitUntil: 'domcontentloaded'`, (9) waits 3 seconds for React hydration to finish on awesome-list pages (measured 2026-04-15), (10) gates capture on "real" payloads — a payload counts as real if it's a SW envelope or contains a `pending-collected` mark (i.e., found at least one repo anchor and went past the fast-path split), (11) drains 500ms past the last real capture, (12) writes ALL captured payloads (real + empty pre-hydration scans) to `docs/plans/probe-runs/<timestamp>-<slug>.json`, (13) prints an ASCII diff table per context against the most recent previous run, (14) closes the browser in `finally`. Chrome window is positioned off-screen at `--window-position=-10000,-10000` so agent-driven runs don't visually disrupt the desktop.
- **`scripts/tsconfig.json`** — new file. Separate tsconfig for the script so it compiles standalone without interfering with the extension build. Targets ES2022 / CommonJS.
- **`.gitignore`** — adds `.sneetches-probe/` for the persistent probe profile. `.env*` already covers `.env.probe`.
- **`package.json`** — adds devDependencies `terser-webpack-plugin@^5.4.0`, `puppeteer@^24.41`, `@puppeteer/browsers@^2.13`, `ts-node@^10.9.2`. Puppeteer's postinstall downloads Chrome for Testing into `~/.cache/puppeteer/`. Adds scripts `probe` (runs the measurement script via ts-node) and `test:dce` (builds prod and greps for probe leak).
- **`tests/probe.test.ts`** — new file. 15 unit tests covering Phase constants, mark shape, reset clearing, and dump envelope format. Uses `probe.__getEntriesForTests()` to inspect internal state.
- **Test suite grew from 215 to 230** (15 new probe-module tests).
- **Version bumped to 1.1.6.**

### Key design decisions (locked in during 2026-04-15 brainstorm + harness rewrite)
- **Puppeteer 24+ driving Chrome for Testing, NOT raw CDP / NOT chrome-devtools MCP / NOT real branded Chrome.** Three things killed the earlier raw-CDP-with-profile-copy design. First, **Chrome 137+ branded removed the `--load-extension` flag entirely** (Chromium PSA, April 2025) — only Chrome for Testing / Chromium builds still honor it, so any script that launches `/Applications/Google Chrome.app` with `--load-extension` is on a countdown to silently break. Second, copying the user's **1.5 GB real profile** to `/tmp` on every probe run is absurd and risks corruption (Chrome holds locks on its profile dir while running). Third, `chrome-devtools MCP` has a known habit of dumping `Authorization` headers into agent-visible output — already burned a PAT on 2026-04-14 and not about to do it again. The Puppeteer + Chrome for Testing combination is the **officially-sanctioned 2025+ path** for automated MV3 extension testing (`developer.chrome.com/docs/extensions/how-to/test/puppeteer`), version-pinned via `@puppeteer/browsers`, and isolated from the user's real Chrome installation.
- **Persistent profile at `~/.sneetches-probe/profile/`, NOT fresh-each-run.** Created once by Puppeteer on first run, reused for every subsequent probe. The PAT lives there after the first `worker.evaluate` injection and the extension's on-disk `chrome.storage.local` cache persists across probe runs — which is the point, because we want to measure warm cache behavior without cold-starting every single run. The dir is gitignored (`/.sneetches-probe/` in `.gitignore`) and easy to nuke (`rm -rf ~/.sneetches-probe && npm run probe`) when a clean slate is needed.
- **PAT injected into `chrome.storage.sync` via `worker.evaluate()` on the service-worker target, NOT via options-page form-fill or persistent-profile fixture.** MV3 service workers have direct `chrome.storage.sync` access from their isolated world, and Puppeteer's `browser.waitForTarget(t => t.type() === 'service_worker')` → `target.worker()` → `.evaluate()` pattern is the lowest-ceremony way to run code in that world. The injection is gated on "only set if current value differs from env-provided PAT" so repeat runs don't trigger `handleSyncStorageChange` and wipe the persistent local cache. PAT comes from `SNEETCHES_PROBE_GITHUB_PAT` env var, sourced from `.env.probe` at the repo root if present, otherwise from the shell environment. `.env.probe` is gitignored via the pre-existing `.env*` rule.
- **Headful Chrome, NOT headless=new.** The whole point of the probe is measuring main-thread contention from React + GitHub's own chrome during hydration. Headless Chrome has a different task scheduler and no paint pipeline — measurements there would not reproduce the 4+ second stalls we're instrumenting. Mitigation for agent-driven runs: `--window-position=-10000,-10000 --window-size=1280,800` positions the window off-screen so it doesn't visually disrupt the desktop, but the rendering pipeline is still fully engaged.
- **Capture gates on "real" payloads with a `pending-collected` mark, NOT on "first envelope seen".** Pre-hydration scans on awesome-list pages fire many empty scans (MO triggers a scan, `findUnannotatedRepoLinks` returns nothing or all non-repo anchors, `pending.length === 0` early-return, dump fires with just `scan-start`). The harness captures these but doesn't consider them "real" — it waits for a payload that actually went past the fast-path split before starting the drain window. 3-second explicit wait after `page.goto` gives React time to hydrate the README before the gating logic starts.
- **Probe uses raw `performance.now()`, NOT `performance.mark()` / `performance.measure()`.** User Timing API has three specific gotchas for MV3 extensions: content-script isolated-world buffer is invisible to the page, service-worker buffer evicts on SW suspend, and per-realm time origins complicate cross-context correlation. Raw `performance.now()` + an in-memory entries array is simpler, and each entry carries a `ctx: 'cs' | 'sw'` tag so downstream analysis can correlate via absolute `timeOrigin + t`.
- **DCE via `DefinePlugin` + Terser `pure_funcs`, not babel transform or conditional imports.** Already a webpack-native pattern used by Dark Reader and Stylus in their own dev instrumentation. No new build-time deps beyond `terser-webpack-plugin`.
- **Payload allowlist is strict: timing and counts only.** No HTTP headers, no response bodies, no access tokens, no URLs beyond the top-level `pageUrl`. Enforced structurally by the `Extra` type (`Record<string, number | string>`) which prevents object-shaped payloads from sneaking in at the mark site.
- **Console-as-boundary format (`['SNEETCHES_PROBE', jsonString]`) is the contract between the two surfaces.** V8's inspector emits the console event synchronously inside the `console.log` call, so delivery is not racing React main-thread work — contention delays WHEN the probe fires, not WHETHER its output arrives. Same signal for humans reading DevTools and for the measurement script over CDP. If we ever swap the script for a different transport, the probe module doesn't change.
- **`try { ... } finally { probe.dump(label); }` wrapping, not a straight-line `dump` call.** Every scan or SW request dumps exactly once — including failed scans. This was a code review catch from Task 5; before the wrap, a thrown exception would leave the reset/marks orphaned and the next scan's `probe.reset()` would drop the partial envelope silently.
- **14 total probe calls in content.ts** (11 mark + 1 reset + 2 dump in pre-fix; fix collapsed to 11 mark + 1 reset + 1 dump). Coarse phases beat fine profiling for this release's goal. Adding mark-per-appendChild or mark-per-queryParse would bloat the output and make DCE verification harder to read.
- **No CI perf regression job, no synthetic HTML fixtures, no bundle-size CI tracker.** CI perf is a flakiness swamp; synthetic fixtures don't reproduce React contention (the whole thing we're measuring); bundle size isn't a current problem. Ship the measurement loop first; earn the CI stack later if the workflow demands it.

### Backward compatibility
`CACHE_VERSION` stays at `2`. No extension behavior changes. The probe module ships zero bytes to store users (verified via `npm run test:dce`). No new `chrome.storage` keys, no new manifest permissions, no new entry points in the manifest. Firefox `web-ext` builds are unaffected — the DCE happens at webpack time, so both Chrome and Firefox bundles are byte-identical to 1.1.5 modulo the version string update. The `__DEBUG__` global is substituted at build time, so `tsconfig.json`'s ambient-type discovery finds it via `src/globals.d.ts` without any runtime cost.

### First real-world observation from the harness
The first run against awesome-homelab captured **4 back-to-back scans of the same 712 repo anchors**, each with `pending: 712, cached: 712, painted: 712`, all inside a ~500ms window. Interpretation: React re-hydrates the README in waves, and each wave destroys the anchor DOM nodes along with their child annotation spans. The next MutationObserver fire finds 712 "unannotated" anchors again and repaints them. This is an observable perf problem the probe surfaced the very first time it ran successfully — exactly the kind of finding the harness was built to enable. Not fixed in 1.1.6; logged as a candidate follow-up for a future release.

### Follow-up work explicitly enabled
Once 1.1.6 ships and `npm run probe` is a one-command loop, several perf questions become cheap to evaluate: (a) **repeated-paint problem** from the first-run observation above — is it actually the repaint work that's slow, or just MO noise on an already-idle main thread? Probe before/after a fix that memoizes "already-annotated" state in a WeakSet survive-across-rehydration would show the real cost; (b) **SW keepalive ping** (1.1.4 deferred candidate) — write it, probe before/after, read the diff, decide in an afternoon instead of a multi-day investigation; (c) **content-script Worker architecture** (1.1.4 deferred candidate) — the same before/after workflow measures the real savings (research estimated ~500ms–1s) before committing to 2–3 days of implementation. None of these are part of 1.1.6; all benefit from 1.1.6 existing.

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

