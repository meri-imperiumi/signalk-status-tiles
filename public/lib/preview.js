/**
 * Preview rendering for example tile sets (doc/example-tiles-plan.md).
 *
 * The examples picker shows each set's tiles as a live preview. Rather
 * than a static neutral card, the preview runs the REAL tile evaluator
 * (`evalTile`, the same function the live engine calls) against
 * synthesized healthy sample data — a representative value for every
 * check-referenced path — so each tile renders with its actual state,
 * headline value, footer labels, and color. The user sees what the tile
 * looks like in action, not an empty grey box.
 *
 * Context gating is bypassed: every tile in the set is rendered
 * (`evalTile` is called directly per tile), because the picker previews
 * the set's tiles, not the boat's current situation. A context the set
 * ships is consulted only for the unknown-context-id config-error check
 * (so a mis-authored set still shows its tiles, not a silent blank).
 *
 * The synthesized data aims for a healthy (green) state and, where the
 * check is `display`, a representative headline value. A check type
 * that cannot be honestly satisfied from config alone (a `compound`
 * predicate, a `zone` relying on unpublished metadata, a `stateMatch`
 * with no green-mapped value) contributes nothing — its tile falls
 * back to its stale/neutral state, which is the honest "can't preview
 * this without its data" rendering rather than a fabricated green.
 *
 * Pure and browser-safe: no DOM, no fetch. The webapp calls
 * `previewTiles(set)` and hands the rendered tiles to the grid.
 *
 * @file preview.js */

import { PathCache } from "./staleness.js";
import { evalTile } from "./tile.js";

/**
 * A healthy notification: maps to `green` via the default severity map
 * (normal → green). Carries a short message so a `reason` (shown for
 * non-green states) reads sensibly if a custom map routes it elsewhere.
 */
const SAMPLE_NOTIFICATION = Object.freeze({ state: "normal", message: "ok" });

/**
 * Mirrors the module-local `ZONE_DEFAULT_MAP` in checks.js (not
 * exported) so a zone check without an explicit `severityMap` is
 * previewed with the same severity→state mapping the live evaluator
 * uses. Keep in sync if that default changes.
 */
const ZONE_DEFAULT_MAP = {
  nominal: "green",
  alert: "green",
  warn: "amber",
  alarm: "red",
  emergency: "red",
};

/**
 * Synthesizes a representative (healthy, green-aiming) value for a
 * single check's path(s). Returns a `{path: value}` map. Best-effort:
 * aims for green and, where the check is `display`, a representative
 * displayValue. A check type that cannot be honestly satisfied from
 * config alone contributes nothing (see the file doc).
 *
 * @param {object} check
 * @returns {Record<string, unknown>}
 */
