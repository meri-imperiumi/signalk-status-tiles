/**
 * Preview rendering for example tile sets (public/lib/preview.js): the
 * picker renders each set's tiles through the real evaluator against
 * synthesized healthy sample data, so a preview shows actual state/color
 * and headline values rather than grey placeholders.
 *
 * @file preview.test.js */

import assert from "node:assert/strict";
import test from "node:test";
import { previewTiles, sampleValuesForCheck } from "../public/lib/preview.js";

/** A one-tile set wrapping the given tile config. */
function setWith(tile) {
  return { id: "s", name: "S", tiles: [tile] };
}

test("a notification check previews green with no headline (no display)", () => {
  // Notification checks never produce a displayValue, so a healthy
  // (normal) notification previews as a green status tile with no
  // headline — exactly how it looks in the live grid, not a grey "—".
  const [t] = previewTiles(
    setWith({
      id: "n",
      label: "Surplus",
      checks: [{ type: "notification", path: "notifications.x.surplus" }],
    }),
  );
  assert.equal(t.state, "green");
  assert.equal(t.label, "Surplus");
  assert.equal(t.displayValue, undefined, "no headline value");
});

test("a banded display check previews green with a formatted value", () => {
  // A ratio/percent banded check: sample 0.85 is within the healthy
  // band and formats to "85%" — the preview shows a real headline.
  const [t] = previewTiles(
    setWith({
      id: "soc",
      label: "Battery",
      checks: [
        {
          type: "banded",
          path: "electrical.batteries.0.capacity.stateOfCharge",
          low: { warn: 0.5, warnState: "amber" },
          unit: "%",
          display: true,
        },
      ],
    }),
  );
  assert.equal(t.state, "green", "0.85 is above the low.warn threshold");
  assert.equal(t.displayValue, "85%");
});

test("a banded value lands in the healthy band between two thresholds", () => {
  // Non-percent banded with both sides bounded: the sample is the
  // midpoint of [low.warn, high.warn], comfortably green.
  const [t] = previewTiles(
    setWith({
      id: "v",
      label: "Voltage",
      checks: [
        {
          type: "banded",
          path: "electrical.batteries.0.voltage",
          low: { warn: 11.5 },
          high: { warn: 14.5 },
          display: true,
        },
      ],
    }),
  );
  assert.equal(t.state, "green");
  // midpoint of 11.5 and 14.5 = 13; formatted as a bare number.
  assert.equal(t.displayValue, "13.0");
});

test("an agreement display check previews green with the matched value", () => {
  // Both paths fed the same sample value → match → green; the `display`
  // check surfaces that value as the headline.
  const [t] = previewTiles(
    setWith({
      id: "deploy",
      label: "Deploy",
      checks: [
        {
          type: "agreement",
          path: "deployment.x.detectedState",
          path2: "deployment.x.recommendedState",
          display: true,
        },
      ],
    }),
  );
  assert.equal(t.state, "green");
  assert.equal(t.displayValue, "ok");
});

test("a boolean check previews green (feeds the OK value)", () => {
  // badWhen defaults true (true is bad) → sample false → green.
  const [t] = previewTiles(
    setWith({
      id: "b",
      label: "Bilge",
      checks: [{ type: "boolean", path: "bilge.high" }],
    }),
  );
  assert.equal(t.state, "green");
  // boolean checks only display when `display` is set; here it isn't.
  assert.equal(t.displayValue, undefined);

  // badWhen:false (false is bad) → sample true → green.
  const [t2] = previewTiles(
    setWith({
      id: "eng",
      label: "Engine",
      checks: [{ type: "boolean", path: "engine.on", badWhen: false }],
    }),
  );
  assert.equal(t2.state, "green");
});

test("a stateMatch previews green when the map defines a green value", () => {
  const [t] = previewTiles(
    setWith({
      id: "sm",
      label: "Mode",
      checks: [
        {
          type: "stateMatch",
          path: "navigation.state",
          map: [
            { value: "anchored", state: "green" },
            { value: "sailing", state: "amber" },
          ],
          default: "neutral",
        },
      ],
    }),
  );
  assert.equal(t.state, "green", "the green-mapped value is fed");
});

test("a stateMatch with no green row previews neutral (honestly)", () => {
  // No green row → nothing fed → stale → staleState (neutral). The
  // preview does not fabricate a green state the config can't produce.
  const [t] = previewTiles(
    setWith({
      id: "sm",
      label: "Mode",
      checks: [
        {
          type: "stateMatch",
          path: "navigation.state",
          map: [{ value: "sailing", state: "amber" }],
          default: "neutral",
        },
      ],
    }),
  );
  assert.equal(t.state, "neutral");
});

