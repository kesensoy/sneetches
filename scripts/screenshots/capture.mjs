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
import { spawn } from 'child_process';
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
  {
    // Frames the raw popup screenshot (popup-raw.png, hand-captured by
    // Kevin when the UX changes) on a #0d1117 backdrop. No chips on this
    // page, so the archived-chip wait will time out quickly — that's
    // fine, the image is static. Output matches the pre-1.2.0 popup.png
    // dimensions at 1040x1020.
    label: 'popup',
    html: 'popup.html',
    width: 1040,
    height: 1020,
    dsf: 1,
    out: path.join(ASSETS_DIR, 'popup.png'),
    skipArchivedWait: true,
  },
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
    if (!filePath.startsWith(SCRIPT_DIR)) {
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
          show: { stars: true, forks: true, update: true },
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
        await new Promise((r) => setTimeout(r, 2500));
      } else {
        // Static page (no extension chips). Small settle time is enough.
        await new Promise((r) => setTimeout(r, 500));
      }
      await page.screenshot({
        path: c.out,
        clip: { x: 0, y: 0, width: c.width, height: c.height },
      });
      console.log(`[screenshots:${c.label}] wrote ${path.relative(REPO_ROOT, c.out)}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
