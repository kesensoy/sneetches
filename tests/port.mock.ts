/**
 * Hand-rolled chrome.runtime.connect / onConnect port mock.
 *
 * jest-webextension-mock's runtime.js ships unlinked stubs: connect() returns
 * a port whose postMessage is jest.fn() with no sink, and onConnect is a bag
 * of listeners that nothing ever calls. That's worthless for service-worker
 * tests that need a working client↔server channel.
 *
 * This module replaces chrome.runtime.connect and chrome.runtime.onConnect
 * with an implementation that:
 *
 *   1. On connect(), creates a linked pair of FakePort instances.
 *   2. Synchronously dispatches the server side of the pair to every
 *      registered onConnect listener. This matches Chrome's semantics
 *      closely enough for unit tests; microtask ordering inside handlers
 *      is handled by test `await`s as normal.
 *   3. postMessage on one side delivers to the partner's onMessage
 *      listeners AND appends to the partner's `received[]` array for
 *      assertion-friendly history inspection.
 *   4. disconnect() on either side marks both as disconnected and fires
 *      onDisconnect listeners on the opposite side.
 *
 * Listeners on chrome.runtime.onConnect persist for the whole Jest process
 * (module cache keeps service-worker.ts's registration). Per-test state
 * resets naturally because each test creates a fresh connect() pair.
 *
 * Loaded via jest.config.js setupFiles AFTER jest-webextension-mock so this
 * file's assignments win.
 */

type AnyListener = (arg: unknown) => void;

class FakePort {
  name: string;
  received: unknown[] = [];

  private _partner: FakePort | null = null;
  private _onMessageListeners: AnyListener[] = [];
  private _onDisconnectListeners: AnyListener[] = [];
  private _disconnected = false;

  constructor(name: string) {
    this.name = name;
  }

  onMessage = {
    addListener: (fn: AnyListener) => {
      this._onMessageListeners.push(fn);
    },
    removeListener: (fn: AnyListener) => {
      this._onMessageListeners = this._onMessageListeners.filter((l) => l !== fn);
    },
    hasListener: (fn: AnyListener) => this._onMessageListeners.includes(fn),
  };

  onDisconnect = {
    addListener: (fn: AnyListener) => {
      this._onDisconnectListeners.push(fn);
    },
    removeListener: (fn: AnyListener) => {
      this._onDisconnectListeners = this._onDisconnectListeners.filter((l) => l !== fn);
    },
  };

  postMessage = (msg: unknown): void => {
    if (this._disconnected || !this._partner) return;
    this._partner._deliver(msg);
  };

  disconnect = (): void => {
    if (this._disconnected) return;
    this._disconnected = true;
    const partner = this._partner;
    if (partner && !partner._disconnected) {
      partner._disconnected = true;
      for (const fn of partner._onDisconnectListeners.slice()) fn(partner);
    }
  };

  _linkTo(partner: FakePort): void {
    this._partner = partner;
  }

  private _deliver(msg: unknown): void {
    if (this._disconnected) return;
    this.received.push(msg);
    for (const fn of this._onMessageListeners.slice()) fn(msg);
  }
}

const onConnectListeners: AnyListener[] = [];

// Override the broken jest-webextension-mock entries.
(chrome.runtime.connect as unknown) = (info: { name?: string } = {}) => {
  const name = info.name ?? '';
  const clientPort = new FakePort(name);
  const serverPort = new FakePort(name);
  clientPort._linkTo(serverPort);
  serverPort._linkTo(clientPort);

  // Synchronously notify onConnect listeners with the server side of the
  // pair. Matches Chrome's "the SW sees the port immediately after the
  // content script calls connect" behavior closely enough for unit tests.
  for (const fn of onConnectListeners.slice()) fn(serverPort);

  return clientPort;
};

(chrome.runtime.onConnect as unknown) = {
  addListener: (fn: AnyListener) => {
    onConnectListeners.push(fn);
  },
  removeListener: (fn: AnyListener) => {
    const i = onConnectListeners.indexOf(fn);
    if (i >= 0) onConnectListeners.splice(i, 1);
  },
  hasListener: (fn: AnyListener) => onConnectListeners.includes(fn),
};

// Test-only helpers exported on a global namespace. Tests import the
// types from here and use these to introspect the SW's client-side
// view of a connection.
export { FakePort };
