// Service worker tests — exercise the port protocol end-to-end with the
// real src/service-worker.ts module imported once at top-of-file.
//
// The SW registers an onConnect listener at module-load time via
// `chrome.runtime.onConnect.addListener`, which the hand-rolled port mock
// (tests/port.mock.ts) replaces with a working implementation. Each test
// opens a fresh client-side port via chrome.runtime.connect, posts a
// FetchReposRequest, and inspects the client port's `received[]` history
// for the expected {chunk} / {done} / {error} sequence.
//
// Fetches are mocked via the existing tests/fetch.mock.ts helper. The
// chrome.storage mock (tests/chrome-storage.mock.ts) persists access
// tokens across `chrome.storage.sync.set` / get so the unauth-vs-PAT
// routing inside fetchRepoDataStreaming takes the expected branch.

import '../src/service-worker';
import { FakePort } from './port.mock';
import { mockFetch } from './fetch.mock';
import { ChunkMsg, SNEETCHES_PORT_NAME, SneetchesRpcMsg } from '../src/shared/rpc';
import { ACCESS_TOKEN_KEY, TOKEN_VALIDATED_KEY } from '../src/settings';

// Yield enough microtasks + macrotasks for the SW's async handler to
// run bulkReadCache → fetchGraphQLBatch (mocked) → postMessage chain.
// A single setTimeout(0) drain is enough because the mocked fetch
// returns synchronously via `async () => {...}`.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const seedAccessToken = (token: string | null) =>
  new Promise<void>((resolve) => {
    const payload: Record<string, string> = {};
    if (token !== null) payload[ACCESS_TOKEN_KEY] = token;
    chrome.storage.sync.set(payload, () => resolve());
  });

const openPort = (): FakePort =>
  chrome.runtime.connect({ name: SNEETCHES_PORT_NAME }) as unknown as FakePort;

const collectMessages = (port: FakePort): SneetchesRpcMsg[] => port.received as SneetchesRpcMsg[];

const asChunk = (msg: SneetchesRpcMsg): ChunkMsg => {
  if (msg.type !== 'chunk') {
    throw new Error(`expected chunk, got ${JSON.stringify(msg)}`);
  }
  return msg;
};

describe('service worker: onConnect routing', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('ignores ports with the wrong name', async () => {
    const wrong = chrome.runtime.connect({ name: 'not-sneetches' }) as unknown as FakePort;
    wrong.postMessage({ nwos: ['a/b'] });
    await flush();
    // Our handler never fires → no reply messages.
    expect(wrong.received).toEqual([]);
  });
});

