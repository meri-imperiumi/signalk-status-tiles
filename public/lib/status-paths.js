/**
 * Server-side tile status publication (SPEC §6 output #1, on the bus).
 *
 * The server plugin runs the same evaluation engine as the webapp and
 * publishes each tile's aggregated state as a PLAIN STRING delta — no
 * object envelope — so any Signal K consumer (instrument panels, alarm
 * routers, home automation) can read tile status without this plugin's
 * webapp: `statusTiles.tiles.<tileId> = "green" | "amber" | "red" |
 * "neutral" | "opportunity"`.
 *
 * A tile hidden by an inactive context (SPEC §5, revised) publishes
 * null instead of its last state, so consumers never render a stale
 * severity. Publishing is change-driven: a delta is emitted only when
 * a tile's state actually differs from the last published one.
 *
 * The paths live under the same plugin-namespaced branch as
 * CONFIG_HASH_PATH (`statusTiles.*`) so they cannot collide with
 * standard Signal K paths or other plugins' data.
 *
 * This module is browser-safe (no Node APIs), like config-hash.js.
 *
 * @file status-paths.js */

/** Base of the per-tile status paths, relative to `vessels.self`. */
export const TILE_STATUS_BASE = "statusTiles.tiles";

/**
 * The closed state vocabulary published on tile status paths (SPEC §2).
 * @type {readonly string[]}
 */
export const TILE_STATES = ["green", "amber", "red", "neutral", "opportunity"];

/**
 * Path of a single tile's published status, relative to `vessels.self`.
 * Tile ids are validated to `[A-Za-z][A-Za-z0-9_-]*` (config.js), so
 * they are safe as path segments.
 *
 * @param {string} id - tile id
 * @returns {string}
 */
export function tileStatusPath(id) {
  return `${TILE_STATUS_BASE}.${id}`;
}

/**
 * Path of a tile's published headline display value (SPEC §3.4),
 * relative to `vessels.self` — a sibling of the tile's status path.
 * The string state stays a plain leaf (SPEC §6: any consumer can read
 * tile status without this plugin's webapp); the display value rides
 * beside it as its own scalar so instrument panels and plotter widgets
 * (public/tile-ext-widget.js) can show "House Bank 92%" without
 * re-running the evaluation engine. Published as a plain formatted
 * string (the check type owns formatting), null when the tile has no
 * display value or its context is inactive.
 *
 * @param {string} id - tile id
 * @returns {string}
 */
export function tileDisplayValuePath(id) {
  return `${tileStatusPath(id)}.displayValue`;
}

/**
 * Metadata description for the published status paths, used by the
 * server when it sends path metadata (displayName/description).
 */
export const TILE_STATUS_DESCRIPTION = `Current Status Tiles state: one of ${TILE_STATES.map((s) => `"${s}"`).join(", ")}, or null while the tile's context is inactive or the plugin is stopped`;

/**
 * Metadata description for the published display-value paths (SPEC
 * §3.4), used by the server when it sends path metadata.
 */
export const TILE_DISPLAY_VALUE_DESCRIPTION = `Current Status Tiles headline display value for the tile (SPEC 3.4), formatted by the tile's display check; null when the tile has none, its display input is stale, its context is inactive, or the plugin is stopped`;
