/**
 * Onboard timezone handling for the kiosk clock.
 *
 * The chrome bar's clock shows ship time, not the display device's
 * time: a helm display mounted on the boat may be configured for any
 * timezone (or UTC), while the crew reads wall-clock time. The
 * standard `vessels.self.environment.time.timezoneOffset` path carries
 * the onboard offset from UTC in (-)hhmm encoding (e.g. 200, -930).
 *
 * Like environment.mode, the offset may already be set on the server
 * long before this webapp connects and never arrive as a delta after
 * subscription, so the initial value comes from a one-shot REST fetch;
 * the stream subscription (added in app.js's watched paths) covers
 * live changes.
 *
 * Browser-safe (no Node APIs); fetch is injectable for tests.
 *
 * @file timezone.js */

/** Standard Signal K onboard timezone offset path (relative to vessels.self). */
export const ENVIRONMENT_TIMEZONE_OFFSET_PATH =
  "environment.time.timezoneOffset";

/** REST endpoint addressing the timezoneOffset node itself. */
export const ENVIRONMENT_TIMEZONE_OFFSET_URL =
  "/signalk/v1/api/vessels/self/environment/time/timezoneOffset";

/**
 * Real-world UTC offsets span -12:00 to +14:00; anything outside is
 * junk and must not scramble the clock.
 */
const MAX_OFFSET_HOURS = 14;

/**
 * Parses a (-)hhmm-encoded timezone offset into minutes east of UTC.
 * Returns null for anything that is not a plausible offset — a broken
 * value must fall back to device-local time, never show a wrong clock.
 *
 * @param {unknown} value - e.g. 200 (UTC+2:00), -930 (UTC-9:30)
 * @returns {number|null} minutes east of UTC, or null when invalid
 */
export function parseTimezoneOffset(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const hours = Math.floor(abs / 100);
  const minutes = abs % 100;
  if (hours > MAX_OFFSET_HOURS || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * Extracts the onboard timezone offset from a raw delta, if it carries
 * one. Returns the last matching value (deltas may batch several
 * updates), or null when the delta says nothing about the offset — or
 * carries a value outside the plausible range.
 *
 * @param {object} delta - raw Signal K delta
 * @returns {number|null} minutes east of UTC
 */
export function timezoneOffsetFromDelta(delta) {
  let offset = null;
  for (const update of delta?.updates || []) {
    for (const v of update?.values || []) {
      if (v?.path === ENVIRONMENT_TIMEZONE_OFFSET_PATH) {
        offset = parseTimezoneOffset(v.value);
      }
    }
  }
  return offset;
}

/**
 * Ship time as a Date: shifts the instant by the offset so UTC getters
 * read ship wall-clock time. With the display device's own offset
 * (`-date.getTimezoneOffset()`) the same path renders local time, so
 * the clock formatter has a single code path for both.
 *
 * @param {Date} date - the instant
 * @param {number} offsetMinutes - minutes east of UTC
 * @returns {Date} shifted Date whose getUTC* methods read ship time
 */
export function shipTime(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60000);
}

/**
 * Fetches the current onboard offset once via REST. Returns null on
 * any failure or implausible value (the clock is chrome, not data —
 * never throw).
 *
 * @param {typeof fetch} [fetchFn] - fetch implementation (injectable)
 * @returns {Promise<number|null>} minutes east of UTC
 */
export async function fetchEnvironmentTimezoneOffset(fetchFn) {
  const f = fetchFn ?? ((...args) => globalThis.fetch(...args));
  try {
    const res = await f(ENVIRONMENT_TIMEZONE_OFFSET_URL);
    if (!res.ok) return null;
    const data = await res.json();
    // The endpoint addresses the offset node itself, so the body is the
    // bare number; accept an object shape too in case a server build
    // wraps the node.
    const value = typeof data === "number" ? data : data?.value;
    return parseTimezoneOffset(value);
  } catch {
    return null;
  }
}
