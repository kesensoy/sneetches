# Sneetches - Project Documentation

## Overview
Chrome/Firefox browser extension that adds GitHub repo stats (stars, forks, last pushed date) inline next to GitHub repo links on any webpage. Manifest V3, TypeScript, Webpack-bundled.

## Current state
- Version 1.1.7 in `package.json` / `src/manifest.json`; branch `1.1.8` for structural cleanup work.
- Full Jest suite: 219 tests passing across 8 suites.

## Technology Stack
- **Node.js** 20+ (fnm recommended), **TypeScript** 5.7.2, **Webpack** 5.97.1
- **Jest** 29.7.0 (ts-jest 29.2.5, jest-webextension-mock 3.9.0, jsdom env, custom `tests/chrome-storage.mock.ts`)
- **ESLint** 9.17.0 (flat config) + **Prettier** 3.4.2 + **typescript-eslint** 8.18.2
- **Husky** 9.1.7 + **lint-staged** 15.2.11; pre-commit = format + lint + type check + affected tests; pre-push = full lint/check/test
- **web-ext** 8.3.0 (Firefox packaging), **Puppeteer** 24.41+ (dev probe harness)

No GitHub Actions / CI workflows — husky pre-push is the only gate.

## Project structure
Source under `src/`, tests under `tests/`. Key modules: `content.ts`, `service-worker.ts`, `github.ts`, `cache.ts`, `settings.ts`, `options.ts`, `icons.ts`, `rpc.ts`, `probe.ts`, `utils.ts`. Top-level — no `src/shared/` or `src/debug/` subdirs. Probe CLI at `scripts/probe-run.ts` with its own `scripts/tsconfig.json`.

## Development Commands
```bash
npm run dev           # Development build (Webpack, __DEBUG__=true, probe live)
npm run build         # Production build (__DEBUG__=false, probe DCE'd)
npm run watch         # Dev build, watch mode
npm run build:firefox # Prod build + web-ext package
npm run lint          # ESLint
npm run format        # Prettier write
npm run check         # tsc --noEmit
npm test              # Jest
npm run test:dce      # Prod build + grep build/*.js for 'SNEETCHES_PROBE' leak
npm run probe         # ts-node scripts/probe-run.ts (requires --url --label)
```

## Architecture + Locked-in Decisions

Invariants organized by subsystem. These are load-bearing — future work must not unknowingly reverse them.

### Manifest / extension shape
- `content_scripts.matches` is `["http://*/*", "https://*/*"]`, NOT `*://*/*`. Keeps `file://`, `chrome://`, `about:` etc. out of the injection set.
- `host_permissions` is tight to `https://api.github.com/*`, NOT `<all_urls>`. The content script talks through the service worker; no host access needed on host pages.
- `permissions` is `["storage"]` only.
- `content_scripts.run_at` is `"document_start"`. This is what makes the preload cheap — the content script runs before the HTML parser finishes, giving `readAllCachedRepos` a main-thread window before React / 1Password / GitHub chrome start contending. Moving it to `document_idle` would reintroduce the multi-second storage-read stalls we spent 1.1.3–1.1.4 eliminating.
- `background` SW uses `"type": "module"`. Firefox 121+ (Dec 2023) supports this; older Firefox is out of scope.
- No `key` field on manifest.json — adding one would conflict with the Chrome Web Store extension ID.

### Cache layer (`src/cache.ts`)
- **`CACHE_VERSION = 2`** (exported from `src/github.ts`; `content.ts` imports it). On-disk entry shape is `{exp: number, pay: T, ver: V}` — do not change the field names; 1.1.0 entries at `ver: 1` are still silently dropped by the version-mismatch path.
- Four primitives: `bulkReadCache(keys, version)` (array-in / partition-out into `{cached, missing}`), `bulkWriteCache(fresh, version)` (fire-and-forget, clears cache area on storage error), `readAllCachedRepos(version)` (single `get(null)` for the preload path, filters by nwo-shape `"owner/name"`), `getCacheEntryCount` / `clearCache` (both exclude the `rate_limit` key). The earlier `locallyCached` / `locallyCachedBatch` helpers are deleted — do not resurrect them.
- `RATE_LIMIT_KEY = 'rate_limit'` is duplicated as a local constant in `cache.ts` rather than imported from `github.ts` to avoid a `cache.ts ← github.ts ← cache.ts` cycle. Comment in source explains; don't "fix" it.

