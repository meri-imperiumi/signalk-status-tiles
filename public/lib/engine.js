/**
 * Top-level evaluation engine. Owns the PathCache, the context index, and
 * the tile list. The webapp feeds deltas into it (`onDelta`) and drives a
 * timer tick (`onTick`) for staleness discovery (SPEC §8). It produces the
 * structured per-tile output (SPEC §6) on every re-evaluation.
 *
 * This module is framework-free: no DOM, no WebSocket. The webapp wires
 * it to the stream; tests drive it directly.
 *
 * @file engine.js */

import { evalPredicate } from "./context.js";
import { AnomalyTracker, claimedPaths, detectAnomalies } from "./coverage.js";
import { unwrapConfig } from "./paths.js";
import { DEFAULT_STALE_MS, PathCache } from "./staleness.js";
import { evalTile } from "./tile.js";

/**
 * @typedef {object} Engine
 * @property {import("./staleness.js").PathCache} cache - shared path cache
 * @property {Map<string, object>} contexts - id → context object
 * @property {(delta: object) => Set<string>} onDelta - feed a raw delta into the cache, returns changed paths
 * @property {(now?: number) => void} evaluate - re-evaluate all tiles + coverage, call onEval
 */

/**
 * Creates an engine bound to a config. Re-create on config reload.
 *
 * @param {object} config - `{ contexts, tiles, coverage, staleMs }`
 * @param {(tiles: Array, coverage: Array, activeContexts: Array<{id: string, label: string}>) => void} [onEval] - called on
 *   every re-evaluation with the structured tile outputs, surfaced
 *   coverage anomalies, and the currently-active contexts (chrome bar)
 * @param {object} [options]
 * @param {import("./anomaly-log.js").AnomalyLog} [options.anomalyLog] - durable log for
 *   coverage anomalies (SPEC §10); every detected anomaly is recorded,
 *   surfaced or not. Absent => no logging.
 * @returns {Engine}
 */
export function createEngine(config, onEval, options = {}) {
  const cfg = unwrapConfig(config);
  const cache = new PathCache();
  const contexts = new Map((cfg?.contexts || []).map((c) => [c.id, c]));
  const tiles = cfg?.tiles || [];
  const globalStaleMs = cfg?.staleMs ?? DEFAULT_STALE_MS;

  // Wrap each check so a missing per-check staleMs falls back to the
  // global default rather than the hardcoded constant. Keeps a single
  // source of truth for the staleness threshold (SPEC §4).
  const tilesWithDefaults = tiles.map((t) => ({
    ...t,
    checks: (t.checks || []).map((c) => ({
      ...c,
      staleMs: c.staleMs ?? globalStaleMs,
    })),
  }));

  /** Coverage hysteresis/ranking state (SPEC §10) + durable log. */
  const tracker = new AnomalyTracker({
    surfaceMs: cfg?.coverage?.surfaceMs,
    clearMs: cfg?.coverage?.clearMs,
  });
  const anomalyLog = options.anomalyLog ?? null;
  const slotCount = cfg?.coverage?.slots ?? 1;

  /**
   * Feeds a raw Signal K delta into the cache. Only path-bearing values
   * and meta blocks are consumed. Returns the set of paths that changed
   * (for the caller to decide whether to trigger a re-eval).
   *
   * @param {object} delta
   * @returns {Set<string>} changed paths
   */
  function onDelta(delta) {
    const changed = new Set();
    for (const update of delta?.updates || []) {
      const ts = update.timestamp
        ? new Date(update.timestamp).getTime()
        : Date.now();
      for (const v of update.values || []) {
        cache.set(v.path, v.value, ts);
        changed.add(v.path);
      }
      for (const m of update.meta || []) {
        cache.setMeta(m.path, m.value);
      }
    }
    return changed;
  }

  /**
   * Re-evaluates all tiles + coverage and calls onEval. Called both by
   * the delta-driven path (when a watched path changes) and by the
   * timer-driven tick (the only way staleness is discovered, SPEC §8).
   *
   * @param {number} [now]
   */
  function evaluate(now = Date.now()) {
    // Context gating (SPEC §5, deliberately revised): a tile whose
    // context is currently inactive is OMITTED from the output
    // entirely — not rendered neutral. A helm display showing every
    // off-duty tile as a dimmed panel gets too busy; the tile
    // reappears (with fresh evaluation) the moment its context turns
    // active. Tiles with no context, or referencing an unknown
    // context id (a config error, flagged by validation), always
    // evaluate.
    const tileOut = [];
    for (const t of tilesWithDefaults) {
      const ctx = t.context ? contexts.get(t.context) : null;
      if (ctx && !evalPredicate(ctx.predicate, cache, now)) continue;
      tileOut.push(evalTile(t, cache, contexts, now));
    }

    // Active contexts for the chrome bar: every declared context whose
    // predicate currently holds (label falls back to id). Rendered by
    // the UI next to the vessel name — "the boat's current situation"
    // is exactly what contexts express (SPEC §3.1).
    const activeContexts = [];
    for (const [id, ctx] of contexts) {
      if (evalPredicate(ctx.predicate, cache, now)) {
        activeContexts.push({ id, label: ctx.label || id });
      }
    }

    // Coverage: compute currently-inactive-context-owned paths so they
    // count as unclaimed for this tick (SPEC §10).
    const inactiveContextPaths = computeInactiveContextPaths(now);
    const claimed = claimedPaths(cfg, inactiveContextPaths);
    const anomalies = detectAnomalies(cfg, cache, claimed, now);
    const { surfaced, events } = tracker.update(anomalies, slotCount, now);
    // Durable log: every episode is recorded, surfaced or not (SPEC §10).
    for (const ev of events) {
      if (ev.type === "opened") anomalyLog?.record(ev, now);
      else anomalyLog?.clear(ev.path, ev.clearedAt);
    }

    onEval?.(tileOut, surfaced, activeContexts);
  }

  /**
   * Paths owned only by tiles whose context is currently inactive. These
   * are "claimed-but-not-currently-evaluated" — treated as unclaimed for
   * the duration the context is inactive (SPEC §10).
   *
   * @param {number} now
   * @returns {Set<string>}
   */
  function computeInactiveContextPaths(now) {
    const out = new Set();
    for (const tile of tilesWithDefaults) {
      if (!tile.context) continue;
      const ctx = contexts.get(tile.context);
      if (ctx && !evalPredicate(ctx.predicate, cache, now)) {
        for (const check of tile.checks || []) {
          for (const p of checkPaths(check)) out.add(p);
        }
      }
    }
    return out;
  }

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

  return { cache, contexts, onDelta, evaluate };
}
