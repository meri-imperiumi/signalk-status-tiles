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
  tileDisplayValuePath,
  tileFooterPath,
  tileReasonPath,
  tileStatusPath,
} from "../public/lib/status-paths.js";

const SOC_PATH = "electrical.batteries.0.capacity.stateOfCharge";
const WIND_PATH = "environment.wind.speedTrue";
const TANK_PATH = "tanks.freshWater.water.currentLevel";

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

/** Fake ServerAPI with a subscriptionmanager stand-in (see server.test.js).
 *  Optional `meta`: Map of path → {meta, displayUnits} the fake app
 *  answers getMetadata()/getDisplayUnits() from (the seeded-metadata
 *  tests). Optional `legacy: true` drops the plugin-side metadata APIs
 *  entirely, mimicking a released server that predates them. Captures
 *  unitpreferencesChanged listeners like the real EventEmitter does. */
function fakeApp({ meta, legacy = false } = {}) {
  /** @type {Array<{id: string, msg: object}>} */
  const messages = [];
  /** @type {Array<object>} */
  const subscriptions = [];
  /** @type {Function[]} */
  const unsubscribed = [];
  /** @type {Function|null} */
  let deltaCallback = null;
  /** @type {Map<string, Function>} */
  const prefsListeners = new Map();
  return {
    messages,
    subscriptions,
    unsubscribed,
    /** Emits the unit-preferences change event to the plugin. */
    emitPrefsChange() {
      for (const l of prefsListeners.values()) l();
    },
    feed(delta) {
      deltaCallback?.(delta);
    },
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    get: () => {},
    on: (event, l) => {
      if (event === "unitpreferencesChanged") prefsListeners.set(l, l);
    },
    removeListener: (event, l) => {
      if (event === "unitpreferencesChanged") prefsListeners.delete(l);
    },
    getMetadata: (path) =>
      meta?.get(path.replace(/^vessels\.self\./, ""))?.meta,
    getDisplayUnits: (path) => meta?.get(path)?.displayUnits,
    ...(legacy ? { getMetadata: undefined, getDisplayUnits: undefined } : {}),
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
  assert.deepEqual(paths, [
    tileStatusPath("anchor"),
    tileDisplayValuePath("anchor"),
    tileFooterPath("anchor"),
    tileReasonPath("anchor"),
    tileStatusPath("soc"),
    tileDisplayValuePath("soc"),
    tileFooterPath("soc"),
    tileReasonPath("soc"),
  ]);
  const socMeta = metas.find((m) => m.path === tileStatusPath("soc"));
  assert.equal(socMeta.value.displayName, "Battery status");
  assert.ok(socMeta.value.description.includes("opportunity"));
  const socDvMeta = metas.find((m) => m.path === tileDisplayValuePath("soc"));
  assert.equal(socDvMeta.value.displayName, "Battery display value");
  assert.ok(socDvMeta.value.description.includes("stale"));
  const socReasonMeta = metas.find((m) => m.path === tileReasonPath("soc"));
  assert.equal(socReasonMeta.value.displayName, "Battery reason");
  const socFooterMeta = metas.find((m) => m.path === tileFooterPath("soc"));
  assert.equal(socFooterMeta.value.displayName, "Battery footer");
});

test("seeded metadata reaches the engine cache (zones, units)", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  // A zone check with NO inline zones: without seeded metadata the tile
  // is stuck at neutral ("no zones defined"); with it, the path's
  // published zones classify the value (SPEC §3.3).
  const app = fakeApp({
    meta: new Map([
      [
        "tanks.freshWater.level",
        {
          meta: {
            units: "ratio",
            zones: [
              { state: "nominal", lower: 0.2 },
              { state: "warn", lower: 0, upper: 0.2 },
            ],
          },
          displayUnits: { formula: "value * 100", symbol: "%" },
        },
      ],
    ]),
  });
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [
          { type: "zone", path: "tanks.freshWater.level", display: true },
        ],
      },
    ],
  });
  t.mock.timers.tick(2_000); // open the throttle window (see above)
  app.feed(delta("tanks.freshWater.level", 0.125));
  assert.equal(latest(app).get("fw"), "amber");
  // The headline is unit-converted by the seeded displayUnits, exactly
  // what the webapp renders from its WS meta (0.125 is binary-exact, so
  // the ×100 formula lands on 12.5).
  assert.equal(latest(app).get("fw.displayValue"), "12.5%");
});

