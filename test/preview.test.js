/**
 * Preview rendering for example tile sets (public/lib/preview.js): the
 * picker renders each set's tiles through the real evaluator against a
 * LIVE cache fed by the app's stream — real states/values from the
 * boat, never synthesized ones. Paths absent from the cache render the
 * tile's stale state (honest "no data on this boat yet").
 *
 * @file preview.test.js */

import assert from "node:assert/strict";
import test from "node:test";
import { previewTiles } from "../public/lib/preview.js";
import { PathCache } from "../public/lib/staleness.js";

/** A one-tile set wrapping the given tile config. */
function setWith(tile) {
  return { id: "s", name: "S", tiles: [tile] };
}

/** Feeds `samples` (`{path: value}`) and `meta` into a fresh cache. */
function cacheWith(samples = {}, meta = {}, now = Date.now()) {
  const c = new PathCache();
  for (const [p, v] of Object.entries(samples)) c.set(p, v, now);
  for (const [p, m] of Object.entries(meta)) c.setMeta(p, m);
  return c;
}

test("a stateMatch previews with the boat's REAL current value", () => {
  // The live cache holds the actual status word the plugin published —
  // whatever it is, that's the headline. No invented values.
  const c = cacheWith({ "electrical.energy.prediction.status": "surplus" });
  const [t] = previewTiles(
    setWith({
      id: "energy",
      label: "Energy",
      checks: [
        {
          type: "stateMatch",
          path: "electrical.energy.prediction.status",
          map: [
            { value: "surplus", state: "opportunity" },
            { value: "deficit", state: "amber" },
            { value: "rising", state: "green" },
          ],
          default: "neutral",
          display: true,
        },
      ],
    }),
    c,
  );
  assert.equal(t.state, "opportunity", "the real value's mapped state");
  assert.equal(t.displayValue, "surplus", "the real value is the headline");
});

test("an agreement previews the boat's REAL agreement state", () => {
  // Real detected vs recommended: mismatch → the configured mismatch
  // state, with the real states in the reason. Not a fabricated "ok".
  const c = cacheWith({
    "d.flinsail.detectedState": "stowed",
    "d.flinsail.recommendedState": "deployed",
  });
  const [t] = previewTiles(
    setWith({
      id: "flinsail",
      label: "FLINsail",
      checks: [
        {
          type: "agreement",
          path: "d.flinsail.detectedState",
          path2: "d.flinsail.recommendedState",
          mismatchState: "amber",
          display: true,
        },
      ],
    }),
    c,
  );
  assert.equal(t.state, "amber", "real mismatch → real mismatch state");
  assert.match(t.reason, /detectedState/);
  assert.equal(t.displayValue, "stowed", "real detected value as headline");

  // And when they really agree: green, no fabrication needed.
  const c2 = cacheWith({
    "d.flinsail.detectedState": "deployed",
    "d.flinsail.recommendedState": "deployed",
  });
  const [t2] = previewTiles(
    setWith({
      id: "flinsail",
      label: "FLINsail",
      checks: [
        {
          type: "agreement",
          path: "d.flinsail.detectedState",
          path2: "d.flinsail.recommendedState",
          display: true,
        },
      ],
    }),
    c2,
  );
  assert.equal(t2.state, "green");
  assert.equal(t2.displayValue, "deployed");
});

test("a banded check previews the boat's REAL value, meta-formatted", () => {
  // Real wind speed from the cache, formatted with the path's real
  // displayUnits meta (same formatting as the live grid).
  const c = cacheWith(
    { "wp.correctedSpeed": 12.4 },
    { "wp.correctedSpeed": { displayUnits: { symbol: "m/s" } } },
  );
  const [t] = previewTiles(
    setWith({
      id: "wind",
      label: "Wind forecast",
      checks: [
        {
          type: "banded",
          path: "wp.correctedSpeed",
          high: { warn: 10, crit: 20 },
          display: true,
        },
      ],
    }),
    c,
  );
  assert.equal(t.state, "amber", "12.4 > warn 10 — the real band");
  assert.equal(t.displayValue, "12.4 m/s", "real value with real unit");
});

test("a notification previews from the boat's REAL notification", () => {
  const c = cacheWith({
    "n.surplus": { state: "warn", message: "1.3kWh surplus available" },
  });
  const [t] = previewTiles(
    setWith({
      id: "n",
      label: "Surplus",
      checks: [
        {
          type: "notification",
          path: "n.surplus",
          severityMap: { normal: "green", warn: "opportunity" },
        },
      ],
    }),
    c,
  );
  assert.equal(t.state, "opportunity", "the real severity, mapped");
});

test("a path the boat doesn't publish previews honestly stale/neutral", () => {
  // The core honesty contract: no data in the cache → the tile's stale
  // state (neutral by default), never an invented healthy value.
  const [t] = previewTiles(
    setWith({
      id: "energy",
      label: "Energy",
      checks: [
        {
          type: "stateMatch",
          path: "electrical.energy.prediction.status",
          map: [{ value: "rising", state: "green" }],
          default: "neutral",
          display: true,
        },
      ],
    }),
    cacheWith({ "some.other.path": 1 }),
  );
  assert.equal(t.state, "neutral", "unfed path → stale state");
  // evalTile normalizes a display check with no value to "—" — the
  // same honest placeholder the live grid shows for stale tiles.
  assert.equal(t.displayValue, "—", "no-data placeholder, not a value");
});

