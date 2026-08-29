/**
 * Example tile sets from other plugins (doc/example-tiles-plan.md).
 *
 * Plugins ship ready-made example tiles by registering a read-only
 * `statusTileExamples` resource provider; this plugin fetches the
 * aggregated collection from the standard resources API and copies a
 * chosen set's tiles/contexts into the active config via the admin PUT
 * endpoint (index.js).
 *
 * This module is pure and browser-safe: defensive parsing of the
 * collection a bad provider might return, the skip-and-report merge
 * into a config (SPEC §11.1 declaration order preserved), and the
 * "already added" marker for the picker. No fetch, no server APIs —
 * those live in index.js (server) and app.js (webapp).
 *
 * @file examples.js */

import { unwrapConfig } from "./paths.js";

/**
 * Whether a set entry is shaped well enough to offer: a non-empty
 * `id` and `name`, and a non-empty `tiles` array. Contexts are
 * optional (a set may ship tiles only). Defensive — a malformed entry
 * from a bad provider is skipped, never thrown over.
 *
 * @param {*} entry
 * @returns {boolean}
 */
function isValidSet(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (typeof entry.name !== "string" || entry.name === "") return false;
  if (!Array.isArray(entry.tiles) || entry.tiles.length === 0) return false;
  if (entry.contexts != null && !Array.isArray(entry.contexts)) return false;
  return true;
}

/**
 * Flattens the resources-API collection (keyed by providing plugin id)
 * into a list of `{ source, set }`. Defensive: skips providers and
 * individual sets whose shape is wrong, never throws — one bad citizen
 * must not break the picker.
 *
 * A provider may return either `{ sets: [...] }` (the examples-file
 * shape) or the sets array directly under its plugin id; both are
 * accepted.
 *
 * @param {*} collection - the raw object from `GET /resources/statusTileExamples`
 * @returns {Array<{source: string, set: object}>}
 */
export function flattenExamplesCollection(collection) {
  const out = [];
  if (!collection || typeof collection !== "object") return out;
  for (const [source, providerPayload] of Object.entries(collection)) {
    const sets = Array.isArray(providerPayload)
      ? providerPayload
      : providerPayload?.sets;
    if (!Array.isArray(sets)) continue;
    for (const set of sets) {
      if (!isValidSet(set)) continue;
      out.push({ source, set });
    }
  }
  return out;
}

/**
 * Whether a config is the `{ configuration, enabled }` envelope the
 * admin UI / server sometimes hands us (see paths.js unwrapConfig).
 * Mirrors that helper's detection so the merge round-trips the same
 * shape it received.
 *
 * @param {*} config
 * @returns {boolean}
 */
function isWrapped(config) {
  return (
    config &&
    typeof config === "object" &&
    "configuration" in config &&
    !("contexts" in config) &&
    !("tiles" in config)
  );
}

/**
 * Merges a set's contexts and tiles into a config, skipping (not
 * overwriting) any whose id already exists — re-adding a set is
 * idempotent, and a user's edits to a copied tile are never clobbered
 * by a second copy action. Declaration order is preserved: new items
 * are appended after the existing ones (SPEC §11.1 config-order
 * packing). Nothing is ever removed by a copy.
 *
 * Does not validate — the caller runs `validateConfig()` on the merged
 * config before persisting (unknown check types, bad shapes, and
 * straddles introduced by mixing the set with the live config are
 * caught there, not here). Preserves the wrapper shape of the input so
 * `savePluginOptions` / `restart` round-trip the same form.
 *
 * @param {object} config - current config (wrapped or unwrapped)
 * @param {{contexts?: Array, tiles?: Array}} set
 * @returns {{merged: object, added: {contexts: Array, tiles: Array}, skipped: {contexts: Array, tiles: Array}}}
 */
export function mergeIntoConfig(config, set) {
  const wrapped = isWrapped(config);
  const inner = unwrapConfig(config);
  const existingContexts = Array.isArray(inner.contexts) ? inner.contexts : [];
  const existingTiles = Array.isArray(inner.tiles) ? inner.tiles : [];

  const ctxIds = new Set(
    existingContexts.map((c) => c?.id).filter((id) => typeof id === "string"),
  );
  const tileIds = new Set(
    existingTiles.map((t) => t?.id).filter((id) => typeof id === "string"),
  );

  const inContexts = Array.isArray(set?.contexts) ? set.contexts : [];
  const inTiles = Array.isArray(set?.tiles) ? set.tiles : [];

  const addedContexts = [];
  const skippedContexts = [];
  const mergedContexts = [...existingContexts];
  for (const c of inContexts) {
    const id = c?.id;
    if (typeof id === "string" && ctxIds.has(id)) {
      skippedContexts.push(id);
      continue;
    }
    mergedContexts.push(c);
    if (typeof id === "string") {
      ctxIds.add(id);
      addedContexts.push(id);
    }
  }

  const addedTiles = [];
  const skippedTiles = [];
  const mergedTiles = [...existingTiles];
  for (const t of inTiles) {
    const id = t?.id;
    if (typeof id === "string" && tileIds.has(id)) {
      skippedTiles.push(id);
      continue;
    }
    mergedTiles.push(t);
    if (typeof id === "string") {
      tileIds.add(id);
      addedTiles.push(id);
    }
  }

  const mergedInner = {
    ...inner,
    contexts: mergedContexts,
    tiles: mergedTiles,
  };
  const merged = wrapped
    ? { ...config, configuration: mergedInner }
    : mergedInner;
  return {
    merged,
    added: { contexts: addedContexts, tiles: addedTiles },
    skipped: { contexts: skippedContexts, tiles: skippedTiles },
  };
}

/**
 * Which sets in a flattened collection are already fully present in
 * the config — every one of the set's tile ids exists in the config's
 * tiles. Used by the picker to badge sets the user has already copied.
 * A set whose tiles carry no ids is never "already added."
 *
 * @param {Array<{source: string, set: object}>} flat
 * @param {object} config
 * @returns {Set<string>} set ids that are fully added
 */
export function fullyAddedSetIds(flat, config) {
  const inner = unwrapConfig(config);
  const tileIds = new Set(
    (Array.isArray(inner.tiles) ? inner.tiles : [])
      .map((t) => t?.id)
      .filter((id) => typeof id === "string"),
  );
  const out = new Set();
  for (const { set } of flat) {
    const ids = (set.tiles || [])
      .map((t) => t?.id)
      .filter((id) => typeof id === "string");
    if (ids.length === 0) continue;
    if (ids.every((id) => tileIds.has(id))) out.add(set.id);
  }
  return out;
}
