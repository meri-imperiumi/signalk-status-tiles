import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evalPredicate } from "../public/lib/context.js";
import { PathCache } from "../public/lib/staleness.js";

describe("context predicates", () => {
  test("equals comparison true/false on match/mismatch", () => {
    const c = new PathCache();
    c.set("navigation.state", "anchored");
    assert.ok(
      evalPredicate(
        { path: "navigation.state", compare: "equals", value: "anchored" },
        c,
      ),
    );
    assert.ok(
      !evalPredicate(
        { path: "navigation.state", compare: "equals", value: "sailing" },
        c,
      ),
    );
  });

  test("numeric comparisons coerce strings to numbers", () => {
    const c = new PathCache();
    c.set("soc", 0.5);
    assert.ok(evalPredicate({ path: "soc", compare: "lt", value: "0.8" }, c));
    assert.ok(!evalPredicate({ path: "soc", compare: "gt", value: "0.8" }, c));
    assert.ok(evalPredicate({ path: "soc", compare: "gte", value: "0.5" }, c));
    assert.ok(evalPredicate({ path: "soc", compare: "lte", value: "0.5" }, c));
  });

  test("valuePath compares two live paths (e.g. currentRadius < alertThreshold)", () => {
    const c = new PathCache();
    c.set("navigation.anchor.currentRadius", 18);
    c.set("navigation.anchor.alertThreshold", 25);
    assert.ok(
      evalPredicate(
        {
          path: "navigation.anchor.currentRadius",
          compare: "lt",
          valuePath: "navigation.anchor.alertThreshold",
        },
        c,
      ),
    );
    // crossing the threshold flips it
    c.set("navigation.anchor.currentRadius", 30);
    assert.ok(
      !evalPredicate(
        {
          path: "navigation.anchor.currentRadius",
          compare: "lt",
          valuePath: "navigation.anchor.alertThreshold",
        },
        c,
      ),
    );
  });

  test("valuePath absent fails closed by default; honors whenMissing", () => {
    const c = new PathCache();
    c.set("a", 1);
    assert.ok(
      !evalPredicate({ path: "a", compare: "lt", valuePath: "missing" }, c),
    );
    assert.ok(
      evalPredicate(
        { path: "a", compare: "lt", valuePath: "missing", whenMissing: "true" },
        c,
      ),
    );
  });

  test("absent path fails closed by default (whenMissing false)", () => {
    const c = new PathCache();
    assert.ok(
      !evalPredicate({ path: "missing", compare: "equals", value: "x" }, c),
    );
  });

  test("absent path with whenMissing true evaluates true", () => {
    const c = new PathCache();
    assert.ok(
      evalPredicate(
        { path: "missing", compare: "equals", value: "x", whenMissing: "true" },
        c,
      ),
    );
  });

  test("allOf / anyOf / not combinators", () => {
    const c = new PathCache();
    c.set("a", 1);
    c.set("b", 2);
    assert.ok(
      evalPredicate(
        {
          allOf: [
            { path: "a", compare: "equals", value: 1 },
            { path: "b", compare: "gt", value: 1 },
          ],
        },
        c,
      ),
    );
    assert.ok(
      !evalPredicate(
        {
          allOf: [
            { path: "a", compare: "equals", value: 1 },
            { path: "b", compare: "lt", value: 1 },
          ],
        },
        c,
      ),
    );
    assert.ok(
      evalPredicate(
        {
          anyOf: [
            { path: "a", compare: "lt", value: 0 },
            { path: "b", compare: "gt", value: 1 },
          ],
        },
        c,
      ),
    );
    assert.ok(
      evalPredicate({ not: { path: "a", compare: "gt", value: 1 } }, c),
    );
  });

  test("between with literal timestamps", () => {
    const c = new PathCache();
    const now = 1_000_000;
    assert.ok(
      evalPredicate({ between: { from: now - 10, to: now + 10 } }, c, now),
    );
    assert.ok(
      !evalPredicate({ between: { from: now + 10, to: now + 20 } }, c, now),
    );
  });

  test("between with path references resolves the window from data", () => {
    const c = new PathCache();
    c.set("surplus.from", 900);
    c.set("surplus.to", 1100);
    assert.ok(
      evalPredicate(
        { between: { from: "surplus.from", to: "surplus.to" } },
        c,
        1000,
      ),
    );
    assert.ok(
      !evalPredicate(
        { between: { from: "surplus.from", to: "surplus.to" } },
        c,
        1200,
      ),
    );
  });

  test("between fails closed when a window path is absent", () => {
    const c = new PathCache();
    assert.ok(
      !evalPredicate(
        { between: { from: "missing.from", to: "missing.to" } },
        c,
        1000,
      ),
    );
    assert.ok(
      evalPredicate(
        {
          between: { from: "missing.from", to: "missing.to" },
          whenMissing: "true",
        },
        c,
        1000,
      ),
    );
  });
});
