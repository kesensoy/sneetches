#!/usr/bin/env bash
# Firefox build pipeline with guaranteed cleanup.
#
# Wraps the four sequential steps (webpack build → patch manifest → web-ext
# zip → sources.zip) and uses a trap to always restore the Chrome-clean
# manifest on exit, even if one of the steps fails partway through. Prevents
# build/ from being left in a Firefox-patched state (which would emit the
# Chrome "'background.scripts' requires manifest version of 2 or lower"
# warning when a developer next loads build/ as an unpacked Chrome
# extension).
#
# Invoked from package.json's `build:firefox`.

set -e
trap 'node scripts/patch-firefox-manifest.js --revert' EXIT

npm run build
node scripts/patch-firefox-manifest.js
web-ext build -s build -a dist -o
git ls-files | zip -@ dist/sources.zip
