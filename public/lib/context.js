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
 * Whether a predicate node (recursively) says nothing at all: no
 * usable comparison, no between window with at least one endpoint,
 * and no combinator with a non-degenerate child. The admin UI emits
 * EVERY combinator key on EVERY predicate — `allOf: []`,
 * `anyOf: []`, `not: { whenMissing: "false" }`, `between: {}` for
 * the unused ones. Both the empty-array and the junk-object forms
 * would otherwise evaluate vacuously TRUE (`[].every` / `!false`),
 * making a context permanently active. Evaluation ignores such
 * branches; validation flags a node where nothing real is left.
 *
 * @param {object} pred
 * @returns {boolean}
 */
export function isEmptyPredicate(pred) {
  if (!pred || typeof pred !== "object") return true;
  if (pred.path && pred.compare) return false;
  if (pred.between && (pred.between.from != null || pred.between.to != null))
    return false;
  if (Array.isArray(pred.allOf) && pred.allOf.some((p) => !isEmptyPredicate(p)))
    return false;
  if (Array.isArray(pred.anyOf) && pred.anyOf.some((p) => !isEmptyPredicate(p)))
    return false;
  if (pred.not && !isEmptyPredicate(pred.not)) return false;
  return true;
}

/** Combinator children that carry real content (junk skipped). */
function realChildren(list) {
  return (Array.isArray(list) ? list : []).filter((p) => !isEmptyPredicate(p));
}

/**
 * Evaluates a predicate node against a PathCache.
 *
 * The admin UI emits the leaf comparator and every combinator key in
 * ONE node (unused ones as junk). Semantics for that flattened form:
 * the positive parts — leaf comparator, `allOf` children, `not`,
 * `between` — AND together into a base condition, and a non-junk
 * `anyOf` group ORs alternatives on top of it:
 *
 *   result = (leaf ∧ allOf… ∧ ¬not ∧ between) ∨ anyOf…
 *
 * so `equals "moored"` + `anyOf:[equals "anchored"]` reads as
 * "moored OR anchored", while `gt 0` + `allOf:[equals "on"]` reads
 * as "both required". Pure-combinator and pure-leaf nodes are the
 * degenerate cases of the same rule.
 *
 * `whenMissing` (default `"false"`): what a comparison resolves to
 * when a referenced path is absent. `"false"` fails closed (the safe
 * default); `"true"` lets a context be active on an unknown input —
 * a deliberate config choice (SPEC §3.1, §5).
 *
 * Degenerate nodes (see `isEmptyPredicate`) fail closed: junk keys
 * the admin UI emits for unused combinators must not become an
 * always-true context.
 *
 * @param {object} pred - Predicate node
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} [now] - ms epoch; defaults to Date.now()
 * @returns {boolean}
 */
export function evalPredicate(pred, cache, now = Date.now()) {
  if (!pred || typeof pred !== "object") return false;
  if (isEmptyPredicate(pred)) return false;

  const base = evalConjunction(pred, cache, now);
  const anyOf = realChildren(pred.anyOf);
  if (anyOf.length > 0) {
    return base || anyOf.some((p) => evalPredicate(p, cache, now));
  }
  return base;
}

/**
 * The AND side of a flattened node: leaf comparator, `allOf` children,
 * `not`, `between` — every real part must hold. Recursion bottoms out
 * through `evalPredicate`, so `anyOf` groups nested deeper down still
 * mean alternatives inside their own subtree.
 *
 * @param {object} pred
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {boolean}
 */
function evalConjunction(pred, cache, now) {
  let ok = true;
  if (pred.path && pred.compare) {
    ok = ok && evalComparison(pred, cache);
  }
  for (const child of realChildren(pred.allOf)) {
    ok = ok && evalPredicate(child, cache, now);
  }
  if (pred.not && !isEmptyPredicate(pred.not)) {
    ok = ok && !evalPredicate(pred.not, cache, now);
  }
  if (pred.between && (pred.between.from != null || pred.between.to != null)) {
    ok = ok && evalBetween(pred, cache, now);
  }
  return ok;
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
