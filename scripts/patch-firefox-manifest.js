// Inject `background.scripts` into build/manifest.json for the Firefox build.
//
// Why: AMO's static validator rejects MV3 manifests that only declare
// `background.service_worker`, even though Firefox 121+'s runtime
// accepts it directly. Chrome, on the other hand, emits a user-visible
// "'background.scripts' requires manifest version of 2 or lower"
// warning when it sees the key. So the keys can't coexist in the
// shipped Chrome artifact — we keep src/manifest.json Chrome-clean
// and patch `scripts` in only for the Firefox zip.
//
// Run from package.json's `build:firefox` after webpack produces build/
// and before web-ext zips it.

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'build', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.background || !manifest.background.service_worker) {
  console.error('patch-firefox-manifest: expected background.service_worker in build/manifest.json');
  process.exit(1);
}

manifest.background.scripts = [manifest.background.service_worker];

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('patch-firefox-manifest: added background.scripts for AMO');