test("a stale (old-timestamp) value also previews as stale, not frozen", () => {
  // A value that arrived long ago is stale by the evaluator's own
  // staleness clock — the preview must not show a frozen old reading.
  const old = Date.now() - 10 * 60_000; // 10 min
  const c = new PathCache();
  c.set("electrical.energy.prediction.status", "rising", old);
  const [t] = previewTiles(
    setWith({
      id: "energy",
      label: "Energy",
      checks: [
        {
          type: "stateMatch",
          path: "electrical.energy.prediction.status",
          map: [{ value: "rising", state: "green" }],
          default: "neutral",
          display: true,
          staleMs: 60_000,
        },
      ],
    }),
    c,
  );
  assert.equal(t.state, "neutral", "stale value degrades, never freezes");
});

test("no cache at all degrades to all-neutral (honest), never throws", () => {
  // Called before the engine/stream exist: every tile stale/neutral.
  const tiles = previewTiles({
    tiles: [
      {
        id: "a",
        label: "A",
        checks: [{ type: "notification", path: "n" }],
      },
      {
        id: "b",
        label: "B",
        checks: [{ type: "banded", path: "p", high: { warn: 5 } }],
      },
    ],
  });
  assert.equal(tiles.length, 2);
  for (const t of tiles) {
    assert.equal(t.state, "neutral");
    assert.equal(t.displayValue, undefined);
  }
});

test("footers render real values; unfed footer paths show dash", () => {
  const c = cacheWith({
    "wp.correctedSpeed": 8.2,
    "wp.correctedGust": 11.9,
  });
  c.setMeta("wp.correctedSpeed", { units: "m/s" });
  const [t] = previewTiles(
    setWith({
      id: "wind",
      label: "Wind",
      checks: [
        { type: "banded", path: "wp.correctedSpeed", high: { warn: 10 } },
      ],
      footer: [
        { label: "Current", path: "wp.correctedSpeed" },
        { label: "WPF", path: "wp.speedFactor" },
      ],
    }),
    c,
  );
  assert.equal(t.footer[0].label, "Current");
  assert.equal(t.footer[0].value, "8.20 m/s", "fed footer shows real data");
  assert.equal(t.footer[1].value, "—", "unfed footer shows dash");
});

test("displayParts render real values when fed", () => {
  const c = cacheWith({
    "d.flinsail.detectedState": "deployed",
    "d.flinsail.recommendedState": "deployed",
    "d.flinsail.recommendedSide": "starboard",
  });
  const [t] = previewTiles(
    setWith({
      id: "flinsail",
      label: "FLINsail",
      checks: [
        {
          type: "agreement",
          path: "d.flinsail.detectedState",
          path2: "d.flinsail.recommendedState",
          display: true,
        },
      ],
      displayParts: [{ path: "d.flinsail.recommendedSide" }],
    }),
    c,
  );
  assert.equal(t.state, "green");
  assert.equal(t.displayValue, "deployed starboard", "real composed headline");
});

test("context gating is bypassed — all tiles preview regardless of context", () => {
  // The picker previews the set's tiles, not the boat's situation: a
  // tile gated on a context whose predicate does NOT hold (boat is
  // sailing, tile wants at-rest) still previews with real data.
  const c = cacheWith({
    "navigation.state": "sailing",
    "d.flinsail.detectedState": "deployed",
    "d.flinsail.recommendedState": "deployed",
  });
  const tiles = previewTiles(
    {
      contexts: [
        {
          id: "at-rest",
          predicate: {
            path: "navigation.state",
            compare: "equals",
            value: "moored",
          },
        },
      ],
      tiles: [
        {
          id: "flinsail",
          label: "FLINsail",
          context: "at-rest",
          checks: [
            {
              type: "agreement",
              path: "d.flinsail.detectedState",
              path2: "d.flinsail.recommendedState",
              display: true,
            },
          ],
        },
      ],
    },
    c,
  );
  assert.equal(tiles.length, 1, "context-gated tile still previews");
  assert.equal(tiles[0].state, "green", "…with its real evaluated state");
});

test("a malformed tile falls back to neutral, not a thrown preview", () => {
  // One bad tile must not blank the whole set.
  const tiles = previewTiles({
    tiles: [
      { id: "bad", label: "Bad" }, // no checks: renders neutral via evalTile
      {
        id: "good",
        label: "Good",
        checks: [{ type: "notification", path: "n" }],
      },
    ],
  });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].label, "Bad");
  assert.equal(tiles[1].state, "neutral");
});

test("an unknown context id still previews (config-error path, neutral)", () => {
  // evalTile renders neutral with a reason for a tile referencing an
  // unknown context — surfaced, not hidden.
  const [t] = previewTiles({
    tiles: [
      {
        id: "u",
        label: "Unknown ctx",
        context: "nope",
        checks: [{ type: "notification", path: "n" }],
      },
    ],
  });
  assert.equal(t.state, "neutral");
  assert.match(t.reason, /unknown context/);
});
