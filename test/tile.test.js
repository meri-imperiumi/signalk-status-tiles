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

  test("context inactive => neutral outright, checks do not run", () => {
    const c = new PathCache();
    c.set("nav", "sailing"); // context wants anchored
    c.set("alarm", true); // would be red if checks ran
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
    assert.strictEqual(t.state, "neutral");
    assert.strictEqual(t.reason, "context inactive");
    // context-inactive neutral shows NO display value (not a dash)
    assert.strictEqual(t.displayValue, undefined);
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
