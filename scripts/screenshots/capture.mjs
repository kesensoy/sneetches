#!/usr/bin/env node
// Regenerates the committed screenshot assets:
//   assets/comparison.png       — store-listing + README comparison
//   assets/social-preview.png   — GitHub repo social preview (link unfurls)
//
// Flow:
//   1. Load .env.probe for SNEETCHES_PROBE_GITHUB_PAT (same env file the
//      probe harness uses, so one PAT covers both workflows).
//   2. Build extension in prod mode if build/ is missing.
//   3. Start a tiny in-process HTTP server on 127.0.0.1:8765 serving
//      scripts/screenshots/*.html — Sneetches' content_scripts only
//      inject on http(s)://*, so file:// doesn't work.
//   4. Launch Chrome for Testing with --load-extension=build/ using the
//      persistent probe profile dir.
//   5. Inject PAT + force all show-toggles on + filled star style, so
//      renders are deterministic regardless of profile state.
//   6. For each capture, navigate, wait for the first archived chip (proof
//      the GraphQL round-trip completed), drain briefly, screenshot the
//      logical viewport at DSF=2 for retina output.
//
// Usage: npm run screenshots

import puppeteer from 'puppeteer';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const BUILD_DIR = path.join(REPO_ROOT, 'build');
const PROFILE_DIR = path.join(REPO_ROOT, '.sneetches-probe', 'profile');
const ENV_PATH = path.join(REPO_ROOT, '.env.probe');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const PORT = 8765;

// Logical viewport × DSF = physical output. Matches the dimensions
// already on file in assets/ (and that the stores accepted).
const CAPTURES = [
  {
    label: 'comparison',
    html: 'store-screenshot.html',
    width: 1200,
    height: 340,
    dsf: 2,
    out: path.join(ASSETS_DIR, 'comparison.png'),
  },
  {
    label: 'social-preview',
    html: 'social-preview.html',
    width: 1280,
    height: 640,
    dsf: 2,
    out: path.join(ASSETS_DIR, 'social-preview.png'),
  },
  // Chrome Web Store assets — strict canvas sizes. CWS accepts JPEG OR
  // 24-bit-PNG-no-alpha; we go PNG for sharper text. Puppeteer's PNG
  // output includes an alpha channel (32-bit RGBA) even with a fully
  // opaque background, which CWS's validator rejects, so we route the
  // screenshot through `sips -s format png` (stripAlpha) — sips re-encodes
  // as 24-bit RGB PNG with no alpha. macOS-only, but this is a dev-time
  // tool so that's fine.
  {
    label: 'cws-screenshot',
    html: 'cws-screenshot.html',
    width: 1280,
    height: 800,
    dsf: 1,
    out: path.join(ASSETS_DIR, 'cws-screenshot.png'),
    stripAlpha: true,
  },
  {
    label: 'cws-promo-small',
    html: 'cws-promo-small.html',
    width: 440,
    height: 280,
    dsf: 1,
    out: path.join(ASSETS_DIR, 'cws-promo-small.png'),
    stripAlpha: true,
    skipArchivedWait: true,
  },
  {
    label: 'cws-promo-marquee',
    html: 'cws-promo-marquee.html',
    width: 1400,
    height: 560,
    dsf: 1,
    out: path.join(ASSETS_DIR, 'cws-promo-marquee.png'),
    stripAlpha: true,
  },
  // Popup has its own dedicated capture flow (capturePopup) below: renders
  // the real extension options.html at chrome-extension://<ID>/ with rich
  // state injected, then crops to the body bbox. No backdrop. Renders in
  // an extension tab rather than the toolbar popup window so Chrome's
  // theme-tinted popup border doesn't leak into the shot.
];

