/**
 * Server-side example-tile-set endpoints (index.js): the read-only
 * `statusTileExamples` resource provider this plugin registers, and the
 * admin `GET/PUT /examples` routes for probing access and copying a set
 * into the active config.
 *
 * @file examples-api.test.js */

import assert from "node:assert/strict";
import test from "node:test";

import pluginFactory, { PLUGIN_ID } from "../index.js";
import { validateConfig } from "../public/lib/config.js";

/** A small valid config for stored options. */
const SAMPLE = {
  contexts: [],
  tiles: [{ id: "existing", checks: [{ type: "boolean", path: "p" }] }],
};

/** A small valid example set. */
const EXAMPLE_SET = {
  contexts: [
    { id: "newctx", predicate: { path: "q", compare: "gt", value: 1 } },
  ],
  tiles: [{ id: "newtile", checks: [{ type: "boolean", path: "q" }] }],
};

/**
 * Fake ServerAPI with everything index.js touches: subscriptionmanager
 * (stand-in), app.get for the config endpoint, the resource provider
 * registry, readPluginOptions/savePluginOptions, and a
 * registerWithRouter-captured express-like router. Every handler that
 * could be called is wired; missing ones default to no-ops so a test
 * that doesn't exercise them isn't cluttered.
 *
 * readPluginOptions/savePluginOptions deliberately mirror
 * signalk-server's real (asymmetric) contract rather than a simplified
 * one: internally this holds the server's own envelope shape,
 * `{ configuration: <bare config>, enabled }`. `readPluginOptions()`
 * returns that whole envelope; `savePluginOptions(bareConfig, cb)`
 * takes the *bare* config (matching what `start(config)` itself
 * receives) and wraps it itself — `envelope.configuration = bareConfig`
 * — exactly like signalk-server's `appCopy.savePluginOptions`. A fake
 * that instead treated both as symmetric (as an earlier version of this
 * file did) can't catch a caller that round-trips the wrapped shape
 * back into savePluginOptions, which is exactly the bug in issue #1:
 * every such round-trip nests the stored config one level deeper.
 */
function fakeApp({ storedOptions = SAMPLE } = {}) {
  /** @type {object|null} the resource provider registered, if any */
  let provider = null;
  /** @type {object} the server's own envelope: { configuration, enabled } */
  let envelope = {
    configuration: structuredClone(storedOptions),
    enabled: true,
  };
  /** @type {Array<{verb: string, path: string, handler: Function}>} */
  const routerRoutes = [];
  const router = {
    get: (path, handler) => routerRoutes.push({ verb: "get", path, handler }),
    put: (path, handler) => routerRoutes.push({ verb: "put", path, handler }),
  };
  /** @type {Array<object>} deltas published via handleMessage */
  const messages = [];
  return {
    messages,
    provider: () => provider,
    routerRoutes,
    /** The bare persisted config (`envelope.configuration`) — what most
     * tests actually want to assert against. */
    storedConfig: () => structuredClone(envelope.configuration),
    /** The full server envelope, for tests that want to check nesting
     * hasn't crept in (issue #1's regression shape). */
    storedEnvelope: () => structuredClone(envelope),
    feed(delta, deltaCallback) {
      deltaCallback?.(delta);
    },
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    get: () => {},
    handleMessage: (id, msg) => messages.push({ id, msg }),
    subscriptionmanager: {
      subscribe(_sub, unsubscribes, _onError, onDelta) {
        unsubscribes.push(() => {});
        this._onDelta = onDelta;
      },
    },
    registerResourceProvider(p) {
      provider = p;
    },
    readPluginOptions: () => structuredClone(envelope),
    savePluginOptions: (bareConfig, cb) => {
      envelope = { ...envelope, configuration: structuredClone(bareConfig) };
      // Mirror the real server's async cb contract.
      setImmediate(() => cb(null));
    },
    // The plugin calls registerWithRouter(router); tests capture it.
    _router: router,
  };
}

/** Minimal express-like res with json/status chaining. */
function callRoute(route, req = {}) {
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
  route.handler(req, res);
  return res;
}

function findRoute(app, verb, path) {
  return app.routerRoutes.find((r) => r.verb === verb && r.path === path);
}

test("start registers a statusTileExamples resource provider", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  try {
    plugin.start(SAMPLE);
    const provider = app.provider();
    assert.ok(provider, "provider registered");
    assert.equal(provider.type, "statusTileExamples");
  } finally {
    plugin.stop();
  }
});