test("loopback REST meta fallback covers released servers", async (t) => {
  // Released-server shape: no plugin-side metadata APIs at all; the
  // server answers the loopback REST meta call with the live tree's
  // metadata and resolved displayUnits — the same answer its WS meta
  // carries, which is what the webapp formats from.
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    // The user's TEMP config-endpoint probe fetches too; only the meta
    // route is under test.
    if (!u.endsWith("/signalk/v1/api/vessels/self/meta")) {
      return { ok: true, json: async () => ({}) };
    }
    calls.push(u);
    return {
      ok: true,
      json: async () => ({
        "tanks.freshWater.currentLevel": {
          units: "ratio",
          zones: [
            { state: "nominal", lower: 0.2 },
            { state: "warn", lower: 0, upper: 0.2 },
          ],
          displayUnits: { formula: "value * 100", symbol: "%" },
        },
      }),
    };
  };
  const app = fakeApp({ legacy: true });
  app.config = { settings: { port: 3123 } };
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [
          {
            type: "zone",
            path: "tanks.freshWater.currentLevel",
            display: true,
          },
        ],
      },
    ],
  });
  // The value feeds the cache immediately; the fetch lands within
  // milliseconds and its re-evaluation formats it — long before the
  // delta throttle would have. (0.125 is binary-exact, so the ×100
  // formula lands on 12.5.)
  app.feed(delta("tanks.freshWater.currentLevel", 0.125));
  await new Promise((r) => setTimeout(r, 20));

  // The data-bearing path had no metadata (empty boot answer): the
  // on-demand refresh fires at once, so calls >= 1 by now.
  assert.ok(calls.length >= 1);
  assert.ok(calls[0].endsWith("/signalk/v1/api/vessels/self/meta"));
  // Zones classify where without metadata the tile sits at neutral.
  assert.equal(latest(app).get("fw"), "amber");
  // Headline unit-converted exactly like the webapp renders it.
  assert.equal(latest(app).get("fw.displayValue"), "12.5%");
});

test("a failed loopback meta fetch degrades gracefully", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  const app = fakeApp({ legacy: true });
  app.config = { settings: { port: 3123 } };
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [{ type: "zone", path: "tanks.freshWater.currentLevel" }],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));
  // No metadata anywhere: the zone check sits at its neutral "no zones
  // defined" answer and the plugin keeps publishing.
  assert.equal(latest(app).get("fw"), "neutral");
});