### Data layer (`src/github.ts`)
- **`BATCH_SIZE = 10`**. Found empirically in 1.1.7 probe sweep — cold-cache wall clock: 5=2.4s, 10=2.9s, 25=3.3s, 50=6.1s, 200=8.7s. Smaller batches parallelize better against GitHub's GraphQL latency despite the round-trip overhead. Halve on HTTP 422; do NOT increase without a probe run backing it.
- Dispatcher is `fetchRepoDataStreaming(nwos, accessToken, onResults)`. One `bulkReadCache` up front fires `onResults` with the cached subset, then chunked `fetchGraphQLBatch` (PAT) or parallel per-repo REST (unauth) each writes its chunk via `bulkWriteCache + onResults`. Per-repo errors (NOT_FOUND, FORBIDDEN) become map entries; transport failures (401, 5xx, network) throw.
- **`RepoResponse` is a discriminated union** `{kind: 'ok', json} | {kind: 'error', status?} | {kind: 'silent'}`. Do NOT overload booleans (`ok`, `silent`) on a flat object — that shape was removed deliberately. Every consumer switches on `kind`.
- GraphQL error distribution: `NOT_FOUND` → `kind: 'error', status: 404` (cached), `FORBIDDEN` → `kind: 'silent'` (cached, so an awesome-list page with private repos under a limited PAT doesn't re-POST every scan), anything else → `kind: 'silent'` + `console.error`. HTTP 401 clears `TOKEN_VALIDATED_KEY` and throws.
- One-time `console.warn` if GraphQL `rateLimit.cost > 1` so a future GitHub pricing change surfaces.
- User-Agent is `kesensoy/sneetches`, not `osteele/sneetches`.

### Service worker (`src/service-worker.ts`) and RPC (`src/rpc.ts`)
- **Port-based transport, not `chrome.runtime.sendMessage`.** Port name `SNEETCHES_PORT_NAME = 'sneetches:fetchRepos'`. Long-lived port supports progressive reveal: cache-hit subset fires first, then one chunk per fresh GraphQL batch. A single-shot sendMessage would have to wait for all chunks.
- **Single-shot port per scan.** The SW disconnects after `'done'` or `'error'`; the content script opens a fresh port per scan.
- Message shape is `ChunkMsg | DoneMsg | ErrorMsg` discriminated union, defined once in `rpc.ts` and imported by both sides.
- SW is pure transport glue — it reads the access token and delegates to `fetchRepoDataStreaming`. All repo-data knowledge stays in `github.ts`.
- **Service worker owns all writes to `chrome.storage.local`.** The content script's `inMemoryRepoCache` is read-only relative to the disk cache; new cache hits during a scan do NOT live-update the mirror. Avoids a dual-writer race with the SW's `bulkWriteCache` calls.

### Content script (`src/content.ts`)
- **In-memory cache mirror**: module-level `inMemoryRepoCache: Map<string, RepoResponse> | null`, populated at module load by `runPreload()` which calls `readAllCachedRepos(CACHE_VERSION)`. `updateLinks` splits pending anchors into cached (painted synchronously via `paintResult`) and uncached (sent through the port path with a reduced `uniqueNwos` list).
- **Preload race protection**: `preloadGeneration` counter. `handleSyncStorageChange` bumps it + nulls `inMemoryRepoCache` on access-token change; an in-flight preload captures its generation at start and drops its result if superseded. Show/starStyle changes do NOT invalidate the mirror — repo data is still valid; only rendering changes.
- **Settings cache**: `cachedSettings: Promise<CachedSettings> | null` one-shot. `getCachedSettings()` returns the in-flight or resolved promise; `invalidateCachedSettings()` clears it. Called from `applySettingsChange`'s `onChanged` listener so fresh values are picked up. Rejections self-clear so the next call retries. Fixes the 1.1.2 5-second `chrome.storage.sync.get` stall under React contention.
- **MutationObserver microtasks beat setTimeout under React contention.** Leading-edge MO trigger: when any added subtree is-or-contains `a[href^="https://github.com/"]`, call `updateAnnotationsFromSettings()` directly from the MO callback (throttled 100ms via `lastLeadingEdgeAt`). Do NOT rely solely on `setTimeout` debouncing — under continuous React hydration bursts, setTimeout slots can be delayed 4+ seconds. Keep the 300ms rolling debounce + 500ms max-wait cap as a backstop.
- Deferred init: `startLinkScanner` and `detectStarredStateOnSneetchesRepo` wait for `<body>` via a `MutationObserver` on `document.documentElement`. Not `DOMContentLoaded` / `setTimeout` — same contention reason.
- **Scan epochs + in-flight WeakMap** preserve correctness across mid-flight settings changes. Every `updateLinks` call runs under an epoch; settings-change bumps it; each paint re-checks.
- Per-scan `ProbeFrame` held in a local variable — concurrent scans interleave on `await` points, so a shared-state stack would clobber. Per-frame design is load-bearing, not a style choice.

### UI — popup / options (`src/options.ts`, `src/options.html`, `src/popup.css`)
- Branded dark header with 8-color star-constellation logo + Sneetches wordmark + tagline.
- Horizontal pill toggles for Stars/Forks/Last push; token field with eye-toggle + Test button (`GET /user`); Advanced disclosure tray with rate-limit gradient bar + cache entry count + Clear cache.
- "Star us?" CTA in popup header: gray at rest, gold on hover, locks gold when user has starred `github.com/kesensoy/sneetches` (detected via DOM scrape + MutationObserver).
- Footer shows version from `chrome.runtime.getManifest().version`.
- Settings keys live in `src/settings.ts`: `access_token`, `show`, `star_style`, `advanced_open`, `token_validated`, `has_starred`, `toolbar_icon` (sync). `rate_limit` is the only non-repo key in local storage.

### Chip design (`src/style.css`, `src/icons.ts`, `src/content.ts`)
- Every chip is `.sneetch-*` + padded span + Octicon SVG + text + `aria-label` + `title` tooltip. Use the `buildChip` helper.
- Chip classes: `.sneetch-stars` / `.sneetch-forks` / `.sneetch-date` / `.sneetch-archived` / `.sneetch-broken` / `.sneetch-rate-limited` / `.sneetch-error`.
- Absolute `12px` font-size on all chips (pre-1.1.2 `0.9em` blew up on host pages with 28px base font). `.sneetch-icon` stays `0.9em` because it sizes relative to the chip.
- **`.is-archived` modifier must dim siblings via per-chip rules, NOT wrapper-level `opacity`.** A wrapper opacity rule would dim the archive chip itself due to CSS opacity cascading. Existing comment in `style.css` warns against this.
- Three-wash error system: red (`#d1242f`) broken / amber (`#d97706`) rate-limited / green (`#1a7f37`) else. Amber shares with `.sneetch-archived` — intentional; both are "not fully available" and can't appear on the same anchor. Green-as-success collision is accepted because the `else` branch is rare and `bug` + "error" wording disambiguates.
- Icons (inline Octicons SVG, no npm dep): `archiveIcon`, `bugIcon`, `clockIcon`, `forkIcon`, `hourglassIcon`, `starIcon(filled?)`, `unlinkIcon`. `unlink` is the upstream's closest "broken chain" glyph (no `link-slash` in current Octicons).
- Display date prefers `committed_date ?? pushed_at`; tooltip is `"last updated"` (convergent with npm/PyPI/crates.io/pkg.go.dev). Archive chip is unconditional (not gated on a show setting).

### Dev probe (`src/probe.ts`, `scripts/probe-run.ts`)
- **`__DEBUG__` runtime global** substituted by webpack `DefinePlugin` (true in dev/test, false in prod). Declared in `src/globals.d.ts`. Jest passes `__DEBUG__: true` via `globals`.
- Production DCE via Terser `pure_funcs: ['probe.newFrame', 'frame.mark', 'frame.dump']` + `passes: 2`. `npm run test:dce` greps the prod bundle for `SNEETCHES_PROBE` as a safety check. Call sites MUST use the `probe.newFrame` / `frame.mark` / `frame.dump` naming shape or DCE silently stops working — the test catches it.
- `tests/probe-silence.ts` in `setupFiles` swallows `SNEETCHES_PROBE` console output during non-probe tests.
- **Payload allowlist: timing + counts only.** No HTTP headers, no response bodies, no access tokens, no URLs beyond the top-level `pageUrl` (query + fragment stripped). Enforced by the `Extra = Record<string, number | string>` type at the mark site.
- Console-as-boundary format: `console.log('SNEETCHES_PROBE', JSON.stringify(payload))`. V8 emits it synchronously inside the call; the CDP listener in `scripts/probe-run.ts` ingests it.
- Probe harness uses **Puppeteer 24+ driving Chrome for Testing**, NOT raw CDP / not chrome-devtools MCP / not real branded Chrome. Persistent profile at `<repo>/.sneetches-probe/profile/` (gitignored). PAT sourced from `.env.probe` → `SNEETCHES_PROBE_GITHUB_PAT`. Never use `chrome-devtools MCP` on authed endpoints — it dumps Authorization headers into context.

## Rate limiting
Without a PAT: 60 req/hour. With PAT: 5000 req/hour. Advanced tray shows current usage from captured `x-ratelimit-*` headers + GraphQL `rateLimit` sibling.

## License
MIT
