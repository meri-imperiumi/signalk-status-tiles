import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createEngine } from "../public/lib/engine.js";

function anchorConfig() {
  return {
    staleMs: 60000,
    contexts: [
      {
        id: "anchored",
        predicate: {
          path: "navigation.state",
          compare: "equals",
          value: "anchored",
        },
      },
    ],
    tiles: [
      {
        id: "anchor",
        label: "Anchor watch",
        context: "anchored",
        checks: [{ type: "boolean", path: "notifications.anchor.alarm" }],
      },
    ],
    coverage: { candidates: [], slots: 1 },
  };
}

function delta(path, value, ts = Date.now()) {
  return {
    context: "vessels.self",
    updates: [
      {
        timestamp: new Date(ts).toISOString(),
        values: [{ path, value }],
      },
    ],
  };
}

describe("engine", () => {
  test("off-anchor tile is neutral regardless of alarm feed (SPEC §5)", () => {
    const out = [];
    const e = createEngine(anchorConfig(), (tiles) => {
      out.push(tiles);
    });
    e.onDelta(delta("navigation.state", "sailing"));
    e.onDelta(delta("notifications.anchor.alarm", true)); // tripped, but we're not anchored
    e.evaluate();
    assert.strictEqual(out.at(-1)[0].state, "neutral");
  });

  test("at anchor with alarm tripped => red", () => {
    const out = [];
    const e = createEngine(anchorConfig(), (tiles) => {
      out.push(tiles);
    });
    e.onDelta(delta("navigation.state", "anchored"));
    e.onDelta(delta("notifications.anchor.alarm", true));
    e.evaluate();
    assert.strictEqual(out.at(-1)[0].state, "red");
  });

  test("at anchor, alarm feed goes stale => neutral (not green, SPEC §4/§5)", () => {
    const out = [];
    const e = createEngine(anchorConfig(), (tiles) => {
      out.push(tiles);
    });
    e.onDelta(delta("navigation.state", "anchored"));
    const old = Date.now() - 120000;
    e.onDelta(delta("notifications.anchor.alarm", false, old));
    e.evaluate();
    // boolean default stale -> neutral
    assert.strictEqual(out.at(-1)[0].state, "neutral");
  });

  test("stale alarm feed with safety default red stays red at anchor", () => {
    const cfg = anchorConfig();
    cfg.tiles[0].checks[0].staleState = "red"; // anchor alarm should not read as neutral when silent
    const out = [];
    const e = createEngine(cfg, (tiles) => {
      out.push(tiles);
    });
    e.onDelta(delta("navigation.state", "anchored"));
    const old = Date.now() - 120000;
    e.onDelta(delta("notifications.anchor.alarm", false, old));
    e.evaluate();
    assert.strictEqual(out.at(-1)[0].state, "red");
  });

  test("timer-driven evaluate discovers staleness after silence", () => {
    const out = [];
    const e = createEngine(anchorConfig(), (tiles) => {
      out.push(tiles);
    });
    e.onDelta(delta("navigation.state", "anchored"));
    e.onDelta(delta("notifications.anchor.alarm", false));
    e.evaluate();
    assert.strictEqual(out.at(-1)[0].state, "green");
    // simulate time passing with no new deltas — timer tick re-evaluates
    // and the path (60s threshold) goes stale.
    e.evaluate(Date.now() + 70000);
    assert.strictEqual(out.at(-1)[0].state, "neutral");
  });

  test("coverage: unclaimed anomaly surfaces via onEval second arg", () => {
    const cfg = {
      contexts: [],
      tiles: [
        {
          id: "t",
          label: "T",
          checks: [{ type: "banded", path: "owned", low: { warn: 0 } }],
        },
      ],
      coverage: { candidates: ["unowned"], slots: 1 },
    };
    const out = [];
    const e = createEngine(cfg, (tiles, coverage) => {
      out.push({ tiles, coverage });
    });
    e.onDelta(delta("unowned", 15));
    e.cache.setMeta("unowned", {
      zones: [{ lower: 14, upper: 100, state: "warn" }],
    });
    e.evaluate();
    const last = out.at(-1);
    assert.strictEqual(last.coverage.length, 1);
    assert.strictEqual(last.coverage[0].path, "unowned");
  });

  test("unwraps the { configuration, enabled } envelope so evaluation works on the wrapped form", () => {
    const inner = {
      staleMs: 60000,
      contexts: [
        {
          id: "moored",
          predicate: {
            path: "navigation.state",
            compare: "equals",
            value: "moored",
          },
        },
      ],
      tiles: [
        {
          id: "fridge",
          label: "Fridge",
          context: "moored",
          checks: [
            {
              type: "zone",
              path: "environment.inside.refrigerator.temperature",
              zones: [
                { lower: 0, upper: 10, state: "nominal" },
                { lower: 10, upper: 100, state: "warn" },
              ],
            },
          ],
        },
      ],
      coverage: { candidates: [], slots: 1, severityMap: {} },
    };
    const wrapped = { configuration: inner, enabled: true };
    const out = [];
    const e = createEngine(wrapped, (tiles, coverage) =>
      out.push({ tiles, coverage }),
    );
    // context active + value in warn zone -> amber tile
    e.onDelta(delta("navigation.state", "moored"));
    e.onDelta(delta("environment.inside.refrigerator.temperature", 12));
    e.evaluate();
    const last = out.at(-1);
    assert.strictEqual(last.tiles.length, 1);
    assert.strictEqual(last.tiles[0].state, "amber");
  });

  test("per-check staleMs:0 is honored as disabled even with a global default (regression: || was overriding 0)", () => {
    // Infrequent updates (e.g. every 15min) must not be marked stale when
    // the check explicitly sets staleMs:0 (disabled). The global default
    // must not override an explicit 0.
    const cfg = {
      staleMs: 60000,
      contexts: [],
      tiles: [
        {
          id: "flinsail",
          label: "FLINSAIL",
          checks: [
            {
              type: "agreement",
              path: "a",
              path2: "b",
              staleMs: 0,
            },
          ],
        },
      ],
      coverage: { candidates: [], slots: 1 },
    };
    const out = [];
    const e = createEngine(cfg, (tiles) => out.push(tiles));
    // Both paths arrive once, long ago — well beyond the 60s global default.
    const old = Date.now() - 900000; // 15 min ago
    e.onDelta(delta("a", "deployed", old));
    e.onDelta(delta("b", "deployed", old));
    e.evaluate();
    // staleMs:0 => staleness disabled => not stale => agreement green
    assert.strictEqual(out.at(-1)[0].state, "green");
    assert.notStrictEqual(out.at(-1)[0].reason, "agreement input stale/absent");
  });

  test("evaluate reports currently-active contexts for the chrome bar", () => {
    const cfg = anchorConfig();
    // Give the context a label; add a second context that stays inactive.
    cfg.contexts[0].label = "At anchor";
    cfg.contexts.push({
      id: "underway",
      label: "Underway",
      predicate: {
        path: "navigation.state",
        compare: "equals",
        value: "sailing",
      },
    });
    const seen = [];
    const e = createEngine(cfg, (_t, _c, active) => seen.push(active));
    e.onDelta(delta("navigation.state", "anchored"));
    e.evaluate();
    // Active context surfaces with its label; inactive one absent.
    assert.deepStrictEqual(seen.at(-1), [
      { id: "anchored", label: "At anchor" },
    ]);
    // Falls back to id when no label.
    delete cfg.contexts[0].label;
    e.evaluate();
    assert.deepStrictEqual(seen.at(-1), [
      { id: "anchored", label: "anchored" },
    ]);
    // Predicate flips false → context drops out.
    e.onDelta(delta("navigation.state", "sailing"));
    e.evaluate();
    assert.deepStrictEqual(seen.at(-1), [
      { id: "underway", label: "Underway" },
    ]);
    // Inputs absent → contexts fail closed → none active (SPEC §3.1).
    const e2 = createEngine(cfg, (_t, _c, active) => seen.push(active));
    e2.evaluate();
    assert.deepStrictEqual(seen.at(-1), []);
  });
});
