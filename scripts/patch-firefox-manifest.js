// Inject or remove `background.scripts` in build/manifest.json to toggle
// between the Firefox-compatible (both keys) and Chrome-clean (service_worker
// only) shapes.
//
// Why the two shapes can't coexist: AMO's static validator rejects MV3
// manifests that only declare `background.service_worker`, even though
// Firefox 121+'s runtime accepts it directly. Chrome emits a user-visible
// "'background.scripts' requires manifest version of 2 or lower" warning
// when it sees the key. So src/manifest.json is Chrome-clean, and this
// script patches `scripts` in only for the Firefox zip, then reverts it
// so build/ is safe to load unpacked in Chrome for dev testing afterward.
//
// Invoked from package.json's `build:firefox`:
//   1. after webpack produces build/, before web-ext zips it → forward
//   2. after web-ext finishes zipping → `--revert` to restore Chrome-clean

const fs = require('fs');
const path = require('path');

const revert = process.argv.includes('--revert');
const manifestPath = path.join(__dirname, '..', 'build', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.background || !manifest.background.service_worker) {
  console.error('patch-firefox-manifest: expected background.service_worker in build/manifest.json');
  process.exit(1);
}

if (revert) {
  if (!manifest.background.scripts) {
    console.log('patch-firefox-manifest: --revert is a no-op (scripts already absent)');
    return;
  }
  delete manifest.background.scripts;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('patch-firefox-manifest: removed background.scripts (Chrome-clean)');
} else {
  if (manifest.background.scripts) {
    console.log('patch-firefox-manifest: already patched (scripts present) — skipping');
    return;
  }
  manifest.background.scripts = [manifest.background.service_worker];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('patch-firefox-manifest: added background.scripts for AMO');
}
