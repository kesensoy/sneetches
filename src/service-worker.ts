// Manifest V3 background service worker.
//
// 1.1.3 moves the repo-data hot path out of the content script so it
// stops losing main-thread races to React hydration / 1Password / GitHub
// hovercards on big awesome-list pages. The service worker runs on its
// own thread with its own event loop: chrome.storage.local.get callbacks
// land instantly, fetch() response handlers don't queue behind anything,
// and progressive reveal can actually stream.
//
// Transport shape:
//
//   content.ts                         service-worker.ts
//   chrome.runtime.connect ──────────▶ onConnect
//   port.postMessage({nwos}) ────────▶ port.onMessage → fetchRepoDataStreaming
//                                   ◀─ port.postMessage({type:'chunk',entries})
//                                       (... one per cache hit + chunk ...)
//                                   ◀─ port.postMessage({type:'done'|'error'})
//                                      port.disconnect()
//
// One request ↔ many responses; the content script never calls
// chrome.storage.local.get or fetch() directly for repo data. Settings
// (show toggles, starStyle) still live in chrome.storage.sync and the
// content script reads those on its own, because they're needed
// synchronously at render time and don't dominate wall-clock.

import * as probe from './probe';
import { fetchRepoDataStreaming } from './github';
import { getAccessToken } from './settings';
import { FetchReposRequest, SNEETCHES_PORT_NAME, SneetchesRpcMsg } from './rpc';

// Narrow the per-connection state into a single async handler so we
// can exercise it directly from tests without going through
// chrome.runtime.connect. Exported for testing only; production code
// reaches it via the onConnect listener below.
async function handleFetchReposRequest(
  req: FetchReposRequest,
  send: (msg: SneetchesRpcMsg) => void
): Promise<void> {
  // Each request gets its own probe frame. Held in a local variable
  // so concurrent handler invocations each have their own entries
  // array — no shared-state race.
  const frame = probe.newFrame('sw');
  try {
    // SW_HANDLER_ENTRY is inside the try so any unexpected error
    // before getAccessToken() still triggers the finally's
    // frame.dump(). The nwos access uses optional chaining + nullish
    // coalesce, so undefined req.nwos itself won't throw — but the
    // try/finally guard covers other failure modes (e.g. a future
    // code change that accesses req properties without guarding).
    frame.mark(probe.Phase.SW_HANDLER_ENTRY, { nwos: req.nwos?.length ?? 0 });
    const accessToken = await getAccessToken();
    frame.mark(probe.Phase.SW_FETCH_START);
    await fetchRepoDataStreaming(req.nwos, accessToken || undefined, (chunkResults) => {
      // Convert Map → [[k,v],...] for postMessage portability.
      // Map is structured-cloneable in modern Chrome, but the array
      // form is smaller in serialization and keeps the protocol
      // human-readable in chrome://extensions' service worker view.
      send({ type: 'chunk', entries: Array.from(chunkResults) });
    });
    frame.mark(probe.Phase.SW_FETCH_DONE);
    send({ type: 'done' });
  } catch (err) {
    // Transport-level failure (HTTP 401 / 5xx, network error).
    // fetchGraphQLBatch throws `{ok:false, status}` and also takes care
    // of token invalidation on 401 by clearing TOKEN_VALIDATED_KEY
    // itself, so we just need to relay the status for the content
    // script's error-annotation rendering.
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? (err as { status?: number }).status
        : undefined;
    send({ type: 'error', status });
  } finally {
    frame.dump();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SNEETCHES_PORT_NAME) return;

  // Each connection services exactly one request. The content script
  // opens a fresh port per scan; the worker tears it down on 'done' or
  // 'error'. This keeps the worker from accumulating state across
  // scans and makes service-worker-termination behavior less fraught
  // (a terminated worker just means the next scan opens a fresh port).
  const onMessage = (msg: unknown): void => {
    // Defensive: remove the listener as soon as the first message is
    // being processed. The protocol is explicitly single-shot (one
    // request per connection), but removing the listener here means a
    // misbehaving caller that posts a second message on the same port
    // before the first `finally` disconnect runs doesn't kick off a
    // second concurrent handleFetchReposRequest. In-flight listener is
    // gone before any second message can reach it.
    port.onMessage.removeListener(onMessage);

    const req = msg as FetchReposRequest;
    handleFetchReposRequest(req, (out) => {
      // Guard against posting on an already-closed port. disconnect()
      // from either side tears down the channel; any late chunk from a
      // slow fetch after the client disconnected should no-op rather
      // than throw.
      try {
        port.postMessage(out);
      } catch {
        // Silent — port closed. The chunkResults were still cached
        // before onResults ran, so the next scan will see them.
      }
    }).finally(() => {
      // Single-shot connection: always disconnect after one request/
      // terminal-message exchange. Protects against stuck worker
      // state if the content script forgets to disconnect on 'done'.
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
    });
  };

  port.onMessage.addListener(onMessage);
});
