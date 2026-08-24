import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AnomalyTracker,
  claimedPaths,
  detectAnomalies,
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

  test("AnomalyTracker: ranking is severity-first then oldest; extras bumped not dropped", () => {
    const t = new AnomalyTracker({ surfaceMs: 0, clearMs: 1000 });
    const now = 10_000;
    // Detect all three at once (surfaceMs 0 => eligible immediately).
    const a = { path: "a", state: "amber", zone: "warn", value: 1 };
    const b = { path: "b", state: "red", zone: "alarm", value: 2 };
    const c = { path: "c", state: "amber", zone: "warn", value: 3 };
    // Stagger firstSeen via successive updates.
    t.update([c], 3, now);
    t.update([b, c], 3, now + 100);
    t.update([a, b, c], 3, now + 200);
    const { surfaced, bumped } = t.update([a, b, c], 2, now + 300);
    assert.strictEqual(surfaced[0].path, "b"); // red first
    assert.strictEqual(surfaced[1].path, "c"); // oldest amber
    assert.strictEqual(bumped.length, 1);
    assert.strictEqual(bumped[0].path, "a");
  });

  test("AnomalyTracker: surface dwell — a blip below the dwell never surfaces", () => {
    const t = new AnomalyTracker({ surfaceMs: 10_000, clearMs: 30_000 });
    const a = { path: "v", state: "amber", zone: "warn", value: 15 };
    // Detected for 2s only, then gone — below the 10s surface dwell.
    t.update([a], 1, 0);
    t.update([a], 1, 2000);
    const { surfaced } = t.update([], 1, 2500);
    assert.strictEqual(surfaced.length, 0);
    // And it still clears on the clear clock (logged as a real episode).
    const { events } = t.update([], 1, 40_000);
    assert.ok(events.some((e) => e.type === "cleared" && e.path === "v"));
  });

  test("AnomalyTracker: surfaced after dwell; clear dwell holds the slot against flicker", () => {
    const t = new AnomalyTracker({ surfaceMs: 10_000, clearMs: 30_000 });
    const a = { path: "v", state: "amber", zone: "warn", value: 15 };
    // Detected continuously for 10s -> eligible.
    t.update([a], 1, 0);
    t.update([a], 1, 5000);
    const { surfaced } = t.update([a], 1, 10_000);
    assert.strictEqual(surfaced.length, 1);
    assert.strictEqual(surfaced[0].path, "v");

    // Detection drops for 10s (< clearMs 30s) -> still holds the slot.
    assert.strictEqual(t.update([], 1, 20_000).surfaced.length, 1);
    // Re-detected during the clear window -> seamless, no new open event.
    const { events } = t.update([a], 1, 25_000);
    assert.ok(!events.some((e) => e.type === "opened"));
    assert.strictEqual(t.update([a], 1, 26_000).surfaced.length, 1);

    // Absence now spans the clear window (starts at the first absent
    // tick after the 26s re-detection, resets nothing since) -> cleared,
    // slot freed.
    t.update([], 1, 30_000); // clear window opens
    const done = t.update([], 1, 61_000); // 31s absent >= 30s clearMs
    assert.strictEqual(done.surfaced.length, 0);
    assert.ok(done.events.some((e) => e.type === "cleared" && e.path === "v"));
  });

  test("AnomalyTracker: emits one opened event per episode with firstSeen", () => {
    const t = new AnomalyTracker({ surfaceMs: 0, clearMs: 1000 });
    const a = { path: "v", state: "amber", zone: "warn", value: 15 };
    const first = t.update([a], 1, 5000);
    assert.deepStrictEqual(
      first.events.filter((e) => e.type === "opened"),
      [
        {
          type: "opened",
          path: "v",
          state: "amber",
          zone: "warn",
          value: 15,
          firstSeen: 5000,
        },
      ],
    );
    // Subsequent ticks don't re-open.
    assert.strictEqual(
      t.update([a], 1, 6000).events.filter((e) => e.type === "opened").length,
      0,
    );
  });
});
