import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildSchema } from "../public/lib/schema.js";

describe("schema", () => {
  test("buildSchema returns a parseable JSON Schema with all top-level props", () => {
    // Smoke test: if schema.js has a syntax error, this import throws and
    // the plugin fails to load (which silently breaks the admin UI and
    // the /config endpoint). Guard against that regression.
    const s = buildSchema();
    assert.strictEqual(s.type, "object");
    for (const key of ["staleMs", "contexts", "tiles", "coverage"]) {
      assert.ok(key in s.properties, `expected ${key} in schema properties`);
    }
  });

  test("schema is JSON-serializable (no functions/circular refs)", () => {
    const s = buildSchema();
    const json = JSON.stringify(s);
    assert.ok(json.length > 0);
    assert.ok(json.includes("predicate"));
  });

  test("predicate offers valuePath for two-path comparisons", () => {
    const s = buildSchema();
    const pred = s.properties.contexts.items.properties.predicate;
    assert.ok("valuePath" in pred.properties);
  });

  test("zone check exists and documents path-only usage", () => {
    const s = buildSchema();
    const checkOneOf = s.properties.tiles.items.properties.checks.items.oneOf;
    const zone = checkOneOf.find((c) => c.properties?.type?.const === "zone");
    assert.ok(zone, "expected a zone check variant");
    assert.ok(zone.description.includes("just give a path"));
  });
});
