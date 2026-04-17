// The jest.config.js default is `__DEBUG__: false` so the probe module
// early-returns during all non-probe tests (nothing to silence). This
// file opts back in to live-mode behavior for the tests that exercise
// the real mark/dump code path. Must be set before importing the probe
// module since the module's top-level block reads __DEBUG__ to decide
// whether to mount the `sneetchesProbe` global.
(globalThis as Record<string, unknown>).__DEBUG__ = true;

import * as probe from '../src/probe';

describe('probe module', () => {
  describe('Phase constants', () => {
    it('exports all documented phase constants', () => {
      expect(probe.Phase.PRELOAD_START).toBe('preload-start');
      expect(probe.Phase.PRELOAD_DONE).toBe('preload-done');
      expect(probe.Phase.SCAN_START).toBe('scan-start');
      expect(probe.Phase.PENDING_COLLECTED).toBe('pending-collected');
      expect(probe.Phase.FAST_PATH_PAINTED).toBe('fast-path-painted');
      expect(probe.Phase.PORT_SEND).toBe('port-send');
      expect(probe.Phase.PORT_FIRST_CHUNK).toBe('port-first-chunk');
      expect(probe.Phase.PORT_DONE).toBe('port-done');
      expect(probe.Phase.PAINT_DONE).toBe('paint-done');
      expect(probe.Phase.SW_HANDLER_ENTRY).toBe('sw-handler-entry');
      expect(probe.Phase.SW_FETCH_START).toBe('sw-fetch-start');
      expect(probe.Phase.SW_FETCH_DONE).toBe('sw-fetch-done');
    });
  });

  describe('newFrame() + mark()', () => {
    it('newFrame returns a ProbeFrame with the supplied label', () => {
      const frame = probe.newFrame('scan');
      expect(frame).toBeInstanceOf(probe.ProbeFrame);
      expect(frame.label).toBe('scan');
      expect(frame.entries).toEqual([]);
    });

    it('mark appends an entry with phase and t (number)', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      expect(frame.entries).toHaveLength(1);
      expect(frame.entries[0].phase).toBe('scan-start');
      expect(typeof frame.entries[0].t).toBe('number');
    });

    it('preserves extra metadata when provided', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.PENDING_COLLECTED, {
        pending: 712,
        cached: 705,
        uncached: 7,
      });
      expect(frame.entries[0].extra).toEqual({
        pending: 712,
        cached: 705,
        uncached: 7,
      });
    });

    it('supports multiple marks of the same phase', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.PORT_SEND);
      frame.mark(probe.Phase.PORT_SEND);
      expect(frame.entries).toHaveLength(2);
    });

    it('records monotonically non-decreasing timestamps for sequential marks', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.mark(probe.Phase.PENDING_COLLECTED);
      frame.mark(probe.Phase.PAINT_DONE);
      const t = frame.entries.map((e) => e.t);
      expect(t[1]).toBeGreaterThanOrEqual(t[0]);
      expect(t[2]).toBeGreaterThanOrEqual(t[1]);
    });
  });

  describe('dump()', () => {
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('emits exactly one console.log call', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.dump();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the SNEETCHES_PROBE envelope as the first argument', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.dump();
      expect(consoleLogSpy.mock.calls[0][0]).toBe('SNEETCHES_PROBE');
    });

    it('serializes the payload as a JSON string as the second argument', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.dump();
      const jsonArg = consoleLogSpy.mock.calls[0][1];
      expect(typeof jsonArg).toBe('string');
      const parsed = JSON.parse(jsonArg);
      expect(parsed).toBeDefined();
    });

    it('payload includes the label from the frame constructor', () => {
      const frame = probe.newFrame('preload');
      frame.mark(probe.Phase.PRELOAD_START);
      frame.dump();
      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      expect(parsed.label).toBe('preload');
    });

    it('payload includes ctx, timeOrigin, and all entries', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.mark(probe.Phase.PAINT_DONE);
      frame.dump();
      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      expect(parsed.ctx).toBe('cs');
      expect(typeof parsed.timeOrigin).toBe('number');
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.entries[0].phase).toBe('scan-start');
      expect(parsed.entries[1].phase).toBe('paint-done');
    });

    it('does not emit when the frame has no entries', () => {
      const frame = probe.newFrame('scan');
      frame.dump();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('clears entries after dump so the frame can be reused', () => {
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      frame.dump();
      expect(frame.entries).toHaveLength(0);
    });

    it('strips query string and fragment from pageUrl', () => {
      const originalHref = window.location.href;
      Object.defineProperty(window, 'location', {
        value: new URL('https://github.com/owner/repo?code=secret&state=xyz#frag'),
        writable: true,
        configurable: true,
      });
      try {
        const frame = probe.newFrame('scan');
        frame.mark(probe.Phase.SCAN_START);
        frame.dump();
        const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
        expect(parsed.pageUrl).toBe('https://github.com/owner/repo');
        expect(parsed.pageUrl).not.toContain('secret');
        expect(parsed.pageUrl).not.toContain('xyz');
        expect(parsed.pageUrl).not.toContain('#');
      } finally {
        Object.defineProperty(window, 'location', {
          value: new URL(originalHref),
          writable: true,
          configurable: true,
        });
      }
    });
  });

  // These tests exercise the specific concurrency scenario the
  // reviewer flagged as broken in the round-1 stack-of-frames
  // design: scan A awaits, scan B runs partway, scan A resumes and
  // marks, scan B resumes and marks, both dump. With per-scan frames
  // held in local variables, each scan's marks land only on its own
  // frame regardless of interleave order.
  describe('concurrent scans with real async interleave', () => {
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('scans that interleave at await points produce clean envelopes', async () => {
      // Simulate two concurrent updateLinks-style scans, each with
      // their own frame. Between awaits, each scan marks into its
      // own frame. If the probe were using a shared "current frame"
      // (stack or otherwise), scan A's post-resume marks would land
      // on whatever scan B pushed last.
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

      const scanA = async (): Promise<void> => {
        const frame = probe.newFrame('scan');
        frame.mark(probe.Phase.SCAN_START);
        await tick(); // yield
        frame.mark(probe.Phase.PENDING_COLLECTED, { pending: 100 });
        frame.mark(probe.Phase.PORT_SEND, { unique: 100 });
        await tick(); // yield (like portFetcher await)
        frame.mark(probe.Phase.PORT_DONE, { ok: 'yes' });
        frame.mark(probe.Phase.PAINT_DONE);
        frame.dump();
      };

      const scanB = async (): Promise<void> => {
        const frame = probe.newFrame('scan');
        frame.mark(probe.Phase.SCAN_START);
        await tick();
        frame.mark(probe.Phase.PENDING_COLLECTED, { pending: 5 });
        frame.mark(probe.Phase.FAST_PATH_PAINTED, { painted: 5 });
        frame.mark(probe.Phase.PAINT_DONE);
        frame.dump();
      };

      await Promise.all([scanA(), scanB()]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);

      // Both envelopes should have exactly their own scan's marks in
      // order. Unpack both and assert each has its expected shape
      // regardless of dump ordering.
      const payloads = consoleLogSpy.mock.calls.map(
        (call) => JSON.parse(call[1] as string) as { entries: Array<{ phase: string }> }
      );

      const aPayload = payloads.find((p) => p.entries.some((e) => e.phase === 'port-send'));
      const bPayload = payloads.find((p) => p.entries.some((e) => e.phase === 'fast-path-painted'));
      expect(aPayload).toBeDefined();
      expect(bPayload).toBeDefined();

      expect(aPayload!.entries.map((e) => e.phase)).toEqual([
        'scan-start',
        'pending-collected',
        'port-send',
        'port-done',
        'paint-done',
      ]);
      expect(bPayload!.entries.map((e) => e.phase)).toEqual([
        'scan-start',
        'pending-collected',
        'fast-path-painted',
        'paint-done',
      ]);
    });

    it('three overlapping scans each get independent envelopes', async () => {
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

      const makeScan = (label: string, phase: probe.Phase) => async (): Promise<void> => {
        const frame = probe.newFrame(label);
        frame.mark(probe.Phase.SCAN_START);
        await tick();
        frame.mark(phase);
        await tick();
        frame.mark(probe.Phase.PAINT_DONE);
        frame.dump();
      };

      await Promise.all([
        makeScan('a', probe.Phase.PORT_SEND)(),
        makeScan('b', probe.Phase.PENDING_COLLECTED)(),
        makeScan('c', probe.Phase.FAST_PATH_PAINTED)(),
      ]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      const phases = consoleLogSpy.mock.calls.map((call) => {
        const p = JSON.parse(call[1] as string) as { entries: Array<{ phase: string }> };
        return p.entries[1].phase; // the per-scan phase from makeScan
      });
      expect(phases.sort()).toEqual(['fast-path-painted', 'pending-collected', 'port-send']);
    });
  });

  // These tests pin the contract that in production builds
  // (__DEBUG__ === false), every method call is a no-op. Jest sets
  // __DEBUG__: true via jest.config.js globals, so we monkey-patch
  // globalThis to flip the flag for the duration of each test. The
  // test:dce npm script verifies the same contract from the bundle
  // side by grepping for SNEETCHES_PROBE in build/*.js after a
  // production build.
  describe('production mode (__DEBUG__ === false)', () => {
    let originalDebug: unknown;

    beforeEach(() => {
      originalDebug = (globalThis as Record<string, unknown>).__DEBUG__;
      (globalThis as Record<string, unknown>).__DEBUG__ = false;
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).__DEBUG__ = originalDebug;
    });

    it('frame.mark() is a no-op (does not push an entry)', () => {
      // Create frame with __DEBUG__=false so nothing ever lands in it
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      expect(frame.entries).toHaveLength(0);
    });

    it('frame.dump() does not emit a console.log', () => {
      // Create frame with __DEBUG__=true so entries exist, then flip
      // to false and dump — the dump should still no-op.
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      (globalThis as Record<string, unknown>).__DEBUG__ = false;

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      frame.dump();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('frame.dump() does not clear entries when __DEBUG__ is false', () => {
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      const frame = probe.newFrame('scan');
      frame.mark(probe.Phase.SCAN_START);
      (globalThis as Record<string, unknown>).__DEBUG__ = false;

      frame.dump();
      // Early-return at the __DEBUG__ guard means the entries
      // clearing logic never runs
      expect(frame.entries).toHaveLength(1);
    });
  });
});
