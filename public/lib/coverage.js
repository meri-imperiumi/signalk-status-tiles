/**
 * Coverage layer (SPEC §10): continuously checks paths NOT claimed by any
 * tile's checks against those paths' own zone metadata, and surfaces any
 * outside nominal. Handles the "claimed-but-not-currently-evaluated" case
 * (a path claimed only by a context-gated tile whose context is inactive
 * is treated as unclaimed for the duration the context is inactive).
 *
 * Output is a bounded list of overflow anomalies with hysteresis, plus a
 * durable log entry for every detected anomaly (surfaced or not).
 *
 * NOTE: this module is the detection core. The webapp owns the timer
 * loop that drives re-evaluation and the slot-ranking policy; it calls
 * `detectAnomalies` on each timer tick and feeds the result through
 * `rankAndAssign` to produce the surfaced list.
 *
 * @file coverage.js */

import { unwrapConfig } from "./paths.js";
import { DEFAULT_STALE_MS } from "./staleness.js";
import { valueToNumber } from "./util.js";

const ZONE_SEVERITY_MAP = {
  nominal: "green",
  alert: "green",
  warn: "amber",
  alarm: "red",
  emergency: "red",
};

/**
 * Computes the set of paths claimed by any tile's checks. A path is
 * claimed regardless of whether its tile's context is currently active;
 * the "claimed-but-not-currently-evaluated" distinction is handled
 * separately by the caller (it passes an extra "inactiveContextPaths"
 * set so those are temporarily un-claimed).
 *
 * @param {object} config
 * @param {Set<string>} [inactiveContextPaths] - paths owned only by
 *   tiles whose context is currently inactive (treated as unclaimed)
 * @returns {Set<string>}
 */
export function claimedPaths(config, inactiveContextPaths = new Set()) {
  const cfg = unwrapConfig(config);
  const out = new Set();
  for (const tile of cfg?.tiles || []) {
    for (const check of tile?.checks || []) {
      for (const p of checkPaths(check)) {
        if (!inactiveContextPaths.has(p)) out.add(p);
      }
    }
  }
  return out;
}

/**
 * Collects the paths a single check references (mirrors paths.js but
 * local to keep coverage self-contained).
 *
 * @param {object} check
 * @returns {string[]}
 */
function checkPaths(check) {
  switch (check?.type) {
    case "differential":
    case "agreement":
      return [check.path, check.path2].filter(Boolean);
    case "alarmGroup":
      return [...(check.paths || []), check.levelPath].filter(Boolean);
    default:
      return check?.path ? [check.path] : [];
  }
}

/**
 * Detects unclaimed anomalies among the candidate paths. Only warn/alarm/
 * emergency zone states trigger surfacing (SPEC §10); alert-level noise
 * should not. Stale candidates are skipped (no false alarm from silence).
 *
 * @param {object} config
 * @param {import("./staleness.js").PathCache} cache
 * @param {Set<string>} claimed
 * @param {number} [now]
 * @returns {Array<{path: string, state: "amber"|"red", zone: string, value: number}>}
 */
export function detectAnomalies(config, cache, claimed, now = Date.now()) {
  const cfg = unwrapConfig(config);
  const candidates = cfg?.coverage?.candidates || [];
  const out = [];
  for (const c of candidates) {
    // Candidates may be literal paths or patterns; only literals are
    // resolvable from the cache. Patterns would need server-side path
    // enumeration (out of scope for the first cut).
    if (typeof c !== "string" || c.includes("*")) continue;
    if (claimed.has(c)) continue;
    const threshold = cfg?.coverage?.staleMs ?? DEFAULT_STALE_MS;
    if (cache.isStale(c, threshold, now)) continue;
    const v = valueToNumber(cache.value(c));
    if (!Number.isFinite(v)) continue;
    const zones = cache.metaFor(c)?.zones || [];
    const smap = cfg?.coverage?.severityMap || ZONE_SEVERITY_MAP;
    for (const z of zones) {
      const lower = z.lower != null ? z.lower : -Infinity;
      const upper = z.upper != null ? z.upper : Infinity;
      if (v >= lower && v <= upper) {
        const zoneName = z.state || "nominal";
        const mapped = smap[zoneName] ?? "green";
        if (mapped === "amber" || mapped === "red") {
          out.push({ path: c, state: mapped, zone: zoneName, value: v });
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Ranks anomalies for slot assignment when more exist than slots, and
 * returns which anomalies are surfaced vs. bumped (SPEC §10). Ranking:
 * severity first (red before amber), then longest-since-first-detected
 * (oldest anomaly wins a slot, so a transient that's been showing wins
 * over a brand-new one of equal severity).
 *
 * `firstSeen` is a Map<path, number> maintained by the caller across
 * ticks (the persistence of anomaly start time).
 *
 * @param {Array} anomalies
 * @param {Map<string, number>} firstSeen - path → ms epoch first detected
 * @param {number} slotCount
 * @param {number} now
 * @returns {{surfaced: Array, bumped: Array}}
 */
export function rankAndAssign(anomalies, firstSeen, slotCount, now) {
  const ranked = [...anomalies].sort((a, b) => {
    if (a.state !== b.state) return a.state === "red" ? -1 : 1; // red first
    const fa = firstSeen.get(a.path) ?? now;
    const fb = firstSeen.get(b.path) ?? now;
    return fa - fb; // oldest first
  });
  const surfaced = ranked.slice(0, slotCount);
  const bumped = ranked.slice(slotCount);
  return { surfaced, bumped };
}
