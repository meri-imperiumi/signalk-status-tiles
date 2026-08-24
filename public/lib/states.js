/**
 * The four tile states and their severity ordering (SPEC §2).
 *
 * `neutral` is NOT a severity — it is a statement that no severity
 * judgment can honestly be made (either the context is inactive, or the
 * input is missing/stale). It ranks below amber/red so a tile is neutral
 * outright when its context is inactive, and a check's worst state is
 * the max severity among its checks otherwise.
 *
 * @file states.js */

/**
 * @typedef {"green"|"amber"|"red"|"neutral"} TileState
 */

/**
 * Severity rank. `neutral` is deliberately below the severities so it
 * never wins a max() aggregation unless every check is neutral, but a
 * single red/amber check still surfaces.
 * @type {Record<TileState, number>}
 */
export const SEVERITY = {
  green: 0,
  neutral: -1,
  amber: 1,
  red: 2,
};

/** Ordered list, worst-first, excluding neutral. */
export const SEVERITY_ORDER = ["red", "amber", "green"];

/**
 * Returns the worst (most severe) of two states. `neutral` only wins when
 * the other is also neutral or green-and-neutral collapses to neutral?
 * No — per SPEC §2, a tile's state is the worst among its checks, with
 * neutral ranking below amber/red. So max(severity) is the rule, and
 * neutral's -1 rank makes it lose to anything except another neutral.
 *
 * @param {TileState} a
 * @param {TileState} b
 * @returns {TileState}
 */
export function worst(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** True for the severity-bearing states (amber/red). @param {TileState} s */
export function isAlarm(s) {
  return s === "amber" || s === "red";
}
