/**
 * Vessel-name resolution for the chrome bar.
 *
 * Signal K delta streams are change-driven: they do NOT replay current
 * state on subscribe. `name` is static vessel identity — published at
 * server startup, long before this webapp connects — so it never arrives
 * as a delta after we subscribe, and a stream-only subscription for it
 * stays silent forever. (Live sensor paths stream continuously, which is
 * why tiles don't need this.)
 *
 * Resolution: fetch it once through the standard REST API
 * (`/signalk/v1/api/vessels/self/name`) at startup; the stream
 * subscription (kept in app.js) covers the rare case of a live rename.
 * The webapp is served from the Signal K host, so a relative URL hits
 * the right origin.
 *
 * Failures return null (never throw): the name is chrome, not data —
 * the grid's placeholder takes over and everything else keeps working.
 *
 * `fetchFn` is injectable so tests can drive it without a network.
 *
 * @file vessel.js */

/** Standard Signal K self-vessel name endpoint (REST API). */
export const VESSEL_NAME_URL = "/signalk/v1/api/vessels/self/name";

/**
 * @param {typeof fetch} [fetchFn] - fetch implementation (injectable)
 * @returns {Promise<string|null>} the vessel name, or null when unknown
 */
export async function fetchVesselName(fetchFn) {
  const f = fetchFn ?? ((...args) => globalThis.fetch(...args));
  try {
    const res = await f(VESSEL_NAME_URL);
    if (!res.ok) return null;
    const data = await res.json();
    // The endpoint addresses the `name` node itself, so the body is the
    // bare JSON string (e.g. `"S/Y Pi"`). Accept an object shape too in
    // case a server build wraps the node.
    if (typeof data === "string") return data || null;
    const name = data?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
