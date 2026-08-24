/**
 * End-to-end simulation of the webapp (public/app.js) with stubbed DOM,
 * fetch, and WebSocket: initial config load, hash-delta-driven reload,
 * and reconnect verification. This is where server/webapp shape skew
 * and reload bugs surface before they hit a helm display.
 *
 * @file app.test.js */

import assert from "node:assert/strict";
import test from "node:test";

// --- DOM stubs (before importing app.js, which registers elements) ---

class FakeShadowRoot {
  constructor() {
    /** @type {Array} */
    this.children = [];
  }
  append(...els) {
    this.children.push(...els);
  }
}

class FakeElement {
  constructor(_tag) {
    this.children = [];
    this.style = {
      setProperty: () => {},
      removeProperty: () => {},
      display: "",
    };
    this.classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
    };
    this.dataset = {};
    this.textContent = "";
    this._innerHTML = "";
  }
  /** Mimic the browser: clearing innerHTML drops the children. */
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  append(...els) {
    this.children.push(...els);
  }
  replaceChildren(...els) {
    this.children = els;
  }
  querySelectorAll() {
    return [];
  }
}

/** @type {Map<string, Function>} */
const elementClasses = new Map();

globalThis.HTMLElement = class HTMLElement extends FakeElement {
  attachShadow() {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }
};
globalThis.customElements = {
  define: (name, cls) => elementClasses.set(name, cls),
};
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
};
globalThis.window = {
  location: { protocol: "http:", host: "signalk.local" },
  localStorage: null,
};

// --- WebSocket stub ------------------------------------------------------

class FakeWebSocket {
  /** All sockets ever created, oldest first. */
  static sockets = [];
  /** @type {Array<{type: string, listener: Function}>} */
  listeners = [];
  /** @type {Array<string>} raw frames sent by the client */
  sent = [];
  closed = false;

  constructor(url) {
    this.url = url;
    FakeWebSocket.sockets.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.#emit("close");
  }
  #emit(type, event = {}) {
    for (const l of this.listeners) {
      if (l.type === type) l.listener({ type, ...event });
    }
  }
  /** Test hooks: simulate server behavior. */
  serverOpen() {
    this.#emit("open");
  }
  serverMessage(data) {
    this.#emit("message", { data });
  }
}

globalThis.WebSocket = FakeWebSocket;

// --- fetch stub ----------------------------------------------------------

/** Mutable server state the stubbed fetch serves. */
const server = {
  configBody: null,
  statusCode: 200,
  calls: 0,
};

globalThis.fetch = async () => {
  server.calls++;
  if (server.statusCode !== 200) {
    return { ok: false, status: server.statusCode };
  }
  return { ok: true, json: async () => server.configBody };
};

// Import AFTER stubs are in place (registers both custom elements).
await import("../public/app.js");

const StApp = elementClasses.get("st-app");
assert.ok(StApp, "st-app element registered");

/** @returns {HTMLElement} */
function mount() {
  const el = new StApp();
  // st-tile-grid stub: record assigned properties.
  const grid = new (elementClasses.get("st-tile-grid"))();
  el.shadowRoot.children = [grid];
  el.gridEl = grid;
  return el;
}

/** Tiles rendered into the grid's inner container (plus reserved slots). */
function renderedChildren(el) {
  return el.gridEl.gridEl.children.length;
}

/** Minimal config: one tile, one banded check on battery `idx`. */
function configWith(socWarn, batteryIdx = 0) {
  return {
    contexts: [],
    tiles: [
      {
        id: "soc",
        label: "Battery",
        checks: [
          {
            type: "banded",
            path: `electrical.batteries.${batteryIdx}.capacity.stateOfCharge`,
            high: { warn: socWarn, warnState: "amber" },
          },
        ],
      },
    ],
  };
}

const CONFIG_A = configWith(0.4, 0);
// Different check path AND threshold: proves both the engine swap and
// the stream re-subscription pick up the new config.
const CONFIG_B = configWith(0.3, 1);

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush(microtasks = 5) {
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
}

function subscribePaths(socket) {
  assert.ok(socket.sent.length > 0, "subscribe sent");
  const msg = JSON.parse(socket.sent[0]);
  return msg.subscribe.map((s) => s.path);
}

