/**
 * Reason/path shortening for the tile grid (SPEC §11). Long Signal K
 * paths in a check's reason line overflow a tile and shove the
 * centered value off-center; the grid shortens each path token to its
 * last dot-segment (the differing tail — the shared prefix is noise on
 * a glanceable line).
 *
 * @file grid.test.js */

import assert from "node:assert/strict";
import test from "node:test";

// st-tile-grid.js calls customElements.define on import; supply stubs
// so the module loads without a DOM.
globalThis.HTMLElement = class {};
globalThis.customElements = { define: () => {} };
globalThis.document = {
  createElement: () => ({ classList: { add: () => {} } }),
};

const { shortenReason, lastSegment, shortPath, valueFit, STATE_THEME } =
  await import("../public/st-tile-grid.js");

test("state theme mapping: every lit state resolves to a spec theme class", () => {
  // amber rides the spec's orange ramp position, opportunity its own
  // teal branch (SPEC §2.1); neutral is deliberately unmapped (it is
  // rendered un-lit, not themed).
  assert.deepEqual(STATE_THEME, {
    green: "green",
    amber: "orange",
    red: "red",
    opportunity: "teal",
  });
});

test("lastSegment returns the final dot-segment", () => {
  assert.equal(
    lastSegment(
      "electrical.energy.prediction.deployment.flinsail.detectedState",
    ),
    "detectedState",
  );
  assert.equal(lastSegment("a.b.c"), "c");
  assert.equal(lastSegment("noseparator"), "noseparator");
});

test("shortPath returns the last two segments (anomaly labels)", () => {
  assert.equal(
    shortPath("electrical.batteries.0.capacity.stateOfCharge"),
    "capacity.stateOfCharge",
  );
});

test("shortenReason trims every path token to its last segment", () => {
  const r =
    "electrical.energy.prediction.deployment.flinsail.detectedState ≠ electrical.energy.prediction.deployment.flinsail.recommendedState";
  assert.equal(shortenReason(r), "detectedState ≠ recommendedState");
});

test("valueFit buckets headline lengths for font sizing", () => {
  // A single short number keeps the full 6.5vh glanceable size...
  assert.equal(valueFit("95%"), "s");
  assert.equal(valueFit("surplus"), "s");
  // ...composed headlines step down ('surplus 95%')...
  assert.equal(valueFit("surplus 95%"), "m");
  assert.equal(valueFit("deficit 45%"), "m");
  // ...and the longest wrap ('deployed starboard').
  assert.equal(valueFit("deployed starboard"), "l");
  assert.equal(valueFit(""), "s");
});

test("shortenReason leaves non-path text, numbers, and short tokens intact", () => {
  // single segment, no dot -> unchanged
  assert.equal(shortenReason("status=surplus"), "status=surplus");
  // a number with a decimal point is not a path token (starts with digit)
  assert.equal(shortenReason("soc=0.4 above 0.95"), "soc=0.4 above 0.95");
  // path + plain words
  assert.equal(
    shortenReason("electrical.batteries.0.capacity.stateOfCharge stale/absent"),
    "stateOfCharge stale/absent",
  );
  // message-style reasons with no dotted paths pass through
  assert.equal(shortenReason("spread 1.2 >= 0.95"), "spread 1.2 >= 0.95");
  assert.equal(shortenReason("agreement"), "agreement");
});
