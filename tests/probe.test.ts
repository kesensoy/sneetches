import * as probe from '../src/debug/probe';

describe('probe module', () => {
  beforeEach(() => {
    // Stack-collapsing reset (not the public reset, which would push
    // a new frame). Keeps test state isolated even if a previous test
    // left an unbalanced reset/dump pair.
    probe.__resetStackForTests();
  });

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

  describe('mark()', () => {
    it('appends an entry with phase, t (number), and ctx', () => {
      probe.mark(probe.Phase.SCAN_START);
      const entries = probe.__getEntriesForTests();
      expect(entries).toHaveLength(1);
      expect(entries[0].phase).toBe('scan-start');
      expect(typeof entries[0].t).toBe('number');
      expect(['cs', 'sw']).toContain(entries[0].ctx);
    });

    it('preserves extra metadata when provided', () => {
      probe.mark(probe.Phase.PENDING_COLLECTED, {
        pending: 712,
        unique: 705,
        cached: 705,
        uncached: 0,
      });
      const entries = probe.__getEntriesForTests();
      expect(entries[0].extra).toEqual({
        pending: 712,
        unique: 705,
        cached: 705,
        uncached: 0,
      });
    });

    it('supports multiple marks of the same phase', () => {
      probe.mark(probe.Phase.PORT_SEND);
      probe.mark(probe.Phase.PORT_SEND);
      expect(probe.__getEntriesForTests()).toHaveLength(2);
    });

    it('records monotonically non-decreasing timestamps for sequential marks', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PENDING_COLLECTED);
      probe.mark(probe.Phase.PAINT_DONE);
      const entries = probe.__getEntriesForTests();
      expect(entries[1].t).toBeGreaterThanOrEqual(entries[0].t);
      expect(entries[2].t).toBeGreaterThanOrEqual(entries[1].t);
    });

    it('ctx is "cs" under jsdom (window defined)', () => {
      probe.mark(probe.Phase.SCAN_START);
      expect(probe.__getEntriesForTests()[0].ctx).toBe('cs');
    });
  });

  describe('reset()', () => {
    it('clears all entries', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PAINT_DONE);
      probe.reset();
      expect(probe.__getEntriesForTests()).toHaveLength(0);
    });

    it('leaves the module ready to record new marks', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.reset();
      probe.mark(probe.Phase.PORT_SEND);
      const entries = probe.__getEntriesForTests();
      expect(entries).toHaveLength(1);
      expect(entries[0].phase).toBe('port-send');
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
      probe.mark(probe.Phase.SCAN_START);
      probe.dump();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the SNEETCHES_PROBE envelope as the first argument', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.dump();
      expect(consoleLogSpy.mock.calls[0][0]).toBe('SNEETCHES_PROBE');
    });

    it('serializes the payload as a JSON string as the second argument', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.dump();
      const jsonArg = consoleLogSpy.mock.calls[0][1];
      expect(typeof jsonArg).toBe('string');
      const parsed = JSON.parse(jsonArg);
      expect(parsed).toBeDefined();
    });

    it('payload includes label when provided', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.dump('scan');
      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      expect(parsed.label).toBe('scan');
    });

    it('payload defaults label to "dump" when not provided', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.dump();
      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      expect(parsed.label).toBe('dump');
    });

    it('payload includes ctx, timeOrigin, and all entries', () => {
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump();
      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      expect(parsed.ctx).toBe('cs');
      expect(typeof parsed.timeOrigin).toBe('number');
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.entries[0].phase).toBe('scan-start');
      expect(parsed.entries[1].phase).toBe('paint-done');
    });

    it('does nothing when there are no entries', () => {
      probe.dump();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('strips query string and fragment from pageUrl', () => {
      // jsdom defaults to http://localhost/ which has no query string.
      // Simulate a page with sensitive query params by replacing
      // window.location via jsdom's reconfigure API.
      const originalHref = window.location.href;
      Object.defineProperty(window, 'location', {
        value: new URL('https://github.com/owner/repo?code=secret&state=xyz#frag'),
        writable: true,
        configurable: true,
      });
      try {
        probe.mark(probe.Phase.SCAN_START);
        probe.dump();
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

  // Concurrent scans are the reason the probe uses a stack-of-frames
  // rather than a single shared entries array. On cold-cache
  // awesome-homelab runs, scan A starts the port fetch and awaits
  // for ~4s; during that await the MutationObserver fires and
  // schedules scan B, which runs to completion before A resumes.
  // Without per-scan frame isolation, B's reset() would wipe A's
  // marks and the two scans' envelopes would be garbled.
  describe('concurrent scans (stack-of-frames isolation)', () => {
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('scan B finishing mid-scan-A emits clean envelopes for both', () => {
      // Simulate scan A starting
      probe.reset();
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PENDING_COLLECTED, { pending: 100 });
      probe.mark(probe.Phase.PORT_SEND, { unique: 100 });
      // ... scan A now awaits portFetcher ...

      // Scan B fires during A's await and completes
      probe.reset();
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PENDING_COLLECTED, { pending: 5 });
      probe.mark(probe.Phase.FAST_PATH_PAINTED, { painted: 5 });
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump('scan'); // scan B dumps

      // ... scan A resumes ...
      probe.mark(probe.Phase.PORT_FIRST_CHUNK, { chunkSize: 50 });
      probe.mark(probe.Phase.PORT_DONE, { ok: 'yes' });
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump('scan'); // scan A dumps

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);

      const bPayload = JSON.parse(consoleLogSpy.mock.calls[0][1]);
      const aPayload = JSON.parse(consoleLogSpy.mock.calls[1][1]);

      // Scan B's envelope should have exactly its 4 marks, in order
      expect(bPayload.entries.map((e: { phase: string }) => e.phase)).toEqual([
        'scan-start',
        'pending-collected',
        'fast-path-painted',
        'paint-done',
      ]);
      expect(bPayload.entries[1].extra).toEqual({ pending: 5 });

      // Scan A's envelope should have its 6 marks, NOT mixed with scan B
      expect(aPayload.entries.map((e: { phase: string }) => e.phase)).toEqual([
        'scan-start',
        'pending-collected',
        'port-send',
        'port-first-chunk',
        'port-done',
        'paint-done',
      ]);
      expect(aPayload.entries[1].extra).toEqual({ pending: 100 });
    });

    it('three nested scans all emit their own envelopes without interleave', () => {
      probe.reset(); // scan A
      probe.mark(probe.Phase.SCAN_START);

      probe.reset(); // scan B
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PENDING_COLLECTED, { pending: 1 });

      probe.reset(); // scan C
      probe.mark(probe.Phase.SCAN_START);
      probe.mark(probe.Phase.PENDING_COLLECTED, { pending: 2 });
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump('scan'); // C pops

      // Scan B resumes
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump('scan'); // B pops

      // Scan A resumes
      probe.mark(probe.Phase.PAINT_DONE);
      probe.dump('scan'); // A pops

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);

      const cPhases = JSON.parse(consoleLogSpy.mock.calls[0][1]).entries.map(
        (e: { phase: string }) => e.phase
      );
      const bPhases = JSON.parse(consoleLogSpy.mock.calls[1][1]).entries.map(
        (e: { phase: string }) => e.phase
      );
      const aPhases = JSON.parse(consoleLogSpy.mock.calls[2][1]).entries.map(
        (e: { phase: string }) => e.phase
      );

      expect(cPhases).toEqual(['scan-start', 'pending-collected', 'paint-done']);
      expect(bPhases).toEqual(['scan-start', 'pending-collected', 'paint-done']);
      expect(aPhases).toEqual(['scan-start', 'paint-done']);
    });

    it('dump on an empty frame pops without emitting', () => {
      probe.reset();
      probe.dump('scan'); // frame is empty, should not emit

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  // These tests pin the contract that in production builds
  // (__DEBUG__ === false), every exported function is a no-op. Jest
  // sets __DEBUG__: true via jest.config.js globals, so we have to
  // monkey-patch globalThis to flip the flag for the duration of
  // each test. The test:dce npm script verifies the same contract
  // from the bundle side by grepping for SNEETCHES_PROBE in
  // build/*.js after a production build.
  describe('production mode (__DEBUG__ === false)', () => {
    let originalDebug: unknown;

    beforeEach(() => {
      originalDebug = (globalThis as Record<string, unknown>).__DEBUG__;
      (globalThis as Record<string, unknown>).__DEBUG__ = false;
      // reset() is a no-op under __DEBUG__ === false, so we have to
      // clear residual entries via the test-only accessor check.
      // Easiest path: flip to true, reset, then flip back.
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      probe.reset();
      (globalThis as Record<string, unknown>).__DEBUG__ = false;
    });

    afterEach(() => {
      (globalThis as Record<string, unknown>).__DEBUG__ = originalDebug;
      probe.reset();
    });

    it('mark() is a no-op (does not push an entry)', () => {
      probe.mark(probe.Phase.SCAN_START);
      // Flip back to read entries
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      expect(probe.__getEntriesForTests()).toHaveLength(0);
      (globalThis as Record<string, unknown>).__DEBUG__ = false;
    });

    it('dump() does not emit a console.log', () => {
      // Seed an entry via the live path first
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      probe.mark(probe.Phase.SCAN_START);
      (globalThis as Record<string, unknown>).__DEBUG__ = false;

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      probe.dump();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('reset() is a no-op (does not clear entries)', () => {
      // Seed with __DEBUG__=true
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      probe.mark(probe.Phase.SCAN_START);
      (globalThis as Record<string, unknown>).__DEBUG__ = false;
      probe.reset();
      // Flip back to verify the entry is still there
      (globalThis as Record<string, unknown>).__DEBUG__ = true;
      expect(probe.__getEntriesForTests()).toHaveLength(1);
    });
  });
});
