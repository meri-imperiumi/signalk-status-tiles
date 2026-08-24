import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_STALE_MS, PathCache } from "../public/lib/staleness.js";

describe("staleness PathCache", () => {
  test("absent path is stale", () => {
    const c = new PathCache();
    assert.strictEqual(c.isStale("nope"), true);
    assert.strictEqual(c.age("nope"), Infinity);
    assert.strictEqual(c.has("nope"), false);
  });

  test("fresh path is not stale; age measured from delta timestamp", () => {
    const c = new PathCache();
    const ts = Date.now() - 100;
    c.set("p", 42, ts);
    assert.strictEqual(c.value("p"), 42);
    assert.strictEqual(c.isStale("p"), false);
    assert.ok(Math.abs(c.age("p") - 100) < 50);
  });

  test("stale once age exceeds threshold; per-check threshold respected", () => {
    const c = new PathCache();
    const old = Date.now() - (DEFAULT_STALE_MS + 5000);
    c.set("p", 1, old);
    assert.strictEqual(c.isStale("p"), true);
    // a larger per-check threshold makes it fresh again
    assert.strictEqual(c.isStale("p", DEFAULT_STALE_MS + 60000), false);
  });

  test("threshold of 0 means staleness disabled (never stale), not instantly stale", () => {
    const c = new PathCache();
    // even a very old value is not stale when the threshold is 0
    const old = Date.now() - 1000000;
    c.set("p", 1, old);
    assert.strictEqual(c.isStale("p", 0), false);
    assert.strictEqual(c.isStale("p", -1), false);
  });

  test("meta is stored separately from values", () => {
    const c = new PathCache();
    c.setMeta("p", { zones: [{ lower: 0, upper: 10, state: "nominal" }] });
    assert.strictEqual(c.metaFor("p").zones.length, 1);
    assert.strictEqual(c.value("p"), undefined);
  });
});
