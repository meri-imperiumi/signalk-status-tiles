/**
 * Preview rendering for example tile sets (doc/example-tiles-plan.md).
 *
 * The examples picker shows each set's tiles rendered with REAL live
 * data: `previewTiles` evaluates each tile through the real evaluator
 * (`evalTile`) against a live PathCache fed by the boat's stream. The
 * app subscribes to the example sets' paths for the duration the picker
 * is open and feeds those deltas into a preview cache, so each tile
 * shows its actual state, headline value, and footer readouts from the
 * boat — the same rendering the live grid produces. Paths the boat
 * doesn't publish stay stale → the tile's stale state (neutral):
 * honest "no data for this on your boat yet", never a fabricated value.
 *
 * Context gating is bypassed: every tile in the set is rendered
 * (`evalTile` is called directly per tile), because the picker previews
 * the set's tiles, not the boat's current situation. The set's own
 * contexts are consulted only for the unknown-context-id config-error
 * check (so a mis-authored set still shows its tiles, not a blank).
 *
 * Pure and browser-safe: no DOM, no fetch, no subscription logic. The
 * webapp owns the cache (fed from its stream) and hands it in.
 *
 * @file preview.js */

import { PathCache } from "./staleness.js";
import { evalTile } from "./tile.js";

/**
 * Renders a set's tiles as live previews: evaluates each tile through
 * the real `evalTile` against `cache` (real values + meta, fed by the
 * app's stream subscription). Returns the rendered tile array — the
 * same shape the live engine emits (`{id, state, label, reason,
 * displayValue, footer, timestamp}`) — ready to hand to the grid's
 * #buildTile.
 *
 * A falsy cache (no engine/stream yet) degrades to an empty one: every
 * path is stale, so tiles render their stale state — the honest
 * no-data-yet appearance, never invented values.
 *
 * @param {{contexts?: Array, tiles?: Array}} set
 * @param {import("./staleness.js").PathCache} [cache] - live path cache
 *   (real values + meta). Optional; absent = all tiles stale/neutral.
 * @returns {Array<object>}
 */
export function previewTiles(set, cache) {
  const contexts = new Map(
    (Array.isArray(set?.contexts) ? set.contexts : []).map((c) => [c?.id, c]),
  );
  const tiles = Array.isArray(set?.tiles) ? set.tiles : [];
  const now = Date.now();
  // evalTile per tile (not the engine's evaluate) so context gating is
  // bypassed: every tile in the set previews, regardless of whether its
  // context's predicate currently holds.
  return tiles.map((tile) => {
    try {
      return evalTile(tile, cache ?? new PathCache(), contexts, now);
    } catch {
      // A malformed tile must not blank the whole set's preview.
      return {
        id: tile?.id,
        label: tile?.label || tile?.id,
        state: "neutral",
        reason: "",
        timestamp: now,
      };
    }
  });
}
