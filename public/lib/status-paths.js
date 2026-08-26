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
 * Metadata description for the published status paths, used by the
 * server when it sends path metadata (displayName/description).
 */
export const TILE_STATUS_DESCRIPTION = `Current Status Tiles state: one of ${TILE_STATES.map((s) => `"${s}"`).join(", ")}, or null while the tile's context is inactive or the plugin is stopped`;
