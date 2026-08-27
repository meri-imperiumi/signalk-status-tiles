/**
 * Day/night mode handling for the kiosk display.
 *
 * The spec's theme is reactive to `vessels.self.environment.mode`: the
 * host applies `data-mode="day"|"night"` to the root <html> element,
 * and every color custom property (defined in index.html) shifts with
 * it — bright and saturated by day to fight glare on a washed-out
 * screen, dimmed at night to protect the helm's night vision.
 *
 * Like the vessel name, environment.mode may already be set on the
 * server long before this webapp connects and never arrive as a delta
 * after subscription, so the initial value comes from a one-shot REST
 * fetch; the stream subscription (added in app.js's watched paths)
 * covers live changes.
 *
 * Browser-safe (no Node APIs); the DOM and fetch are injectable for
 * tests.
 *
 * @file mode.js */

/** Standard Signal K day/night mode path (relative to vessels.self). */
export const ENVIRONMENT_MODE_PATH = "environment.mode";

/** REST endpoint addressing the mode node itself. */
export const ENVIRONMENT_MODE_URL =
  "/signalk/v1/api/vessels/self/environment/mode";

/**
 * @param {unknown} value
 * @returns {boolean} true for the two modes Signal K defines
 */
function isMode(value) {
  return value === "day" || value === "night";
}

/**
 * Extracts the day/night mode from a raw delta, if it carries one.
 * Returns the last matching value (deltas may batch several updates),
 * or null when the delta says nothing about the mode — or carries a
 * value outside the day/night vocabulary, which must not re-skin the
 * display.
 *
 * @param {object} delta - raw Signal K delta
 * @returns {"day"|"night"|null}
 */
export function modeFromDelta(delta) {
  let mode = null;
  for (const update of delta?.updates || []) {
    for (const v of update?.values || []) {
      if (v?.path === ENVIRONMENT_MODE_PATH && isMode(v.value)) {
        mode = v.value;
      }
    }
  }
  return mode;
}

/**
 * Applies the mode to the root <html> element as `data-mode`, which the
 * palette variables in index.html key off. Unknown/missing values are
 * ignored: the served HTML boots with data-mode="day" and stays that
 * way until a real value arrives — the kiosk never gets dimmer because
 * of bad data.
 *
 * @param {"day"|"night"|null|undefined} mode
 * @param {Document} [doc] - document to theme (injectable for tests)
 */
export function applyMode(mode, doc = globalThis.document) {
  if (!isMode(mode)) return;
  const root = doc?.documentElement;
  if (root == null) return;
  root.dataset.mode = mode;
}

/**
 * Fetches the current mode once via REST. Returns null on any failure
 * or non-mode value (mode is chrome, not data — never throw).
 *
 * @param {typeof fetch} [fetchFn] - fetch implementation (injectable)
 * @returns {Promise<"day"|"night"|null>}
 */
export async function fetchEnvironmentMode(fetchFn) {
  const f = fetchFn ?? ((...args) => globalThis.fetch(...args));
  try {
    const res = await f(ENVIRONMENT_MODE_URL);
    if (!res.ok) return null;
    const data = await res.json();
    // The endpoint addresses the mode node itself, so the body is the
    // bare JSON string ("day"/"night"); accept an object shape too in
    // case a server build wraps the node.
    const value = typeof data === "string" ? data : data?.value;
    return isMode(value) ? value : null;
  } catch {
    return null;
  }
}