test("provider listResources returns the dogfood set while running", async () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  try {
    plugin.start(SAMPLE);
    const provider = app.provider();
    const resources = await provider.methods.listResources();
    assert.ok(PLUGIN_ID in resources);
    assert.equal(resources[PLUGIN_ID].name, "Status Tiles starter examples");
    assert.ok(Array.isArray(resources[PLUGIN_ID].sets));
    assert.ok(resources[PLUGIN_ID].sets.length > 0);
  } finally {
    plugin.stop();
  }
});

test("provider listResources returns {} when stopped", async () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  plugin.stop();
  const provider = app.provider();
  const resources = await provider.methods.listResources();
  assert.deepEqual(resources, {});
});

test("provider is read-only (setResource/deleteResource throw)", async () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  try {
    plugin.start(SAMPLE);
    const provider = app.provider();
    await assert.rejects(() => provider.methods.setResource("x", {}));
    await assert.rejects(() => provider.methods.deleteResource("x"));
  } finally {
    plugin.stop();
  }
});

test("registerWithRouter mounts GET and PUT /examples", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.registerWithRouter(app._router);
  assert.ok(findRoute(app, "get", "/examples"), "GET /examples mounted");
  assert.ok(findRoute(app, "put", "/examples"), "PUT /examples mounted");
});

