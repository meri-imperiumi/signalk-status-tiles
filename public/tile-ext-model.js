/**
 * Pure wording/mapping decisions for the plotter tile widget
 * (`tile-ext-widget.js`). No DOM, no bus — the widget is the adapter,
 * this module is the decision table, mirror of dr-ext-model.js /
 * brief-ext-model.js in the family.
 *
 * The widget renders exactly what the server publishes on the bus
 * (SPEC §6 output #1, reduced to scalars in index.js): the tile's
 * aggregated state string and its optional headline display value.
 * The tile label comes from the plugin config (fetched by the widget);
 * an unfetchable label falls back to the tile id.
 *
 * @file tile-ext-model.js
 */

import { TILE_STATES } from "./lib/states.js";

/**
 * Short glance word per state (SPEC §2 meanings, compressed to what
 * fits a widget at arm's length). Green needs no word ("OK" confirms
 * without claiming more); amber/red carry the spec's urgency; the
 * opportunity branch gets its own word — never a severity word
 * (SPEC §2.1); null (unpublished: context inactive per SPEC §5
 * revised, plugin stopped, or not yet received) is honest "no data".
 *
 * @type {Record<string, string>}
 */
export const STATE_WORDS = {
  green: "OK",
  amber: "TODAY",
  red: "NOW",
  opportunity: "OPEN",
  neutral: "N/A",
};

/**
 * Maps a published state string to the widget's view fields.
 *
 * @param {object} input
 * @param {string|null} input.label - config label (already falls back to
 *   the tile id in the widget); rendered uppercase by CSS
 * @param {string|null} input.state - published state string
 *   (`statusTiles.tiles.<id>`), or null when nothing has been published
 * @param {string|null} [input.displayValue] - published headline value
 *   (`statusTiles.tiles.<id>.displayValue`), null when the tile has
 *   none or it is stale
 * @returns {{label: string, value: string, word: string, theme: string|null, lit: boolean}}
 *   `theme` is the spec theme class stem (green/orange/red/teal) or
 *   null for neutral/no-data; `lit` is false exactly when `theme` is
 *   null (neutral styling, SPEC §11: never visually confusable with
 *   green); `value` is the display value or "" when absent.
 */
export function tileWidgetModel({ label, state, displayValue }) {
  // An unmapped state (a future vocabulary, or a corrupted value)
  // renders as neutral rather than as an uncolored lit tile — same
  // defensive default as the webapp grid's #paintTile.
  const known = state != null && TILE_STATES.includes(state);
  const theme =
    known && state !== "neutral"
      ? { green: "green", amber: "orange", red: "red", opportunity: "teal" }[
          state
        ]
      : null;
  return {
    label: label || "—",
    value: displayValue != null ? String(displayValue) : "",
    word: known ? STATE_WORDS[state] : "NO DATA",
    theme,
    lit: theme != null,
  };
}

/**
 * Extracts the tile id from the widget page's query string — the
 * manifest's `?tile=<id>` contract (ids are validated to
 * `[A-Za-z][A-Za-z0-9_-]*` in config.js, so no escaping needed).
 *
 * @param {string} search - location.search of the widget iframe
 * @returns {string|null} tile id, or null when absent
 */
export function tileIdFromSearch(search) {
  return new URLSearchParams(search || "").get("tile");
}
