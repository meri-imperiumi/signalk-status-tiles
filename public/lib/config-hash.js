/**
 * Config-change signaling between the server plugin and the webapp.
 *
 * Server-side config edits (admin UI) restart the plugin; `start()` is
 * the moment a change becomes visible. The server hashes the config
 * contents and publishes the hash as an ordinary Signal K delta; the
 * webapp subscribes to that path on its existing stream and re-fetches
 * the config when the hash differs from what it loaded. The REST
 * endpoint carries the same hash so the initial load has a baseline to
 * compare against.
 *
 * The hash is a change token, not a checksum the webapp verifies: it
 * only needs to be stable for identical content (canonical
 * serialization, sorted keys) and different for different content.
 *
 * This module is browser-safe (no Node APIs) — both index.js and the
 * webapp import it.
 *
 * @file config-hash.js */

/**
 * Delta path (relative to `vessels.self`) carrying the current config
 * hash. A plugin-namespaced branch: only this plugin's webapp consumes
 * it, so it must not collide with standard Signal K paths.
 */
export const CONFIG_HASH_PATH = "statusTiles.configHash";

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays
 * order-preserving. Two configs that differ only in key order (e.g. the
 * admin UI rewriting the plugin's JSON) serialize identically, so the
 * hash only changes when the *contents* change.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Extracts the config hash from a raw delta, if it carries one.
 * Returns the last matching value (deltas may batch several updates),
 * or null when the delta says nothing about the config.
 *
 * @param {object} delta - raw Signal K delta
 * @returns {string|null}
 */
export function configHashFromDelta(delta) {
  let hash = null;
  for (const update of delta?.updates || []) {
    for (const v of update?.values || []) {
      if (v?.path === CONFIG_HASH_PATH && typeof v.value === "string") {
        hash = v.value;
      }
    }
  }
  return hash;
}
