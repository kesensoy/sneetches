#!/usr/bin/env node
// Local dev measurement harness.
//
// Drives a perf probe against the sneetches Chrome extension without
// touching the user's real Chrome. The flow is:
//
//   1. Load .env.probe at the repo root (for SNEETCHES_PROBE_GITHUB_PAT)
//   2. Build the extension in development mode (unless fresh)
//   3. Launch Chrome for Testing via Puppeteer with the unpacked
//      extension loaded via `enableExtensions`, using a persistent
//      profile dir at ~/.sneetches-probe/profile/
//   4. Attach to the extension's service-worker target and inject the
//      PAT into chrome.storage.sync if it's not already there
//   5. Open a new page, wire a console listener, navigate to the
//      target URL, wait for the SNEETCHES_PROBE envelope, drain for
//      500ms, close the browser
//   6. Write the captured payloads to docs/plans/probe-runs/ and print
//      a diff table against the most recent previous run
//
// Design doc: docs/plans/2026-04-15-1.1.6-dev-instrumentation-design.md
// Usage:
//   npm run probe
//   npm run probe -- --url https://github.com/some/list
//   npm run probe -- --label my-experiment

import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import puppeteer, { Browser, ConsoleMessage, Target } from 'puppeteer';

const DEFAULT_TARGET_URL = 'https://github.com/miantiao-me/awesome-homelab';
const CAPTURE_TIMEOUT_MS = 60_000;
const POST_CAPTURE_DRAIN_MS = 500;
const SW_TARGET_TIMEOUT_MS = 15_000;
const PROBE_PROFILE_DIR = path.join(os.homedir(), '.sneetches-probe', 'profile');

interface Args {
  url: string;
  label?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { url: DEFAULT_TARGET_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      args.url = argv[++i];
    } else if (a === '--label') {
      args.label = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run probe [-- --url URL] [--label LABEL]');
      process.exit(0);
    }
  }
  return args;
}

function slugify(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// Minimal .env parser. Reads the repo-root .env.probe (if present) and
// sets any KEY=VALUE pairs into process.env. Skips comments, blank
// lines, and ignores quoted values' surrounding quotes. Silent no-op
// if the file doesn't exist — the script will fail later at the PAT
// check with a clear error.
async function loadEnvProbe(): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env.probe');
  let content: string;
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't overwrite anything already set in the shell environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function isStale(file: string, thresholdMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs > thresholdMs;
  } catch {
    return true;
  }
}

async function ensureDevBuild(): Promise<string> {
  const buildPath = path.resolve(process.cwd(), 'build');
  const manifestPath = path.join(buildPath, 'manifest.json');
  const contentPath = path.join(buildPath, 'content.js');
  // Trigger a rebuild if: build is missing, stale (>60s), or looks
  // like a production build (no SNEETCHES_PROBE envelope, because
  // Terser's pure_funcs stripped it). The probe canary doubles as
  // the "is this a dev build?" check.
  let needsBuild =
    !existsSync(manifestPath) || !existsSync(contentPath) || (await isStale(contentPath, 60_000));
  if (!needsBuild) {
    const existing = await fs.readFile(contentPath, 'utf-8');
    if (!existing.includes('SNEETCHES_PROBE')) {
      console.log('[probe-run] existing build/ is a production build; rebuilding in dev mode');
      needsBuild = true;
    }
  }
  if (needsBuild) {
    console.log('[probe-run] running `npm run dev`...');
    await new Promise<void>((resolve, reject) => {
      const b = spawn('npm', ['run', 'dev'], { stdio: 'inherit' });
      b.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`dev build failed (${code})`))
      );
    });
  }
  // Post-build sanity check
  const content = await fs.readFile(contentPath, 'utf-8');
  if (!content.includes('SNEETCHES_PROBE')) {
    throw new Error(
      '[probe-run] dev build does not contain SNEETCHES_PROBE — is __DEBUG__ set correctly?'
    );
  }
  return buildPath;
}

// Find (or wait for) the extension's service worker target so we can
// inject settings via chrome.storage.sync from inside the SW context.
// MV3 SWs register asynchronously after the extension loads; on a
// cold profile the target may not exist yet when we first check.
async function findServiceWorkerTarget(browser: Browser): Promise<Target> {
  // Check existing targets first — on warm profiles the SW is already up.
  for (const t of browser.targets()) {
    if (t.type() === 'service_worker' && t.url().endsWith('service-worker.js')) {
      return t;
    }
  }
  return browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('service-worker.js'),
    { timeout: SW_TARGET_TIMEOUT_MS }
  );
}

