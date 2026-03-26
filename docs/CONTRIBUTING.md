## Setup

1. **Node.js 20+** required (use `fnm use 20` or `nvm use 20`)
2. Install [jq](https://stedolan.github.io/jq/) (for Chrome build).
3. `npm install`

## Test

Unit tests: `npm test`

Test in Chrome:

1. `npm run dev`
2. Open `chrome://extensions/`, enable "Developer mode", click "Load unpacked", select `./build`.

Use Python to run a local HTTP server, and open the `./example/sampler.html`
sampler in the default browser: `npm run sampler`.

This leaves the Python server running. Run `lsof -i :8000` to find the PID and
`kill` it.

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
the extension has already used up its GitHub API request quota. The extension
doesn't currently visually indicate this state.
