## Setup

1. **Node.js 20+** required (use `fnm use 20` or `nvm use 20`)
2. Install [jq](https://stedolan.github.io/jq/) (for Chrome build).
3. `npm install`

## Test

Unit tests: `npm test`

Test in Chrome:

1. `npm run dev`
2. Open `chrome://extensions/`, enable "Developer mode", click "Load unpacked", select `./build`.

To exercise the extension against a known set of repo links, open
`examples/sampler.html` in a browser (e.g. via `python3 -m http.server` in the
repo root, then visit `http://localhost:8000/examples/sampler.html`).

## Build (Chrome)

`npm run build:chrome`

## Build (Firefox)

`npm run build:firefox`

This creates the following files in `dist`:

* sneetches_for_github-${version}.zip — extension package
* sources.zip — source code package

To verify that the Firefox extension is working, visit e.g
<https://github.com/bfred-it/Awesome-WebExtensions#libraries-and-frameworks> and
visually confirm that links are followed by star counts, for example
"webext-options-sync (30★)" instead of "webext-options-sync".

You may need to enter a GitHub Personal Access Token into the options panel, if
the extension has already used up its GitHub API request quota. Current rate-limit
usage is shown in the Advanced tray of the popup as a bar displaying remaining
requests out of the hourly limit.
