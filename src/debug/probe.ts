// Permanent dev probe module. Lives in the committed codebase; fires
// marks at strategic sites across content.ts, github.ts, and
// service-worker.ts. In production, every exported function is a
// no-op via the `if (!__DEBUG__) return;` guard, and Terser's
// pure_funcs config strips the call sites entirely — zero bytes
// shipped to store users.
//
// In development (webpack --mode=development, `npm run dev`, Jest
// with globals.__DEBUG__ === true), the module records coarse phase
// timings into an in-memory array and emits them as a single
// structured console.log per scan. The measurement script at
// scripts/probe-run.ts listens for that envelope via CDP's
// Runtime.consoleAPICalled event.
//
// Payload is restricted to timing + count data. DO NOT include any
// HTTP request/response content, Authorization headers, access
// tokens, or URLs beyond the top-level pageUrl — those would leak
// into the measurement output and we have a standing rule against
// capturing auth material in dev tooling.

export const Phase = {
  PRELOAD_START: 'preload-start',
  PRELOAD_DONE: 'preload-done',
  SCAN_START: 'scan-start',
  PENDING_COLLECTED: 'pending-collected',
  FAST_PATH_PAINTED: 'fast-path-painted',
  PORT_SEND: 'port-send',
  PORT_FIRST_CHUNK: 'port-first-chunk',
  PORT_DONE: 'port-done',
  PAINT_DONE: 'paint-done',
  SW_HANDLER_ENTRY: 'sw-handler-entry',
  SW_FETCH_START: 'sw-fetch-start',
  SW_FETCH_DONE: 'sw-fetch-done',
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

type Extra = Record<string, number | string>;

interface Entry {
  phase: Phase;
  t: number;
  ctx: 'cs' | 'sw';
  extra?: Extra;
}

// Inferred once at module load. Service workers have no `window`;
// content scripts do. The distinction matters for cross-context
// payload correlation, because each realm has its own
// performance.timeOrigin.
const ctx: 'cs' | 'sw' = typeof window === 'undefined' ? 'sw' : 'cs';

// Stack of entry arrays. Every `reset()` pushes a new frame onto the
// stack; every `dump()` pops its frame off and emits it as an
// envelope. Concurrent async scans (e.g. when an MO-triggered scan
// fires while `updateLinks` is still awaiting `portFetcher`) each
// own their own frame and don't interleave marks.
//
// Concrete scenario this fixes: cold-cache awesome-homelab scan A
// calls `reset()` → frame A on top, marks SCAN_START /
// PENDING_COLLECTED / FAST_PATH_PAINTED / PORT_SEND into frame A,
// then awaits portFetcher for ~4s. During that await the MO fires
// again and scan B calls `reset()` → frame B on top, marks its own
// SCAN_START / ... / PAINT_DONE into frame B, finally `dump('scan')`
// → pops frame B → emits scan B's envelope. Frame A is now on top
// again; scan A's subsequent PORT_FIRST_CHUNK / PORT_DONE /
// PAINT_DONE marks land on frame A; scan A's `dump('scan')` → pops
// frame A → emits scan A's complete envelope.
//
// The stack always has at least one frame so that `mark()` calls
// outside any scan (e.g. mark calls from DevTools-console manual
// invocation before the first `reset()`) have somewhere to push.
// The base frame is pinned and never popped — `dump()` refuses to
// pop when `stack.length === 1`, instead emitting the base frame's
// contents and draining it in place.
const stack: Entry[][] = [[]];

function topFrame(): Entry[] {
  return stack[stack.length - 1];
}

export function mark(phase: Phase, extra?: Extra): void {
  if (!__DEBUG__) return;
  topFrame().push({
    phase,
    t: performance.now(),
    ctx,
    ...(extra !== undefined ? { extra } : {}),
  });
}

export function reset(): void {
  if (!__DEBUG__) return;
  stack.push([]);
}

// Strip query string + fragment from a URL before capturing it into
// a probe payload. Query strings on github.com can contain OAuth
// `code=` / `state=` parameters, PR review comment ids, and other
// tokens that have no business in probe telemetry. Origin + pathname
// is enough to identify the page for measurement correlation.
function sanitizePageUrl(href: string): string {
  try {
    const u = new URL(href);
    return u.origin + u.pathname;
  } catch {
    return '(invalid-url)';
  }
}

export function dump(label = 'dump'): void {
  if (!__DEBUG__) return;
  // Pop the top frame (if it's not the pinned base frame) and emit
  // it. If we're at the base frame, drain it in place instead so
  // that subsequent marks start fresh.
  let frame: Entry[];
  if (stack.length > 1) {
    frame = stack.pop()!;
  } else {
    frame = stack[0];
    stack[0] = [];
  }
  if (frame.length === 0) return;
  const payload = {
    label,
    ctx,
    timeOrigin: performance.timeOrigin,
    version:
      typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : 'unknown',
    pageUrl:
      ctx === 'cs' && typeof location !== 'undefined' ? sanitizePageUrl(location.href) : undefined,
    entries: frame.map((e) => ({
      phase: e.phase,
      t: e.t,
      ...(e.extra !== undefined ? { extra: e.extra } : {}),
    })),
  };
  console.log('SNEETCHES_PROBE', JSON.stringify(payload));
}

// Test-only accessor. Exported as __-prefixed to signal "not for
// production use"; the webpack build still includes it in dev mode,
// which is fine — it's guarded by __DEBUG__ like the rest.
//
// Returns the top frame of the stack — i.e., the entries that a
// current-scope `mark()` call would push into. Does NOT include
// entries from outer frames that `reset()` pushed past.
export function __getEntriesForTests(): ReadonlyArray<Entry> {
  if (!__DEBUG__) return [];
  return topFrame();
}

// Test-only: collapse the stack back to a single empty base frame.
// Used by test setup/teardown to ensure per-test isolation regardless
// of how many reset() / dump() the test left unbalanced.
export function __resetStackForTests(): void {
  if (!__DEBUG__) return;
  stack.length = 0;
  stack.push([]);
}

// Mount a global handle so `sneetchesProbe.dump()` is invokable from
// DevTools console on any page with the extension loaded. Only in
// debug builds.
if (__DEBUG__ && typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).sneetchesProbe = {
    mark,
    dump,
    reset,
    Phase,
  };
}
