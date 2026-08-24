/**
 * Context predicate evaluation (SPEC §3.1). A context is a named,
 * reusable boolean predicate evaluated against the current Signal K
 * state. Predicate forms:
 *
 *   - path comparison: equals / gt / gte / lt / lte against a path's value
 *   - allOf / anyOf / not combinators (depth-capped, SPEC §9)
 *   - between: now falls between two timestamps, each a literal or path
 *   - whenMissing: policy for a referenced path being unknown
 *     (default: predicate evaluates false — contexts fail closed)
 *
 * @file context.js */

import { valueToNumber } from "./util.js";

/** @typedef {"equals"|"gt"|"gte"|"lt"|"lte"} Comparator */

/**
 * Evaluates a predicate node against a PathCache.
 *
 * `whenMissing` (default `"false"`): what the predicate resolves to when
 * a referenced path is absent. `"false"` fails closed (the safe default);
 * `"true"` lets a context be active on an unknown input — a deliberate
 * config choice (SPEC §3.1, §5).
 *
 * @param {object} pred - Predicate node
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} [now] - ms epoch; defaults to Date.now()
 * @returns {boolean}
 */
export function evalPredicate(pred, cache, now = Date.now()) {
  if (!pred || typeof pred !== "object") return false;

  // Combinators first (depth cap enforced at validation time).
  if (Array.isArray(pred.allOf)) {
    return pred.allOf.every((p) => evalPredicate(p, cache, now));
  }
  if (Array.isArray(pred.anyOf)) {
    return pred.anyOf.some((p) => evalPredicate(p, cache, now));
  }
  if (pred.not) {
    return !evalPredicate(pred.not, cache, now);
  }
  if (pred.between) {
    return evalBetween(pred, cache, now);
  }
  if (pred.path && pred.compare) {
    return evalComparison(pred, cache);
  }
  return false;
}

/**
 * @param {object} pred - `{ path, compare, value?, valuePath?, whenMissing }`
 * @param {import("./staleness.js").PathCache} cache
 * @returns {boolean}
 */
function evalComparison(pred, cache) {
  const present = cache.has(pred.path);
  if (!present) {
    return pred.whenMissing === "true";
  }
  const raw = cache.value(pred.path);
  // The right-hand side: either a literal `value` or a second path
  // `valuePath` (compare two live paths, e.g. currentRadius <
  // alertThreshold). When valuePath is set but absent, the comparison
  // can't be made — honor whenMissing (default false, fail closed).
  let want;
  if (pred.valuePath) {
    if (!cache.has(pred.valuePath)) return pred.whenMissing === "true";
    want = cache.value(pred.valuePath);
  } else {
    want = pred.value;
  }
  switch (pred.compare) {
    case "equals":
      return looseEqual(raw, want);
    case "gt":
      return valueToNumber(raw) > valueToNumber(want);
    case "gte":
      return valueToNumber(raw) >= valueToNumber(want);
    case "lt":
      return valueToNumber(raw) < valueToNumber(want);
    case "lte":
      return valueToNumber(raw) <= valueToNumber(want);
    default:
      return false;
  }
}

/**
 * `between`: now falls inside [from, to], each a literal ms timestamp or a
 * path reference (SPEC §3.1). Motivated by upstream forecasting plugins
 * that publish a validity window as data.
 *
 * @param {object} pred - `{ between: { from, to }, whenMissing }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {boolean}
 */
function evalBetween(pred, cache, now) {
  const from = resolveTimestamp(pred.between.from, cache);
  const to = resolveTimestamp(pred.between.to, cache);
  if (from == null || to == null) return pred.whenMissing === "true";
  return now >= from && now <= to;
}

/**
 * @param {string|number} v - literal ms, or path string
 * @param {import("./staleness.js").PathCache} cache
 * @returns {number|null}
 */
function resolveTimestamp(v, cache) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const raw = cache.value(v);
    if (raw == null) return null;
    const n = valueToNumber(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Loose equality: coerces both sides to strings for non-numeric
 * comparisons (Signal K booleans arrive as JSON true/false; enums as
 * strings). Numeric paths compare numerically.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function looseEqual(a, b) {
  if (a == null || b == null) return a === b;
  const na = valueToNumber(a);
  const nb = valueToNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}
