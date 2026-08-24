/**
 * Coverage layer (SPEC §10): continuously checks paths NOT claimed by any
 * tile's checks against those paths' own zone metadata, and surfaces any
 * outside nominal. Handles the "claimed-but-not-currently-evaluated" case
 * (a path claimed only by a context-gated tile whose context is inactive
 * is treated as unclaimed for the duration the context is inactive).
 *
 * Output is a bounded list of overflow anomalies with hysteresis
 * (AnomalyTracker), plus open/clear events for the durable anomaly log
 * (SPEC §10): every detected anomaly is recorded, surfaced or not —
 * including ones bumped by something more severe.
 *
 * NOTE: this module is the detection core. The webapp owns the timer
 * loop that drives re-evaluation; the engine calls `detectAnomalies` on
 * each tick and feeds the result through its `AnomalyTracker`, which
 * time-gates surfacing/clearing and ranks for the bounded slot set.
 *
 * @file coverage.js */

import { unwrapConfig } from "./paths.js";
import { DEFAULT_STALE_MS } from "./staleness.js";
import { valueToNumber } from "./util.js";

/** Default dwell before an unclaimed anomaly takes an overflow slot. */
export const DEFAULT_SURFACE_MS = 10_000;
/** Default dwell after an anomaly stops being detected before its slot
 * is freed — longer than surfaceMs so a flickering value holds the slot
 * rather than churning it (SPEC §10 hysteresis). */
export const DEFAULT_CLEAR_MS = 30_000;

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
 * Hysteresis + ranking state machine for overflow slots (SPEC §10).
 *
 * Debounces both directions so a zone-crossing value can't churn a slot:
 * - **Surfacing**: an anomaly must be detected continuously for
 *   `surfaceMs` before it is eligible for a slot — a sub-dwell blip
 *   never takes one.
 * - **Clearing**: once detection stops, the anomaly *holds* its
 *   eligibility for `clearMs` (re-detection during the window cancels
 *   the clear seamlessly) before it vacates. A value flickering across
 *   the zone boundary keeps the slot instead of blinking it.
 *
 * Ranking when more eligible anomalies exist than slots: severity
 * first (red before amber), then longest-since-first-detected. Extras
 * are "bumped" — not surfaced, but still logged (via the returned
 * events / the caller's durable log), never silently dropped.
 */
export class AnomalyTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.surfaceMs]
   * @param {number} [opts.clearMs]
   */
  constructor(opts = {}) {
    this.surfaceMs = opts.surfaceMs ?? DEFAULT_SURFACE_MS;
    this.clearMs = opts.clearMs ?? DEFAULT_CLEAR_MS;
    /** @type {Map<string, {state: string, zone: string, value: number, firstSeen: number, lastSeen: number, clearingSince: number|null}>} */
    this.known = new Map();
  }

  /**
   * Feeds one tick's detected anomalies; returns slot assignment and
   * log events.
   *
   * @param {Array<{path: string, state: string, zone: string, value: number}>} detected
   * @param {number} slotCount
   * @param {number} [now]
   * @returns {{surfaced: Array<{path: string, state: string, zone: string, value: number, firstSeen: number}>, bumped: Array, events: Array<{type: "opened"|"cleared", path: string}>}}
   */
  update(detected, slotCount, now = Date.now()) {
    const events = [];
    const seen = new Set(detected.map((d) => d.path));

    for (const d of detected) {
      const k = this.known.get(d.path);
      if (!k) {
        this.known.set(d.path, {
          state: d.state,
          zone: d.zone,
          value: d.value,
          firstSeen: now,
          lastSeen: now,
          clearingSince: null,
        });
        events.push({ type: "opened", path: d.path, ...d, firstSeen: now });
      } else {
        // Refresh state/value; re-detection cancels a pending clear.
        k.state = d.state;
        k.zone = d.zone;
        k.value = d.value;
        k.lastSeen = now;
        k.clearingSince = null;
      }
    }

    // Start/finish clears for anomalies no longer detected.
    for (const [path, k] of this.known) {
      if (seen.has(path)) continue;
      if (k.clearingSince == null) k.clearingSince = now;
      if (now - k.clearingSince >= this.clearMs) {
        this.known.delete(path);
        events.push({ type: "cleared", path, clearedAt: now });
      }
    }

    // Slot-eligible: dwelled past surfaceMs. Entries inside their clear
    // window are still eligible (they hold the slot against flicker);
    // ones that never reached surfaceMs aren't (a blip stays invisible).
    const eligible = [];
    for (const [path, k] of this.known) {
      if (now - k.firstSeen >= this.surfaceMs) {
        eligible.push({
          path,
          state: k.state,
          zone: k.zone,
          value: k.value,
          firstSeen: k.firstSeen,
        });
      }
    }
    eligible.sort((a, b) => {
      if (a.state !== b.state) return a.state === "red" ? -1 : 1;
      return a.firstSeen - b.firstSeen;
    });

    return {
      surfaced: eligible.slice(0, slotCount),
      bumped: eligible.slice(slotCount),
      events,
    };
  }
}
