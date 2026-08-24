/**
 * Tile aggregation (SPEC §3.2). A tile's state is the worst state among
 * its checks, `neutral` ranking below amber/red.
 *
 * Context gating is NOT done here: the engine omits inactive-context
 * tiles from its output entirely (SPEC §5, revised) before this
 * function runs. evalTile only handles the config-error case of a
 * tile referencing an unknown context id.
 *
 * @file tile.js */

import { evalCheck } from "./checks.js";
import { worst } from "./states.js";
import { formatDisplayValue, valueToNumber } from "./util.js";

/**
 * Evaluates a single tile against the cache. Returns the structured tile
 * value (SPEC §6 output #1): `{ state, label, reason, displayValue, timestamp }`.
 *
 * Only called for tiles the engine has already decided to show: a tile
 * whose context is currently inactive never reaches this function —
 * the engine hides it outright (SPEC §5, revised: a dimmed
 * off-duty tile is busywork on a helm display). When a context IS
 * active, checks run normally, including going stale/neutral or red
 * if inputs disappear while the context is active.
 *
 * Display value (SPEC §3.4): at most one check is designated `display`;
 * its formatted value becomes the tile's headline number. A stale check's
 * display value is replaced with an explicit "unknown" marker (dash), not
 * the frozen last reading.
 *
 * @param {object} tile - `{ id, label, context?, checks, size? }`
 * @param {import("./staleness.js").PathCache} cache
 * @param {Map<string, object>} contexts - id → context object (only
 *   consulted for the unknown-context-id config error)
 * @param {number} [now]
 * @returns {{id: string, state: import("./checks.js").TileState, label: string, reason: string, displayValue?: string, timestamp: number}}
 */
export function evalTile(tile, cache, contexts, now = Date.now()) {
  const timestamp = now;

  // Config error (flagged by validation): tile references a context
  // that doesn't exist. Render neutral with the reason so the problem
  // is visible on screen, not silently hidden.
  if (tile.context && !contexts.get(tile.context)) {
    return {
      id: tile.id,
      state: "neutral",
      label: tile.label || tile.id,
      reason: `unknown context ${tile.context}`,
      timestamp,
    };
  }

  // Run all checks; worst state wins.
  let state = "neutral";
  let reason = "";
  let displayValue;
  for (const check of tile.checks || []) {
    const r = evalCheck(check, cache, now);
    state = worst(state, r.state);
    // The reason tracks the check that produced the worst state. Since
    // `worst` returns the more severe, keep the reason of whichever
    // check is currently the worst. A later equal-severity check does
    // not overwrite (first-wins keeps the reason stable).
    if (r.state === state && !reason) reason = r.reason;
    if (check.display) {
      displayValue = r.displayValue;
    }
  }

  // Stale display value: if the designated display check's input is
  // stale, show "—" not the frozen last reading (SPEC §3.4). The check's
  // own evalCheck already returns no displayValue when stale, so
  // displayValue is undefined here when stale — normalize to "—".
  const displayCheck = (tile.checks || []).find((c) => c.display);
  if (displayCheck) {
    const staleMs = displayCheck.staleMs;
    if (cache.isStale(displayCheck.path ?? displayCheck.path2, staleMs, now)) {
      displayValue = "—";
    } else if (displayValue == null) {
      displayValue = "—";
    }
  }

  const footer = resolveFooter(tile.footer, cache);

  return {
    id: tile.id,
    state,
    label: tile.label || tile.id,
    reason: reason || (state === "green" ? "ok" : ""),
    displayValue,
    footer,
    timestamp,
  };
}

/**
 * Resolves a tile's footer entries — small subordinate readouts shown
 * beneath the headline (e.g. "Port 164W Starboard 158W" under a Solar
 * "Good 358W" headline). Each entry is a plain path lookup formatted via
 * the path's displayUnits metadata when available. Absent/stale paths
 * show "—". Footer is informational only and never affects tile state.
 *
 * Unit resolution (so SI scaling applies, SPEC §3.4 readability): the
 * path's published `displayUnits` metadata wins; the standard `meta.units`
 * field serves as a symbol fallback; the entry's inline `unit` is the
 * last resort. Any known symbol lets 3190 Wh render as "3.19 kWh".
 *
 * @param {Array<{label?: string, path: string, unit?: string}>} [footer]
 * @param {import("./staleness.js").PathCache} cache
 * @returns {Array<{label: string, value: string}>}
 */
function resolveFooter(footer, cache) {
  if (!Array.isArray(footer) || footer.length === 0) return [];
  const out = [];
  for (const f of footer) {
    if (!f?.path) continue;
    const meta = cache.metaFor(f.path);
    let value;
    if (!cache.has(f.path)) {
      value = "—";
    } else {
      const raw = cache.value(f.path);
      const n = valueToNumber(raw);
      // Numeric values get display-unit conversion (K→°C, etc.).
      // Strings/booleans (e.g. state enums like "deployed") are shown as-is.
      value = Number.isFinite(n)
        ? formatDisplayValue(n, footerUnits(meta, f.unit))
        : String(raw);
    }
    out.push({ label: f.label || f.path, value });
  }
  return out;
}

/**
 * Unit source for footer formatting: published displayUnits metadata
 * first (needs at least one usable field), then the standard `meta.units`
 * field as a bare symbol, then the entry's inline `unit`.
 *
 * @param {object|undefined} meta
 * @param {string} [inlineUnit]
 * @returns {object|undefined}
 */
function footerUnits(meta, inlineUnit) {
  const du = meta?.displayUnits;
  if (du?.formula || du?.symbol || du?.displayFormat) return du;
  if (meta?.units) return { symbol: meta.units };
  if (inlineUnit) return { symbol: inlineUnit };
  return undefined;
}
