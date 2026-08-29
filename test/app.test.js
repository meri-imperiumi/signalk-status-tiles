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
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {FakeElement|null} */
    this.parentNode = null;
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
    /** @type {Record<string, Function[]>} */
    this._listeners = {};
  }
  addEventListener(type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }
  removeEventListener(type, listener) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i !== -1) arr.splice(i, 1);
  }
  dispatchEvent(event) {
    for (const l of this._listeners[event.type] || []) l(event);
    return true;
  }
  /** Mimic the browser: clearing innerHTML drops the children. */
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
  }
  get innerHTML() {
    return this._innerHTML;
  }
  append(...els) {
    for (const el of els) {
      el.parentNode = this;
      this.children.push(el);
    }
  }
  replaceChildren(...els) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...els);
  }
  insertBefore(el, ref) {
    el.parentNode = this;
    if (ref == null) {
      this.children.push(el);
      return el;
    }
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(el);
    else this.children.splice(i, 0, el);
    return el;
  }
  remove() {
    if (this.parentNode == null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i !== -1) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get nextSibling() {
    if (this.parentNode == null) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] ?? null;
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
  location: {
    protocol: "http:",
    host: "signalk.local",
    /** @type {number} */
    reloadCalls: 0,
    reload() {
      this.reloadCalls++;
    },
  },
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
  /** @type {{ok: boolean, status: number}|null} admin probe response */
  adminProbe: null,
  /** @type {object|null} resources-API collection for examples */
  examplesCollection: null,
  /** @type {{ok: boolean, status: number, body: object}|null} PUT /examples */
  examplesPut: null,
  /** Captured PUT bodies (one per PUT /examples call). */
  putBodies: [],
};

globalThis.fetch = async (url, opts) => {
  server.calls++;
  const u = typeof url === "string" ? url : "";
  // Admin examples probe/route (admin-gated by the server).
  if (u.includes("/plugins/signalk-status-tiles/examples")) {
    if (opts?.method === "PUT") {
      server.putBodies.push(opts.body ? JSON.parse(opts.body) : null);
      const r = server.examplesPut ?? {
        ok: true,
        status: 200,
        body: {
          added: { contexts: [], tiles: [] },
          skipped: { contexts: [], tiles: [] },
        },
      };
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }
    const p = server.adminProbe ?? { ok: true, status: 200 };
    return { ok: p.ok, status: p.status, json: async () => ({ ok: true }) };
  }
  // Resources API (aggregated example sets).
  if (u.includes("/resources/statusTileExamples")) {
    return { ok: true, json: async () => server.examplesCollection ?? {} };
  }
  // Config endpoint.
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

async function flush(microtasks = 5) {
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
}

function subscribePaths(socket) {
  assert.ok(socket.sent.length > 0, "subscribe sent");
  const msg = JSON.parse(socket.sent[0]);
  for (const entry of msg.subscribe) {
    assert.equal(
      entry.policy,
      "instant",
      "instant policy, rate-limited by minPeriod",
    );
    assert.equal(entry.minPeriod, 1000, "at most once per second");
  }
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
  assert.ok(
    paths.includes("environment.mode"),
    "day/night mode path subscribed",
  );
  // The reliable reload backstop: a poll timer is running.
  assert.ok(el.pollTimer != null, "config poll scheduled");
  // On-connect verification: same hash => no extra swap.
  assert.equal(el.configHash, "hash-a");
  el.disconnectedCallback();
  assert.equal(el.pollTimer, null, "poll timer cleared on disconnect");
});