async function loadEnv() {
  let content;
  try {
    content = await fs.readFile(ENV_PATH, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function ensureProdBuild() {
  const contentPath = path.join(BUILD_DIR, 'content.js');
  if (!existsSync(contentPath)) {
    console.log('[screenshots] build/ missing; running `npm run build`');
    await new Promise((resolve, reject) => {
      const p = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`build failed (${code})`))
      );
    });
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    const filePath = path.join(SCRIPT_DIR, rel);
    // Path-traversal guard — resolved path must stay inside SCRIPT_DIR.
    // Anchor to the directory boundary (SCRIPT_DIR + sep) so a sibling
    // directory whose name shares SCRIPT_DIR's textual prefix (e.g.
    // /foo/scripts_attack when SCRIPT_DIR is /foo/scripts) can't slip
    // past startsWith.
    if (filePath !== SCRIPT_DIR && !filePath.startsWith(SCRIPT_DIR + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath)
      .then((data) => {
        const ext = path.extname(filePath).toLowerCase();
        const ct =
          ext === '.html'
            ? 'text/html; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : ext === '.js' || ext === '.mjs'
                ? 'text/javascript; charset=utf-8'
                : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
      })
      .catch(() => {
        res.writeHead(404);
        res.end('not found');
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `[screenshots] port ${PORT} is already in use. Kill the other listener (lsof -iTCP:${PORT} -sTCP:LISTEN) or change PORT.`
          )
        );
      } else {
        reject(err);
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function findSwTarget(browser) {
  for (const t of browser.targets()) {
    if (t.type() === 'service_worker' && t.url().endsWith('service-worker.js')) return t;
  }
  return browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('service-worker.js'),
    { timeout: 15000 }
  );
}

// Extract the extension ID from the service worker target's URL. Used
// to construct chrome-extension://<ID>/options.html for the popup shot.
async function getExtensionId(browser) {
  const t = await findSwTarget(browser);
  const m = t.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (!m) throw new Error(`[screenshots] unexpected SW URL: ${t.url()}`);
  return m[1];
}

// Popup: render the actual extension UI (options.html in a
// chrome-extension:// context) with rich state injected, then crop
// to the body's bounding box. No backdrop framing — output is just
// the popup itself, theme-free since it's rendered in an extension
// tab instead of the floating popup window (which Chrome decorates
// with the user's theme accent).
async function capturePopup(browser) {
  const extId = await getExtensionId(browser);
  const popupUrl = `chrome-extension://${extId}/options.html`;

  // Inject state BEFORE navigating so DOMContentLoaded sees it.
  const target = await findSwTarget(browser);
  const worker = await target.worker();
  console.log('[screenshots:popup] injecting rich state for render');
  await worker.evaluate(async () => {
    await new Promise((res) =>
      chrome.storage.sync.set(
        {
          access_token: 'ghp_ExampleReadmeScreenshotTokenEndingIn493C',
          token_validated: true,
          show: { stars: true, forks: true, update: true, contributors: true },
          star_style: 'filled',
          has_starred: true,
          advanced_open: true,
          // Sample owners so the Skip-owners row + Manage panel render
          // with realistic content in the README screenshot.
          skip_owners: ['acme-corp', 'legacy-co'],
        },
        () => res()
      )
    );
    // rate_limit + 1127 fake cache entries → Advanced tray reads
    // "4,886 / 5,000 per hour" + "1127 entries".
    const now = Date.now();
    const entries = { rate_limit: { limit: 5000, remaining: 4886 } };
    for (let i = 0; i < 1127; i++) {
      entries[`demo-org${i}/demo-repo${i}`] = {
        exp: now + 3600 * 1000,
        pay: { kind: 'ok', json: {} },
        ver: 2,
      };
    }
    await new Promise((res) => chrome.storage.local.set(entries, () => res()));
  });
  await new Promise((r) => setTimeout(r, 500));

  // Render options.html at popup width (body.is-popup sets 324px).
  // DSF=2 for retina-sharp text. Viewport extra-tall so the Manage
  // panel doesn't push the body past the visible region.
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 1100, deviceScaleFactor: 2 });
  await page.goto(popupUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await page
    .waitForSelector('#token-collapsed:not([hidden])', { timeout: 5000 })
    .catch(() =>
      console.warn('[screenshots:popup] #token-collapsed never became visible — proceeding')
    );
  // Open the Skip-owners Manage panel so the screenshot shows the
  // feature's actual surface (list + input + tip), not just a row.
  await page
    .evaluate(() => {
      const btn = document.getElementById('skip-owners-toggle');
      if (btn instanceof HTMLElement) btn.click();
    })
    .catch(() =>
      console.warn(
        '[screenshots:popup] #skip-owners-toggle click failed — Manage panel may be closed'
      )
    );
  await new Promise((r) => setTimeout(r, 500));

  const bbox = await page.evaluate(() => {
    const b = document.body;
    return { width: b.offsetWidth, height: b.offsetHeight };
  });

  await page.screenshot({
    path: path.join(ASSETS_DIR, 'popup.png'),
    clip: { x: 0, y: 0, width: bbox.width, height: bbox.height },
  });
  await page.close();

  console.log(
    `[screenshots:popup] wrote ${path.relative(REPO_ROOT, path.join(ASSETS_DIR, 'popup.png'))} (${bbox.width * 2}x${bbox.height * 2})`
  );
}

async function ensureSettings(browser, pat) {
  const target = await findSwTarget(browser);
  const worker = await target.worker();
  if (!worker) throw new Error('no SW worker handle');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const ready = await worker.evaluate(
        () => typeof chrome !== 'undefined' && !!chrome.storage?.sync
      );
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // Force all three show-toggles on + filled stars. Setting access_token
  // to the same value is a no-op per chrome.storage onChanged semantics,
  // so this doesn't trigger the handleSyncStorageChange cache-clear path.
  console.log('[screenshots] injecting PAT + show + star_style');
  await worker.evaluate(async (token) => {
    return new Promise((res) => {
      chrome.storage.sync.set(
        {
          access_token: token,
          token_validated: true,
          show: { stars: true, forks: true, update: true, contributors: true },
          star_style: 'filled',
        },
        () => res()
      );
    });
  }, pat);
  await new Promise((r) => setTimeout(r, 500));
}

async function main() {
  await loadEnv();
  const pat = process.env.SNEETCHES_PROBE_GITHUB_PAT;
  if (!pat) {
    throw new Error(
      '[screenshots] SNEETCHES_PROBE_GITHUB_PAT not set. Put it in .env.probe at the repo root.'
    );
  }

  await ensureProdBuild();

  console.log(`[screenshots] starting HTTP server on 127.0.0.1:${PORT}`);
  const server = await startServer();

  // Ensure probe profile dir exists on a fresh clone. Chrome for Testing
  // would auto-create it, but being explicit matches scripts/probe-run.ts
  // and makes the invariant checkable.
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  console.log('[screenshots] launching Chrome for Testing');
  const browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    userDataDir: PROFILE_DIR,
    enableExtensions: [BUILD_DIR],
    args: [
      '--window-position=-10000,-10000',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    await ensureSettings(browser, pat);
    for (const c of CAPTURES) {
      console.log(`[screenshots:${c.label}] capturing ${c.html}`);
      const page = await browser.newPage();
      await page.setViewport({ width: c.width, height: c.height, deviceScaleFactor: c.dsf });
      await page.goto(`http://127.0.0.1:${PORT}/${c.html}`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      if (!c.skipArchivedWait) {
        try {
          await page.waitForSelector('.sneetch-archived', { timeout: 15000 });
        } catch {
          console.warn(`[screenshots:${c.label}] no archived chip within 15s — proceeding`);
        }
        // Contributors lives on a separate port + per-repo REST pipeline
        // that lands AFTER the GraphQL repo chunks. Wait for at least one
        // contributor chip too so the demo shots include the 4-chip
        // variant rather than racing the screenshot ahead of paint.
        try {
          await page.waitForSelector('.sneetch-contributors', { timeout: 15000 });
        } catch {
          console.warn(`[screenshots:${c.label}] no contributor chip within 15s — proceeding`);
        }
        await new Promise((r) => setTimeout(r, 2500));
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
      const screenshotPath = c.stripAlpha ? `${c.out}.tmp` : c.out;
      await page.screenshot({
        path: screenshotPath,
        clip: { x: 0, y: 0, width: c.width, height: c.height },
        ...(c.type === 'jpeg' ? { type: 'jpeg', quality: 92 } : {}),
      });
      if (c.stripAlpha) {
        // sips re-encodes as 24-bit RGB PNG (no alpha), satisfying CWS.
        const r = spawnSync('sips', ['-s', 'format', 'png', screenshotPath, '--out', c.out], {
          stdio: 'pipe',
        });
        if (r.status !== 0) {
          throw new Error(`[screenshots:${c.label}] sips failed: ${r.stderr?.toString() ?? ''}`);
        }
        await fs.unlink(screenshotPath);
      }
      console.log(`[screenshots:${c.label}] wrote ${path.relative(REPO_ROOT, c.out)}`);
      await page.close();
    }
    await capturePopup(browser);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
