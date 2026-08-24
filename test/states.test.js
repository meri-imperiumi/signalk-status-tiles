import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isAlarm,
  isOpportunity,
  SEVERITY,
  SEVERITY_ORDER,
  TILE_STATES,
  worst,
} from "../public/lib/states.js";

describe("states", () => {
  test("the five tile states are all known", () => {
    assert.deepStrictEqual([...TILE_STATES].sort(), [
      "amber",
      "green",
      "neutral",
      "opportunity",
      "red",
    ]);
  });

  test("opportunity ranks between green and amber (SPEC §2.1)", () => {
    // It's above green/neutral for noticing, below amber/red for urgency.
    assert.ok(SEVERITY.opportunity > SEVERITY.green);
    assert.ok(SEVERITY.opportunity > SEVERITY.neutral);
    assert.ok(SEVERITY.opportunity < SEVERITY.amber);
    assert.ok(SEVERITY.opportunity < SEVERITY.red);
  });

  test("SEVERITY_ORDER is the problem branch only (no opportunity)", () => {
    assert.deepStrictEqual(SEVERITY_ORDER, ["red", "amber", "green"]);
  });

  test("worst: a problem state always beats opportunity", () => {
    assert.strictEqual(worst("opportunity", "amber"), "amber");
    assert.strictEqual(worst("amber", "opportunity"), "amber");
    assert.strictEqual(worst("opportunity", "red"), "red");
    assert.strictEqual(worst("red", "opportunity"), "red");
  });

  test("worst: opportunity beats green and neutral", () => {
    assert.strictEqual(worst("opportunity", "green"), "opportunity");
    assert.strictEqual(worst("green", "opportunity"), "opportunity");
    assert.strictEqual(worst("opportunity", "neutral"), "opportunity");
    assert.strictEqual(worst("neutral", "opportunity"), "opportunity");
  });

  test("worst: two opportunities yield opportunity", () => {
    assert.strictEqual(worst("opportunity", "opportunity"), "opportunity");
  });

  test("worst: problem-branch ladder unchanged", () => {
    assert.strictEqual(worst("green", "amber"), "amber");
    assert.strictEqual(worst("amber", "red"), "red");
    assert.strictEqual(worst("green", "red"), "red");
    assert.strictEqual(worst("neutral", "green"), "green");
    assert.strictEqual(worst("neutral", "amber"), "amber");
  });

  test("isAlarm is amber/red only — opportunity is never an alarm", () => {
    assert.strictEqual(isAlarm("amber"), true);
    assert.strictEqual(isAlarm("red"), true);
    assert.strictEqual(isAlarm("opportunity"), false);
    assert.strictEqual(isAlarm("green"), false);
    assert.strictEqual(isAlarm("neutral"), false);
  });

  test("isOpportunity identifies the noticing branch", () => {
    assert.strictEqual(isOpportunity("opportunity"), true);
    for (const s of ["green", "amber", "red", "neutral"]) {
      assert.strictEqual(isOpportunity(s), false);
    }
  });
});
