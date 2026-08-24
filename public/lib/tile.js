/**
 * Tile aggregation (SPEC §3.2). A tile's state is the worst state among
 * its checks, `neutral` ranking below amber/red — but the tile is
 * `neutral` outright (skipping checks) when its context is inactive.
 *
 * @file tile.js */

import { evalCheck } from "./checks.js";
import { evalPredicate } from "./context.js";
import { worst } from "./states.js";

/**
 * Evaluates a single tile against the cache. Returns the structured tile
 * value (SPEC §6 output #1): `{ state, label, reason, displayValue, timestamp }`.
 *
 * Context gating (SPEC §5): if the tile's context is inactive, the tile is
 * `neutral` outright and NO checks run — regardless of what the
 * underlying paths are doing. When active, checks run normally, including
 * going stale/neutral or red if inputs disappear while the context is
 * active.
 *
 * Display value (SPEC §3.4): at most one check is designated `display`;
 * its formatted value becomes the tile's headline number. A stale check's
 * display value is replaced with an explicit "unknown" marker (dash), not
 * the frozen last reading. A context-inactive tile shows nothing (not a
 * dash) — the two neutral reasons must look different.
 *
 * @param {object} tile - `{ id, label, context?, checks, size? }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {Map<string, object>} contexts - id → context object
 * @param {number} [now]
 * @returns {{id: string, state: import("./checks.js").TileState, label: string, reason: string, displayValue?: string, timestamp: number}}
 */
export function evalTile(tile, cache, contexts, now = Date.now()) {
  const timestamp = now;

  // Context gating: inactive context => neutral outright, checks skipped.
  if (tile.context) {
    const ctx = contexts.get(tile.context);
    if (!ctx) {
      return {
        id: tile.id,
        state: "neutral",
        label: tile.label || tile.id,
        reason: `unknown context ${tile.context}`,
        timestamp,
      };
    }
    if (!evalPredicate(ctx.predicate, cache, now)) {
      // Context inactive: neutral, NO display value, NO dash marker
      // (SPEC §3.4 — "shows nothing, not a stale-looking dash").
      return {
        id: tile.id,
        state: "neutral",
        label: tile.label || tile.id,
        reason: "context inactive",
        timestamp,
      };
    }
  }

  // Run all checks; worst state wins.
  let state = "neutral";
  let reason = "";
  let displayValue;
  for (const check of tile.checks || []) {
    const r = evalCheck(check, cache, now);
    state = worst(state, r.state);
    // The reason tracks the check that produced the worst state. Since
    // `worst` returns the more severe, keep the reason of whichever
    // check is currently the worst. A later equal-severity check does
    // not overwrite (first-wins keeps the reason stable).
    if (r.state === state && !reason) reason = r.reason;
    if (check.display) {
      displayValue = r.displayValue;
    }
  }

  // Stale display value: if the designated display check's input is
  // stale, show "—" not the frozen last reading (SPEC §3.4). The check's
  // own evalCheck already returns no displayValue when stale, so
  // displayValue is undefined here when stale — normalize to "—".
  const displayCheck = (tile.checks || []).find((c) => c.display);
  if (displayCheck) {
    const staleMs = displayCheck.staleMs;
    if (cache.isStale(displayCheck.path ?? displayCheck.path2, staleMs, now)) {
      displayValue = "—";
    } else if (displayValue == null) {
      displayValue = "—";
    }
  }

  return {
    id: tile.id,
    state,
    label: tile.label || tile.id,
    reason: reason || (state === "green" ? "ok" : ""),
    displayValue,
    timestamp,
  };
}
