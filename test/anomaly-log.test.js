import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AnomalyLog } from "../public/lib/anomaly-log.js";

/** Minimal Web-Storage-shaped map. */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

const EV = {
  path: "electrical.batteries.0.voltage",
  state: "amber",
  zone: "warn",
  value: 12.1,
  firstSeen: 1000,
};

describe("anomaly-log", () => {
  test("records opened episodes and marks them cleared", () => {
    const log = new AnomalyLog(memStorage());
    log.record(EV, 1500);
    assert.strictEqual(log.all().length, 1);
    log.clear(EV.path, 9000);
    const e = log.all()[0];
    assert.strictEqual(e.path, EV.path);
    assert.strictEqual(e.state, "amber");
    assert.strictEqual(e.zone, "warn");
    assert.strictEqual(e.firstSeen, 1000);
    assert.strictEqual(e.openedAt, 1500);
    assert.strictEqual(e.clearedAt, 9000);
  });

  test("one entry per open episode; reopen after clear appends a new entry", () => {
    const log = new AnomalyLog(memStorage());
    log.record(EV, 1500);
    log.record(EV, 2000); // already open -> no-op
    assert.strictEqual(log.all().length, 1);
    log.clear(EV.path, 9000);
    log.record({ ...EV, value: 12.0, firstSeen: 20_000 }, 21_000);
    assert.strictEqual(log.all().length, 2);
    assert.strictEqual(log.all()[0].clearedAt, 9000);
    assert.strictEqual(log.all()[1].clearedAt, null);
    // clear with nothing open is a no-op.
    log.clear("never.seen", 22_000);
    assert.strictEqual(log.all().length, 2);
  });

  test("persists across instances via the injected storage", () => {
    const storage = memStorage(); // durability stand-in: same storage, new log
    const a = new AnomalyLog(storage);
    a.record(EV, 1500);
    a.clear(EV.path, 9000);
    const b = new AnomalyLog(storage);
    assert.strictEqual(b.all().length, 1);
    assert.strictEqual(b.all()[0].clearedAt, 9000);
  });

  test("bounds entries, preferring to drop closed history", () => {
    const log = new AnomalyLog(memStorage(), { maxEntries: 3 });
    for (let i = 0; i < 3; i++) {
      log.record({ ...EV, path: `p${i}`, firstSeen: i }, i);
      log.clear(`p${i}`, i + 10);
    }
    // Still-open entry: bounded drop must evict a closed one, not it.
    log.record({ ...EV, path: "open", firstSeen: 99 }, 100);
    assert.strictEqual(log.all().length, 3);
    assert.ok(log.all().some((e) => e.path === "open"));
    // All closed: oldest dropped.
    log.record({ ...EV, path: "closed", firstSeen: 200 }, 210);
    log.clear("closed", 220);
    log.record({ ...EV, path: "newer", firstSeen: 300 }, 310);
    assert.strictEqual(log.all().length, 3);
    assert.ok(!log.all().some((e) => e.path === "p0"));
  });

  test("memory-only with null storage; malformed persisted state discarded", () => {
    const log = new AnomalyLog(null);
    log.record(EV, 1500);
    assert.strictEqual(log.all().length, 1); // served from memory
    const bad = {
      getItem: () => "{not json",
      setItem: () => {},
    };
    assert.strictEqual(new AnomalyLog(bad).all().length, 0);
    const notArray = {
      getItem: () => "42",
      setItem: () => {},
    };
    assert.strictEqual(new AnomalyLog(notArray).all().length, 0);
  });

  test("setitem failures never throw (quota/private mode)", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const log = new AnomalyLog(throwing);
    log.record(EV, 1500);
    log.clear(EV.path, 9000);
    assert.strictEqual(log.all().length, 1);
  });
});
