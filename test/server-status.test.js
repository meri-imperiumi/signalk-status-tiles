/**
 * Server-side tile status evaluation and publication (index.js +
 * public/lib/status-paths.js). The plugin runs the same engine the
 * webapp uses, fed by a subscriptionmanager subscription, and publishes
 * each tile's aggregated state as a plain string delta under
 * `statusTiles.tiles.<id>` — change-driven, with null for
 * context-hidden tiles.
 *
 * @file server-status.test.js */

import assert from "node:assert/strict";
import test from "node:test";

import pluginFactory from "../index.js";
import { collectPaths } from "../public/lib/paths.js";
import {
  TILE_STATUS_BASE,
  tileStatusPath,
} from "../public/lib/status-paths.js";

const SOC_PATH = "electrical.batteries.0.capacity.stateOfCharge";
const WIND_PATH = "environment.wind.speedTrue";

const SAMPLE = {
  contexts: [
    {
      id: "sailing",
      predicate: { path: WIND_PATH, compare: "gt", value: 5 },
    },
  ],
  tiles: [
    {
      id: "soc",
      label: "Battery",
      checks: [
        // SoC: amber below 40%, stale/absent neutral (banded defaults)
        { type: "banded", path: SOC_PATH, low: { warn: 0.4 } },
      ],
    },
    {
      id: "anchor",
      label: "Anchor watch",
      context: "sailing",
      checks: [{ type: "boolean", path: "navigation.anchor.alarm" }],
    },
  ],
};

/** Fake ServerAPI with a subscriptionmanager stand-in (see server.test.js). */
function fakeApp() {
  /** @type {Array<{id: string, msg: object}>} */
  const messages = [];
  /** @type {Array<object>} */
  const subscriptions = [];
  /** @type {Function[]} */
  const unsubscribed = [];
  /** @type {Function|null} */
  let deltaCallback = null;
  return {
    messages,
    subscriptions,
    unsubscribed,
    feed(delta) {
      deltaCallback?.(delta);
    },
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    get: () => {},
    handleMessage: (id, msg) => messages.push({ id, msg }),
    subscriptionmanager: {
      subscribe(subscription, unsubscribes, _onError, onDelta) {
        subscriptions.push(subscription);
        unsubscribes.push(() => unsubscribed.push(subscription));
        deltaCallback = onDelta;
      },
    },
  };
}

/** A single-path Signal K delta. */
function delta(path, value) {
  return {
    context: "vessels.self",
    updates: [
      {
        timestamp: new Date().toISOString(),
        values: [{ path, value }],
      },
    ],
  };
}

/** Every published tile-status {path, value} pair, in order. */
function statusValues(app) {
  const out = [];
  for (const { msg } of app.messages) {
    for (const u of msg?.updates || []) {
      for (const v of u?.values || []) {
        if (
          typeof v?.path === "string" &&
          v.path.startsWith(`${TILE_STATUS_BASE}.`)
        )
          out.push(v);
      }
    }
  }
  return out;
}

/** tile id → last published status value. */
function latest(app) {
  const m = new Map();
  for (const v of statusValues(app)) {
    m.set(v.path.slice(TILE_STATUS_BASE.length + 1), v.value);
  }
  return m;
}

test("start publishes initial statuses as plain strings", (t) => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  const m = latest(app);
  // Absent input: banded stale default is neutral
  assert.equal(m.get("soc"), "neutral");
  // Context inactive (no wind data): tile omitted entirely => null
  assert.equal(m.get("anchor"), null);
  // Values are strings, not objects
  const soc = statusValues(app).find((v) => v.path === tileStatusPath("soc"));
  assert.equal(typeof soc.value, "string");
});

test("start sends metadata for every tile status path", (t) => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  const metas = [];
  for (const { msg } of app.messages) {
    for (const u of msg?.updates || []) {
      for (const m of u?.meta || []) metas.push(m);
    }
  }
  const paths = metas.map((m) => m.path).sort();
  assert.deepEqual(paths, [tileStatusPath("anchor"), tileStatusPath("soc")]);
  const socMeta = metas.find((m) => m.path === tileStatusPath("soc"));
  assert.equal(socMeta.value.displayName, "Battery status");
  assert.ok(socMeta.value.description.includes("opportunity"));
});

test("subscribes to every config-referenced path", (t) => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  assert.equal(app.subscriptions.length, 1);
  const sub = app.subscriptions[0];
  assert.equal(sub.context, "vessels.self");
  assert.deepEqual(
    sub.subscribe,
    collectPaths(SAMPLE).map((path) => ({
      path,
      policy: "fixed",
      minPeriod: 1000,
    })),
  );
});

test("a watched-path delta publishes the changed state", (t) => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  // 0.2 < low.warn 0.4 => amber
  app.feed(delta(SOC_PATH, 0.2));
  assert.equal(latest(app).get("soc"), "amber");

  // Same band: no re-publish (change-driven)
  const before = statusValues(app).filter(
    (v) => v.path === tileStatusPath("soc"),
  ).length;
  app.feed(delta(SOC_PATH, 0.25));
  const after = statusValues(app).filter(
    (v) => v.path === tileStatusPath("soc"),
  ).length;
  assert.equal(after, before);

  // Back to a good SoC => green
  app.feed(delta(SOC_PATH, 0.9));
  assert.equal(latest(app).get("soc"), "green");
});

test("context-hidden tiles publish null, context-active ones evaluate", (t) => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  // Wind picks up: sailing active, anchor tile now evaluates. Its
  // input is absent => boolean stale default neutral.
  app.feed(delta(WIND_PATH, 7));
  assert.equal(latest(app).get("anchor"), "neutral");

  // Wind drops: context inactive => null, never a lingering state
  app.feed(delta(WIND_PATH, 2));
  assert.equal(latest(app).get("anchor"), null);
});

test("timer tick discovers staleness and publishes it", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);

  app.feed(delta(SOC_PATH, 0.9));
  assert.equal(latest(app).get("soc"), "green");

  // Default staleMs is 60s: after 61s of silence the timer-driven
  // tick (SPEC §8) flips the tile to its stale state.
  t.mock.timers.tick(61_000);
  assert.equal(latest(app).get("soc"), "neutral");
});

test("stop unsubscribes and nulls published statuses", () => {
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  app.feed(delta(SOC_PATH, 0.2));
  assert.equal(latest(app).get("soc"), "amber");

  plugin.stop();

  // Subscription torn down
  assert.equal(app.unsubscribed.length, 1);
  // Amber cleared to null so consumers don't render a stale severity
  assert.equal(latest(app).get("soc"), null);
  // ...but already-null tiles aren't re-published
  const anchorPublishes = statusValues(app).filter(
    (v) => v.path === tileStatusPath("anchor"),
  );
  assert.equal(anchorPublishes.length, 1);
});

test("tolerates servers without subscriptionmanager", (t) => {
  const app = fakeApp();
  delete app.subscriptionmanager;
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  // Only the initial (empty-cache) evaluation happens; no crash
  assert.doesNotThrow(() => plugin.start(SAMPLE));
  assert.equal(latest(app).get("soc"), "neutral");
});