test("a differing hash delta reloads the page", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };
  window.location.reloadCalls = 0;

  const el = mount();
  await el.connectedCallback();
  await flush();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();

  // Server-side edit: plugin restarts, publishes a new hash, and REST
  // serves the new config+hash. The delta triggers a re-fetch to
  // confirm, then a full page reload (no in-page hot-swap).
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
  assert.equal(window.location.reloadCalls, 1, "page reloaded on new hash");
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
test("reconnect re-verifies and reloads if the hash differs", async () => {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };
  window.location.reloadCalls = 0;

  const el = mount();
  await el.connectedCallback();
  await flush();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();
  assert.equal(window.location.reloadCalls, 0, "initial connect: hash matches");

  // While the link is down the plugin is reconfigured (new hash). The
  // delta was missed, so the on-reconnect verification re-fetches and
  // reloads to catch up.
  server.configBody = { config: CONFIG_B, configHash: "hash-b" };
  socket.serverOpen(); // simulate reconnect firing the open handler
  await flush(10);
  assert.equal(
    window.location.reloadCalls,
    1,
    "reconnect with a new hash reloads",
  );
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

test("REST returns no hash: first delta becomes baseline, a later change reloads", async () => {
  // Some server setups serve /configuration without a configHash (older
  // handler, stale closure). The stream delta is the source of truth
  // there: the first delta we see must NOT reload (it describes the
  // config we already booted with), but a subsequent differing delta
  // (a real save) must reload.
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: null };
  window.location.reloadCalls = 0;

  const el = mount();
  await el.connectedCallback();
  await flush();
  assert.equal(el.configHash, null, "boot saw no REST hash");
  const socket = FakeWebSocket.sockets.at(-1);
  socket.serverOpen();
  await flush();
  assert.equal(
    window.location.reloadCalls,
    0,
    "reconnect verify: no hash -> no reload",
  );

  // First delta: adopts the hash as the baseline, does NOT reload.
  socket.serverMessage(
    JSON.stringify({
      context: "vessels.self",
      updates: [
        { values: [{ path: "statusTiles.configHash", value: "hash-a" }] },
      ],
    }),
  );
  await flush();
  assert.equal(el.configHash, "hash-a", "first delta adopted as baseline");
  assert.equal(
    window.location.reloadCalls,
    0,
    "baseline delta does not reload",
  );

  // A real save: differing hash -> reload.
  socket.serverMessage(
    JSON.stringify({
      context: "vessels.self",
      updates: [
        { values: [{ path: "statusTiles.configHash", value: "hash-b" }] },
      ],
    }),
  );
  await flush(10);
  assert.equal(window.location.reloadCalls, 1, "changed delta reloads");
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

// --- Example tile sets (doc/example-tiles-plan.md) --------------------

/**
 * Resets the mutable server state for an examples test: config serves
 * a clean CONFIG_A, admin probe returns 200, and the examples
 * collection / PUT responses are cleared (tests set them as needed).
 */
function resetExamplesServer() {
  FakeWebSocket.sockets = [];
  server.statusCode = 200;
  server.configBody = { config: CONFIG_A, configHash: "hash-a" };
  server.adminProbe = null;
  server.examplesCollection = null;
  server.examplesPut = null;
  server.putBodies = [];
}

/** Finds a set card's Add button by class — robust to the preview
 *  tile elements inserted ahead of it in the card. */
function addBtn(card) {
  for (const c of card.children) {
    if (typeof c.className === "string" && c.className.includes("add-set-btn"))
      return c;
  }
  return null;
}

/** A small example set returned by a fake resource provider. */
const EXAMPLE_SET = {
  id: "energy-outlook",
  name: "Energy outlook",
  description: "Surplus window tiles",
  contexts: [
    {
      id: "energySurplusWindow",
      predicate: { between: { from: "a", to: "b" } },
    },
  ],
  tiles: [
    {
      id: "energySurplus",
      label: "Energy surplus",
      footer: [
        { label: "Window", path: "electrical.energy.prediction.surplus.from" },
      ],
      checks: [
        {
          type: "notification",
          path: "notifications.electrical.energy.surplus",
        },
      ],
    },
  ],
};

test("admin probe enables the chrome-bar + button", async () => {
  resetExamplesServer();
  server.adminProbe = { ok: true, status: 200 };
  const el = mount();
  await el.connectedCallback();
  await flush();
  assert.equal(
    el.gridEl.addBtn.style.display,
    "",
    "+ visible after admin probe",
  );
  el.disconnectedCallback();
});

test("non-admin (403) hides the + button", async () => {
  resetExamplesServer();
  server.adminProbe = { ok: false, status: 403 };
  const el = mount();
  await el.connectedCallback();
  await flush();
  assert.equal(
    el.gridEl.addBtn.style.display,
    "none",
    "+ hidden for read-only",
  );
  el.disconnectedCallback();
});

test("openExamples renders set cards from the resources API", async () => {
  resetExamplesServer();
  server.examplesCollection = {
    "signalk-energy-predictor": { sets: [EXAMPLE_SET] },
  };
  const el = mount();
  await el.connectedCallback();
  await flush();
  const socket = FakeWebSocket.sockets.at(-1);

  // Simulate the user clicking the "+" button.
  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-open", { bubbles: true }),
  );
  await flush();
  // setPaths reconnects via a setTimeout(0) — let timers run.
  await new Promise((r) => setTimeout(r, 5));

  // Overlay visible with one set card.
  assert.equal(el.gridEl.examplesOverlay.style.display, "", "overlay open");
  const cards = el.gridEl.examplesList.children;
  assert.equal(cards.length, 1, "one set card");
  assert.equal(cards[0].children[0].textContent, "Energy outlook");
  // Real-data previews (public/lib/preview.js): tiles render through
  // the real evaluator against the boat's live cache. Before the first
  // delta lands, the notification check is honestly stale → neutral,
  // no headline (the check isn't `display`), footer "—" (unfed), and a
  // muted caption naming the check type + watched path. No fabricated
  // healthy state.
  const preview = cards[0].children[3];
  assert.equal(preview.className, "examples-preview", "preview container");
  const wrap = preview.children[0];
  assert.equal(wrap.className, "examples-tile-wrap");
  const tileEl = wrap.children[0];
  assert.equal(tileEl.className, "tile neutral", "no data yet → neutral");
  assert.equal(
    tileEl.children[0].textContent,
    "Energy surplus",
    "label rendered",
  );
  // No display check → no headline value; the slot is hidden.
  assert.equal(tileEl.children[1].textContent, "", "no headline value");
  assert.equal(tileEl.children[1].style.display, "none", "value slot hidden");
  const footer = tileEl.children[3];
  assert.equal(footer.children.length, 1, "one footer entry");
  assert.equal(footer.children[0].children[0].textContent, "Window");
  assert.equal(
    footer.children[0].children[1].textContent,
    "—",
    "footer value is — (path unfed so far)",
  );
  const caption = wrap.children[1];
  assert.equal(caption.className, "examples-checks");
  assert.match(caption.textContent, /^notification · /);
  // Add button enabled (not already added).
  const btn = addBtn(cards[0]);
  assert.equal(btn.textContent, "Add");
  assert.equal(btn.disabled, false);

  // The picker extends the stream subscription with the sets' paths:
  // setPaths reconnected the socket; the new socket's subscribe list
  // includes the example tile's paths (check + footer).
  const pickSocket = FakeWebSocket.sockets.at(-1);
  assert.notEqual(pickSocket, socket, "picker re-subscribed the stream");
  pickSocket.serverOpen();
  await flush();
  const pickPaths = subscribePaths(pickSocket);
  assert.ok(
    pickPaths.includes("notifications.electrical.energy.surplus"),
    "example check path subscribed",
  );
  assert.ok(
    pickPaths.includes("electrical.energy.prediction.surplus.from"),
    "example footer path subscribed",
  );

  // A real delta for the check path arrives → the preview re-renders
  // with the REAL data: a normal notification evaluates green.
  pickSocket.serverMessage(
    JSON.stringify({
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: "notifications.electrical.energy.surplus",
              value: { state: "normal", message: "all good" },
            },
          ],
        },
      ],
    }),
  );
  await flush();
  // replaceChildren rebuilt the wrap in place — re-query the tile.
  const tile2 = preview.children[0].children[0];
  assert.equal(
    tile2.className,
    "tile theme-green lit",
    "real delta → real evaluated state",
  );
  assert.equal(tile2.children[0].textContent, "Energy surplus");
  assert.equal(el.gridEl.errorEl.textContent, "", "no eval error");

  // Closing the picker restores the config-only subscription.
  el.gridEl.closeExamples();
  await flush();
  await new Promise((r) => setTimeout(r, 5));
  const restoreSocket = FakeWebSocket.sockets.at(-1);
  assert.notEqual(restoreSocket, pickSocket, "close re-subscribed back");
  restoreSocket.serverOpen();
  await flush();
  const restorePaths = subscribePaths(restoreSocket);
  assert.ok(
    !restorePaths.includes("notifications.electrical.energy.surplus"),
    "example path unsubscribed on close",
  );
  el.disconnectedCallback();
});