// Inject the GitHub PAT into the extension's chrome.storage.sync iff
// it's not already there. Persistent profile means most runs are a
// no-op on this step, which is the intended behavior — changing the
// PAT on every run would wipe the local cache via the extension's
// handleSyncStorageChange handler and we'd always measure cold cache.
async function ensurePatConfigured(browser: Browser, pat: string): Promise<void> {
  const swTarget = await findServiceWorkerTarget(browser);
  const worker = await swTarget.worker();
  if (!worker) {
    throw new Error('[probe-run] service worker target has no worker handle');
  }
  const existing = await worker.evaluate(async () => {
    return new Promise<string | undefined>((resolve) => {
      chrome.storage.sync.get(['access_token'], (r) => resolve(r.access_token));
    });
  });
  if (existing === pat) {
    console.log('[probe-run] PAT already configured in persistent profile');
    return;
  }
  if (existing) {
    console.log('[probe-run] PAT in profile differs from env; updating');
  } else {
    console.log('[probe-run] PAT not set in profile; injecting');
  }
  await worker.evaluate(async (token: string) => {
    return new Promise<void>((resolve) => {
      chrome.storage.sync.set({ access_token: token, token_validated: true }, () => resolve());
    });
  }, pat);
  // Small pause so the SW's own settings-change listeners settle
  // before we start measuring.
  await new Promise((r) => setTimeout(r, 500));
}

interface ProbeEntry {
  phase: string;
  t: number;
  extra?: Record<string, number | string>;
}

interface ProbePayload {
  label: string;
  ctx: 'cs' | 'sw';
  timeOrigin: number;
  version: string;
  pageUrl?: string;
  entries: ProbeEntry[];
}

interface ProbeRun {
  meta: { timestamp: string; url: string; label: string | null };
  payloads: ProbePayload[];
}

