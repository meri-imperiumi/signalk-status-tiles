import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CHECK_TYPES, evalCheck } from "../public/lib/checks.js";
import { PathCache } from "../public/lib/staleness.js";

function cacheWith(entries, meta = {}) {
  const c = new PathCache();
  const now = Date.now();
  for (const [p, v] of Object.entries(entries)) c.set(p, v, now);
  for (const [p, m] of Object.entries(meta)) c.setMeta(p, m);
  return c;
}

describe("checks", () => {
  test("CHECK_TYPES is the closed set from SPEC §3.3", () => {
    assert.deepStrictEqual([...CHECK_TYPES].sort(), [
      "agreement",
      "alarmGroup",
      "banded",
      "boolean",
      "compound",
      "differential",
      "notification",
      "stateMatch",
      "zone",
    ]);
  });

  test("boolean: truthy -> red when badWhen true; green when badWhen false", () => {
    const c = cacheWith({ bilge: true, pump: false });
    assert.strictEqual(
      evalCheck({ type: "boolean", path: "bilge" }, c).state,
      "red",
    );
    assert.strictEqual(
      evalCheck({ type: "boolean", path: "bilge", badWhen: false }, c).state,
      "green",
    );
    assert.strictEqual(
      evalCheck({ type: "boolean", path: "pump" }, c).state,
      "green",
    );
    assert.strictEqual(
      evalCheck({ type: "boolean", path: "pump", badWhen: false }, c).state,
      "red",
    );
  });

  test("banded: warn/crit on low and high; worst wins", () => {
    const c = cacheWith({ soc: 0.15, v: 14.5 });
    assert.strictEqual(
      evalCheck(
        { type: "banded", path: "soc", low: { warn: 0.3, crit: 0.2 } },
        c,
      ).state,
      "red",
    );
    assert.strictEqual(
      evalCheck({ type: "banded", path: "soc", low: { warn: 0.3 } }, c).state,
      "amber",
    );
    assert.strictEqual(
      evalCheck(
        { type: "banded", path: "v", high: { warn: 14.4, crit: 14.8 } },
        c,
      ).state,
      "amber",
    );
    assert.strictEqual(
      evalCheck({ type: "banded", path: "v", high: { crit: 14.4 } }, c).state,
      "red",
    );
    assert.strictEqual(
      evalCheck({ type: "banded", path: "soc", low: { crit: 0.1 } }, c).state,
      "green",
    );
  });

  test("banded: display value formatted by unit", () => {
    const c = cacheWith({ soc: 0.92 });
    const r = evalCheck(
      { type: "banded", path: "soc", display: true, unit: "ratio" },
      c,
    );
    assert.strictEqual(r.displayValue, "92%");
  });

  test("banded: display value honors published displayUnits metadata", () => {
    const c = new PathCache();
    c.set("electrical.venus.totalPanelPower", 31.776);
    c.setMeta("electrical.venus.totalPanelPower", {
      displayUnits: {
        formula: "value",
        symbol: "W",
        displayFormat: "0.00",
      },
    });
    const r = evalCheck(
      {
        type: "banded",
        path: "electrical.venus.totalPanelPower",
        display: true,
      },
      c,
    );
    assert.strictEqual(r.displayValue, "31.78 W");
  });

  test("banded: inline unit is the fallback when no metadata is published", () => {
    // No metadata on the path: inline unit: "ratio" still renders as %.
    const c = cacheWith({ soc: 0.92 });
    const r = evalCheck(
      { type: "banded", path: "soc", display: true, unit: "ratio" },
      c,
    );
    assert.strictEqual(r.displayValue, "92%");
    // Metadata wins over an inline unit when both are present.
    const c2 = new PathCache();
    c2.set("soc", 0.92);
    c2.setMeta("soc", {
      displayUnits: { formula: "value * 100", symbol: "%", displayFormat: "0" },
    });
    const r2 = evalCheck(
      { type: "banded", path: "soc", display: true, unit: "ratio" },
      c2,
    );
    assert.strictEqual(r2.displayValue, "92%");
  });

  test("differential: spread vs warn/crit", () => {
    const c = cacheWith({ a: 12.1, b: 13.5 }); // diff 1.4 >= crit 1 -> red
    assert.strictEqual(
      evalCheck(
        { type: "differential", path: "a", path2: "b", warn: 0.5, crit: 1 },
        c,
      ).state,
      "red",
    );
    const c2 = cacheWith({ a: 12.1, b: 12.5 }); // diff 0.4 >= warn 0.3 -> amber
    assert.strictEqual(
      evalCheck(
        { type: "differential", path: "a", path2: "b", warn: 0.3, crit: 1 },
        c2,
      ).state,
      "amber",
    );
  });

  test("alarmGroup: tripped path -> red; level sub-check -> amber", () => {
    const c = cacheWith({ a1: true, a2: false, lvl: 0.4 });
    assert.strictEqual(
      evalCheck({ type: "alarmGroup", paths: ["a1", "a2"] }, c).state,
      "red",
    );
    const c3 = cacheWith({ a1: false, a2: false, lvl: 0.4 });
    assert.strictEqual(
      evalCheck(
        {
          type: "alarmGroup",
          paths: ["a1", "a2"],
          levelPath: "lvl",
          levelWarn: 0.5,
          levelCrit: 0.3,
        },
        c3,
      ).state,
      "amber",
    );
    const c4 = cacheWith({ a1: false, a2: false, lvl: 0.6 });
    assert.strictEqual(
      evalCheck(
        {
          type: "alarmGroup",
          paths: ["a1", "a2"],
          levelPath: "lvl",
          levelWarn: 0.5,
          levelCrit: 0.3,
        },
        c4,
      ).state,
      "green",
    );
  });

  test("alarmGroup stale path defaults to red (safety-relevant, SPEC §4)", () => {
    const old = Date.now() - 120000;
    const c = new PathCache();
    c.set("a1", false, old);
    assert.strictEqual(
      evalCheck({ type: "alarmGroup", paths: ["a1"] }, c).state,
      "red",
    );
  });

  test("stateMatch: map lookup with default", () => {
    const c = cacheWith({ nav: "sailing" });
    assert.strictEqual(
      evalCheck(
        {
          type: "stateMatch",
          path: "nav",
          map: { sailing: "green", motoring: "amber" },
          default: "neutral",
        },
        c,
      ).state,
      "green",
    );
    assert.strictEqual(
      evalCheck(
        {
          type: "stateMatch",
          path: "nav",
          map: { sailing: "green" },
          default: "red",
        },
        cacheWith({ nav: "anchored" }),
      ).state,
      "red",
    );
  });

  test("zone: reads metadata zones; severity map collapses 5->4", () => {
    const meta = {
      zones: [
        { lower: 0, upper: 11.8, state: "alarm" },
        { lower: 11.8, upper: 12.2, state: "nominal" },
        { lower: 14.4, upper: 100, state: "warn" },
      ],
    };
    const c = cacheWith({ v: 11.5 }, { v: meta });
    assert.strictEqual(evalCheck({ type: "zone", path: "v" }, c).state, "red");
    const c2 = cacheWith({ v: 12.0 }, { v: meta });
    assert.strictEqual(
      evalCheck({ type: "zone", path: "v" }, c2).state,
      "green",
    );
    const c3 = cacheWith({ v: 15.0 }, { v: meta });
    assert.strictEqual(
      evalCheck({ type: "zone", path: "v" }, c3).state,
      "amber",
    );
  });

  test("zone: inline zones fallback when no metadata published", () => {
    const c = cacheWith({ v: 11.5 });
    const r = evalCheck(
      {
        type: "zone",
        path: "v",
        zones: [{ lower: 0, upper: 11.8, state: "alarm" }],
      },
      c,
    );
    assert.strictEqual(r.state, "red");
  });

  test("zone: path-only with published metadata zones needs no inline config", () => {
    const meta = {
      zones: [
        { lower: 0, upper: 10, state: "nominal" },
        { lower: 10, upper: 100, state: "warn" },
      ],
    };
    const c = cacheWith({ v: 12 }, { v: meta });
    const r = evalCheck({ type: "zone", path: "v" }, c);
    assert.strictEqual(r.state, "amber");
  });

  test("zone: empty inline zones: [] falls through to metadata (admin UI defaults to [])", () => {
    const meta = { zones: [{ upper: 1000, lower: 285.15, state: "warn" }] };
    const c = cacheWith({ v: 285.76 }, { v: meta });
    // zones: [] is truthy but empty — must fall through to metadata, not mask it
    const r = evalCheck({ type: "zone", path: "v", zones: [] }, c);
    assert.strictEqual(r.state, "amber");
    assert.ok(!r.reason.includes("no zones"));
  });

  test("zone: no zones at all (neither inline nor metadata) => neutral, not silent green (SPEC §4)", () => {
    const c = cacheWith({ v: 12 });
    const r = evalCheck({ type: "zone", path: "v" }, c);
    assert.strictEqual(r.state, "neutral");
    assert.ok(r.reason.includes("no zones"));
  });

  test("notification: maps upstream severity; defaults reason to message", () => {
    const c = cacheWith({
      "notifications.x": { state: "warn", message: "Low voltage 11.9V" },
    });
    const r = evalCheck({ type: "notification", path: "notifications.x" }, c);
    assert.strictEqual(r.state, "amber");
    assert.strictEqual(r.reason, "Low voltage 11.9V");
  });

  test("notification: per-check severityMap can remap a positive warn to green (SPEC §7.1)", () => {
    const c = cacheWith({
      "notifications.surplus": { state: "warn", message: "1.3kWh surplus" },
    });
    const r = evalCheck(
      {
        type: "notification",
        path: "notifications.surplus",
        severityMap: { warn: "green" },
      },
      c,
    );
    assert.strictEqual(r.state, "green");
  });

  test("agreement: equal -> green; mismatch -> amber by default; configurable", () => {
    const c = cacheWith({ expected: "deployed", actual: "deployed" });
    assert.strictEqual(
      evalCheck({ type: "agreement", path: "expected", path2: "actual" }, c)
        .state,
      "green",
    );
    const c2 = cacheWith({ expected: "deployed", actual: "stowed" });
    assert.strictEqual(
      evalCheck({ type: "agreement", path: "expected", path2: "actual" }, c2)
        .state,
      "amber",
    );
    assert.strictEqual(
      evalCheck(
        {
          type: "agreement",
          path: "expected",
          path2: "actual",
          mismatchState: "red",
        },
        c2,
      ).state,
      "red",
    );
  });

  test("agreement: display:true surfaces the observed (path) value as headline", () => {
    const c = cacheWith({ expected: "deployed", actual: "deployed" });
    const r = evalCheck(
      { type: "agreement", path: "expected", path2: "actual", display: true },
      c,
    );
    assert.strictEqual(r.state, "green");
    assert.strictEqual(r.displayValue, "deployed");
  });

  test("agreement: display:true on numeric value applies displayUnits conversion", () => {
    const c = new PathCache();
    c.set("observed", 285.76);
    c.set("reference", 285.76);
    c.setMeta("observed", {
      displayUnits: {
        formula: "value - 273.15",
        symbol: "°C",
        displayFormat: "0.0",
      },
    });
    const r = evalCheck(
      {
        type: "agreement",
        path: "observed",
        path2: "reference",
        display: true,
      },
      c,
    );
    assert.strictEqual(r.state, "green");
    assert.strictEqual(r.displayValue, "12.6°C");
  });

  test("most checks default stale -> neutral; overridable", () => {
    const old = Date.now() - 120000;
    const c = new PathCache();
    c.set("p", 1, old);
    assert.strictEqual(
      evalCheck({ type: "banded", path: "p", low: { warn: 0 } }, c).state,
      "neutral",
    );
    assert.strictEqual(
      evalCheck(
        { type: "banded", path: "p", low: { warn: 0 }, staleState: "red" },
        c,
      ).state,
      "red",
    );
  });

  test("compound: amber when predicate matches, green otherwise", () => {
    // Motivating case: AC output is 0 AND inverter is on -> amber
    // (user forgot to leave the inverter running).
    const off = cacheWith({
      "electrical.venus.acPower": 0,
      "electrical.inverters.294.mode": "on",
    });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        off,
      ).state,
      "amber",
    );
    // Inverter on but producing power -> not the fault -> green.
    const producing = cacheWith({
      "electrical.venus.acPower": 320,
      "electrical.inverters.294.mode": "on",
    });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        producing,
      ).state,
      "green",
    );
    // Inverter off and no output -> also green (the fault is specifically
    // 'on but idle').
    const inverterOff = cacheWith({
      "electrical.venus.acPower": 0,
      "electrical.inverters.294.mode": "off",
    });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        inverterOff,
      ).state,
      "green",
    );
  });

  test("compound: configurable state when matched (e.g. red)", () => {
    const c = cacheWith({ a: 1, b: 2 });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          state: "red",
          predicate: {
            path: "a",
            compare: "lt",
            value: "10",
          },
        },
        c,
      ).state,
      "red",
    );
  });

  test("compound: supports anyOf and not combinators", () => {
    const c = cacheWith({ a: 1, b: 0 });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            anyOf: [
              { path: "a", compare: "equals", value: "1" },
              { path: "b", compare: "equals", value: "1" },
            ],
          },
        },
        c,
      ).state,
      "amber",
    );
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            not: { path: "a", compare: "equals", value: "0" },
          },
        },
        c,
      ).state,
      "amber",
    );
  });

  test("compound: stale referenced path -> staleState (default neutral), never silent green", () => {
    const old = Date.now() - 120000;
    const c = new PathCache();
    // acPower fresh at 0, inverter mode stale -> predicate would
    // not match (mode absent), but staleness must surface, not a green.
    c.set("electrical.venus.acPower", 0, Date.now());
    c.set("electrical.inverters.294.mode", "on", old);
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        c,
      ).state,
      "neutral",
    );
    // Override: a stale inverter-mode reading is a fault here.
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          staleState: "red",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        c,
      ).state,
      "red",
    );
  });

  test("compound: absent path fails closed (whenMissing default false)", () => {
    const c = cacheWith({ "electrical.venus.acPower": 0 });
    assert.strictEqual(
      evalCheck(
        {
          type: "compound",
          predicate: {
            allOf: [
              {
                path: "electrical.venus.acPower",
                compare: "equals",
                value: "0",
              },
              {
                path: "electrical.inverters.294.mode",
                compare: "equals",
                value: "on",
              },
            ],
          },
        },
        c,
      ).state,
      "neutral",
    );
  });
});