test("GET /examples is an admin probe returning { ok: true }", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.registerWithRouter(app._router);
  const res = callRoute(findRoute(app, "get", "/examples"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("PUT /examples merges the set, validates, persists, and restarts", async () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  let restartedWith = null;
  plugin.start(SAMPLE, (cfg) => {
    restartedWith = cfg;
  });
  plugin.registerWithRouter(app._router);

  const res = callRoute(findRoute(app, "put", "/examples"), {
    body: EXAMPLE_SET,
  });

  // savePluginOptions is async (setImmediate); await the macrotask.
  await new Promise((r) => setImmediate(r));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.added, {
    contexts: ["newctx"],
    tiles: ["newtile"],
  });
  assert.deepEqual(res.body.skipped, { contexts: [], tiles: [] });
  // Persisted (merged contains both old and new).
  const stored = app.storedConfig();
  assert.deepEqual(
    stored.tiles.map((t) => t.id),
    ["existing", "newtile"],
  );
  assert.deepEqual(
    stored.contexts.map((c) => c.id),
    ["newctx"],
  );
  // restart was invoked with the merged config.
  assert.ok(restartedWith, "restart called");
  assert.deepEqual(
    restartedWith.tiles.map((t) => t.id),
    ["existing", "newtile"],
  );
  // Regression for issue #1: what's persisted and what restart() got
  // are both the *bare* config — neither wraps a `configuration` key
  // around the whole thing (which is what nested storage one level
  // deeper on every add).
  assert.ok(!("configuration" in stored));
  assert.ok(!("configuration" in restartedWith));
  plugin.stop();
});

test("PUT /examples across two calls accumulates tiles instead of nesting the stored config (issue #1)", async () => {
  // The regression: app.readPluginOptions() returns the server's
  // wrapped envelope ({ configuration, enabled }). Two successive PUT
  // /examples calls — each merging a *different* set — must both:
  //  1. leave the stored config at a single nesting level throughout
  //     (never `stored.configuration.configuration...`), and
  //  2. accumulate tiles from *both* calls, not just the most recent
  //     one (the actual symptom reported: "Add" appeared to replace
  //     the whole tile grid rather than adding to it).
  const app = fakeApp();
  const plugin = pluginFactory(app);
  const restarts = [];
  plugin.start(SAMPLE, (cfg) => restarts.push(cfg));
  plugin.registerWithRouter(app._router);

  const OTHER_SET = {
    contexts: [],
    tiles: [{ id: "othertile", checks: [{ type: "boolean", path: "r" }] }],
  };

  callRoute(findRoute(app, "put", "/examples"), { body: EXAMPLE_SET });
  await new Promise((r) => setImmediate(r));
  callRoute(findRoute(app, "put", "/examples"), { body: OTHER_SET });
  await new Promise((r) => setImmediate(r));

  const envelope = app.storedEnvelope();
  // Exactly one level of wrapping — the stored config itself carries no
  // nested `configuration` key.
  assert.ok(!("configuration" in envelope.configuration));

  const stored = app.storedConfig();
  assert.deepEqual(
    stored.tiles.map((t) => t.id),
    ["existing", "newtile", "othertile"],
  );

  // Both restart calls got the bare shape too, and the second restart's
  // tile list already includes the first call's addition (proving the
  // second PUT actually saw the first PUT's merge, rather than reading
  // a stale/empty view because it was buried under an extra wrapper).
  assert.equal(restarts.length, 2);
  for (const cfg of restarts) assert.ok(!("configuration" in cfg));
  assert.deepEqual(
    restarts[1].tiles.map((t) => t.id),
    ["existing", "newtile", "othertile"],
  );

  plugin.stop();
});

test("PUT /examples skips (never clobbers) duplicate ids", async () => {
  const app = fakeApp({
    storedOptions: {
      contexts: [],
      tiles: [
        {
          id: "newtile",
          label: "mine",
          checks: [{ type: "boolean", path: "p" }],
        },
      ],
    },
  });
  const plugin = pluginFactory(app);
  plugin.start(app.storedConfig(), () => {});
  plugin.registerWithRouter(app._router);

  const res = callRoute(findRoute(app, "put", "/examples"), {
    body: EXAMPLE_SET,
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(res.statusCode, 200);
  // newctx is a new context (stored has none) → added; newtile exists → skipped.
  assert.deepEqual(res.body.added, { contexts: ["newctx"], tiles: [] });
  assert.deepEqual(res.body.skipped, { contexts: [], tiles: ["newtile"] });
  // Existing tile untouched (never clobbered).
  assert.equal(app.storedConfig().tiles[0].label, "mine");
  plugin.stop();
});

test("PUT /examples re-add is idempotent", async () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE, () => {});
  plugin.registerWithRouter(app._router);

  callRoute(findRoute(app, "put", "/examples"), { body: EXAMPLE_SET });
  await new Promise((r) => setImmediate(r));
  const second = callRoute(findRoute(app, "put", "/examples"), {
    body: EXAMPLE_SET,
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body.added, { contexts: [], tiles: [] });
  assert.deepEqual(second.body.skipped, {
    contexts: ["newctx"],
    tiles: ["newtile"],
  });
  // No duplication.
  assert.equal(app.storedConfig().tiles.length, 2);
  plugin.stop();
});

test("PUT /examples rejects a body without a tiles array with 400", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  plugin.registerWithRouter(app._router);

  const res = callRoute(findRoute(app, "put", "/examples"), {
    body: { contexts: [] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tiles/);
  plugin.stop();
});

test("PUT /examples returns 400 when the merged config is invalid", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE, () => {});
  plugin.registerWithRouter(app._router);

  // Unknown check type → validateConfig flags it.
  const badSet = {
    contexts: [],
    tiles: [{ id: "bad", checks: [{ type: "nope", path: "p" }] }],
  };
  const res = callRoute(findRoute(app, "put", "/examples"), { body: badSet });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(
    res.body.errors,
    validateConfig({
      contexts: SAMPLE.contexts,
      tiles: [...SAMPLE.tiles, ...badSet.tiles],
    }).errors,
  );
  plugin.stop();
});

test("PUT /examples answers 503 when the plugin is not started", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.registerWithRouter(app._router);

  const res = callRoute(findRoute(app, "put", "/examples"), {
    body: EXAMPLE_SET,
  });
  assert.equal(res.statusCode, 503);
});

test("start tolerates servers without a resource provider registry", () => {
  const app = fakeApp();
  delete app.registerResourceProvider;
  const plugin = pluginFactory(app);
  try {
    // No crash; examples discovery just won't include this plugin's set.
    assert.doesNotThrow(() => plugin.start(SAMPLE));
    assert.equal(app.provider(), null);
  } finally {
    plugin.stop();
  }
});

test("a second provider appears in the aggregated resources collection", async () => {
  // Two plugins' providers aggregate in the resources API; we simulate
  // that by collecting both listResources outputs the way the server
  // would (merge keys). This is the shape the webapp fetches.
  const appA = fakeApp();
  const pluginA = pluginFactory(appA);
  pluginA.start(SAMPLE);

  const appB = fakeApp();
  const pluginB = pluginFactory(appB);
  pluginB.start(SAMPLE);

  const collection = {
    ...(await appA.provider().methods.listResources()),
    ...(await appB.provider().methods.listResources()),
  };
  // Both keyed under their plugin id (same id here → last wins, which
  // is fine: a server never hosts two instances of the same plugin).
  assert.ok(PLUGIN_ID in collection);

  pluginA.stop();
  pluginB.stop();
});
