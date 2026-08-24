/**
 * Small value-coercion helpers shared across check types and the context
 * evaluator. Signal K values arrive as numbers, strings, booleans, or
 * `{value, ...}`-wrapped objects.
 *
 * @file util.js */

/**
 * Coerces a Signal K value to a finite number, or returns NaN. Unwraps
 * `{value}` objects. Booleans map to 1/0 so boolean paths can be used in
 * numeric comparisons.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function valueToNumber(v) {
  if (v == null) return NaN;
  if (typeof v === "object" && "value" in /** @type {object} */ (v)) {
    return valueToNumber(/** @type {any} */ (v).value);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return n;
}

/**
 * Unwraps a `{value}`-wrapped Signal K object, or returns the input as-is.
 * @param {unknown} v
 * @returns {unknown}
 */
export function unwrap(v) {
  if (v != null && typeof v === "object" && "value" in v) {
    return /** @type {any} */ (v).value;
  }
  return v;
}

/**
 * Formatting helpers exposed to display-unit formulas (duration category).
 * The server's unit-definitions ship formulas like `formatDurationDHMS(value)`;
 * we provide minimal implementations so those categories render.
 */
const DURATION_FMT = {
  formatDurationHMS(value) {
    return formatDuration(value, false, false);
  },
  formatDurationHMSMillis(value) {
    return formatDuration(value, false, false, true);
  },
  formatDurationMS(value) {
    return formatDuration(value, true, false);
  },
  formatDurationMSMillis(value) {
    return formatDuration(value, true, false, true);
  },
  formatDurationCompact(value) {
    return formatDuration(value, true, true);
  },
  formatDurationVerbose(value) {
    return formatDuration(value, false, true);
  },
  formatDurationDHMS(value) {
    return formatDuration(value, false, true);
  },
};

/**
 * Formats a seconds count as a duration string. Used by the duration
 * display-unit formatters.
 *
 * @param {number} seconds
 * @param {boolean} [compact]
 * @param {boolean} [verbose]
 * @param {boolean} [withMillis]
 * @returns {string}
 */
function formatDuration(seconds, compact, verbose, withMillis) {
  if (!Number.isFinite(seconds)) return "—";
  const neg = seconds < 0;
  let s = Math.abs(Math.round(seconds * 1000) / 1000);
  const ms = withMillis ? Math.round((s - Math.floor(s)) * 1000) : 0;
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || parts.length) parts.push(`${h}h`);
  if (m || parts.length) parts.push(`${m}m`);
  if (verbose) {
    parts.push(`${s}s`);
    if (withMillis && ms) parts.push(`${ms}ms`);
  } else {
    parts.push(`${String(s).padStart(2, "0")}s`);
  }
  return (neg ? "-" : "") + parts.join(compact ? " " : ":");
}

/**
 * Magnitude-based precision for a display number (SPEC §3.4 readability):
 * keep the digit count small and stable so a glance can parse it.
 *
 *   |v| < 10      -> 2 decimals   (0.12, 9.99)
 *   10 <= |v| < 100 -> 1 decimal   (12.3, 99.5)
 *   |v| >= 100     -> 0 decimals   (123, 1234)
 *
 * Applied to the absolute magnitude; the sign is preserved. This is the
 * *fallback* precision — an explicit Signal K `displayFormat` (authored
 * per path) still wins. Also applied to unitless numbers (no displayUnits
 * metadata at all), so a raw spread or count reads cleanly too.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatSmartNumber(n) {
  if (!Number.isFinite(n)) return "—";
  const mag = Math.abs(n);
  let decimals;
  if (mag < 10) decimals = 2;
  else if (mag < 100) decimals = 1;
  else decimals = 0;
  // Negative zero would render as "-0" without the +0 normalization; also
  // guards -0.00 from toFixed(2).
  return (n === 0 ? 0 : n).toFixed(decimals);
}

/**
 * SI prefixes we'll scale to when a value crosses 1000 in a unit that
 * has a standard prefixed form. Keys are the base (un-prefixed) symbol
 * as published in `displayUnits.symbol`; values map each prefix letter
 * to its multiplier. Only base symbols present here are eligible for
 * scaling — degree/percent/ratio/unitless and unknown symbols are left
 * alone (a temperature never becomes "k°C").
 *
 * @type {Record<string, Array<[string, number]>>}
 */
const SI_PREFIXES = {
  W: [
    ["k", 1e3],
    ["M", 1e6],
    ["G", 1e9],
  ],
  Wh: [
    ["k", 1e3],
    ["M", 1e6],
    ["G", 1e9],
  ],
  A: [
    ["k", 1e3],
    ["M", 1e6],
  ],
  Ah: [
    ["k", 1e3],
    ["M", 1e6],
  ],
  V: [["k", 1e3]],
  Hz: [
    ["k", 1e3],
    ["M", 1e6],
    ["G", 1e9],
  ],
  J: [
    ["k", 1e3],
    ["M", 1e6],
    ["G", 1e9],
  ],
  Pa: [
    ["k", 1e3],
    ["M", 1e6],
  ],
  // SI base units that use prefixes: metre, gram (note: base SI mass is
  // kg, but Signal K publishes mass in kg already; g is included for the
  // rare g-published path so 1500 g -> 1.5 kg).
  g: [
    ["k", 1e3],
    ["M", 1e6],
  ],
  m: [["k", 1e3]],
};

