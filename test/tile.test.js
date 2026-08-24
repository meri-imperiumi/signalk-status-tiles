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
});