test("a boot-race meta snapshot is upgraded by the refresh schedule", async (t) => {
  // The plugin fetches at start, while the vessel tree is still filling:
  // the first answer has no usable metadata; the settled tree (a later
  // fetch) does. The refresh schedule must re-fetch, re-seed, and
  // re-publish the re-formatted values.
  t.mock.timers.enable({ now: Date.now() });
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const answers = [
    {}, // boot-race snapshot: tree still filling
    {
      "tanks.freshWater.currentLevel": {
        units: "ratio",
        zones: [{ state: "warn", lower: 0, upper: 0.2 }],
        displayUnits: { formula: "value * 100", symbol: "%" },
      },
    },
  ];
  let fetches = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith("/signalk/v1/api/vessels/self/meta")) {
      return { ok: true, json: async () => ({}) }; // TEMP probe traffic
    }
    fetches += 1;
    return {
      ok: true,
      json: async () => answers[Math.min(fetches - 1, answers.length - 1)],
    };
  };
  const app = fakeApp({ legacy: true });
  app.config = { settings: { port: 3123 } };
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [
          {
            type: "zone",
            path: "tanks.freshWater.currentLevel",
            display: true,
            // Long-stale: the 120s refresh tick must not double as a
            // staleness flip — this test isolates the refresh behavior.
            staleMs: 600_000,
          },
        ],
      },
    ],
  });
  app.feed(delta("tanks.freshWater.currentLevel", 0.125));
  // The demand arrives while the boot fetch is in flight; it is queued
  // and re-run the moment that fetch lands.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  // The data-bearing path lacked metadata: the demand-forced refresh
  // lands the settled tree — the zone check classifies without waiting
  // for any schedule.
  assert.equal(fetches, 2);
  assert.equal(latest(app).get("fw"), "amber");
  assert.equal(latest(app).get("fw.displayValue"), "12.5%");

  // +30s: the boot fetch's tree-fill backstop fires and re-fetches the
  // (now settled) tree; identical metadata and values stay change-driven
  // silent. The forced fetch consumed the refresh budget, so no further
  // ticks fetch anything.
  const before = statusValues(app).length;
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(fetches, 3);
  assert.equal(latest(app).get("fw"), "amber");
  assert.equal(statusValues(app).length, before);
});

test("a unit-preferences change re-formats published display values", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const metaMap = new Map();
  const app = fakeApp({ meta: metaMap });
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "soc",
        label: "Battery",
        checks: [{ type: "banded", path: SOC_PATH, display: true }],
      },
    ],
  });
  t.mock.timers.tick(2_000);
  // 0.25 is binary-exact, so the seeded ×100 formula lands on 25.
  app.feed(delta(SOC_PATH, 0.25));
  // No metadata yet: the raw ratio with smart fallback precision.
  assert.equal(latest(app).get("soc.displayValue"), "0.25");

  // The user picks a unit preference: the plugin re-seeds and
  // re-evaluates, and the next publish carries the new formatting.
  metaMap.set(SOC_PATH, {
    meta: {},
    displayUnits: { formula: "value * 100", symbol: "%" },
  });
  app.emitPrefsChange();
  assert.equal(latest(app).get("soc.displayValue"), "25.0%");

  // The listener is plugin-lifecycle-scoped: stop removes it, so a late
  // preferences change neither re-publishes nor crashes.
  plugin.stop();
  const publishes = statusValues(app).length;
  app.emitPrefsChange();
  assert.equal(statusValues(app).length, publishes);
});

test("reason and footer ride beside the status as siblings", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [
          {
            type: "banded",
            path: "tanks.freshWater.level",
            low: { warn: 0.4 },
          },
        ],
        footer: [{ label: "Remaining", path: "tanks.freshWater.remaining" }],
      },
    ],
  });
  t.mock.timers.tick(2_000);
  app.feed(delta("tanks.freshWater.level", 0.13));
  app.feed(delta("tanks.freshWater.remaining", 0.0268));
  t.mock.timers.tick(2_000);

  // Amber with the check's reason line, formatted like the webapp
  // renders it (the render side shortens path tokens).
  assert.equal(latest(app).get("fw"), "amber");
  assert.ok(latest(app).get("fw.reason").includes("below 0.4"));
  // Footer entries ride as a JSON string of {label, value} pairs; the
  // remaining volume (a ratio path) is formatted per fallback rules.
  const footer = JSON.parse(latest(app).get("fw.footer"));
  assert.deepEqual(footer, [{ label: "Remaining", value: "0.03" }]);

  // Change-driven: an unchanged footer never republishes.
  const before = statusValues(app).filter(
    (v) => v.path === tileFooterPath("fw"),
  ).length;
  app.feed(delta("tanks.freshWater.remaining", 0.0269));
  t.mock.timers.tick(2_000);
  const after = statusValues(app).filter(
    (v) => v.path === tileFooterPath("fw"),
  ).length;
  assert.equal(after, before);

  // Stop clears the siblings like the rest.
  plugin.stop();
  assert.equal(latest(app).get("fw.reason"), null);
  assert.equal(latest(app).get("fw.footer"), null);
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
      policy: "instant",
      minPeriod: 1000,
    })),
  );
});

