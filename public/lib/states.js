/**
 * The tile states (SPEC §2, §2.1).
 *
 * There are two *branches* of states, not one ladder:
 *
 *   - The problem branch: `green` / `amber` / `red` — "how urgently does
 *     something bad need attention?" `neutral` sits alongside this branch
 *     as a non-severity ("no judgment can be made") that ranks below the
 *     severities.
 *   - The opportunity branch: `opportunity` — "a beneficial window is
 *     open that will close." Structurally separate from amber/red, not
 *     a variant of either.
 *
 * `opportunity` is NOT on the problem-severity ladder. It ranks below
 * `amber`/`red` for urgency (a chance to make water is never an
 * interrupt) but above `green`/`neutral` for noticing (a glance is
 * worth it). The worst-of aggregation (`worst`) treats `opportunity`
 * as ranking between `green` and `amber`: a problem state always wins
 * over an opportunity, but an opportunity wins over green/neutral. Per
 * SPEC §2.1 a tile is in exactly one state at a time, and a tile's
 * checks must not straddle both branches — that's a config-author
 * responsibility, not something `worst` resolves.
 *
 * @file states.js */

/**
 * @typedef {"green"|"amber"|"red"|"neutral"|"opportunity"} TileState
 */

/**
 * Severity rank used by `worst()` for worst-of aggregation.
 *
 * `opportunity` (0.5) ranks above `green` (0) for noticing but below
 * `amber` (1) / `red` (2) for urgency — so a problem state always wins
 * over an opportunity, and an opportunity always wins over
 * green/neutral. `neutral` (-1) stays the lowest so it never wins
 * unless everything is neutral.
 * @type {Record<TileState, number>}
 */
export const SEVERITY = {
  neutral: -1,
  green: 0,
  opportunity: 0.5,
  amber: 1,
  red: 2,
};

/** Ordered list of the *problem-branch* severities, worst-first. */
export const SEVERITY_ORDER = ["red", "amber", "green"];

/**
 * Returns the worst (most severe) of two states (SPEC §2, §2.1).
 *
 * Within the problem branch this is the familiar max-severity rule.
 * `opportunity` participates via its 0.5 rank: it loses to amber/red
 * (a problem always outranks a chance) and beats green/neutral (a
 * chance is worth a glance where green isn't). Two opportunities yield
 * opportunity.
 *
 * @param {TileState} a
 * @param {TileState} b
 * @returns {TileState}
 */
export function worst(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * True for the problem-branch severity states that warrant an
 * interrupt/alarm treatment (`amber`/`red`). `opportunity` is never an
 * alarm — it ranks below amber/red for urgency and must never be
 * eligible for the full-screen-interrupt tier (SPEC §2.1).
 * @param {TileState} s
 */
export function isAlarm(s) {
  return s === "amber" || s === "red";
}

/**
 * True for `opportunity` — the noticing branch, distinct from the
 * problem severities. Used by the UI to render its own color/treatment
 * and to exclude it from alarm/pulse behavior.
 * @param {TileState} s
 */
export function isOpportunity(s) {
  return s === "opportunity";
}

/**
 * All valid tile states. Used to validate config-provided state values
 * and to build schema enums.
 * @type {TileState[]}
 */
export const TILE_STATES = ["green", "amber", "red", "neutral", "opportunity"];

/**
 * States a check may *target* (i.e. produce as its result), as opposed
 * to `neutral` which is reserved for "no judgment." `opportunity` is
 * included — several check types can legitimately target it (banded's
 * high side, stateMatch, notification, agreement, compound). `zone`
 * excludes it (SPEC §3.3: SK's zone vocabulary is a badness scale with
 * no native "good/opportunity" concept); see `PROBLEM_TARGET_STATES`.
 * @type {TileState[]}
 */
export const TARGET_STATES = ["green", "amber", "red", "opportunity"];

/**
 * Target states excluding `opportunity` — for check types the SPEC
 * explicitly forbids from producing opportunity (notably `zone`, whose
 * upstream zone vocabulary has no good-news concept).
 * @type {TileState[]}
 */
export const PROBLEM_TARGET_STATES = ["green", "amber", "red"];
