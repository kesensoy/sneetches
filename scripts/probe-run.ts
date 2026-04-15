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
    // This block is filled in by Task 9 (CDP attach + capture + diff).
    console.log('[probe-run] (Task 8 skeleton: Chrome launched, capture logic comes in Task 9)');
    // Wait briefly then exit — placeholder so the script terminates
    // cleanly during skeleton-level smoke tests.
    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error('[probe-run] error:', e);
  process.exit(1);
});
