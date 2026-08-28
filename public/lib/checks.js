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

import { evalPredicate } from "./context.js";
import { DEFAULT_STALE_MS } from "./staleness.js";
import {
  displayUnitsForPath,
  formatDisplayValue,
  formatSmartNumber,
  unwrap,
  valueToNumber,
} from "./util.js";

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
  "compound",
]);

/**
 * @typedef {"green"|"amber"|"red"|"neutral"|"opportunity"} TileState
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
  // compound has no single watched path of its own; its predicate
  // references paths and handles missingness via whenMissing. A stale
  // compound check (a referenced path gone quiet) is, by default, not
  // an alarm — the predicate simply won't match on a missing value
  // (contexts fail closed). Override per check if a silent input
  // should be a fault.
  compound: "neutral",
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
    case "compound":
      return evalCompound(check, cache, now);
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
 * When designated `display`, the headline is a short label for the
 * current state — defaults OK / NOT OK, overridable per check (e.g.
 * RUNNING / STOPPED for an engine-running path where `badWhen:false`
 * means false is the bad state). Stale inputs produce no displayValue
 * (the tile normalizes that to "—", SPEC §3.4).
 *
 * @param {object} check - `{ path, badWhen (default true), okLabel?, notOkLabel?, display?, staleState }`
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
  const okLabel = check.okLabel || "OK";
  const notOkLabel = check.notOkLabel || "NOT OK";
  return {
    state: isBad ? "red" : "green",
    reason: check.reason || (check.display ? "" : check.path),
    displayValue: check.display ? (isBad ? notOkLabel : okLabel) : undefined,
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
  // Each side's warn/crit target state is independently configurable
  // (SPEC §3.3, §2.1): low is typically a deficit (amber/red) and high
  // may be a surplus (opportunity), not both 'bad'. Defaults preserve
  // the historical behavior: warn→amber, crit→red. Crit beats warn
  // regardless of side; within a tier, high is checked before low for
  // deterministic reason text (matches the prior ordering).
  const lowWarnState = check.low?.warnState || "amber";
  const lowCritState = check.low?.critState || "red";
  const highWarnState = check.high?.warnState || "amber";
  const highCritState = check.high?.critState || "red";
  let state = "green";
  let reason = check.reason || check.path;
  if (check.high?.crit != null && v > check.high.crit) {
    state = highCritState;
    reason = check.reason || `${check.path} above ${check.high.crit}`;
  } else if (check.low?.crit != null && v < check.low.crit) {
    state = lowCritState;
    reason = check.reason || `${check.path} below ${check.low.crit}`;
  } else if (check.high?.warn != null && v > check.high.warn) {
    state = highWarnState;
    reason = check.reason || `${check.path} above ${check.high.warn}`;
  } else if (check.low?.warn != null && v < check.low.warn) {
    state = lowWarnState;
    reason = check.reason || `${check.path} below ${check.low.warn}`;
  }
  return {
    state,
    reason,
    displayValue: check.display
      ? formatBandedValue(v, check, cache)
      : undefined,
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
 * value→state row list, with a default for unmapped values (SPEC §3.3).
 *
 * The map is an ARRAY of `{value, state}` rows (not a free-form
 * object): the admin UI's form renderer cannot render
 * additionalProperties objects, but renders array rows fine. The last
 * matching row wins — validation flags duplicates, so in practice at
 * most one row matches.
 *
 * When designated `display`, the raw value itself is the tile's
 * headline text (e.g. "surplus") — a status path has no number to
 * format, the value IS the display (SPEC §3.4). In that case the
 * default `path=value` reason is suppressed: it would restate the
 * headline one line lower ("SURPLUS" over "…STATUS=SURPLUS"). An
 * explicit `reason` still wins when the author wants one. Stale
 * inputs produce no displayValue; the tile normalizes that to "—".
 *
 * @param {object} check - `{ path, map: [{value, state}], default, display?, reason? }`
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
  let state = check.default ?? "neutral";
  for (const entry of check.map || []) {
    if (entry && String(entry.value) === key) state = entry.state;
  }
  return {
    state,
    reason: check.reason || (check.display ? "" : `${check.path}=${key}`),
    displayValue: check.display ? key : undefined,
  };
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
      ? formatDisplayValue(
          v,
          displayUnitsForPath(
            check.path,
            cache.metaFor(check.path)?.displayUnits,
          ),
        )
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
  // When display is requested, surface the observed (path) value as the
  // headline — formatted via displayUnits for numbers, as-is for strings.
  const displayValue = check.display
    ? formatScalar(a, cache, check.path)
    : undefined;
  if (equal) {
    return {
      state: "green",
      reason: check.reason || "agreement",
      displayValue,
    };
  }
  return {
    state: check.mismatchState || "amber",
    reason: `${check.path} ≠ ${check.path2}`,
    displayValue,
  };
}

/**
 * compound: a context-style predicate (reusing evalPredicate) mapped to
 * a single configurable state when true (default amber), green when false
 * (SPEC §3.3). The motivating case for a rule that genuinely cannot be
 * expressed by any single-path check type — e.g. "amber when AC output is
 * zero AND the inverter is on" (the user forgot to leave the inverter
 * running), which spans two independent paths with an AND that no existing
 * check type captures.
 *
 * The predicate reuses the same forms as contexts (path comparisons,
 * allOf/anyOf/not, between), so authoring is consistent and the depth cap
 * from SPEC §9 applies equally. Missingness is handled per-leaf by the
 * predicate's `whenMissing` (default false — fail closed), so an unknown
 * input doesn't silently match.
 *
 * Staleness: a compound check has no single watched path, so the usual
 * single-path staleMs gate doesn't apply. Instead, each referenced path is
 * checked for staleness against the check's staleMs (0 = global default);
 * if ANY referenced path is stale, the check resolves to its staleState
 * (default neutral). This keeps the "missing data is not silently green"
 * principle (SPEC §4) intact for a check that reads multiple paths — a
 * stale inverter-mode reading must not let the predicate silently fail
 * closed and read as a healthy green.
 *
 * @param {object} check - `{ predicate, state (default amber), staleState, staleMs }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {number} now
 * @returns {CheckResult}
 */