async function printDiffAgainstLatest(runsDir: string, currentPath: string): Promise<void> {
  let files: string[];
  try {
    files = (await fs.readdir(runsDir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(runsDir, f))
      .sort();
  } catch {
    files = [];
  }
  const previousFiles = files.filter((f) => f !== currentPath);
  if (previousFiles.length === 0) {
    console.log('[probe-run] first run — no baseline to diff against');
    return;
  }
  const previousPath = previousFiles[previousFiles.length - 1];
  console.log(`[probe-run] diffing against previous run: ${path.basename(previousPath)}`);

  const current: ProbeRun = JSON.parse(await fs.readFile(currentPath, 'utf-8'));
  const previous: ProbeRun = JSON.parse(await fs.readFile(previousPath, 'utf-8'));

  // Pick the last "real" payload per context (most recent scan that
  // actually found work to do). Empty pre-hydration scans have only
  // scan-start and would produce a useless single-row diff.
  const lastReal = (run: ProbeRun, ctx: 'cs' | 'sw'): ProbePayload | undefined => {
    const reals = run.payloads.filter(
      (p) =>
        p.ctx === ctx && (p.ctx === 'sw' || p.entries.some((e) => e.phase === 'pending-collected'))
    );
    return reals[reals.length - 1];
  };

  for (const ctx of ['cs', 'sw'] as const) {
    const cur = lastReal(current, ctx);
    const prev = lastReal(previous, ctx);
    if (!cur || !prev) continue;

    console.log(`\n--- ${ctx.toUpperCase()} phase diff ---`);
    const rows: Array<[string, string, string, string]> = [
      ['phase', 'prev (ms)', 'curr (ms)', 'delta'],
    ];
    const curByPhase = new Map(cur.entries.map((e) => [e.phase, e.t]));
    const prevByPhase = new Map(prev.entries.map((e) => [e.phase, e.t]));
    const allPhases = Array.from(new Set([...curByPhase.keys(), ...prevByPhase.keys()]));
    for (const phase of allPhases) {
      const c = curByPhase.get(phase);
      const p = prevByPhase.get(phase);
      const pStr = p === undefined ? '—' : p.toFixed(0);
      const cStr = c === undefined ? '—' : c.toFixed(0);
      const delta =
        c !== undefined && p !== undefined ? `${c - p >= 0 ? '+' : ''}${(c - p).toFixed(0)}` : '—';
      rows.push([phase, pStr, cStr, delta]);
    }
    const widths = [0, 0, 0, 0];
    for (const row of rows) {
      for (let i = 0; i < 4; i++) {
        widths[i] = Math.max(widths[i], row[i].length);
      }
    }
    for (const row of rows) {
      console.log(
        `  ${row[0].padEnd(widths[0])}  ${row[1].padStart(widths[1])}  ${row[2].padStart(widths[2])}  ${row[3].padStart(widths[3])}`
      );
    }
  }
}

async function main(): Promise<void> {
  await loadEnvProbe();

  const args = parseArgs(process.argv.slice(2));
  console.log(`[probe-run] target URL: ${args.url}`);

  const pat = process.env.SNEETCHES_PROBE_GITHUB_PAT;
  if (!pat) {
    throw new Error(
      '[probe-run] SNEETCHES_PROBE_GITHUB_PAT not set. Put it in .env.probe at the repo root or export it in your shell.'
    );
  }

  const buildPath = await ensureDevBuild();

  // Ensure persistent profile dir exists. Puppeteer will populate it
  // on first run; subsequent runs reuse the same Chrome state.
  await fs.mkdir(PROBE_PROFILE_DIR, { recursive: true });
  console.log(`[probe-run] profile dir: ${PROBE_PROFILE_DIR}`);

  console.log('[probe-run] launching Chrome for Testing via Puppeteer...');
  const browser: Browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    userDataDir: PROBE_PROFILE_DIR,
    enableExtensions: [buildPath],
    args: [
      '--window-position=-10000,-10000',
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Every `console.log('SNEETCHES_PROBE', ...)` from the extension
  // lands here. `captured` accumulates ALL payloads, including empty
  // pre-hydration scans (where `updateLinks` early-returns at
  // `pending.length === 0` before any mark other than SCAN_START
  // fires). Those are still data — preserved in the output file for
  // debugging — but they don't count as "real" captures for the
  // purpose of the wait/drain logic.
  const captured: ProbePayload[] = [];
  let lastRealCaptureAt: number | null = null;

  // A "real" capture is one where the scan ran past the fast-path
  // split: content-script scans with PENDING_COLLECTED (meaning at
  // least one repo anchor was found and classified), or service-
  // worker envelopes which are always "real" since the SW only
  // emits when a fetch request actually ran.
  const isRealCapture = (p: ProbePayload): boolean => {
    if (p.ctx === 'sw') return true;
    return p.entries.some((e) => e.phase === 'pending-collected');
  };

  try {
    await ensurePatConfigured(browser, pat);

    console.log('[probe-run] opening page + wiring console listener');
    const page = await browser.newPage();

    const handleConsole = (msg: ConsoleMessage): void => {
      const text = msg.text();
      if (!text.startsWith('SNEETCHES_PROBE')) return;
      void (async () => {
        try {
          const handles = msg.args();
          if (handles.length < 2) return;
          const tag = (await handles[0].jsonValue()) as string;
          if (tag !== 'SNEETCHES_PROBE') return;
          const jsonStr = (await handles[1].jsonValue()) as string;
          const payload = JSON.parse(jsonStr) as ProbePayload;
          captured.push(payload);
          if (isRealCapture(payload)) {
            lastRealCaptureAt = Date.now();
          }
        } catch (err) {
          console.warn('[probe-run] failed to parse SNEETCHES_PROBE payload:', err);
        }
      })();
    };
    page.on('console', handleConsole);

    // Also listen on any pages already open (e.g. the default new-tab
    // page) just in case extension activity there emits a probe.
    for (const p of await browser.pages()) {
      if (p !== page) p.on('console', handleConsole);
    }

    console.log(`[probe-run] navigating to ${args.url}`);
    // Don't await networkidle — awesome-list pages have long-tail
    // network activity we don't want to gate on. We gate on "real"
    // probe captures instead (see isRealCapture).
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Give React a head start. GitHub's own chrome (header links,
    // feature callouts, etc.) renders before the README hydrates, so
    // the extension's MutationObserver fires a series of empty scans
    // that all early-return at `pending.length === 0`. Without this
    // pause the capture-wait loop can starve — the empty scans look
    // the same as "nothing happening" to the gating logic. 3s is
    // enough for awesome-homelab (measured 2026-04-15), and too
    // short to matter for lighter pages.
    await new Promise((r) => setTimeout(r, 3000));

    // Wait for at least one REAL capture, then drain for
    // POST_CAPTURE_DRAIN_MS past the LAST real capture. This handles
    // the common case where React hydration fires multiple scan
    // rounds — we want the latest one, not the first.
    const captureStart = Date.now();
    while (lastRealCaptureAt === null) {
      if (Date.now() - captureStart > CAPTURE_TIMEOUT_MS) {
        throw new Error(
          `[probe-run] timeout (${CAPTURE_TIMEOUT_MS}ms) waiting for real SNEETCHES_PROBE envelope (captured ${captured.length} empty/pre-hydration payload(s))`
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    while (Date.now() - lastRealCaptureAt < POST_CAPTURE_DRAIN_MS) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const realCount = captured.filter(isRealCapture).length;
    console.log(
      `[probe-run] captured ${captured.length} payload(s) (${realCount} real, ${captured.length - realCount} empty/pre-hydration)`
    );
  } finally {
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
  }

  // Write payloads to docs/plans/probe-runs/
  const runsDir = path.resolve(process.cwd(), 'docs/plans/probe-runs');
  await fs.mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const parsedUrl = new URL(args.url);
  const urlSlug = slugify(parsedUrl.hostname + parsedUrl.pathname);
  const labelSlug = args.label ? `-${slugify(args.label)}` : '';
  const outPath = path.join(runsDir, `${timestamp}-${urlSlug}${labelSlug}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        meta: {
          timestamp: new Date().toISOString(),
          url: args.url,
          label: args.label ?? null,
        },
        payloads: captured,
      },
      null,
      2
    )
  );
  console.log(`[probe-run] wrote ${captured.length} payload(s) → ${outPath}`);
  await printDiffAgainstLatest(runsDir, outPath);
}

main().catch((e) => {
  console.error('[probe-run] error:', e);
  process.exit(1);
});
