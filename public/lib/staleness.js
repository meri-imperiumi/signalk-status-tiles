/**
 * Per-path staleness tracking (SPEC §4). A path's age is measured from the
 * timestamp on the delta that last updated it, NOT wall-clock arrival. A
 * path is stale once its age exceeds a threshold (global default,
 * overridable per check).
 *
 * The webapp maintains one PathCache; every check reads staleness from it.
 * The timer-driven evaluation trigger (SPEC §8) is what actually discovers
 * staleness for a path that has stopped sending — a delta-only design
 * cannot detect silence.
 *
 * @file staleness.js */

/** Default staleness threshold (ms) when not overridden per-check. */
export const DEFAULT_STALE_MS = 60 * 1000;

/**
 * A shared cache of path → {value, timestamp} plus per-path metadata.
 * The stream feeds it; the engine reads it. Stale-state policy lives on
 * the checks, not here — this module only answers "how old is this
 * path's value, and is it stale?"
 */
export class PathCache {
  constructor() {
    /** @type {Map<string, {value: unknown, timestamp: number}>} */
    this.entries = new Map();
    /** @type {Map<string, object>} metadata (zones etc.), keyed by path */
    this.meta = new Map();
  }

  /**
   * Records a value update. `timestamp` is the delta's own timestamp (ms
   * epoch); falls back to Date.now() when absent so a value without a
   * timestamp is considered fresh-but-unverifiable.
   *
   * @param {string} path
   * @param {unknown} value
   * @param {number} [timestamp]
   */
  set(path, value, timestamp = Date.now()) {
    this.entries.set(path, { value, timestamp });
  }

  /**
   * Records a meta update (zones, units, displayName).
   * @param {string} path
   * @param {object} meta
   */
  setMeta(path, meta) {
    this.meta.set(path, meta || {});
  }

  /** @param {string} path @returns {unknown} */
  value(path) {
    return this.entries.get(path)?.value;
  }

  /** @param {string} path @returns {object|undefined} */
  metaFor(path) {
    return this.meta.get(path);
  }

  /**
   * Age of a path's value in ms, or Infinity when never seen.
   * @param {string} path
   * @returns {number}
   */
  age(path, now = Date.now()) {
    const e = this.entries.get(path);
    if (!e) return Infinity;
    return now - e.timestamp;
  }

  /**
   * Whether a path's value is stale (age exceeds threshold) or absent.
   * @param {string} path
   * @param {number} [thresholdMs]
   * @param {number} [now]
   * @returns {boolean}
   */
  isStale(path, thresholdMs = DEFAULT_STALE_MS, now = Date.now()) {
    const e = this.entries.get(path);
    if (!e) return true; // absent => stale-by-definition (SPEC §4)
    // A threshold of 0 (or negative) means "staleness check disabled" —
    // never stale. This matches the admin UI's tendency to default empty
    // number fields to 0, which would otherwise mark every value instantly
    // stale (now - ts > 0 is true the moment after arrival).
    if (thresholdMs <= 0) return false;
    return now - e.timestamp > thresholdMs;
  }

  /** Whether a path has ever received a value. @param {string} path @returns {boolean} */
  has(path) {
    return this.entries.has(path);
  }

  /** Clears the cache (used on reconnect / config reload). */
  clear() {
    this.entries.clear();
    this.meta.clear();
  }
}