function evalCompound(check, cache, now) {
  const threshold = check.staleMs ?? DEFAULT_STALE_MS;
  // Gather referenced paths and fail to staleState if any are stale, so a
  // silent input can't quietly make the predicate not-match into green.
  const paths = collectReferencedPaths(check.predicate);
  for (const p of paths) {
    if (cache.isStale(p, threshold, now)) {
      return staleResult(check, `compound input ${p} stale/absent`);
    }
  }
  const matched = evalPredicate(check.predicate, cache, now);
  if (matched) {
    return {
      state: check.state || "amber",
      reason: check.reason || "compound condition met",
    };
  }
  return {
    state: "green",
    reason: check.reason || "compound condition not met",
  };
}

/**
 * Walks a predicate tree (same shape evalPredicate accepts) and returns
 * the set of paths it references, for staleness checking. Mirrors
 * collectPredicatePaths in paths.js but local to avoid a circular import
 * (paths.js imports from checks.js for CHECK_TYPES).
 *
 * @param {object} pred
 * @returns {Set<string>}
 */
function collectReferencedPaths(pred, out = new Set()) {
  if (!pred || typeof pred !== "object") return out;
  if (pred.path) out.add(pred.path);
  if (pred.valuePath) out.add(pred.valuePath);
  if (pred.between) {
    if (typeof pred.between.from === "string") out.add(pred.between.from);
    if (typeof pred.between.to === "string") out.add(pred.between.to);
  }
  if (Array.isArray(pred.allOf))
    for (const p of pred.allOf) collectReferencedPaths(p, out);
  if (Array.isArray(pred.anyOf))
    for (const p of pred.anyOf) collectReferencedPaths(p, out);
  if (pred.not) collectReferencedPaths(pred.not, out);
  return out;
}

/**
 * Formats a banded value for display. Per SPEC §3.4, each check type
 * that produces a display value formats its own — and the consistent
 * convention across the numeric check types (zone, agreement) is to
 * apply the path's published `meta.displayUnits` (formula + symbol +
 * displayFormat), falling back to the check's inline `unit` only when no
 * metadata is published. A bare number with no metadata and no inline
 * unit is shown as-is.
 *
 * @param {number} v
 * @param {object} check
 * @param {import("./staleness.js").PathCache} cache
 * @returns {string}
 */
function formatBandedValue(v, check, cache) {
  const displayUnits = displayUnitsForPath(
    check.path,
    cache.metaFor(check.path)?.displayUnits,
  );
  if (
    displayUnits?.formula ||
    displayUnits?.displayFormat ||
    displayUnits?.symbol
  ) {
    return formatDisplayValue(v, displayUnits);
  }
  // No published displayUnits metadata: fall back to the check's inline
  // unit (legacy/explicit override path, e.g. a ratio path with no
  // metadata that the author wants shown as a percentage).
  if (check.unit === "%" || check.unit === "ratio")
    return `${Math.round(v * 100)}%`;
  // Other inline units route through the shared formatter as a bare
  // symbol, so SI scaling applies (3190 + "Wh" -> "3.19 kWh").
  if (check.unit) return formatDisplayValue(v, { symbol: check.unit });
  return formatNum(v);
}

function looseEqual(a, b) {
  if (a == null || b == null) return a === b;
  const na = valueToNumber(a);
  const nb = valueToNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

/**
 * Formats a unitless number for display (spreads, levels, bare values
 * with no displayUnits). Uses the shared smart magnitude precision so a
 * glance reads cleanly regardless of magnitude.
 * @param {number} n @returns {string}
 */
function formatNum(n) {
  return formatSmartNumber(n);
}

/**
 * Formats a scalar value for headline display: numbers get display-unit
 * conversion (K→°C, etc.) via the path's metadata; strings and booleans
 * (e.g. state enums like "deployed") are shown as-is.
 *
 * @param {*} raw - the unwrapped value
 * @param {import("./staleness.js").PathCache} cache
 * @param {string} path - path whose metadata supplies displayUnits
 * @returns {string}
 */
function formatScalar(raw, cache, path) {
  const n = valueToNumber(raw);
  if (Number.isFinite(n)) {
    return formatDisplayValue(
      n,
      displayUnitsForPath(path, cache.metaFor(path)?.displayUnits),
    );
  }
  return String(raw);
}
