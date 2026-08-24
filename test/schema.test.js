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

  test("opportunity is offered to banded/stateMatch/notification/agreement/compound but NOT zone (SPEC §2.1, §3.3)", () => {
    const s = buildSchema();
    const variants = s.properties.tiles.items.properties.checks.items.oneOf;
    const byType = (t) => variants.find((c) => c.properties?.type?.const === t);

    // banded: per-side warnState/critState include opportunity.
    const banded = byType("banded");
    assert.ok(
      banded.properties.low.properties.warnState.enum.includes("opportunity"),
    );
    assert.ok(
      banded.properties.high.properties.warnState.enum.includes("opportunity"),
    );

    // stateMatch map rows may target opportunity. Rows (array), not a
    // free-form object: the admin UI can't render additionalProperties.
    const stateMatch = byType("stateMatch");
    assert.equal(stateMatch.properties.map.type, "array");
    assert.ok(
      stateMatch.properties.map.items.properties.state.enum.includes(
        "opportunity",
      ),
    );
    // stateMatch offers the display-value designation like every other
    // check type (SPEC §3.4).
    assert.ok(stateMatch.properties.display);
    assert.equal(stateMatch.properties.display.type, "boolean");

    // notification severityMap may target opportunity (§7.1 motivating case).
    const notification = byType("notification");
    assert.ok(
      notification.properties.severityMap.properties.warn.enum.includes(
        "opportunity",
      ),
    );

    // agreement mismatchState may target opportunity.
    const agreement = byType("agreement");
    assert.ok(agreement.properties.mismatchState.enum.includes("opportunity"));

    // compound state may target opportunity.
    const compound = byType("compound");
    assert.ok(compound.properties.state.enum.includes("opportunity"));

    // zone: opportunity is NOT offered (SK zone vocab is a badness scale).
    const zone = byType("zone");
    assert.ok(
      !zone.properties.severityMap.properties.warn.enum.includes("opportunity"),
      "zone must not offer opportunity (SPEC §3.3)",
    );

    // coverage severityMap likewise excludes opportunity (SPEC §2.1, §10).
    const cov = s.properties.coverage.properties.severityMap;
    assert.ok(
      !cov.properties.warn.enum.includes("opportunity"),
      "coverage must not offer opportunity (SPEC §2.1)",
    );
  });
});
