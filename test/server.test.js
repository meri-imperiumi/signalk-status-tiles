import assert from "node:assert/strict";
import test from "node:test";

import pluginFactory, { CONFIG_PATH, configHash, PLUGIN_ID } from "../index.js";
import { CONFIG_HASH_PATH } from "../public/lib/config-hash.js";

/** Minimal but realistic config (validation outcome isn't under test). */
const SAMPLE = {
  contexts: [
    {
      id: "sailing",
      predicate: {
        path: "environment.wind.speedTrue",
        compare: ">",
        value: 5,
      },
    },
  ],
  tiles: [
    {
      id: "soc",
      label: "Battery",
      checks: [
        {
          type: "banded",
          path: "electrical.batteries.0.capacity.stateOfCharge",
          high: { warn: 0.4, warnState: "amber" },
        },
      ],
    },
  ],
};

/** Fake ServerAPI: records handleMessage calls, swallows logging,
 * and captures the app-mounted config endpoint registered via app.get.
 * subscriptionmanager is a minimal stand-in that records subscriptions
 * and lets tests push deltas through the plugin's callback. */
function fakeApp({ withHandleMessage = true } = {}) {
  /** @type {Array<{id: string, msg: object}>} */
  const messages = [];
  /** @type {string[]} */
  const debugLogs = [];
  /** @type {Array<object>} */
  const subscriptions = [];
  /** @type {Function|null} delta callback captured from the plugin */
  let deltaCallback = null;
  /** @type {Map<string, Function>} handlers registered via app.get */
  const getHandlers = new Map();
  return {
    messages,
    debugLogs,
    getHandlers,
    subscriptions,
    /** Feeds a delta through the plugin's subscription callback. */
    feed(delta) {
      deltaCallback?.(delta);
    },
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: (s) => debugLogs.push(s),
    // The config endpoint is mounted on the app (not the plugin
    // router) so anonymous/read-only clients can reach it.
    get: (path, handler) => getHandlers.set(path, handler),
    subscriptionmanager: {
      subscribe(subscription, unsubscribes, _onError, onDelta) {
        subscriptions.push(subscription);
        unsubscribes.push(() => {});
        deltaCallback = onDelta;
      },
    },
    ...(withHandleMessage
      ? { handleMessage: (id, msg) => messages.push({ id, msg }) }
      : {}),
  };
}

/** All config-hash values published so far, in order. */
function hashValues(app) {
  const out = [];
  for (const { msg } of app.messages) {
    for (const u of msg?.updates || []) {
      for (const v of u?.values || []) {
        if (v?.path === CONFIG_HASH_PATH) out.push(v.value);
      }
    }
  }
  return out;
}

/** Minimal express-like res. */
function call(handler) {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(payload) {
      this.body = payload;
    },
  };
  handler({}, res);
  return res;
}

test("configHash is stable across key order", () => {
  assert.equal(
    configHash({ tiles: SAMPLE.tiles, contexts: SAMPLE.contexts }),
    configHash({ contexts: SAMPLE.contexts, tiles: SAMPLE.tiles }),
  );
});

test("configHash changes with contents", () => {
  const changed = structuredClone(SAMPLE);
  changed.tiles[0].checks[0].high.warn = 0.3;
  assert.notEqual(configHash(SAMPLE), configHash(changed));
});

test("start publishes the config hash as a delta on the stream", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);

  // Exactly one hash publication, among the other deltas (metadata,
  // tile statuses) start() now emits.
  assert.deepEqual(hashValues(app), [configHash(SAMPLE)]);
  const hashMsg = app.messages.find(({ msg }) =>
    (msg?.updates || []).some((u) =>
      (u?.values || []).some((v) => v?.path === CONFIG_HASH_PATH),
    ),
  );
  assert.equal(hashMsg.id, PLUGIN_ID);
  assert.equal(hashMsg.msg.context, "vessels.self");
  // start() logs the hash it booted with (server-side debug trail for
  // tracing config-reload problems).
  assert.ok(
    app.debugLogs.some((s) => s.includes(configHash(SAMPLE))),
    "start() logged the config hash",
  );
});

test("a restart with changed config publishes a new hash", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  const changed = structuredClone(SAMPLE);
  changed.contexts[0].predicate.value = 8;
  plugin.start(changed);

  assert.deepEqual(hashValues(app), [configHash(SAMPLE), configHash(changed)]);
});

test("start tolerates servers without handleMessage", () => {
  const app = fakeApp({ withHandleMessage: false });
  const plugin = pluginFactory(app);
  assert.doesNotThrow(() => plugin.start(SAMPLE));
});

test("/configuration serves the config with its hash", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);

  const res = call(app.getHandlers.get(CONFIG_PATH));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.config, SAMPLE);
  assert.equal(res.body.configHash, configHash(SAMPLE));
  // Never cached: a config edit restarts the plugin (same URL, new
  // hash); a stale cached 200 would make the reload a no-op.
  assert.equal(res.headers["cache-control"], "no-store");
});

test("/configuration answers 503 when the plugin is not started", () => {
  // The endpoint is registered during start(); without start() the
  // handler isn't mounted, so simulate a started-but-stopped plugin
  // by mounting then calling with cleared config state.
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  plugin.stop();

  const res = call(app.getHandlers.get(CONFIG_PATH));
  assert.equal(res.statusCode, 503);
});
