import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  claimedPaths,
  detectAnomalies,
  rankAndAssign,
} from "../public/lib/coverage.js";
import { PathCache } from "../public/lib/staleness.js";

describe("coverage", () => {
  test("claimedPaths excludes paths on tiles' checks; honors inactive-context paths", () => {
    const config = {
      tiles: [
        { checks: [{ type: "banded", path: "claimed" }] },
        { context: "anchored", checks: [{ type: "banded", path: "gated" }] },
      ],
    };
    // with no inactive-context set, both are claimed
    assert.ok(claimedPaths(config).has("claimed"));
    assert.ok(claimedPaths(config).has("gated"));
    // with "gated" owned only by an inactive-context tile, it's unclaimed
    const unclaimed = claimedPaths(config, new Set(["gated"]));
    assert.ok(!unclaimed.has("gated"));
    assert.ok(unclaimed.has("claimed"));
  });

  test("detectAnomalies surfaces only warn/alarm zone states, skips stale + non-numeric", () => {
    const config = {
      coverage: {
        candidates: ["v", "stale1", "txt"],
      },
    };
    const c = new PathCache();
    const now = Date.now();
    c.set("v", 15.0, now); // warn zone
    c.set("stale1", 15.0, now - 200000); // stale
    c.set("txt", "hello", now); // non-numeric
    c.setMeta("v", {
      zones: [
        { lower: 0, upper: 14, state: "nominal" },
        { lower: 14, upper: 100, state: "warn" },
      ],
    });
    const anomalies = detectAnomalies(config, c, new Set(), now);
    assert.strictEqual(anomalies.length, 1);
    assert.strictEqual(anomalies[0].path, "v");
    assert.strictEqual(anomalies[0].state, "amber");
  });

  test("detectAnomalies ignores claimed paths", () => {
    const config = { coverage: { candidates: ["v"] } };
    const c = new PathCache();
    c.set("v", 15, Date.now());
    c.setMeta("v", { zones: [{ lower: 14, upper: 100, state: "warn" }] });
    const out = detectAnomalies(config, c, new Set(["v"]));
    assert.strictEqual(out.length, 0);
  });

  test("rankAndAssign: severity first then oldest; extras are bumped not dropped", () => {
    const now = 1000;
    const anomalies = [
      { path: "a", state: "amber" },
      { path: "b", state: "red" },
      { path: "c", state: "amber" },
    ];
    const firstSeen = new Map([
      ["a", 900],
      ["b", 950],
      ["c", 800],
    ]);
    const { surfaced, bumped } = rankAndAssign(anomalies, firstSeen, 2, now);
    assert.strictEqual(surfaced[0].path, "b"); // red first
    assert.strictEqual(surfaced[1].path, "c"); // oldest amber (800 < 900)
    assert.strictEqual(bumped.length, 1);
    assert.strictEqual(bumped[0].path, "a");
  });
});