export function sampleValuesForCheck(check) {
  if (!check || typeof check !== "object") return {};
  switch (check.type) {
    case "notification":
      // normal → green via the default severity map.
      return check.path ? { [check.path]: { ...SAMPLE_NOTIFICATION } } : {};
    case "boolean": {
      // badWhen defaults true (true is the bad state); feed the OK value.
      const bad = check.badWhen !== false;
      return check.path ? { [check.path]: !bad } : {};
    }
    case "banded":
      return check.path ? { [check.path]: sampleBandedValue(check) } : {};
    case "differential":
      // Equal values → |diff| 0, below any positive warn threshold → green.
      return { [check.path]: 0, [check.path2]: 0 };
    case "agreement": {
      // Matching values → green. A short status word reads as a
      // plausible headline for a `display` agreement (state enums,
      // mode comparisons) without inventing a domain-specific value.
      const v = "ok";
      return { [check.path]: v, [check.path2]: v };
    }
    case "stateMatch": {
      // Feed a value that maps to green, if the map defines one. A
      // map with no green row can't be honestly previewed green —
      // contribute nothing and let the check resolve to its default.
      const map = Array.isArray(check.map) ? check.map : [];
      const green = map.find((e) => e && (e.state ?? "neutral") === "green");
      return green && green.value != null && check.path
        ? { [check.path]: green.value }
        : {};
    }
    case "zone": {
      // Feed a value inside the first green INLINE zone, if any. A zone
      // relying on unpublished metadata can't be previewed green —
      // contribute nothing (the check returns neutral "no zones").
      const zones = Array.isArray(check.zones) ? check.zones : [];
      const smap = check.severityMap || ZONE_DEFAULT_MAP;
      const green = zones.find((z) => {
        const mapped = z ? (smap[z.state] ?? "neutral") : "neutral";
        return mapped === "green";
      });
      if (green && check.path) {
        const v = green.lower != null ? green.lower : (green.upper ?? 0);
        return { [check.path]: v };
      }
      return {};
    }
    case "alarmGroup": {
      // No alarm tripped (all false) → green; a level path comfortably
      // above its warn threshold stays green too.
      const out = {};
      for (const p of check.paths || []) out[p] = false;
      if (check.levelPath) {
        const base = check.levelWarn ?? check.levelCrit ?? 0;
        out[check.levelPath] = Number.isFinite(base) ? base + 10 : 100;
      }
      return out;
    }
    case "compound":
      // A compound's predicate can't be satisfied synthetically in
      // general (it may AND several path comparisons); feed nothing.
      // The check resolves to its staleState (default neutral) — the
      // honest "can't preview" rendering rather than a fake green.
      return {};
    default:
      return {};
  }
}

/**
 * Picks a representative value in a banded check's healthy band
 * (between low.warn and high.warn). For ratio/percent paths, 0.85
 * (→ "85%") is a typical healthy reading. Falls back to the midpoint
 * of a two-sided band, or a sensible offset when only one side is
 * bounded; an unbounded check gets an arbitrary healthy default.
 *
 * @param {object} check
 * @returns {number}
 */
function sampleBandedValue(check) {
  if (check.unit === "%" || check.unit === "ratio") return 0.85;
  const lowWarn = check.low?.warn;
  const highWarn = check.high?.warn;
  if (lowWarn != null && highWarn != null) return (lowWarn + highWarn) / 2;
  if (lowWarn != null) return lowWarn + 10;
  if (highWarn != null) return Math.max(0, highWarn - 10);
  return 50;
}

/**
 * Renders a set's tiles as live previews: synthesizes healthy sample
 * data for every check-referenced path, then evaluates each tile
 * through the real `evalTile` (bypassing context gating so every tile
 * in the set shows). Returns the rendered tile array — the same shape
 * the live engine emits (`{id, state, label, reason, displayValue,
 * footer, timestamp}`) — ready to hand to the grid's #buildTile.
 *
 * Footer and displayParts paths are intentionally left unfed: they
 * render their labels with "—" values (the honest add-time appearance
 * for subordinate readouts), and a composed headline omits absent
 * parts — matching how the tile looks the moment it's added, while the
 * headline and state come from representative sample data.
 *
 * @param {{contexts?: Array, tiles?: Array}} set
 * @returns {Array<object>}
 */
export function previewTiles(set) {
  const contexts = new Map(
    (Array.isArray(set?.contexts) ? set.contexts : []).map((c) => [c?.id, c]),
  );
  const tiles = Array.isArray(set?.tiles) ? set.tiles : [];
  const cache = new PathCache();
  const now = Date.now();
  for (const tile of tiles) {
    for (const check of tile?.checks || []) {
      const samples = sampleValuesForCheck(check);
      for (const [path, value] of Object.entries(samples)) {
        cache.set(path, value, now);
      }
    }
  }
  // evalTile per tile (not the engine's evaluate) so context gating is
  // bypassed: every tile in the set previews, regardless of whether its
  // context's predicate currently holds against the sample data.
  return tiles.map((tile) => {
    try {
      return evalTile(tile, cache, contexts, now);
    } catch {
      // A malformed tile must not blank the whole set's preview.
      return {
        id: tile?.id,
        label: tile?.label || tile?.id,
        state: "neutral",
        reason: "",
        timestamp: now,
      };
    }
  });
}
