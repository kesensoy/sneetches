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

let entries: Entry[] = [];

export function mark(phase: Phase, extra?: Extra): void {
  if (!__DEBUG__) return;
  entries.push({
    phase,
    t: performance.now(),
    ctx,
    ...(extra !== undefined ? { extra } : {}),
  });
}

export function reset(): void {
  if (!__DEBUG__) return;
  entries = [];
}

export function dump(label = 'dump'): void {
  if (!__DEBUG__) return;
  if (entries.length === 0) return;
  const payload = {
    label,
    ctx,
    timeOrigin: performance.timeOrigin,
    version:
      typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : 'unknown',
    pageUrl: ctx === 'cs' && typeof location !== 'undefined' ? location.href : undefined,
    entries: entries.map((e) => ({
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
export function __getEntriesForTests(): ReadonlyArray<Entry> {
  if (!__DEBUG__) return [];
  return entries;
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
