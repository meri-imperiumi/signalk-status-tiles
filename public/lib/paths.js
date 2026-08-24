/**
 * Collects every Signal K path referenced by a config (contexts, checks,
 * and the coverage candidate list), de-duplicated.
 *
 * A single path referenced by three checks yields one entry here, so the
 * webapp opens one subscription and maintains one cache entry for it. The
 * evaluation engine reads from that shared cache.
 *
 * @file paths.js */

/**
 * Returns the inner config, unwrapping the `{ configuration, enabled }`
 * envelope the Signal K admin UI / server sometimes hands us. The server's
 * `start(config)` is documented to receive the inner configuration, but in
 * practice the REST endpoint and some server versions expose the wrapped
 * form `{ configuration: {...}, enabled: true }`. Unwrap defensively so the
 * same code handles both shapes.
 *
 * @param {object} config
 * @returns {object} the inner config (or the input as-is if not wrapped)
 */
export function unwrapConfig(config) {
  if (
    config &&
    typeof config === "object" &&
    "configuration" in config &&
    !("contexts" in config) &&
    !("tiles" in config)
  ) {
    return config.configuration || {};
  }
  return config || {};
}

/**
 * Walks a context predicate tree and yields every path it references.
 * Recursive over allOf/anyOf/not. Respects the depth cap (SPEC §9):
 * callers should not construct trees deeper than MAX_DEPTH, but this
 * walker is not itself the enforcer — validation is.
 *
 * @param {object} pred - A context predicate node
 * @param {Set<string>} out
 * @returns {void}
 */
function collectPredicatePaths(pred, out) {
  if (!pred || typeof pred !== "object") return;
  if (pred.path) out.add(pred.path);
  if (pred.valuePath) out.add(pred.valuePath);
  if (pred.between) {
    if (pred.between.from && typeof pred.between.from === "string")
      out.add(pred.between.from);
    if (pred.between.to && typeof pred.between.to === "string")
      out.add(pred.between.to);
  }
  if (Array.isArray(pred.allOf))
    for (const p of pred.allOf) collectPredicatePaths(p, out);
  if (Array.isArray(pred.anyOf))
    for (const p of pred.anyOf) collectPredicatePaths(p, out);
  if (pred.not) collectPredicatePaths(pred.not, out);
}

/**
 * Returns the set of paths a single check references. Different check
 * types read different paths (differential reads two, alarmGroup reads a
 * list, agreement reads two, etc.).
 *
 * @param {object} check
 * @param {Set<string>} out
 * @returns {void}
 */
function collectCheckPaths(check, out) {
  if (!check || typeof check !== "object") return;
  switch (check.type) {
    case "boolean":
    case "banded":
    case "zone":
    case "stateMatch":
      if (check.path) out.add(check.path);
      break;
    case "differential":
    case "agreement":
      if (check.path) out.add(check.path);
      if (check.path2) out.add(check.path2);
      break;
    case "alarmGroup":
      for (const p of check.paths || []) if (p) out.add(p);
      if (check.levelPath) out.add(check.levelPath);
      break;
    case "notification":
      if (check.path) out.add(check.path);
      break;
  }
}

/**
 * Collects every path referenced by a full config — contexts, tiles'
 * checks, and coverage candidates — de-duplicated.
 *
 * @param {object} config - `{ contexts, tiles, coverage }`
 * @returns {string[]} de-duplicated path list, insertion-ordered
 */
export function collectPaths(config) {
  const cfg = unwrapConfig(config);
  const out = new Set();
  for (const ctx of cfg?.contexts || []) {
    collectPredicatePaths(ctx?.predicate, out);
  }
  for (const tile of cfg?.tiles || []) {
    for (const check of tile?.checks || []) collectCheckPaths(check, out);
    for (const f of tile?.footer || []) {
      if (f?.path) out.add(f.path);
    }
  }
  // Coverage candidates: explicit include-list/patterns only (SPEC §10).
  // Patterns are not literal paths here; only concrete strings without
  // wildcards become subscriptions. Patterns are expanded elsewhere.
  for (const c of cfg?.coverage?.candidates || []) {
    if (typeof c === "string" && !c.includes("*")) out.add(c);
  }
  return [...out];
}

export { collectCheckPaths, collectPredicatePaths };
