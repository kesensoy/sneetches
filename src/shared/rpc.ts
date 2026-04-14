// Shared message protocol between content script and service worker.
//
// 1.1.3 moves the repo-data hot path into a Manifest V3 service worker so
// chrome.storage.local.get callbacks and fetch() response handlers don't
// queue behind the page main thread on busy awesome-list pages. The
// content script connects a long-lived port and receives results
// progressively — each cached-subset batch and each GraphQL chunk
// arrives as its own postMessage, so annotations can paint as data
// lands rather than waiting on the whole scan to finish.
//
// One request ↔ many responses. Transport-level failure short-circuits
// with an 'error' message; a clean run ends with 'done'. Both sides
// disconnect the port after 'done' or 'error'.

import type { RepoResponse } from '../github';

export const SNEETCHES_PORT_NAME = 'sneetches:fetchRepos';

/**
 * Client → server. Sent exactly once per connection, immediately after
 * the port opens. `nwos` is the deduplicated set of "owner/name" strings
 * the content script wants annotated. An empty array is valid and
 * results in an immediate 'done' message with no intervening chunks.
 */
export interface FetchReposRequest {
  readonly nwos: readonly string[];
}

/**
 * Server → client. Each chunk carries a subset of the results Map as a
 * tuple array (Map is not structured-cloneable in the way postMessage
 * expects across some Chrome versions; array form is portable). The
 * first chunk may be the cached subset; subsequent chunks are one per
 * resolved GraphQL batch in non-deterministic order.
 */
export interface ChunkMsg {
  readonly type: 'chunk';
  readonly entries: ReadonlyArray<readonly [string, RepoResponse]>;
}

/**
 * Server → client. Terminal success: every chunk for the requested
 * nwos has been sent. The client disconnects the port on receipt.
 */
export interface DoneMsg {
  readonly type: 'done';
}

/**
 * Server → client. Terminal failure: the whole batch aborted before
 * any (or after some) chunks landed. `status` is the HTTP status code
 * if applicable (401 / 5xx), undefined for network errors. The client
 * treats this as a batch-level failure and renders error annotations
 * for any anchor still pending. The server disconnects immediately
 * after posting this.
 */
export interface ErrorMsg {
  readonly type: 'error';
  readonly status?: number;
}

export type SneetchesRpcMsg = ChunkMsg | DoneMsg | ErrorMsg;
