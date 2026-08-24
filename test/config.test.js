import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { validateConfig } from "../public/lib/config.js";

describe("config validation", () => {
  test("minimal valid config has no errors", () => {
    const cfg = {
      contexts: [
        {
          id: "anchored",
          predicate: {
            path: "navigation.state",
            compare: "equals",
            value: "anchored",
          },
        },
      ],
      tiles: [
        {
          id: "anchor",
          label: "Anchor",
          checks: [{ type: "boolean", path: "notifications.anchor.alarm" }],
        },
      ],
    };
    const { errors, warnings } = validateConfig(cfg);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warnings.length, 0);
  });

  test("unknown context reference on a tile is an error", () => {
    const cfg = {
      tiles: [
        {
          id: "x",
          label: "X",
          context: "nope",
          checks: [{ type: "boolean", path: "p" }],
        },
      ],
    };
    assert.ok(
      validateConfig(cfg).errors.some((e) => e.includes("unknown context")),
    );
  });

  test("unknown check type is an error", () => {
    const cfg = {
      tiles: [{ id: "x", label: "X", checks: [{ type: "magic", path: "p" }] }],
    };
    assert.ok(validateConfig(cfg).errors.some((e) => e.includes("magic")));
  });

  test("more than one display check per tile is an error (SPEC §3.4)", () => {
    const cfg = {
      tiles: [
        {
          id: "x",
          label: "X",
          checks: [
            { type: "banded", path: "a", display: true },
            { type: "banded", path: "b", display: true },
          ],
        },
      ],
    };
    assert.ok(validateConfig(cfg).errors.some((e) => e.includes("display")));
  });

  test("deeply nested predicate triggers a warning (SPEC §9 depth cap)", () => {
    const deep = {
      allOf: [
        {
          allOf: [
            { path: "a", compare: "equals", value: 1 },
            { allOf: [{ path: "b", compare: "equals", value: 1 }] },
          ],
        },
      ],
    };
    const cfg = { contexts: [{ id: "c", predicate: deep }], tiles: [] };
    assert.ok(validateConfig(cfg).warnings.length > 0);
  });

  test("duplicate tile id is an error", () => {
    const cfg = {
      tiles: [
        { id: "dup", label: "A", checks: [{ type: "boolean", path: "p" }] },
        { id: "dup", label: "B", checks: [{ type: "boolean", path: "p" }] },
      ],
    };
    assert.ok(validateConfig(cfg).errors.some((e) => e.includes("Duplicate")));
  });

  test("compound check with a predicate is valid", () => {
    const cfg = {
      tiles: [
        {
          id: "ac",
          label: "AC",
          checks: [
            {
              type: "compound",
              predicate: {
                allOf: [
                  { path: "a", compare: "equals", value: "0" },
                  { path: "b", compare: "equals", value: "on" },
                ],
              },
            },
          ],
        },
      ],
    };
    const { errors, warnings } = validateConfig(cfg);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warnings.length, 0);
  });

  test("compound check with empty/missing predicate is an error", () => {
    const noPred = {
      tiles: [{ id: "x", label: "X", checks: [{ type: "compound" }] }],
    };
    assert.ok(
      validateConfig(noPred).errors.some((e) =>
        e.includes("compound check has no predicate"),
      ),
    );
    const emptyPred = {
      tiles: [
        {
          id: "x",
          label: "X",
          checks: [{ type: "compound", predicate: {} }],
        },
      ],
    };
    assert.ok(
      validateConfig(emptyPred).errors.some((e) =>
        e.includes("compound check predicate is empty"),
      ),
    );
  });

  test("tile mixing problem and opportunity checks warns (SPEC §2.1)", () => {
    // One check targets opportunity, another targets a problem state →
    // straddle, should be split into two tiles.
    const cfg = {
      tiles: [
        {
          id: "mixed",
          label: "Mixed",
          checks: [
            { type: "boolean", path: "alarm" }, // red (problem)
            {
              type: "banded",
              path: "soc",
              high: { warn: 0.95, warnState: "opportunity" },
            },
          ],
        },
      ],
    };
    assert.ok(
      validateConfig(cfg).warnings.some((e) =>
        e.includes("split into two tiles"),
      ),
    );
  });

  test("single asymmetric banded check is NOT a straddle (SPEC §2.1)", () => {
    // One banded check with low→red and high→opportunity is the intended
    // single-asymmetric-metric case, not a multi-check straddle.
    const cfg = {
      tiles: [
        {
          id: "outlook",
          label: "Energy outlook",
          checks: [
            {
              type: "banded",
              path: "soc",
              low: { crit: 0.2, critState: "red" },
              high: { warn: 0.95, warnState: "opportunity" },
            },
          ],
        },
      ],
    };
    const { warnings } = validateConfig(cfg);
    assert.ok(
      !warnings.some((e) => e.includes("split into two tiles")),
      "single asymmetric check should not warn about straddling",
    );
  });
});
