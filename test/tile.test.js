import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PathCache } from "../public/lib/staleness.js";
import { evalTile } from "../public/lib/tile.js";

function ctx(id, pred) {
  return { id, predicate: pred };
}

describe("tile aggregation", () => {
  test("worst state among checks wins", () => {
    const c = new PathCache();
    c.set("a", 1);
    c.set("b", 1);
    const t = evalTile(
      {
        id: "t",
        label: "T",
        checks: [
          { type: "boolean", path: "a", badWhen: false }, // green
          { type: "boolean", path: "b" }, // red
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.state, "red");
  });

  test("context inactive => gated by the ENGINE (hidden), evalTile itself runs checks when called", () => {
    // Context gating moved to the engine (SPEC §5, revised): an
    // inactive-context tile is omitted from the engine's output
    // entirely. evalTile is only called for shown tiles — direct calls
    // run checks regardless, which is what lets the engine's filter be
    // the single gating point.
    const c = new PathCache();
    c.set("nav", "sailing"); // context wants anchored
    c.set("alarm", true);
    const contexts = new Map([
      [
        "anchored",
        ctx("anchored", { path: "nav", compare: "equals", value: "anchored" }),
      ],
    ]);
    const t = evalTile(
      {
        id: "anchor",
        label: "Anchor",
        context: "anchored",
        checks: [{ type: "boolean", path: "alarm" }],
      },
      c,
      contexts,
    );
    assert.strictEqual(t.state, "red");
  });

  test("context active => checks run normally", () => {
    const c = new PathCache();
    c.set("nav", "anchored");
    c.set("alarm", true);
    const contexts = new Map([
      [
        "anchored",
        ctx("anchored", { path: "nav", compare: "equals", value: "anchored" }),
      ],
    ]);
    const t = evalTile(
      {
        id: "anchor",
        label: "Anchor",
        context: "anchored",
        checks: [{ type: "boolean", path: "alarm" }],
      },
      c,
      contexts,
    );
    assert.strictEqual(t.state, "red");
  });

  test("unknown context => neutral with reason", () => {
    const t = evalTile(
      { id: "x", label: "X", context: "nope", checks: [] },
      new PathCache(),
      new Map(),
    );
    assert.strictEqual(t.state, "neutral");
    assert.ok(t.reason.includes("unknown context"));
  });

  test("display value from the designated check", () => {
    const c = new PathCache();
    c.set("soc", 0.92);
    const t = evalTile(
      {
        id: "bank",
        label: "House Bank",
        checks: [
          {
            type: "banded",
            path: "soc",
            low: { warn: 0.3 },
            display: true,
            unit: "ratio",
          },
          { type: "boolean", path: "alarm" },
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.state, "green");
    assert.strictEqual(t.displayValue, "92%");
  });

  test("at most one display check; multiple is a config error but only last used", () => {
    const c = new PathCache();
    c.set("a", 0.9);
    c.set("b", 0.9);
    const t = evalTile(
      {
        id: "x",
        label: "X",
        checks: [
          { type: "banded", path: "a", display: true, unit: "ratio" },
          { type: "banded", path: "b", display: true, unit: "ratio" },
        ],
      },
      c,
      new Map(),
    );
    // the validator rejects this; tile.js just takes the last one found
    assert.ok(t.displayValue != null);
  });

  test("stale display check shows dash, not the frozen last reading (SPEC §3.4)", () => {
    const old = Date.now() - 120000;
    const c = new PathCache();
    c.set("soc", 0.92, old);
    const t = evalTile(
      {
        id: "bank",
        label: "House Bank",
        checks: [
          {
            type: "banded",
            path: "soc",
            low: { warn: 0.3 },
            display: true,
            unit: "ratio",
            staleState: "neutral",
          },
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.state, "neutral");
    assert.strictEqual(t.displayValue, "—");
  });

  test("footer resolves labeled path readouts; absent paths show dash", () => {
    const c = new PathCache();
    c.set("solar.good", true);
    c.set("solar.total", 358);
    c.set("solar.port", 164);
    c.setMeta("solar.total", {
      displayUnits: { formula: "value", symbol: "W", displayFormat: "0" },
    });
    c.setMeta("solar.port", {
      displayUnits: { formula: "value", symbol: "W", displayFormat: "0" },
    });
    const t = evalTile(
      {
        id: "solar",
        label: "Solar",
        checks: [{ type: "boolean", path: "solar.good", badWhen: false }],
        footer: [
          { label: "Port", path: "solar.port" },
          { label: "Starboard", path: "solar.stbd" },
          { label: "Total", path: "solar.total" },
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.state, "green");
    assert.strictEqual(t.footer.length, 3);
    assert.deepStrictEqual(t.footer[0], { label: "Port", value: "164 W" });
    assert.deepStrictEqual(t.footer[1], { label: "Starboard", value: "—" });
    assert.deepStrictEqual(t.footer[2], { label: "Total", value: "358 W" });
  });

  test("footer applies SI prefixing via meta.units or inline unit (3190 Wh -> 3.19 kWh)", () => {
    const c = new PathCache();
    // No displayUnits metadata at all — the standard `units` meta field
    // is the symbol fallback.
    c.set("energy.battery", 3190);
    c.setMeta("energy.battery", { units: "Wh" });
    // Neither metadata: the entry's inline unit is the last resort.
    c.set("energy.solar", 3190);
    // Metadata wins over the inline unit (W explicit here).
    c.set("power.bus", 3190);
    c.setMeta("power.bus", {
      displayUnits: { formula: "value", symbol: "W", displayFormat: "0" },
    });
    const t = evalTile(
      {
        id: "e",
        label: "E",
        checks: [],
        footer: [
          { label: "Battery", path: "energy.battery" },
          { label: "Solar", path: "energy.solar", unit: "Wh" },
          { label: "Bus", path: "power.bus", unit: "Wh" },
        ],
      },
      c,
      new Map(),
    );
    assert.deepStrictEqual(t.footer[0], {
      label: "Battery",
      value: "3.19 kWh",
    });
    assert.deepStrictEqual(t.footer[1], {
      label: "Solar",
      value: "3.19 kWh",
    });
    // Published displayUnits beats the inline unit for the *unit source*:
    // stays watts (not Wh). SI scaling still composes with the authored
    // precision ("0" -> integer): 3190 W -> 3.19 kW -> "3 kW".
    assert.deepStrictEqual(t.footer[2], { label: "Bus", value: "3 kW" });
  });

  test("footer omitted when not configured", () => {
    const c = new PathCache();
    c.set("a", 1);
    const t = evalTile(
      {
        id: "t",
        label: "T",
        checks: [{ type: "boolean", path: "a", badWhen: false }],
      },
      c,
      new Map(),
    );
    assert.deepStrictEqual(t.footer, []);
  });

  test("footer shows string state values as-is (no numeric formatting)", () => {
    const c = new PathCache();
    c.set("flinsail.detected", "deployed");
    c.set("flinsail.recommended", "deployed");
    const t = evalTile(
      {
        id: "flinsail",
        label: "FLINSAIL",
        checks: [
          {
            type: "agreement",
            path: "flinsail.detected",
            path2: "flinsail.recommended",
          },
        ],
        footer: [
          { label: "Detected", path: "flinsail.detected" },
          { label: "Recommended", path: "flinsail.recommended" },
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.footer[0].value, "deployed");
    assert.strictEqual(t.footer[1].value, "deployed");
  });

  test("opportunity from one check with green others -> opportunity (SPEC §2.1)", () => {
    const c = new PathCache();
    c.set("soc", 0.97);
    c.set("ok", 1);
    const t = evalTile(
      {
        id: "t",
        label: "T",
        checks: [
          { type: "boolean", path: "ok", badWhen: false }, // green
          {
            type: "banded",
            path: "soc",
            high: { warn: 0.95, warnState: "opportunity" },
          },
        ],
      },
      c,
      new Map(),
    );
    assert.strictEqual(t.state, "opportunity");
  });

  test("problem beats opportunity in worst-of aggregation (SPEC §2.1)", () => {
    const c = new PathCache();
    c.set("soc", 0.97);
    c.set("alarm", true);
    const t = evalTile(
      {
        id: "t",
        label: "T",
        checks: [
          { type: "boolean", path: "alarm" }, // red
          {
            type: "banded",
            path: "soc",
            high: { warn: 0.95, warnState: "opportunity" },
          },
        ],
      },
      c,
      new Map(),
    );
    // A problem (red) always outranks a chance (opportunity).
    assert.strictEqual(t.state, "red");
  });
});
