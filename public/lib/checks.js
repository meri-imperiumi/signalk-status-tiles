/**
 * Check-type evaluators (SPEC §3.3). A closed, reusable set: adding a new
 * tile should mean writing config, not a new check type. Each type defines
 * its own behavior for value-absent and value-stale (SPEC §4).
 *
 * Every check returns `{ state, reason, displayValue }` where:
 *   - state: one of the four TileStates
 *   - reason: short human string identifying which check produced the
 *     worst state (debugging/hover text, not primary UI)
 *   - displayValue: optional formatted value for the tile's headline
 *     number (SPEC §3.4); each type that can produce one formats its own
 *
 * @file checks.js */

import { DEFAULT_STALE_MS } from "./staleness.js";
import { formatDisplayValue, unwrap, valueToNumber } from "./util.js";

/** The closed set of check type names (SPEC §3.3). */
export const CHECK_TYPES = new Set([
  "boolean",
  "banded",
  "differential",
  "alarmGroup",
  "stateMatch",
  "zone",
  "notification",
  "agreement",
]);

/**
 * @typedef {"green"|"amber"|"red"|"neutral"} TileState
 * @typedef {{state: TileState, reason: string, displayValue?: string}} CheckResult
 */

/**
 * The default stale-state policy per check type (SPEC §4). Safety-relevant
 * checks (alarmGroup) default to red; most others to neutral. Overridable
 * per check via `staleState`.
 *
 * @type {Record<string, TileState>}
 */
const DEFAULT_STALE_STATE = {
  boolean: "neutral",
  banded: "neutral",
  differential: "neutral",
  alarmGroup: "red",
  stateMatch: "neutral",
  zone: "neutral",
  notification: "neutral",
  agreement: "neutral",
};

/**
 * Resolves the effective stale-state for a check: explicit override, else
 * the type default.
 *
 * @param {object} check
 * @returns {TileState}
 */
function staleState(check) {
  return check.staleState || DEFAULT_STALE_STATE[check.type] || "neutral";
}

/**
 * Dispatches a check to its type evaluator. This is the single entry
 * point used by the tile aggregator.
 *
 * @param {object} check
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} [now]
 * @returns {CheckResult}
 */
export function evalCheck(check, cache, now = Date.now()) {
  switch (check.type) {
    case "boolean":
      return evalBoolean(check, cache, now);
    case "banded":
      return evalBanded(check, cache, now);
    case "differential":
      return evalDifferential(check, cache, now);
    case "alarmGroup":
      return evalAlarmGroup(check, cache, now);
    case "stateMatch":
      return evalStateMatch(check, cache, now);
    case "zone":
      return evalZone(check, cache, now);
    case "notification":
      return evalNotification(check, cache, now);
    case "agreement":
      return evalAgreement(check, cache, now);
    default:
      return { state: "neutral", reason: `Unknown check type ${check.type}` };
  }
}

/**
 * Returns the stale result for a single-path check: the configured
 * stale-state plus a reason. Centralized because most checks share the
 * "absent or stale → <staleState>" shape.
 *
 * @param {object} check
 * @param {string} reason
 * @returns {CheckResult}
 */
function staleResult(check, reason) {
  return { state: staleState(check), reason };
}