/**
 * If `value` (in base unit `symbol`) is large enough that a standard SI
 * prefix would read better, returns the scaled value and prefixed symbol.
 * Only scales when |value| >= 1000 and `symbol` has a known prefix table.
 * Picks the largest prefix that keeps |scaled| >= 1 (so 1500 W -> 1.5 kW,
 * not 1500 mW). Returns `null` when no scaling applies, so the caller
 * keeps the original value/symbol untouched.
 *
 * @param {number} value
 * @param {string} [symbol]
 * @returns {{value: number, symbol: string} | null}
 */
export function siScale(value, symbol) {
  if (!Number.isFinite(value)) return null;
  if (typeof symbol !== "string" || symbol.length === 0) return null;
  const table = SI_PREFIXES[symbol];
  if (!table) return null;
  if (Math.abs(value) < 1000) return null;
  // Walk smallest->largest prefix; keep the last one that keeps |scaled|>=1.
  let best = null;
  for (const [prefix, mult] of table) {
    const scaled = value / mult;
    if (Math.abs(scaled) >= 1)
      best = { value: scaled, symbol: `${prefix}${symbol}` };
  }
  return best; // may stay null if even the smallest prefix underflows 1
}

/**
 * Resolves a Signal K `displayUnits` meta object against a raw value and
 * returns a formatted display string. The server publishes linear/
 * arithmetic formulas (e.g. `value - 273.15` for K→°C) and duration
 * formatters (`formatDurationHMS(value)`). Formulas come from server
 * metadata (same origin, trusted); we evaluate them in a restricted scope
 * exposing only `value` and the duration formatters. On any failure we
 * fall back to the raw value (+ symbol when available), never throw.
 *
 * Precision (SPEC §3.4 readability): an explicit `displayFormat` wins
 * (it's an authored per-path choice). Otherwise the magnitude-based smart
 * precision (`formatSmartNumber`) is used, applied to the post-formula
 * value. SI prefix switching (`siScale`) applies to the post-formula value
 * + symbol for units with a known prefix table (W→kW, Wh→kWh, …); degree /
 * percent / ratio / unitless symbols are never prefixed. The smart
 * precision rule then re-applies to the scaled value, so 1234 W ->
 * 1.23 kW (single digit -> 2 decimals), not 1.234 kW.
 *
 * @param {number} value - raw (SI-unit) value
 * @param {object} [displayUnits] - the path's `meta.displayUnits`
 * @returns {string}
 */
export function formatDisplayValue(value, displayUnits) {
  if (!Number.isFinite(value)) return "—";
  if (!displayUnits?.formula) {
    // No formula: the raw value is already in the display unit. Apply
    // SI scaling to (value, symbol) if the symbol is prefixable, else
    // format (value) with smart fallback precision.
    const symbol = displayUnits?.symbol;
    if (symbol) {
      const scaled = siScale(value, symbol);
      if (scaled)
        return withSymbol(
          formatNumber(scaled.value, displayUnits?.displayFormat),
          scaled.symbol,
        );
      return withSymbol(
        formatNumber(value, displayUnits?.displayFormat),
        symbol,
      );
    }
    return formatNumber(value, displayUnits?.displayFormat);
  }
  try {
    // eslint-disable-next-line no-new-func -- trusted server metadata
    const fn = new Function(
      "value",
      ...Object.keys(DURATION_FMT),
      `return (${displayUnits.formula});`,
    );
    const out = fn(value, ...Object.values(DURATION_FMT));
    if (typeof out === "number") {
      return formatWithUnits(out, displayUnits);
    }
    return String(out);
  } catch {
    return formatWithUnits(value, displayUnits);
  }
}

/**
 * Formats a post-formula numeric `value` against `displayUnits`: applies
 * SI prefix switching to (value, symbol), then precision (explicit
 * `displayFormat` wins, else smart magnitude precision), then the symbol.
 * Centralizes the shared tail of the formula / no-formula paths.
 *
 * @param {number} value
 * @param {object} displayUnits
 * @returns {string}
 */
function formatWithUnits(value, displayUnits) {
  const symbol = displayUnits?.symbol;
  if (symbol) {
    const scaled = siScale(value, symbol);
    if (scaled)
      return withSymbol(
        formatNumber(scaled.value, displayUnits.displayFormat),
        scaled.symbol,
      );
    return withSymbol(formatNumber(value, displayUnits.displayFormat), symbol);
  }
  return formatNumber(value, displayUnits?.displayFormat);
}

/**
 * Appends the display-unit symbol with a space, unless it's a degree or
 * percent symbol that conventionally attaches without a space.
 *
 * @param {string} formatted
 * @param {string} [symbol]
 * @returns {string}
 */
function withSymbol(formatted, symbol) {
  if (!symbol || formatted === "—") return formatted;
  if (symbol.startsWith("°") || symbol === "%") return `${formatted}${symbol}`;
  return `${formatted} ${symbol}`;
}

/**
 * Formats a number with optional Signal K `displayFormat` precision
 * (e.g. `"0.0"` → one decimal). An explicit `displayFormat` wins (it's
 * an authored per-path choice); with none, falls back to the
 * magnitude-based smart precision (`formatSmartNumber`) so unitless
 * and un-authored numbers still read cleanly at a glance.
 *
 * @param {number} n
 * @param {string} [displayFormat]
 * @returns {string}
 */
function formatNumber(n, displayFormat) {
  if (!Number.isFinite(n)) return "—";
  if (typeof displayFormat === "string" && displayFormat) {
    // Signal K displayFormat is a numeral.js-style pattern; we handle the
    // common `0.0…0` decimal-places form. Count zeros after the decimal.
    const dot = displayFormat.indexOf(".");
    if (dot >= 0) {
      const decimals = displayFormat.length - dot - 1;
      return (n === 0 ? 0 : n).toFixed(decimals);
    }
    return String(Math.round(n));
  }
  return formatSmartNumber(n);
}