test("already-added sets are badged and disabled", async () => {
  resetExamplesServer();
  // Config already contains the set's tile id → fully added.
  server.configBody = {
    config: {
      contexts: [],
      tiles: [
        { id: "energySurplus", checks: [{ type: "notification", path: "n" }] },
      ],
    },
    configHash: "hash-x",
  };
  server.examplesCollection = { p: { sets: [EXAMPLE_SET] } };
  const el = mount();
  await el.connectedCallback();
  await flush();

  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-open", { bubbles: true }),
  );
  await flush();

  const btn = addBtn(el.gridEl.examplesList.children[0]);
  assert.equal(btn.textContent, "Already added");
  assert.equal(btn.disabled, true);
  el.disconnectedCallback();
});

test("addExample PUTs the set and closes the overlay", async () => {
  resetExamplesServer();
  server.examplesCollection = { p: { sets: [EXAMPLE_SET] } };
  const el = mount();
  await el.connectedCallback();
  await flush();

  // Open the overlay.
  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-open", { bubbles: true }),
  );
  await flush();

  // Click "Add".
  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-add", {
      bubbles: true,
      detail: { set: EXAMPLE_SET },
    }),
  );
  await flush();

  // PUT sent with the set's tiles/contexts.
  assert.equal(server.putBodies.length, 1, "one PUT sent");
  assert.deepEqual(server.putBodies[0], {
    tiles: EXAMPLE_SET.tiles,
    contexts: EXAMPLE_SET.contexts,
  });
  // Overlay closed on success.
  assert.equal(
    el.gridEl.examplesOverlay.style.display,
    "none",
    "overlay closed",
  );
  el.disconnectedCallback();
});