/**
 * boolean: a path's truthiness maps to two configurable states. Which
 * value means "bad" is configurable (SPEC §3.3).
 *
 * @param {object} check - `{ path, badWhen (default true), staleState }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalBoolean(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (cache.isStale(check.path, threshold, now)) {
    return staleResult(check, `${check.path} stale/absent`);
  }
  const val = unwrap(cache.value(check.path));
  const truthy = val === true || val === 1 || val === "true";
  const bad = check.badWhen !== false; // default: true is bad
  const isBad = truthy === bad;
  return {
    state: isBad ? "red" : "green",
    reason: check.reason || check.path,
  };
}

/**
 * banded: numeric value against warn/crit thresholds on either or both
 * sides (SPEC §3.3). Supports low.warn/low.crit and high.warn/high.crit.
 * Worst state wins; amber unless a crit threshold is crossed (red).
 *
 * @param {object} check
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalBanded(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (cache.isStale(check.path, threshold, now)) {
    return staleResult(check, `${check.path} stale/absent`);
  }
  const v = valueToNumber(cache.value(check.path));
  if (!Number.isFinite(v)) {
    return { state: "neutral", reason: `${check.path} non-numeric` };
  }
  let state = "green";
  let reason = check.reason || check.path;
  if (check.high?.crit != null && v > check.high.crit) {
    state = "red";
    reason = `${check.path} above ${check.high.crit}`;
  } else if (check.low?.crit != null && v < check.low.crit) {
    state = "red";
    reason = `${check.path} below ${check.low.crit}`;
  } else if (check.high?.warn != null && v > check.high.warn) {
    state = "amber";
    reason = `${check.path} above ${check.high.warn}`;
  } else if (check.low?.warn != null && v < check.low.warn) {
    state = "amber";
    reason = `${check.path} below ${check.low.warn}`;
  }
  return {
    state,
    reason,
    displayValue: check.display ? formatBanded(v, check) : undefined,
  };
}

/**
 * differential: absolute difference between two paths against warn/crit
 * thresholds (e.g. cell voltage spread) (SPEC §3.3).
 *
 * @param {object} check - `{ path, path2, warn, crit, staleState }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalDifferential(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (
    cache.isStale(check.path, threshold, now) ||
    cache.isStale(check.path2, threshold, now)
  ) {
    return staleResult(check, `differential input stale/absent`);
  }
  const a = valueToNumber(cache.value(check.path));
  const b = valueToNumber(cache.value(check.path2));
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { state: "neutral", reason: "differential non-numeric" };
  }
  const diff = Math.abs(a - b);
  if (check.crit != null && diff >= check.crit) {
    return {
      state: "red",
      reason: `spread ${formatNum(diff)} >= ${check.crit}`,
      displayValue: check.display ? formatNum(diff) : undefined,
    };
  }
  if (check.warn != null && diff >= check.warn) {
    return {
      state: "amber",
      reason: `spread ${formatNum(diff)} >= ${check.warn}`,
      displayValue: check.display ? formatNum(diff) : undefined,
    };
  }
  return {
    state: "green",
    reason: check.reason || "spread ok",
    displayValue: check.display ? formatNum(diff) : undefined,
  };
}

/**
 * alarmGroup: a list of boolean/alarm paths; any tripped OR stale → red.
 * Optional secondary numeric sub-check (e.g. battery level) for amber
 * (SPEC §3.3).
 *
 * @param {object} check - `{ paths, levelPath, levelWarn, levelCrit }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalAlarmGroup(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  for (const p of check.paths || []) {
    if (cache.isStale(p, threshold, now)) {
      return { state: "red", reason: `${p} stale (alarmGroup)` };
    }
    if (
      unwrap(cache.value(p)) === true ||
      valueToNumber(cache.value(p)) === 1
    ) {
      return { state: "red", reason: `${p} tripped` };
    }
  }
  if (check.levelPath) {
    if (cache.isStale(check.levelPath, threshold, now)) {
      return staleResult(check, `${check.levelPath} stale`);
    }
    const lvl = valueToNumber(cache.value(check.levelPath));
    if (Number.isFinite(lvl)) {
      if (check.levelCrit != null && lvl <= check.levelCrit) {
        return {
          state: "red",
          reason: `${check.levelPath} <= ${check.levelCrit}`,
          displayValue: check.display ? formatNum(lvl) : undefined,
        };
      }
      if (check.levelWarn != null && lvl <= check.levelWarn) {
        return {
          state: "amber",
          reason: `${check.levelPath} <= ${check.levelWarn}`,
          displayValue: check.display ? formatNum(lvl) : undefined,
        };
      }
    }
  }
  return { state: "green", reason: check.reason || "all clear" };
}

/**
 * stateMatch: a path's discrete value looked up in an explicit
 * state→tile-state map, with a default for unmapped values (SPEC §3.3).
 *
 * @param {object} check - `{ path, map: {value: state}, default }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalStateMatch(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (cache.isStale(check.path, threshold, now)) {
    return staleResult(check, `${check.path} stale/absent`);
  }
  const raw = unwrap(cache.value(check.path));
  const key = String(raw);
  const map = check.map || {};
  const state = key in map ? map[key] : (check.default ?? "neutral");
  return { state, reason: check.reason || `${check.path}=${key}` };
}

/**
 * zone: reads the path's own Signal K metadata `zones` (nominal/alert/
 * warn/alarm/emergency) and collapses 5→4 via a severity map; an inline
 * `zones` fallback may be supplied for paths without published metadata
 * (SPEC §3.3, §10).
 *
 * @param {object} check - `{ path, severityMap, zones? }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
const ZONE_DEFAULT_MAP = {
  nominal: "green",
  alert: "green",
  warn: "amber",
  alarm: "red",
  emergency: "red",
};

function evalZone(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (cache.isStale(check.path, threshold, now)) {
    return staleResult(check, `${check.path} stale/absent`);
  }
  const v = valueToNumber(cache.value(check.path));
  if (!Number.isFinite(v)) {
    return { state: "neutral", reason: `${check.path} non-numeric` };
  }
  // Inline zones override metadata; an empty inline array means "use
  // metadata" (the admin UI defaults the field to []). Fall through to
  // the path's published metadata zones, then to an empty list.
  const metaZones = cache.metaFor(check.path)?.zones;
  const zones =
    check.zones && check.zones.length > 0 ? check.zones : metaZones || [];
  const smap = check.severityMap || ZONE_DEFAULT_MAP;
  if (zones.length === 0) {
    // No zones defined — neither inline nor in the path's metadata. We
    // can't honestly classify severity, so neutral rather than a silent
    // green (SPEC §4: missing data is never silently good).
    return { state: "neutral", reason: `${check.path} has no zones defined` };
  }
  let state = "green";
  let zoneName = "nominal";
  for (const z of zones) {
    const lower = z.lower != null ? z.lower : -Infinity;
    const upper = z.upper != null ? z.upper : Infinity;
    if (v >= lower && v <= upper) {
      zoneName = z.state || "nominal";
      state = smap[zoneName] ?? "neutral";
      break;
    }
  }
  return {
    state,
    reason: check.reason || `${check.path} ${zoneName}`,
    displayValue: check.display
      ? formatDisplayValue(v, cache.metaFor(check.path)?.displayUnits)
      : undefined,
  };
}

/**
 * notification: reads a `notifications.*` path directly. The upstream
 * plugin has already classified severity (normal/alert/warn/alarm/
 * emergency) and usually written a human-readable message. Maps that
 * through a severity map and defaults `reason` to the notification's own
 * message (SPEC §3.3, §7.1).
 *
 * @param {object} check
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
const NOTIFICATION_DEFAULT_MAP = {
  normal: "green",
  alert: "green",
  warn: "amber",
  alarm: "red",
  emergency: "red",
};

function evalNotification(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (cache.isStale(check.path, threshold, now)) {
    return staleResult(check, `${check.path} stale/absent`);
  }
  const notif = unwrap(cache.value(check.path));
  // Signal K notification objects: { state, message, timestamp, ... }
  const n = notif && typeof notif === "object" ? notif : { state: notif };
  const smap = check.severityMap || NOTIFICATION_DEFAULT_MAP;
  const nstate = String(n.state ?? "normal");
  const state = smap[nstate] ?? "neutral";
  return {
    state,
    reason: check.reason || n.message || `${check.path} ${nstate}`,
  };
}

/**
 * agreement: two paths must be equal (string/enum common case, not
 * limited to numeric). Mismatch maps to a configurable state (typically
 * amber) (SPEC §3.3).
 *
 * @param {object} check - `{ path, path2, mismatchState (default amber), staleState }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalAgreement(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  if (
    cache.isStale(check.path, threshold, now) ||
    cache.isStale(check.path2, threshold, now)
  ) {
    return staleResult(check, "agreement input stale/absent");
  }
  const a = unwrap(cache.value(check.path));
  const b = unwrap(cache.value(check.path2));
  const equal = looseEqual(a, b);
  if (equal) {
    return { state: "green", reason: check.reason || "agreement" };
  }
  return {
    state: check.mismatchState || "amber",
    reason: `${check.path} ≠ ${check.path2}`,
  };
}

function looseEqual(a, b) {
  if (a == null || b == null) return a === b;
  const na = valueToNumber(a);
  const nb = valueToNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

/** @param {number} n @returns {string} */
function formatNum(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Formats a banded value for display. Each check type that produces a
 * display value formats its own (SPEC §3.4).
 *
 * @param {number} v
 * @param {object} check
 * @returns {string}
 */
function formatBanded(v, check) {
  if (check.unit === "%") return `${Math.round(v * 100)}%`;
  if (check.unit === "ratio") return `${Math.round(v * 100)}%`;
  return formatNum(v);
}