describe('service worker: PAT / GraphQL path', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await seedAccessToken('fake-pat');
  });

  test('cold cache: one chunk of fresh results, then done', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 10,
            forkCount: 2,
            pushedAt: '2024-01-01',
            isArchived: false,
            defaultBranchRef: { target: { committedDate: '2024-01-02' } },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: 'x' },
        },
      },
    });

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('chunk');
    const chunk = asChunk(msgs[0]);
    expect(chunk.entries).toHaveLength(1);
    expect(chunk.entries[0][0]).toBe('owner/repo');
    expect(chunk.entries[0][1].ok).toBe(true);
    expect(chunk.entries[0][1].json?.stargazers_count).toBe(10);
    expect(msgs[1].type).toBe('done');
  });

  test('warm cache: cached chunk fires before any fetch, no network call', async () => {
    // Seed the cache by firing a cold scan first.
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 7,
            forkCount: 1,
            pushedAt: '2024-01-01',
            isArchived: false,
            defaultBranchRef: { target: { committedDate: '2024-01-02' } },
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: 'x' },
        },
      },
    });
    const warmup = openPort();
    warmup.postMessage({ nwos: ['owner/repo'] });
    await flush();
    expect((warmup.received[warmup.received.length - 1] as SneetchesRpcMsg).type).toBe('done');

    // Swap fetch to a "would blow up if called" spy so we can prove the
    // warm-cache path never issues a POST.
    const fetchSpy = jest.fn().mockRejectedValue(new Error('fetch should not be called'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    const msgs = collectMessages(port);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('chunk');
    expect(asChunk(msgs[0]).entries[0][1].ok).toBe(true);
    expect(msgs[1].type).toBe('done');
  });

  test('empty nwos resolves to done with no chunk', async () => {
    const port = openPort();
    port.postMessage({ nwos: [] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('done');
  });

  test('NOT_FOUND errors surface as per-entry 404 chunk entries', async () => {
    mockFetch({
      json: {
        data: {
          r0: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: 'x' },
        },
        errors: [{ type: 'NOT_FOUND', path: ['r0'], message: 'not found' }],
      },
    });

    const port = openPort();
    port.postMessage({ nwos: ['ghost/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs[0].type).toBe('chunk');
    const entry = asChunk(msgs[0]).entries[0];
    expect(entry[0]).toBe('ghost/repo');
    expect(entry[1]).toEqual({ ok: false, status: 404 });
    expect(msgs[1].type).toBe('done');
  });

  test('FORBIDDEN errors surface as silent-skip chunk entries', async () => {
    mockFetch({
      json: {
        data: {
          r0: null,
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: 'x' },
        },
        errors: [{ type: 'FORBIDDEN', path: ['r0'], message: 'forbidden' }],
      },
    });

    const port = openPort();
    port.postMessage({ nwos: ['private/repo'] });
    await flush();

    const msgs = collectMessages(port);
    const entry = asChunk(msgs[0]).entries[0];
    expect(entry[1]).toEqual({ ok: false, silent: true });
    expect(msgs[1].type).toBe('done');
  });

  test('HTTP 401 posts terminal error and invalidates token flag', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: true }, () => resolve())
    );
    mockFetch({ ok: false, status: 401, json: null });

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'error', status: 401 });

    // fetchGraphQLBatch's side effect: clear the validated flag.
    const stored = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get([TOKEN_VALIDATED_KEY], (items) => resolve(items))
    );
    expect(stored[TOKEN_VALIDATED_KEY]).toBe(false);
  });

  test('HTTP 500 posts terminal error with status', async () => {
    mockFetch({ ok: false, status: 500, json: null });

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toEqual([{ type: 'error', status: 500 }]);
  });

  test('network error posts terminal error with undefined status', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toEqual([{ type: 'error', status: undefined }]);
  });
});

describe('service worker: unauthenticated / REST path', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
  });

  test('unauth path fires per-repo chunk messages then done', async () => {
    mockFetch({
      json: { forks_count: 1, pushed_at: 'x', stargazers_count: 5, archived: false },
    });

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    // Unauth REST path: one chunk per repo + done.
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('chunk');
    const entry = asChunk(msgs[0]).entries[0];
    expect(entry[0]).toBe('owner/repo');
    expect(entry[1]).toEqual({
      ok: true,
      json: { forks_count: 1, pushed_at: 'x', stargazers_count: 5, archived: false },
    });
    expect(msgs[1].type).toBe('done');
  });

  test('unauth 403 surfaces as per-entry status (not a terminal error)', async () => {
    mockFetch({ ok: false, status: 403, json: null });

    const port = openPort();
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    const msgs = collectMessages(port);
    expect(msgs).toHaveLength(2);
    const entry = asChunk(msgs[0]).entries[0];
    expect(entry[1]).toEqual({ ok: false, status: 403 });
    expect(msgs[1].type).toBe('done');
  });
});

describe('service worker: port lifecycle', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.local.clear(resolve));
    await new Promise<void>((resolve) => chrome.storage.sync.clear(resolve));
    await seedAccessToken('fake-pat');
  });

  test('port is disconnected after done', async () => {
    mockFetch({
      json: {
        data: {
          r0: {
            stargazerCount: 1,
            forkCount: 0,
            pushedAt: 'x',
            isArchived: false,
            defaultBranchRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: 'x' },
        },
      },
    });

    const disconnectSpy = jest.fn();
    const port = openPort();
    port.onDisconnect.addListener(disconnectSpy);
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  test('port is disconnected after error', async () => {
    mockFetch({ ok: false, status: 500, json: null });

    const disconnectSpy = jest.fn();
    const port = openPort();
    port.onDisconnect.addListener(disconnectSpy);
    port.postMessage({ nwos: ['owner/repo'] });
    await flush();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
