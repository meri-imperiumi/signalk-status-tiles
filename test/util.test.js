import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  displayUnitsForPath,
  formatDisplayValue,
  formatSmartNumber,
  siScale,
  valueToNumber,
} from "../public/lib/util.js";

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

  test("formatDisplayValue falls back to smart precision when no displayUnits", () => {
    // No metadata: unitless smart magnitude precision applies (SPEC §3.4).
    // |v| >= 100 -> 0 decimals; 10..100 -> 1 decimal; <10 -> 2 decimals.
    assert.strictEqual(formatDisplayValue(285.76), "286");
    assert.strictEqual(formatDisplayValue(285.76, undefined), "286");
    assert.strictEqual(formatDisplayValue(42.5), "42.5");
    assert.strictEqual(formatDisplayValue(3.14159), "3.14");
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

  test("formatSmartNumber: magnitude-based precision (SPEC §3.4)", () => {
    // single digit -> 2 decimals
    assert.strictEqual(formatSmartNumber(0.123), "0.12");
    assert.strictEqual(formatSmartNumber(9.999), "10.00"); // rounds up across band
    // double digit -> 1 decimal
    assert.strictEqual(formatSmartNumber(10.123), "10.1");
    assert.strictEqual(formatSmartNumber(99.5), "99.5");
    // three+ digits -> 0 decimals
    assert.strictEqual(formatSmartNumber(123.456), "123");
    assert.strictEqual(formatSmartNumber(1234.5), "1235");
    // sign preserved; -0 avoided
    assert.strictEqual(formatSmartNumber(-3.14159), "-3.14");
    assert.strictEqual(formatSmartNumber(-0), "0.00");
    assert.strictEqual(formatSmartNumber(NaN), "—");
  });

  test("siScale: no scaling below 1000, or for non-prefixable symbols", () => {
    assert.strictEqual(siScale(999, "W"), null);
    assert.strictEqual(siScale(500, "Wh"), null);
    // degree / percent / unknown symbols are never scaled
    assert.strictEqual(siScale(5000, "°C"), null);
    assert.strictEqual(siScale(5000, "%"), null);
    assert.strictEqual(siScale(5000, "kn"), null);
    assert.strictEqual(siScale(5000, undefined), null);
    assert.strictEqual(siScale(5000, ""), null);
    assert.strictEqual(siScale(NaN, "W"), null);
  });

  test("siScale: scales to the largest prefix keeping |scaled| >= 1", () => {
    assert.deepStrictEqual(siScale(1500, "W"), { value: 1.5, symbol: "kW" });
    assert.deepStrictEqual(siScale(1234, "Wh"), {
      value: 1.234,
      symbol: "kWh",
    });
    assert.deepStrictEqual(siScale(1.5e6, "W"), {
      value: 1.5,
      symbol: "MW",
    });
    assert.deepStrictEqual(siScale(2.5e9, "Wh"), {
      value: 2.5,
      symbol: "GWh",
    });
  });

  test("formatDisplayValue applies SI prefix + smart precision to a symbolled value", () => {
    // 1234.123 W -> 1.234 kW -> smart (single digit) -> 1.23 kW
    assert.strictEqual(
      formatDisplayValue(1234.123, { formula: "value", symbol: "W" }),
      "1.23 kW",
    );
    // No formula, just symbol: scaling still applies to the raw value.
    assert.strictEqual(
      formatDisplayValue(1234.123, { symbol: "W" }),
      "1.23 kW",
    );
    // Below 1000, no scaling; smart precision on the raw magnitude.
    assert.strictEqual(formatDisplayValue(42.5, { symbol: "W" }), "42.5 W");
  });

  test("formatDisplayValue: explicit displayFormat wins over smart precision", () => {
    // displayFormat "0.00" -> 2 decimals even though |12.61| is double digit
    // (smart rule would give 1 decimal).
    const du = {
      formula: "value - 273.15",
      symbol: "°C",
      displayFormat: "0.00",
    };
    assert.strictEqual(formatDisplayValue(285.764999, du), "12.61°C");
    // Explicit displayFormat governs precision only; SI scaling still
    // applies (it's unit choice, a separate concern). 1234.9 W with
    // displayFormat "0" -> scale to 1.2349 kW -> integer -> 1 kW.
    const du2 = { formula: "value", symbol: "W", displayFormat: "0" };
    assert.strictEqual(formatDisplayValue(1234.9, du2), "1 kW");
  });

  test("formatDisplayValue: degree/percent symbols never SI-prefixed", () => {
    // A large temperature in °C (formula) stays unscaled.
    assert.strictEqual(
      formatDisplayValue(1500, { formula: "value", symbol: "°C" }),
      "1500°C",
    );
    // Percent stays unscaled and attaches without a space.
    assert.strictEqual(formatDisplayValue(1234, { symbol: "%" }), "1234%");
  });

  test("displayUnitsForPath: frequency paths keep Hz, ignoring a Hz→RPM formula", () => {
    // A server may publish a Hz→RPM displayUnits formula for rotation-
    // rate paths published in Hz. That formula is wrong for a genuine
    // frequency path, so any path containing "frequency" must drop the
    // formula and show the raw Hz value with the "Hz" symbol.
    const rpmFormula = { formula: "value * 60", symbol: "RPM" };
    assert.deepEqual(
      displayUnitsForPath(
        "electrical.inverters.multiplus.acin.frequency",
        rpmFormula,
      ),
      { symbol: "Hz" },
      "frequency path drops the RPM formula",
    );
    // A non-frequency path keeps the server's displayUnits verbatim.
    assert.strictEqual(
      displayUnitsForPath("propulsion.engine.revolutions", rpmFormula),
      rpmFormula,
    );
    // Case-insensitive, matches as a substring anywhere in the path.
    assert.deepEqual(
      displayUnitsForPath("some.Frequency.value", {
        formula: "value*60",
        symbol: "RPM",
      }),
      { symbol: "Hz" },
    );
    // No displayUnits at all on a frequency path: still resolves to Hz.
    assert.deepEqual(displayUnitsForPath("x.frequency", undefined), {
      symbol: "Hz",
    });
    // End-to-end: a 50 Hz value on a frequency path formats as "50.0 Hz",
    // NOT "3000 RPM".
    assert.strictEqual(
      formatDisplayValue(
        50,
        displayUnitsForPath(
          "electrical.inverters.multiplus.acin.frequency",
          rpmFormula,
        ),
      ),
      "50.0 Hz",
    );
    // The same value on a rotation path applies the formula -> RPM.
    assert.strictEqual(
      formatDisplayValue(50, displayUnitsForPath("engine.rpm", rpmFormula)),
      "3000 RPM",
    );
  });
});
