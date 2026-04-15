// Permanent dev probe module. Lives in the committed codebase; fires
// marks at strategic sites across content.ts, github.ts, and
// service-worker.ts. In production, every method call is a no-op
// via the `if (!__DEBUG__) return;` guard, and Terser's pure_funcs
// config strips the call sites entirely — zero bytes shipped to
// store users.
//
// In development (webpack --mode=development, `npm run dev`, Jest
// with globals.__DEBUG__ === true), each scan creates a private
// `ProbeFrame` via `probe.newFrame(label)` and marks into it. When
// the scan finishes it calls `frame.dump()`, which emits exactly
// one `console.log('SNEETCHES_PROBE', JSON.stringify(payload))`.
// The measurement script at scripts/probe-run.ts listens for that
// envelope via CDP's Runtime.consoleAPICalled event (page-level for
// content-script dumps and a dedicated SW CDP session for
// service-worker dumps).
//
// Why per-scan frames, not a module-level array or a stack:
//
//   `updateLinks()` awaits `getCachedSettings()` and `portFetcher()`.
//   Multiple MO-triggered `updateLinks()` calls run concurrently as
//   fire-and-forget promises. With a shared mutable "current entries"
//   (whether a flat array or a push/pop stack), scan A's marks can
//   land on scan B's frame when A resumes from an await and B is now
//   "current". A naive stack breaks under this pattern because stack
//   position ≠ scan identity under async interleave.
//
//   Per-scan frames fix it at the source: each `ProbeFrame` is a
//   local object, its `mark` is a method that pushes into that
//   specific object's entries array, and its `dump` is a method that
//   emits that specific object's entries. Scans hold their frame
//   reference in a local variable (`const frame = probe.newFrame(...)`)
//   so there's no shared state to race on. Concurrent scans are
//   structurally unable to clobber each other.
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
  extra?: Extra;
}

// Inferred once at module load. Service workers have no `window`;
// content scripts do. The distinction matters for cross-context
// payload correlation, because each realm has its own
// performance.timeOrigin.
const ctx: 'cs' | 'sw' = typeof window === 'undefined' ? 'sw' : 'cs';

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

export class ProbeFrame {
  // Public-readonly for test access. The type-level readonly is a
  // compile-time hint only; tests can still `frame.entries.length`
  // and the like without needing a dedicated accessor.
  readonly entries: Entry[] = [];

  constructor(readonly label: string) {}

  mark(phase: Phase, extra?: Extra): void {
    if (!__DEBUG__) return;
    this.entries.push({
      phase,
      t: performance.now(),
      ...(extra !== undefined ? { extra } : {}),
    });
  }

  dump(): void {
    if (!__DEBUG__) return;
    if (this.entries.length === 0) return;
    const payload = {
      label: this.label,
      ctx,
      timeOrigin: performance.timeOrigin,
      version:
        typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
          ? chrome.runtime.getManifest().version
          : 'unknown',
      pageUrl:
        ctx === 'cs' && typeof location !== 'undefined'
          ? sanitizePageUrl(location.href)
          : undefined,
      entries: this.entries.map((e) => ({
        phase: e.phase,
        t: e.t,
        ...(e.extra !== undefined ? { extra: e.extra } : {}),
      })),
    };
    console.log('SNEETCHES_PROBE', JSON.stringify(payload));
    // Clear after dump so a frame can be reused if a caller wants to
    // (not the recommended pattern, but no reason to forbid it).
    this.entries.length = 0;
  }
}

// Create a new probe frame with a label. The label lands in the
// envelope when `dump()` fires so the measurement script can tell
// scan envelopes from preload envelopes from SW envelopes.
//
// Typical call-site pattern:
//
//   async function myPhase() {
//     const frame = probe.newFrame('scan');
//     frame.mark(probe.Phase.SCAN_START);
//     try {
//       // ... work, including awaits ...
//       frame.mark(probe.Phase.PAINT_DONE);
//     } finally {
//       frame.dump();
//     }
//   }
//
// Each scan holds its frame reference in a local variable, so
// concurrent scans get structural isolation.
export function newFrame(label: string): ProbeFrame {
  return new ProbeFrame(label);
}

// Mount a global handle so probe frames are invokable from the
// DevTools console on any page with the extension loaded. Only in
// debug builds.
//
// Interactive usage:
//
//   > const f = sneetchesProbe.newFrame('interactive')
//   > f.mark(sneetchesProbe.Phase.SCAN_START)
//   > f.dump()
//
if (__DEBUG__ && typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).sneetchesProbe = {
    newFrame,
    Phase,
  };
}
