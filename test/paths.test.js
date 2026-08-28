import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectPaths } from "../public/lib/paths.js";

describe("paths", () => {
  test("de-duplicates paths shared across checks and contexts", () => {
    const config = {
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
          context: "anchored",
          checks: [
            { type: "boolean", path: "navigation.state" }, // shared with context
            {
              type: "banded",
              path: "electrical.batteries.house.capacity.stateOfCharge",
            },
          ],
        },
        {
          id: "bank",
          checks: [
            {
              type: "banded",
              path: "electrical.batteries.house.capacity.stateOfCharge",
            }, // shared with other tile
            { type: "differential", path: "a", path2: "b" },
          ],
        },
      ],
    };
    const paths = collectPaths(config);
    // navigation.state appears once despite context + check both using it
    assert.strictEqual(paths.filter((p) => p === "navigation.state").length, 1);
    assert.strictEqual(
      paths.filter(
        (p) => p === "electrical.batteries.house.capacity.stateOfCharge",
      ).length,
      1,
    );
    assert.ok(paths.includes("a"));
    assert.ok(paths.includes("b"));
  });

  test("walks nested context combinators", () => {
    const config = {
      contexts: [
        {
          id: "complex",
          predicate: {
            allOf: [
              {
                path: "navigation.state",
                compare: "equals",
                value: "anchored",
              },
              {
                not: {
                  path: "electrical.chargers.0.state",
                  compare: "equals",
                  value: "charging",
                },
              },
              {
                anyOf: [
                  { path: "x", compare: "gt", value: 1 },
                  { between: { from: "win.from", to: "win.to" } },
                ],
              },
            ],
          },
        },
      ],
      tiles: [],
    };
    const paths = collectPaths(config);
    for (const expected of [
      "navigation.state",
      "electrical.chargers.0.state",
      "x",
      "win.from",
      "win.to",
    ]) {
      assert.ok(
        paths.includes(expected),
        `expected ${expected} in ${JSON.stringify(paths)}`,
      );
    }
  });

  test("collects valuePath (two-path comparisons) in top-level and leaf predicates", () => {
    const config = {
      contexts: [
        {
          id: "c",
          predicate: {
            path: "currentRadius",
            compare: "lt",
            valuePath: "alertThreshold",
            allOf: [{ path: "a", compare: "gt", valuePath: "b" }],
          },
        },
      ],
      tiles: [],
    };
    const paths = collectPaths(config);
    for (const expected of ["currentRadius", "alertThreshold", "a", "b"]) {
      assert.ok(
        paths.includes(expected),
        `expected ${expected} in ${JSON.stringify(paths)}`,
      );
    }
  });

  test("includes literal coverage candidates but not patterns", () => {
    const config = {
      coverage: {
        candidates: [
          "electrical.batteries.house.voltage",
          "environment.tank.*",
        ],
      },
      tiles: [],
    };
    const paths = collectPaths(config);
    assert.ok(paths.includes("electrical.batteries.house.voltage"));
    assert.ok(!paths.includes("environment.tank.*"));
  });

  test("unwraps the { configuration, enabled } envelope the admin UI / server hands us", () => {
    const inner = {
      staleMs: 60000,
      contexts: [
        {
          id: "moored",
          predicate: {
            path: "navigation.state",
            compare: "equals",
            value: "moored",
          },
        },
      ],
      tiles: [
        {
          id: "fridge",
          checks: [
            {
              type: "zone",
              path: "environment.inside.refrigerator.temperature",
            },
          ],
        },
      ],
      coverage: {
        candidates: ["propulsion.engine.oilPressure"],
        slots: 1,
        staleMs: 0,
        severityMap: {},
      },
    };
    const wrapped = { configuration: inner, enabled: true };
    const paths = collectPaths(wrapped);
    assert.ok(paths.includes("navigation.state"));
    assert.ok(paths.includes("environment.inside.refrigerator.temperature"));
    assert.ok(paths.includes("propulsion.engine.oilPressure"));
    assert.ok(
      paths.length === 3,
      `expected 3 paths, got ${JSON.stringify(paths)}`,
    );
  });

  test("unwrapConfig is a no-op on the already-unwrapped inner form", () => {
    const inner = {
      contexts: [{ id: "x", predicate: { path: "p" } }],
      tiles: [],
    };
    assert.strictEqual(collectPaths(inner).includes("p"), true);
  });

  test("compound check collects every path its predicate references", () => {
    const config = {
      tiles: [
        {
          id: "ac",
          label: "AC",
          checks: [
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
            {
              type: "compound",
              predicate: {
                anyOf: [
                  { path: "a", compare: "gt", valuePath: "b" },
                  { not: { path: "c", compare: "equals", value: "0" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const paths = collectPaths(config);
    for (const expected of [
      "electrical.venus.acPower",
      "electrical.inverters.294.mode",
      "a",
      "b",
      "c",
    ]) {
      assert.ok(
        paths.includes(expected),
        `expected ${expected} in ${JSON.stringify(paths)}`,
      );
    }
  });

  test("collects displayParts paths (composed headlines get subscriptions)", () => {
    const config = {
      tiles: [
        {
          id: "energy",
          checks: [
            {
              type: "stateMatch",
              path: "electrical.energy.prediction.status",
            },
          ],
          displayParts: [
            { path: "electrical.batteries.house.capacity.stateOfCharge" },
            // a path already watched by a check must not duplicate
            { path: "electrical.energy.prediction.status" },
          ],
        },
      ],
    };
    const paths = collectPaths(config);
    assert.ok(
      paths.includes("electrical.batteries.house.capacity.stateOfCharge"),
    );
    assert.strictEqual(
      paths.filter((p) => p === "electrical.energy.prediction.status").length,
      1,
    );
  });
});
