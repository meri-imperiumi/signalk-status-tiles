/**
 * Config validation (SPEC §9). Returns errors (hard problems that will
 * break evaluation) and warnings (soft issues worth surfacing). The server
 * starts even with errors so the user can fix the form rather than being
 * locked out.
 *
 * @file config.js */

import { CHECK_TYPES } from "./checks.js";
import { collectPredicatePaths, unwrapConfig } from "./paths.js";

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
    if (!hasComparator(ctx.predicate) && !hasCombinator(ctx.predicate)) {
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
        } else if (
          !hasComparator(check.predicate) &&
          !hasCombinator(check.predicate)
        ) {
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
      if (check.display) displayCount++;
    }
    if (displayCount > 1) {
      errors.push(
        `Tile "${tile.id}" designates ${displayCount} display checks; at most one (SPEC §3.4)`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * @param {object} pred
 * @returns {boolean}
 */
function hasComparator(pred) {
  return Boolean(pred?.path && pred.compare);
}
/**
 * @param {object} pred
 * @returns {boolean}
 */
function hasCombinator(pred) {
  return Boolean(pred?.allOf || pred?.anyOf || pred?.not || pred?.between);
}

export { collectPredicatePaths };
