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
 * Resolves a Signal K `displayUnits` meta object against a raw value and
 * returns a formatted display string. The server publishes linear/
 * arithmetic formulas (e.g. `value - 273.15` for K→°C) and duration
 * formatters (`formatDurationHMS(value)`). Formulas come from server
 * metadata (same origin, trusted); we evaluate them in a restricted scope
 * exposing only `value` and the duration formatters. On any failure we
 * fall back to the raw value (+ symbol when available), never throw.
 *
 * @param {number} value - raw (SI-unit) value
 * @param {object} [displayUnits] - the path's `meta.displayUnits`
 * @returns {string}
 */
export function formatDisplayValue(value, displayUnits) {
  if (!Number.isFinite(value)) return "—";
  if (!displayUnits?.formula) {
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
      return withSymbol(
        formatNumber(out, displayUnits.displayFormat),
        displayUnits.symbol,
      );
    }
    return String(out);
  } catch {
    return withSymbol(
      formatNumber(value, displayUnits.displayFormat),
      displayUnits.symbol,
    );
  }
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
 * (e.g. `"0.0"` → one decimal). Falls back to a sensible default.
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
      return n.toFixed(decimals);
    }
    return String(Math.round(n));
  }
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}
