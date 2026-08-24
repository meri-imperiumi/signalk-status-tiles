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
});
