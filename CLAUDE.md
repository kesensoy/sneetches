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
  ├── cache.ts         # Local storage caching (2-hour TTL)
  ├── content.ts       # Content script (main extension logic)
  ├── github.ts        # GitHub API interaction
  ├── settings.ts      # Extension settings management
  ├── options.ts       # Options page UI logic
  ├── utils.ts         # Utility functions (number formatting, date humanization)
  ├── options.html     # Options page HTML
  ├── style.css        # Annotation styles
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
- All 30 tests passing

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
- Jest 29.7.0 (30/30 tests passing)
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

## Extension Features

- Displays GitHub repository stats inline next to repo links
- Shows: stars ⭐, forks ➡, last pushed date ➲
- Caches API responses (2-hour TTL)
- Configurable display options
- Supports GitHub Personal Access Tokens for higher API rate limits
- Works on both Chrome and Firefox

## Rate Limiting

The extension makes a GitHub API call for each repo link on a page:
- **Without token**: 60 requests/hour
- **With token**: 5,000 requests/hour

Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new) and add it in the extension options to avoid rate limiting.

## License

MIT

