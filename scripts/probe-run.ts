#!/usr/bin/env node
// Local dev measurement harness.
//
// Launches Chrome with a temp copy of the user's real profile loaded,
// attaches to it via CDP through --remote-debugging-port=9222, listens
// for SNEETCHES_PROBE console events from the extension, and writes
// the captured payloads to docs/plans/probe-runs/<timestamp>.json.
//
// Usage:
//   npm run probe
//   npm run probe -- --url https://github.com/some/list
//   npm run probe -- --label my-experiment
//
// Design doc: docs/plans/2026-04-15-1.1.6-dev-instrumentation-design.md

import { spawn, ChildProcess } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// chrome-remote-interface ships CJS-first; import via require for cleanest typing.

const CDP: (options?: {
  port?: number;
  target?: (
    targets: Array<{ url: string; type: string; webSocketDebuggerUrl: string }>
  ) => { url: string; type: string; webSocketDebuggerUrl: string } | undefined;
}) => Promise<{
  Runtime: {
    enable: () => Promise<void>;
    consoleAPICalled: (
      handler: (params: { args: Array<{ value?: unknown }>; type: string }) => void
    ) => void;
  };
  close: () => Promise<void>;
}> = require('chrome-remote-interface');

const DEBUG_PORT = 9222;
const DEFAULT_TARGET_URL = 'https://github.com/miantiao-me/awesome-homelab';
const CAPTURE_TIMEOUT_MS = 60_000;
const POST_CAPTURE_DRAIN_MS = 500;

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

function getDefaultChromeProfilePath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library/Application Support/Google/Chrome/Default');
    case 'linux':
      return path.join(home, '.config/google-chrome/Default');
    case 'win32':
      return path.join(home, 'AppData/Local/Google/Chrome/User Data/Default');
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getChromeExecutable(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'linux':
      return 'google-chrome';
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

async function copyProfile(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true, errorOnExist: false });
}

async function isStale(file: string, thresholdMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs > thresholdMs;
  } catch {
    return true;
  }
}

async function waitForDebugPort(maxMs = 10_000): Promise<void> {
  const http = require('http');
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const reached = await new Promise<boolean>((resolve) => {
      const req = http.get(
        `http://localhost:${DEBUG_PORT}/json/version`,
        (res: { statusCode?: number; resume?: () => void }) => {
          resolve(res.statusCode === 200);
          res.resume?.();
        }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (reached) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome did not expose --remote-debugging-port=${DEBUG_PORT} within ${maxMs}ms`);
}

async function ensureDevBuild(): Promise<string> {
  const buildPath = path.resolve(process.cwd(), 'build');
  const manifestPath = path.join(buildPath, 'manifest.json');
  const contentPath = path.join(buildPath, 'content.js');
  const needsBuild =
    !existsSync(manifestPath) || !existsSync(contentPath) || (await isStale(contentPath, 60_000));
  if (needsBuild) {
    console.log('[probe-run] build/ missing or stale; running `npm run dev`...');
    await new Promise<void>((resolve, reject) => {
      const b = spawn('npm', ['run', 'dev'], { stdio: 'inherit' });
      b.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`dev build failed (${code})`))
      );
    });
  }
  // Sanity check: probe envelope should exist in the dev bundle
  const content = await fs.readFile(contentPath, 'utf-8');
  if (!content.includes('SNEETCHES_PROBE')) {
    throw new Error(
      '[probe-run] dev build does not contain SNEETCHES_PROBE — is __DEBUG__ set correctly?'
    );
  }
  return buildPath;
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

  // Diff per ctx (cs vs sw)
  for (const ctx of ['cs', 'sw'] as const) {
    const cur = current.payloads.find((p) => p.ctx === ctx);
    const prev = previous.payloads.find((p) => p.ctx === ctx);
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
    // Simple ASCII table
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
  const args = parseArgs(process.argv.slice(2));
  console.log(`[probe-run] target URL: ${args.url}`);

  // Prepare temp profile
  const profileSrc = process.env.SNEETCHES_CHROME_PROFILE_SRC || getDefaultChromeProfilePath();
  if (!existsSync(profileSrc)) {
    throw new Error(`Chrome profile not found at ${profileSrc}. Set SNEETCHES_CHROME_PROFILE_SRC.`);
  }
  const tempProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'sneetches-probe-'));
  console.log(`[probe-run] copying profile ${profileSrc} → ${tempProfile}`);
  await copyProfile(profileSrc, tempProfile);

  // Ensure build/ exists and is fresh
  const buildPath = await ensureDevBuild();

  // Launch Chrome
  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tempProfile}`,
    `--disable-extensions-except=${buildPath}`,
    `--load-extension=${buildPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    args.url,
  ];
  console.log(`[probe-run] launching: ${getChromeExecutable()} ${chromeArgs.join(' ')}`);
  const chrome: ChildProcess = spawn(getChromeExecutable(), chromeArgs, { stdio: 'ignore' });

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (chrome.pid) process.kill(chrome.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    try {
      await fs.rm(tempProfile, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void cleanup().then(() => process.exit(143));
  });
  process.on('uncaughtException', (e) => {
    console.error('[probe-run] uncaught:', e);
    void cleanup().then(() => process.exit(1));
  });

  try {
    // Wait for Chrome's debugging port to come up
    await waitForDebugPort();

    // Attach CDP to the first tab whose URL matches the target
    console.log('[probe-run] attaching CDP...');
    const client = await CDP({
      port: DEBUG_PORT,
      target: (targets) => {
        const match = targets.find((t) => t.type === 'page' && t.url.startsWith(args.url));
        if (match) return match;
        // Fallback: first page target (Chrome may still be navigating)
        return targets.find((t) => t.type === 'page');
      },
    });

    const { Runtime } = client;
    await Runtime.enable();

    const captured: unknown[] = [];
    const captureDone = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timeout waiting for SNEETCHES_PROBE envelope'));
      }, CAPTURE_TIMEOUT_MS);

      Runtime.consoleAPICalled((params) => {
        if (params.args.length < 2) return;
        const first = params.args[0].value;
        if (first !== 'SNEETCHES_PROBE') return;
        const second = params.args[1].value;
        if (typeof second !== 'string') return;
        try {
          const payload = JSON.parse(second);
          captured.push(payload);
          // After the first capture, drain for a short window then resolve
          setTimeout(() => {
            clearTimeout(timeout);
            resolve();
          }, POST_CAPTURE_DRAIN_MS);
        } catch (e) {
          console.warn('[probe-run] failed to parse SNEETCHES_PROBE payload:', e);
        }
      });
    });

    await captureDone;
    await client.close();

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
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error('[probe-run] error:', e);
  process.exit(1);
});
