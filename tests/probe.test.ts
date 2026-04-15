import * as probe from '../src/debug/probe';

describe('probe module', () => {
  beforeEach(() => {
    probe.reset();
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
  });
});
