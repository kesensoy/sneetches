// Jest setup file: silence SNEETCHES_PROBE envelopes in test output.
//
// The probe module emits `console.log('SNEETCHES_PROBE', ...)` as
// part of its normal operation. Under Jest, `__DEBUG__` is `true`
// globally (per jest.config.js's `globals` block), so the probe
// dumps fire during tests that exercise content.ts or
// service-worker.ts. The resulting wall of text drowns out real
// test output and makes failures hard to spot.
//
// This file patches `console.log` once at setup time to swallow any
// call whose first argument is the `SNEETCHES_PROBE` string literal.
// All other console.log calls pass through to the real implementation.
//
// Probe-specific tests (`tests/probe.test.ts`) are unaffected because
// they use `jest.spyOn(console, 'log')` which replaces `console.log`
// wholesale for the duration of each test, bypassing this wrapper.
const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (args[0] === 'SNEETCHES_PROBE') return;
  originalLog(...args);
};