test("delta-driven evaluations coalesce within the throttle window", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);
  // The start() baseline evaluation holds the throttle window shut;
  // 2s later it is open again and a changed delta evaluates at once.
  // (Mock-timer ticks fire due timers with the tick's end time, so the
  // window re-opens exactly EVAL_THROTTLE_MS after the last eval.)
  t.mock.timers.tick(2_000);

  // A burst of changes inside one throttle window: only the leading
  // evaluation runs immediately, and the trailing one sees the final
  // value. The intermediate green state never publishes at all.
  app.feed(delta(SOC_PATH, 0.2)); // amber, leading eval
  app.feed(delta(SOC_PATH, 0.9)); // green, coalesced away
  app.feed(delta(SOC_PATH, 0.25)); // amber, trailing eval sees this
  assert.equal(latest(app).get("soc"), "amber");
  assert.ok(
    !statusValues(app).some(
      (v) => v.path === tileStatusPath("soc") && v.value === "green",
    ),
    "intermediate state never published",
  );

  // The trailing evaluation lands within the throttle window and
  // confirms the coalesced state (amber, from the last value).
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("soc"), "amber");

  // After the window, a new change evaluates and publishes normally.
  app.feed(delta(SOC_PATH, 0.9));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("soc"), "green");
});

test("a watched-path delta publishes the changed state", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);
  t.mock.timers.tick(2_000); // open the throttle window (see above)

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
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("soc"), "green");
});

test("context-hidden tiles publish null, context-active ones evaluate", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);
  t.mock.timers.tick(2_000); // open the throttle window (see above)

  // Wind picks up: sailing active, anchor tile now evaluates. Its
  // input is absent => boolean stale default neutral.
  app.feed(delta(WIND_PATH, 7));
  assert.equal(latest(app).get("anchor"), "neutral");

  // Wind drops: context inactive => null, never a lingering state
  app.feed(delta(WIND_PATH, 2));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("anchor"), null);
});

test("timer tick discovers staleness and publishes it", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(SAMPLE);
  t.mock.timers.tick(2_000); // open the throttle window (see above)

  app.feed(delta(SOC_PATH, 0.9));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("soc"), "green");

  // Default staleMs is 60s: silence since the delta's timestamp means
  // the timer-driven tick (SPEC §8) flips the tile to its stale state
  // at the first tick boundary past the threshold (here +65s).
  t.mock.timers.tick(61_000);
  assert.equal(latest(app).get("soc"), "neutral");
});

test("stop unsubscribes and nulls published statuses", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  plugin.start(SAMPLE);
  t.mock.timers.tick(2_000); // open the throttle window (see above)
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

/** Tiles for the display-value publication: one with a designated
 *  display check (SPEC §3.4), one without. */
const DISPLAY_SAMPLE = {
  contexts: [],
  tiles: [
    {
      id: "bilge",
      label: "Bilge",
      checks: [{ type: "boolean", path: "bilge", display: true }],
    },
    {
      id: "plain",
      label: "Plain",
      checks: [{ type: "boolean", path: "plain" }],
    },
  ],
};

test("publishes the headline display value beside the state", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp();
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start(DISPLAY_SAMPLE);

  // Baseline: absent input => neutral; the designated display check is
  // stale, and evalTile normalizes a stale display value to the explicit
  // "unknown" marker — never the frozen last reading (SPEC §3.4).
  assert.equal(latest(app).get("bilge"), "neutral");
  assert.equal(latest(app).get("bilge.displayValue"), "—");

  t.mock.timers.tick(2_000); // open the throttle window (see above)
  // false is the good state (badWhen default true) => green, "OK"
  app.feed(delta("bilge", false));
  assert.equal(latest(app).get("bilge"), "green");
  assert.equal(latest(app).get("bilge.displayValue"), "OK");

  // true is bad => red, "NOT OK" (the change coalesces; the trailing
  // evaluation lands when the throttle window opens)
  app.feed(delta("bilge", true));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("bilge"), "red");
  assert.equal(latest(app).get("bilge.displayValue"), "NOT OK");

  // A tile without a display check never publishes one
  app.feed(delta("plain", false));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("plain"), "green");
  const plainDvs = statusValues(app).filter(
    (v) => v.path === tileDisplayValuePath("plain"),
  );
  assert.deepEqual(
    plainDvs.map((v) => v.value),
    [null],
  );

  // Stop clears both scalars
  plugin.stop();
  assert.equal(latest(app).get("bilge"), null);
  assert.equal(latest(app).get("bilge.displayValue"), null);
});

