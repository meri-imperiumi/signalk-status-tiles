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

  test("equals with valuePath compares two live paths for equality (pathA === pathB)", () => {
    const c = new PathCache();
    c.set("a", "charging");
    c.set("b", "charging");
    c.set("d", "discharging");
    assert.ok(
      evalPredicate({ path: "a", compare: "equals", valuePath: "b" }, c),
    );
    assert.ok(
      !evalPredicate({ path: "a", compare: "equals", valuePath: "d" }, c),
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

  test("degenerate combinator nodes fail closed, never vacuously true", () => {
    const c = new PathCache();
    c.set("a", 1);
    // `allOf: []` is `[].every` — vacuously true — but must NOT light
    // up a context chip forever just because the admin UI emitted an
    // empty AND.
    assert.ok(!evalPredicate({ allOf: [] }, c));
    assert.ok(!evalPredicate({ anyOf: [] }, c));
    // `not: {}` negates an empty node — same trap.
    assert.ok(!evalPredicate({ not: {} }, c));
    assert.ok(!evalPredicate({ not: { allOf: [] } }, c));
    assert.ok(!evalPredicate({ allOf: [{}] }, c));
    // whenMissing cannot resurrect a degenerate node — it governs
    // absent *paths*, not malformed predicates.
    assert.ok(!evalPredicate({ allOf: [], whenMissing: "true" }, c));
    // A real comparator next to an empty combinator still evaluates.
    assert.ok(
      evalPredicate({ path: "a", compare: "equals", value: 1, allOf: [] }, c),
    );
    // Non-degenerate `not` keeps working.
    assert.ok(
      evalPredicate({ not: { path: "a", compare: "gt", value: 5 } }, c),
    );
  });

  // The admin UI emits the leaf comparator AND every combinator key in
  // one node (unused ones as junk: `not: { whenMissing: "false" }`,
  // empty arrays, empty `between`). These tests use the exact shapes a
  // real saved config carries.
  test("flattened form: leaf + anyOf are OR alternatives", () => {
    const c = new PathCache();
    const atRest = {
      path: "navigation.state",
      compare: "equals",
      value: "moored",
      whenMissing: "false",
      allOf: [],
      anyOf: [
        {
          path: "navigation.state",
          compare: "equals",
          value: "anchored",
          whenMissing: "false",
        },
      ],
      not: { whenMissing: "false" },
    };
    c.set("navigation.state", "moored");
    assert.ok(evalPredicate(atRest, c)); // via the leaf
    c.set("navigation.state", "anchored");
    assert.ok(evalPredicate(atRest, c)); // via the anyOf alternative
    c.set("navigation.state", "sailing");
    assert.ok(!evalPredicate(atRest, c));
  });

  test("flattened form: leaf + allOf are AND requirements", () => {
    const c = new PathCache();
    const acCompound = {
      path: "electrical.venus.acPower",
      compare: "gt",
      value: "0",
      whenMissing: "false",
      allOf: [
        {
          path: "electrical.inverters.294.mode",
          compare: "equals",
          value: "on",
          whenMissing: "false",
        },
      ],
      anyOf: [],
      not: { whenMissing: "false", between: {} },
      between: {},
    };
    c.set("electrical.venus.acPower", 100);
    c.set("electrical.inverters.294.mode", "on");
    assert.ok(evalPredicate(acCompound, c));
    c.set("electrical.inverters.294.mode", "off");
    assert.ok(!evalPredicate(acCompound, c));
    c.set("electrical.inverters.294.mode", "on");
    c.set("electrical.venus.acPower", 0);
    assert.ok(!evalPredicate(acCompound, c));
  });

  test("flattened form: pure leaf with junk combinators (every saved context)", () => {
    const c = new PathCache();
    const ctx = {
      path: "navigation.state",
      compare: "equals",
      value: "moored",
      whenMissing: "false",
      allOf: [],
      anyOf: [],
      not: { whenMissing: "false" },
    };
    c.set("navigation.state", "moored");
    assert.ok(evalPredicate(ctx, c));
    c.set("navigation.state", "sailing");
    assert.ok(!evalPredicate(ctx, c));
    // ...and the junk `not` must not turn a non-matching node into
    // !false = true.
    assert.ok(!evalPredicate({ ...ctx, value: "anchored" }, c));
  });
});
