import assert from "node:assert/strict";
import test from "node:test";

import pluginFactory, { configHash, PLUGIN_ID } from "../index.js";
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

/** Fake ServerAPI: records handleMessage calls, swallows logging. */
function fakeApp({ withHandleMessage = true } = {}) {
  /** @type {Array<{id: string, msg: object}>} */
  const messages = [];
  return {
    messages,
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    ...(withHandleMessage
      ? { handleMessage: (id, msg) => messages.push({ id, msg }) }
      : {}),
  };
}

/** Captures route handlers the way registerWithRouter registers them. */
function captureRouter() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  return {
    handlers,
    get: (path, handler) => handlers.set(path, handler),
  };
}

/** Minimal express-like res. */
function call(handler) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
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

  assert.equal(app.messages.length, 1);
  const { id, msg } = app.messages[0];
  assert.equal(id, PLUGIN_ID);
  assert.equal(msg.context, "vessels.self");
  assert.equal(msg.updates.length, 1);
  const value = msg.updates[0].values[0];
  assert.equal(value.path, CONFIG_HASH_PATH);
  assert.equal(value.value, configHash(SAMPLE));
});

test("a restart with changed config publishes a new hash", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  const changed = structuredClone(SAMPLE);
  changed.contexts[0].predicate.value = 8;
  plugin.start(changed);

  assert.equal(app.messages.length, 2);
  const [first, second] = app.messages.map((m) => m.msg.updates[0].values[0]);
  assert.equal(first.value, configHash(SAMPLE));
  assert.equal(second.value, configHash(changed));
  assert.notEqual(first.value, second.value);
});

test("start tolerates servers without handleMessage", () => {
  const app = fakeApp({ withHandleMessage: false });
  const plugin = pluginFactory(app);
  assert.doesNotThrow(() => plugin.start(SAMPLE));
});

test("/config serves the config with its hash", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  const router = captureRouter();
  plugin.registerWithRouter(router);

  const res = call(router.handlers.get("/config"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.config, SAMPLE);
  assert.equal(res.body.configHash, configHash(SAMPLE));
});

test("/config answers 503 when the plugin is not started", () => {
  const plugin = pluginFactory(fakeApp());
  const router = captureRouter();
  plugin.registerWithRouter(router);

  const res = call(router.handlers.get("/config"));
  assert.equal(res.statusCode, 503);
});