test("an alarmGroup previews green (no alarms tripped)", () => {
  const [t] = previewTiles(
    setWith({
      id: "ag",
      label: "Alarms",
      checks: [
        {
          type: "alarmGroup",
          paths: ["alarms.a", "alarms.b"],
          levelPath: "tanks.fuel.0.level",
          levelWarn: 30,
        },
      ],
    }),
  );
  assert.equal(t.state, "green");
});

test("a differential check previews green (equal inputs)", () => {
  const [t] = previewTiles(
    setWith({
      id: "diff",
      label: "Cell spread",
      checks: [
        {
          type: "differential",
          path: "electrical.batteries.0.cell0",
          path2: "electrical.batteries.0.cell1",
          warn: 0.05,
          crit: 0.1,
        },
      ],
    }),
  );
  assert.equal(t.state, "green", "equal inputs → diff 0 < warn");
});

test("a zone check previews green when an inline green zone exists", () => {
  const [t] = previewTiles(
    setWith({
      id: "z",
      label: "Temp",
      checks: [
        {
          type: "zone",
          path: "environment.water.temperature",
          zones: [
            { lower: 0, upper: 20, state: "nominal" },
            { lower: 20, upper: 30, state: "warn" },
          ],
        },
      ],
    }),
  );
  assert.equal(
    t.state,
    "green",
    "sample feeds the green (nominal) zone's lower bound",
  );
});

test("footer paths are left unfed — they show '—' (add-time appearance)", () => {
  // Footers are subordinate readouts; the preview shows their labels
  // with "—" values (no sample data), while the headline comes from the
  // check's sample. Honest about what the tile looks like at add time
  // for its readouts, alive for its headline.
  const [t] = previewTiles(
    setWith({
      id: "f",
      label: "Solar",
      checks: [
        {
          type: "banded",
          path: "electrical.solar.power",
          high: { warn: 400 },
          display: true,
        },
      ],
      footer: [{ label: "Peak", path: "electrical.solar.peak" }],
    }),
  );
  assert.equal(t.state, "green");
  assert.equal(t.footer.length, 1);
  assert.equal(t.footer[0].label, "Peak");
  assert.equal(t.footer[0].value, "—", "footer path unfed → dash");
});

test("context gating is bypassed — all tiles preview regardless of context", () => {
  // The set ships a context whose `between` predicate references paths
  // with no sample data; a context-gated tile would be hidden. The
  // preview shows it anyway (evalTile called directly per tile).
  const tiles = previewTiles({
    contexts: [
      {
        id: "window",
        predicate: {
          between: { from: "x.from", to: "x.to" },
        },
      },
    ],
    tiles: [
      {
        id: "ctxTile",
        label: "Gated",
        context: "window",
        checks: [{ type: "notification", path: "notifications.x" }],
      },
    ],
  });
  assert.equal(tiles.length, 1, "the context-gated tile still previews");
  assert.equal(tiles[0].state, "green");
});

test("a malformed tile falls back to neutral, not a thrown preview", () => {
  // One bad tile must not blank the whole set.
  const tiles = previewTiles({
    tiles: [
      { id: "bad", label: "Bad" }, // no checks, but not malformed enough to throw
      {
        id: "good",
        label: "Good",
        checks: [{ type: "notification", path: "n" }],
      },
    ],
  });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].label, "Bad");
  assert.equal(tiles[1].state, "green");
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

test("sampleValuesForCheck returns a path→value map per check type", () => {
  // Spot-check the synthesized values for a couple of types.
  assert.deepEqual(sampleValuesForCheck({ type: "notification", path: "n" }), {
    n: { state: "normal", message: "ok" },
  });
  assert.deepEqual(sampleValuesForCheck({ type: "boolean", path: "b" }), {
    b: false,
  });
  assert.deepEqual(
    sampleValuesForCheck({ type: "boolean", path: "b", badWhen: false }),
    { b: true },
  );
  assert.deepEqual(
    sampleValuesForCheck({ type: "agreement", path: "a", path2: "b" }),
    { a: "ok", b: "ok" },
  );
  // compound contributes nothing (can't be honestly satisfied).
  assert.deepEqual(
    sampleValuesForCheck({ type: "compound", predicate: {} }),
    {},
  );
});