test("a meta delta merges over seeded metadata instead of replacing it", (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = fakeApp({
    meta: new Map([
      [
        SOC_PATH,
        {
          meta: { units: "ratio" },
          displayUnits: { formula: "value * 100", symbol: "%" },
        },
      ],
    ]),
  });
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "soc",
        label: "Battery",
        checks: [
          { type: "banded", path: SOC_PATH, low: { warn: 0.4 }, display: true },
        ],
      },
    ],
  });
  t.mock.timers.tick(2_000); // open the throttle window (see above)

  // A provider re-publishes sparse meta for the same path (say, just a
  // displayName): the seeded displayUnits must survive the merge —
  // replacing the entry wholesale would drop unit conversion.
  app.feed({
    context: "vessels.self",
    updates: [
      {
        meta: [{ path: SOC_PATH, value: { displayName: "House SoC" } }],
      },
    ],
  });
  app.feed(delta(SOC_PATH, 0.25));
  t.mock.timers.tick(2_000);
  assert.equal(latest(app).get("soc"), "amber");
  assert.equal(latest(app).get("soc.displayValue"), "25.0%");
});

test("a path first seen after boot triggers a metadata refresh", async (t) => {
  // The boot-time meta answer only covers paths the live tree already
  // knows; a path whose first value arrives later must trigger one
  // rate-limited re-fetch that then formats it.
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      // Boot-time answer: the watched path has no data yet, so the
      // tree has no metadata for it.
      return { ok: true, json: async () => ({}) };
    }
    // Refresh answer: the path has since been seen; metadata attached.
    assert.ok(String(url).endsWith("/signalk/v1/api/vessels/self/meta"));
    return {
      ok: true,
      json: async () => ({
        [TANK_PATH]: {
          units: "ratio",
          displayUnits: { formula: "value * 100", symbol: "%" },
        },
      }),
    };
  };
  const app = fakeApp({ legacy: true });
  app.config = { settings: { port: 3123 } };
  const plugin = pluginFactory(app);
  t.after(() => plugin.stop());
  plugin.start({
    contexts: [],
    tiles: [
      {
        id: "fw",
        label: "Fresh water",
        checks: [
          {
            type: "banded",
            path: TANK_PATH,
            low: { warn: 0.4 },
            display: true,
          },
        ],
      },
    ],
  });

  // First value for a metadata-less path: raw formatting (smart
  // fallback precision), and the refresh fires at once — the rate
  // limiter's "last refresh" marker starts unset, so the first
  // on-demand refresh waits no interval.
  app.feed(delta(TANK_PATH, 0.125));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fetchCount >= 2, "refresh fetch happened");
  assert.equal(latest(app).get("fw.displayValue"), "12.5%");

  // Rate limit: a further value change for the now-seeded path asks
  // for no refresh (it HAS metadata). The delta-driven re-evaluation
  // itself is throttled, hence the wait. (0.25 is binary-exact, so the
  // ×100 formula lands on 25.)
  const count = fetchCount;
  app.feed(delta(TANK_PATH, 0.25));
  await new Promise((r) => setTimeout(r, 2_200));
  assert.equal(latest(app).get("fw.displayValue"), "25.0%");
  assert.equal(fetchCount, count);
});