test("addExample surfaces 400 errors in the overlay", async () => {
  resetExamplesServer();
  server.examplesCollection = { p: { sets: [EXAMPLE_SET] } };
  server.examplesPut = {
    ok: false,
    status: 400,
    body: { message: "Merged config is invalid", errors: ["bad check"] },
  };
  const el = mount();
  await el.connectedCallback();
  await flush();

  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-open", { bubbles: true }),
  );
  await flush();

  el.gridEl.dispatchEvent(
    new CustomEvent("st-examples-add", {
      bubbles: true,
      detail: { set: EXAMPLE_SET },
    }),
  );
  await flush();

  // Overlay stays open; error shown.
  assert.equal(
    el.gridEl.examplesOverlay.style.display,
    "",
    "overlay stays open on 400",
  );
  assert.match(el.gridEl.examplesErrorEl.textContent, /invalid/i);
  assert.match(el.gridEl.examplesErrorEl.textContent, /bad check/);
  el.disconnectedCallback();
});

test("closeExamples hides the overlay", () => {
  resetExamplesServer();
  const grid = new (elementClasses.get("st-tile-grid"))();
  grid.openExamples({ sets: [], alreadyAdded: new Set() });
  assert.equal(grid.examplesOverlay.style.display, "", "overlay open");
  grid.closeExamples();
  assert.equal(grid.examplesOverlay.style.display, "none", "overlay closed");
});