test("initial load: engine built from the REST envelope, hash path subscribed", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };

  const el = mount();
  await el.connectedCallback();
  await flush();

  assert.equal(el.configHash, "hash-a");
  assert.deepEqual(el.config, CONFIG_A);
  // Engine evaluated once (initial paint) and rendered tiles: one tile
  // plus one reserved overflow slot (default coverage.slots = 1).
  assert.ok(renderedChildren(el) === 2, "one tile + one slot rendered");
  assert.equal(el.gridEl.errorEl.textContent, "", "no error for a good config");
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();
  const paths = subscribePaths(socket);
  assert.ok(paths.includes("statusTiles.configHash"), "hash path subscribed");
  assert.ok(
    paths.includes("electrical.batteries.0.capacity.stateOfCharge"),
    "check path subscribed",
  );
  // On-connect verification: same hash => no extra swap.
  assert.equal(el.configHash, "hash-a");
  el.disconnectedCallback();
});

test("initial load: still works when the server answers the old bare-config shape", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = CONFIG_A; // old server version, no envelope

  const el = mount();
  await el.connectedCallback();
  await flush();

  assert.ok(renderedChildren(el) === 2, "one tile + one slot rendered");
  assert.deepEqual(el.config, CONFIG_A);
  assert.equal(el.configHash, null, "no hash in the old shape");
  el.disconnectedCallback();
});

test("initial load: a config without tiles shows an explicit message", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: { contexts: [], tiles: [] }, configHash: "x" };

  const el = mount();
  await el.connectedCallback();
  await flush();

  assert.match(el.gridEl.errorEl.textContent, /No tiles configured/);
  el.disconnectedCallback();
});
test("hash delta triggers re-fetch and engine swap with new subscriptions", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };

  const el = mount();
  await el.connectedCallback();
  await flush();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();

  // Server-side edit: plugin restarts, publishes new hash, REST serves
  // the new config.
  server.configBody = { config: CONFIG_B, configHash: "hash-b" };
  socket.serverMessage(
    JSON.stringify({
      context: "vessels.self",
      updates: [
        { values: [{ path: "statusTiles.configHash", value: "hash-b" }] },
      ],
    }),
  );
  await flush(10);

  assert.equal(el.configHash, "hash-b");
  assert.deepEqual(el.config, CONFIG_B);
  // Stream re-subscribed: setPaths closed the old socket and the
  // immediate reconnect (no retry interval) opened a new one.
  assert.ok(socket.closed, "old socket closed for re-subscription");
  await sleep(20); // reconnect is scheduled with 0 delay
  const newSocket = FakeWebSocket.sockets.at(-1);
  assert.notEqual(newSocket, socket);
  newSocket.serverOpen();
  await flush();
  const newPaths = subscribePaths(newSocket);
  assert.ok(
    newPaths.includes("electrical.batteries.1.capacity.stateOfCharge"),
    "re-subscribed to the new config's paths",
  );
  assert.ok(
    !newPaths.includes("electrical.batteries.0.capacity.stateOfCharge"),
    "old path dropped from subscriptions",
  );
  // Reconnect verification with matching hash: engine not swapped again.
  assert.equal(el.configHash, "hash-b");
  assert.ok(renderedChildren(el) === 2);
  el.disconnectedCallback();
});

test("same-hash delta does not reload", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };

  const el = mount();
  await el.connectedCallback();
  await flush();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();
  const callsBefore = server.calls;

  socket.serverMessage(
    JSON.stringify({
      context: "vessels.self",
      updates: [
        { values: [{ path: "statusTiles.configHash", value: "hash-a" }] },
      ],
    }),
  );
  await flush();
  assert.equal(server.calls, callsBefore, "no re-fetch for same hash");
  el.disconnectedCallback();
});

test("config fetch retries through a 503 plugin restart window", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 503;
  server.configBody = null;

  const el = mount();
  const pending = el.connectedCallback();
  await flush();
  // First attempts fail; the server comes back mid-retry.
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };
  await pending;
  await flush();

  assert.ok(renderedChildren(el) === 2, "loaded after retries");
  el.disconnectedCallback();
});
