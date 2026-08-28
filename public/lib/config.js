/**
 * Config validation (SPEC §9). Returns errors (hard problems that will
 * break evaluation) and warnings (soft issues worth surfacing). The server
 * starts even with errors so the user can fix the form rather than being
 * locked out.
 *
 * @file config.js */

import { CHECK_TYPES } from "./checks.js";
import { isEmptyPredicate } from "./context.js";
import { collectPredicatePaths, unwrapConfig } from "./paths.js";
import { TILE_STATES } from "./states.js";

/** Max recursion depth for context predicate combinators (SPEC §9). */
const MAX_PREDICATE_DEPTH = 2;

const CONTEXT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TILE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * @param {object} pred
 * @param {number} depth - current nesting depth (1 at a combinator's children)
 * @returns {number} max depth seen, or -1 on a leaf
 */
function predicateDepth(pred, depth) {
  if (!pred || typeof pred !== "object") return depth;
  let d = depth;
  if (pred.allOf)
    d = Math.max(d, ...pred.allOf.map((p) => predicateDepth(p, depth + 1)));
  if (pred.anyOf)
    d = Math.max(d, ...pred.anyOf.map((p) => predicateDepth(p, depth + 1)));
  if (pred.not) d = Math.max(d, predicateDepth(pred.not, depth + 1));
  return d;
}

/**
 * @param {object} config
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object") {
    return { errors: ["Config is empty"], warnings };
  }
  const config_ = unwrapConfig(config);

  // --- Contexts ---------------------------------------------------------
  const contextIds = new Set();
  for (const ctx of config_.contexts || []) {
    if (!ctx.id) {
      errors.push("Context missing id");
    } else if (!CONTEXT_ID_RE.test(ctx.id)) {
      errors.push(`Context id "${ctx.id}" is invalid (letters/digits/-/_)`);
    } else if (contextIds.has(ctx.id)) {
      errors.push(`Duplicate context id "${ctx.id}"`);
    } else {
      contextIds.add(ctx.id);
    }
    if (!ctx.predicate) {
      errors.push(`Context "${ctx.id}" has no predicate`);
      continue;
    }
    const depth = predicateDepth(ctx.predicate, 0);
    if (depth > MAX_PREDICATE_DEPTH) {
      warnings.push(
        `Context "${ctx.id}" nests predicates to depth ${depth} (max ${MAX_PREDICATE_DEPTH}); split into named contexts`,
      );
    }
    // Degenerate predicates (empty `allOf`/`not` — the admin UI emits
    // these when a combinator is picked but never filled in) evaluate
    // vacuously true, which would make the context permanently active.
    if (isEmptyPredicate(ctx.predicate)) {
      errors.push(`Context "${ctx.id}" predicate is empty`);
    }
  }

  // --- Tiles ------------------------------------------------------------
  const tileIds = new Set();
  for (const tile of config_.tiles || []) {
    if (!tile.id) {
      errors.push("Tile missing id");
    } else if (!TILE_ID_RE.test(tile.id)) {
      errors.push(`Tile id "${tile.id}" is invalid`);
    } else if (tileIds.has(tile.id)) {
      errors.push(`Duplicate tile id "${tile.id}"`);
    } else {
      tileIds.add(tile.id);
    }
    if (tile.context && !contextIds.has(tile.context)) {
      errors.push(
        `Tile "${tile.id}" references unknown context "${tile.context}"`,
      );
    }
    if (tile.active) {
      // Same predicate rules as a context (SPEC §9 depth cap; a
      // degenerate predicate would be vacuously true, making the tile
      // permanently "active" — no downgrade ever).
      const depth = predicateDepth(tile.active, 0);
      if (depth > MAX_PREDICATE_DEPTH) {
        errors.push(
          `Tile "${tile.id}" active predicate nests to depth ${depth} (max ${MAX_PREDICATE_DEPTH}); split into a named context`,
        );
      }
      // An empty predicate is a no-op the engine deliberately ignores
      // (tile.js: the admin UI's form emits blank scaffolds), so it is a
      // warning ("this field does nothing"), never a start-blocking
      // error — the form's own output must validate.
      if (isEmptyPredicate(tile.active)) {
        warnings.push(
          `Tile "${tile.id}" active predicate is empty — ignored (no green→neutral downgrade)`,
        );
      }
    }
    if (!tile.checks || tile.checks.length === 0) {
      errors.push(`Tile "${tile.id}" has no checks`);
    }
    let displayCount = 0;
    for (const check of tile.checks || []) {
      if (!CHECK_TYPES.has(check?.type)) {
        errors.push(
          `Tile "${tile.id}" has unknown check type "${check?.type}"`,
        );
        continue;
      }
      if (check.type === "compound") {
        if (!check.predicate) {
          errors.push(`Tile "${tile.id}" compound check has no predicate`);
        } else if (isEmptyPredicate(check.predicate)) {
          errors.push(`Tile "${tile.id}" compound check predicate is empty`);
        } else {
          const depth = predicateDepth(check.predicate, 0);
          if (depth > MAX_PREDICATE_DEPTH) {
            warnings.push(
              `Tile "${tile.id}" compound check nests predicates to depth ${depth} (max ${MAX_PREDICATE_DEPTH}); split into named contexts`,
            );
          }
        }
      }
      if (check.type === "stateMatch") {
        const rowErrors = validateStateMatchMap(check.map || []);
        for (const e of rowErrors) errors.push(`Tile "${tile.id}" ${e}`);
      }
      if (check.display) displayCount++;
    }
    if (displayCount > 1) {
      errors.push(
        `Tile "${tile.id}" designates ${displayCount} display checks; at most one (SPEC §3.4)`,
      );
    }
    // SPEC §2.1: a tile's checks must not straddle the problem and
    // opportunity branches simultaneously. A single asymmetric check on
    // one metric (e.g. a banded check whose low side is a deficit and
    // high side is a surplus) is the intended single-tile case and is
    // NOT a straddle. The straddle is multiple checks producing
    // different branches at once from unrelated paths — a real
    // ambiguity that should be split into two tiles. We surface a
    // warning (not a hard error, since worst() still resolves to a
    // defined single state) when one check explicitly targets
    // opportunity and another explicitly targets a problem state.
    if (tileStraddlesBranches(tile.checks || [])) {
      warnings.push(
        `Tile "${tile.id}" mixes problem-state and opportunity checks on one tile; split into two tiles (SPEC §2.1)`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Whether a tile's checks straddle the problem and opportunity branches
 * (SPEC §2.1). True only when there are at least two checks, one
 * explicitly targeting `opportunity` and another explicitly targeting a
 * problem state (`amber`/`red`). A single check that mixes both within
 * itself (e.g. a banded check with low→red and high→opportunity) is the
 * intended single-asymmetric-metric case and is NOT a straddle.
 *
 * Inspects the config-supplied target-state fields per check type.
 * `zone` is excluded from opportunity entirely (SPEC §3.3), so it can
 * never contribute the opportunity side.
 *
 * @param {object[]} checks
 * @returns {boolean}
 */
function tileStraddlesBranches(checks) {
  if (!Array.isArray(checks) || checks.length < 2) return false;
  let hasOpportunity = false;
  let hasProblem = false;
  for (const c of checks) {
    const opp = checkTargetsOpportunity(c);
    const prob = checkTargetsProblem(c);
    if (opp) hasOpportunity = true;
    if (prob) hasProblem = true;
  }
  return hasOpportunity && hasProblem;
}

/**
 * Whether a single check's configured target states include `opportunity`.
 * @param {object} check
 * @returns {boolean}
 */
function checkTargetsOpportunity(check) {
  if (!check || typeof check !== "object") return false;
  switch (check.type) {
    case "banded":
      return (
        check.low?.warnState === "opportunity" ||
        check.low?.critState === "opportunity" ||
        check.high?.warnState === "opportunity" ||
        check.high?.critState === "opportunity"
      );
    case "stateMatch":
      return (check.map || []).some((e) => e?.state === "opportunity");
    case "notification":
      return Object.values(check.severityMap || {}).some(
        (s) => s === "opportunity",
      );
    case "agreement":
      return check.mismatchState === "opportunity";
    case "compound":
      return check.state === "opportunity";
    // zone: cannot produce opportunity (SPEC §3.3)
    default:
      return false;
  }
}

/**
 * Whether a single check's configured target states include a problem
 * severity (`amber`/`red`). Used for the §2.1 straddle check.
 * @param {object} check
 * @returns {boolean}
 */
function checkTargetsProblem(check) {
  if (!check || typeof check !== "object") return false;
  const isProblem = (s) => s === "amber" || s === "red";
  switch (check.type) {
    case "banded":
      return (
        isProblem(check.low?.warnState) ||
        isProblem(check.low?.critState) ||
        isProblem(check.high?.warnState) ||
        isProblem(check.high?.critState)
      );
    case "stateMatch":
      return (check.map || []).some((e) => isProblem(e?.state));
    case "zone":
      return Object.values(check.severityMap || {}).some(isProblem);
    case "notification":
      return Object.values(check.severityMap || {}).some(isProblem);
    case "agreement":
      return isProblem(check.mismatchState);
    case "compound":
      return isProblem(check.state);
    case "alarmGroup":
      return true; // alarmGroup is inherently problem-oriented (red/amber)
    case "boolean":
      // boolean maps truthiness to red (badWhen default true) or green;
      // it targets a problem state unless explicitly inverted to
      // badWhen:false (which makes true→green, false→red — still a
      // problem check, just flipped polarity). Either way it's a
      // problem-branch check.
      return true;
    case "differential":
      // threshold checks default to amber/red on a breach.
      return true;
    default:
      return false;
  }
}

/**
 * Validates a stateMatch check's map rows: every row needs a non-empty
 * value string and a valid tile state; duplicate values are ambiguous
 * (last row wins at evaluation) and flagged as errors.
 *
 * @param {Array<{value: string, state: string}>} map
 * @returns {string[]} error messages
 */
function validateStateMatchMap(map) {
  const errors = [];
  const seen = new Set();
  for (const [i, row] of map.entries()) {
    if (!row || typeof row !== "object") {
      errors.push(`map row ${i + 1} is not an object`);
      continue;
    }
    if (typeof row.value !== "string" || row.value === "") {
      errors.push(`map row ${i + 1} needs a non-empty value`);
    } else if (seen.has(row.value)) {
      errors.push(`map has duplicate rows for value "${row.value}"`);
    } else {
      seen.add(row.value);
    }
    if (!TILE_STATES.includes(row.state)) {
      errors.push(
        `map row for "${row.value}" has invalid state "${row.state}"`,
      );
    }
  }
  return errors;
}

export { collectPredicatePaths };
