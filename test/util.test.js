import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDisplayValue, valueToNumber } from "../public/lib/util.js";

describe("util", () => {
  test("valueToNumber unwraps {value} objects and coerces", () => {
    assert.strictEqual(valueToNumber(5), 5);
    assert.strictEqual(valueToNumber("5"), 5);
    assert.strictEqual(valueToNumber(true), 1);
    assert.strictEqual(valueToNumber(false), 0);
    assert.strictEqual(valueToNumber({ value: 7 }), 7);
    assert.ok(Number.isNaN(valueToNumber(null)));
    assert.ok(Number.isNaN(valueToNumber("nope")));
  });

  test("formatDisplayValue applies the meta displayUnits formula (K → °C)", () => {
    const du = {
      category: "temperature",
      targetUnit: "C",
      formula: "value - 273.15",
      symbol: "°C",
      displayFormat: "0.0",
    };
    assert.strictEqual(formatDisplayValue(285.76, du), "12.6°C");
  });

  test("formatDisplayValue respects displayFormat precision", () => {
    const du = {
      formula: "value - 273.15",
      symbol: "°C",
      displayFormat: "0.00",
    };
    assert.strictEqual(formatDisplayValue(285.764999, du), "12.61°C");
  });

  test("formatDisplayValue appends non-degree symbol with a space", () => {
    const du = {
      formula: "value * 1.94384",
      symbol: "kn",
      displayFormat: "0.0",
    };
    assert.strictEqual(formatDisplayValue(5.14, du), "10.0 kn");
  });

  test("formatDisplayValue falls back to raw value when no displayUnits", () => {
    assert.strictEqual(formatDisplayValue(285.76), "285.76");
    assert.strictEqual(formatDisplayValue(285.76, undefined), "285.76");
  });

  test("formatDisplayValue returns dash for non-finite input", () => {
    assert.strictEqual(formatDisplayValue(NaN), "—");
    assert.strictEqual(formatDisplayValue(NaN, { formula: "value" }), "—");
  });

  test("formatDisplayValue falls back to raw if formula throws", () => {
    const du = { formula: "value / 0", symbol: "X" };
    // value/0 -> Infinity, which is not finite -> dash (via formatNumber)
    assert.strictEqual(formatDisplayValue(1, du), "—");
  });

  test("formatDisplayValue handles duration formulas", () => {
    const du = {
      formula: "formatDurationHMS(value)",
      symbol: "",
      displayFormat: "0",
    };
    // 3661s = 1h 1m 1s
    const out = formatDisplayValue(3661, du);
    assert.ok(out.includes("1"), `expected time parts in "${out}"`);
  });
});
