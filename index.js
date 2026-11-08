/**
 * Signal K Status Tiles plugin.
 *
 * The server serves the plugin configuration (contexts + tiles) to the
 * webapp via a single REST endpoint, validates it on start, and
 * publishes a hash of the config contents as a delta so connected
 * webapps can reload when the config changes server-side
 * (public/lib/config-hash.js).
 *
 * It also runs the full evaluation engine server-side — the very same
 * one the webapp uses — fed by a subscription to every config-referenced
 * path (the `subscriptionmanager` pattern, see signalk-energy-predictor),
 * driven by both SPEC §8 triggers (delta + timer). Every re-evaluation
 * publishes each tile's aggregated state as a plain string delta under
 * `statusTiles.tiles.<id>` (public/lib/status-paths.js) so instrument
 * panels and other Signal K consumers can read tile status without
 * this plugin's webapp. The webapp keeps evaluating locally: it needs
 * per-check detail (display values, coverage, active contexts) the
 * string status does not carry. See SPEC.md.
 *
 * @file index.js */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerPlotterExtension } from "./plotterext.js";
import { validateConfig } from "./public/lib/config.js";
import { CONFIG_HASH_PATH, canonicalJson } from "./public/lib/config-hash.js";
import { createEngine } from "./public/lib/engine.js";
import { mergeIntoConfig } from "./public/lib/examples.js";
import { collectPaths, unwrapConfig } from "./public/lib/paths.js";
import { buildSchema } from "./public/lib/schema.js";
import {
  TILE_DISPLAY_VALUE_DESCRIPTION,
  TILE_FOOTER_DESCRIPTION,
  TILE_REASON_DESCRIPTION,
  TILE_STATUS_DESCRIPTION,
  tileDisplayValuePath,
  tileFooterPath,
  tileReasonPath,
  tileStatusPath,
} from "./public/lib/status-paths.js";

/** Resource type other plugins (and this one) register example sets under. */
const EXAMPLES_RESOURCE_TYPE = "statusTileExamples";

const PLUGIN_ID = "signalk-status-tiles";

/** Public REST path the config is served at. Mounted on the app (not the
 * plugin router) so anonymous and read-only clients — a helm display
 * hitting the page without logging in — can load it. Routes registered
 * through `registerWithRouter` are admin-only and the reserved `/config`
 * path can't be downgraded; an app-mounted route under the public
 * `/signalk/v2/api/` namespace is the established Signal K pattern for a
 * plugin-provided read endpoint (see @meri-imperiumi/signalk-infodisplay).
 */
const CONFIG_PATH = "/signalk/v2/api/status-tiles/configuration";

/**
 * Timer-driven evaluation tick (SPEC §8): the only way staleness is
 * ever discovered for a path that stopped sending. Same cadence as the
 * webapp's tick; publishing stays change-driven so a quiet system
 * emits nothing. Deliberately slow: every tick is a full-engine
 * evaluation on the server's event loop, and staleness thresholds
 * (default 60s) need no sub-second precision — the cadence only sets
 * the worst-case delay for surfacing a stale tile.
 */
const STATUS_TICK_MS = 5000;

/**
 * Delta-driven evaluations coalesce (SPEC §8): at most one full-engine
 * evaluation per interval, trailing edge, so a burst of deltas costs
 * one evaluation — not one per message. Only *changed* values schedule
 * one at all (engine.onDelta reports per-path value changes).
 */
const EVAL_THROTTLE_MS = 2000;

/**
 * Loopback metadata fallback (released-server compatibility): servers
 * without the plugin-side `getDisplayUnits` API (Oct 2026) still resolve
 * display units for their REST clients — `GET
 * /signalk/v1/api/vessels/self/meta` answers with the live vessel tree's
 * metadata (provider-published zones included) enhanced with each path's
 * resolved displayUnits, the very same answer the webapp's WS meta
 * carries. Fetched once per start (plus on unit-preference changes),
 * with a short bounded retry while the server finishes booting.
 */
const REST_META_PATH = "/signalk/v1/api/vessels/self/meta";
const REST_META_RETRIES = 12;
const REST_META_RETRY_MS = 5_000;
/** Re-fetch schedule after a successful boot fetch: the vessel tree is
 *  still filling at plugin start (baseDeltas replaying, providers
 *  connecting), so the first snapshot can lack zones/displayUnits for
 *  paths whose metadata lands seconds later — seeding it and stopping
 *  there pins the raw formatting in place for the whole run. Each
 *  refresh re-applies and re-publishes; values only move if the
 *  formatting actually changed. */
const REST_META_REFRESH_MS = [30_000, 120_000];
/** Fetch hardening: a self-fetch that hangs must not pin the whole
 * fallback in a pending state — time it out into the retry path. */
const REST_META_FETCH_TIMEOUT_MS = 10_000;
/**
 * The boot-time meta answer only covers paths the live tree already
 * knows (metadata attaches to first-seen values) — watched paths whose
 * first data arrives later are absent. When such a path gets a value,
 * the answer is fetched again; rate-limited (at most one per interval,
 * bounded count per boot) so a genuinely metadata-less path cannot
 * stampede the endpoint.
 */
const META_REFRESH_MIN_INTERVAL_MS = 30_000;
const META_REFRESH_MAX_PER_BOOT = 20;

/**
 * Stable hash of the config contents (sha256 over the canonical
 * serialization). Used as a change token: the webapp compares it
 * against the last hash it saw to decide whether to re-fetch.
 *
 * @param {object} config
 * @returns {string} hex digest
 */
export function configHash(config) {
  return createHash("sha256")
    .update(canonicalJson(config ?? {}))
    .digest("hex");
}

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin} Plugin instance
 */
export default function (app) {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);

  /** @type {object|null} */
  let pluginConfig = null;
  /** @type {string|null} hash of the current config (see configHash) */
  let pluginConfigHash = null;
  /** @type {import("./public/lib/engine.js").Engine|null} server-side engine */
  let engine = null;
  /** @type {Array<object>} tile list of the current config (meta + cleanup) */
  let tiles = [];
  /** @type {Function[]} unsubscribe fns for the delta subscription */
  const unsubscribes = [];
  /** @type {ReturnType<typeof setInterval>|null} staleness tick */
  let evalTimer = null;
  /** @type {Map<string, string|null>} last status published per bus key
   *  — tile id for the state string, `"<id>|dv"` for its display value,
   *  `"<id>|reason"` for its reason line, `"<id>|footer"` for its
   *  footer entries */
  const lastPublished = new Map();
  /** @type {number} Date.now() of the last engine evaluation */
  let lastEvalAt = 0;
  /** @type {ReturnType<typeof setTimeout>|null} trailing evaluation timer */
  let pendingEval = null;
  /** @type {((...args: unknown[]) => void)|null} unit-preferences change
   *  listener (registered while the engine runs; removed on stop) */
  let prefsListener = null;
  /** @type {object|null} cached loopback REST meta answer
   *  (path → metadata entry with resolved displayUnits) */
  let restMetaCache = null;
  /** @type {Promise<unknown>|null} in-flight REST meta fetch (dedupe) */
  let restMetaFetch = null;
  /** @type {number} remaining REST meta retry attempts */
  let restMetaRetries = REST_META_RETRIES;
  /** @type {ReturnType<typeof setTimeout>|null} pending REST meta retry */
  let restMetaRetryTimer = null;
  /** @type {number} scheduled tree-fill refreshes still to run */
  let restMetaRefreshesLeft = REST_META_REFRESH_MS.length;
  /** @type {ReturnType<typeof setTimeout>|null} pending REST meta refresh */
  let restMetaRefreshTimer = null;
  /** @type {"rest"|"api"|"registry"|"none"|null} the deepest metadata
   *  source the seed actually got displayUnits/zones from */
  let metaSeedVia = null;
  /** @type {string|null} the "Ready: …" status prefix the seed suffix
   *  hangs off (null when the last start() had validation errors) */
  let statusBase = null;
  /** @type {boolean} an on-demand metadata refresh is already scheduled */
  let metaRefreshScheduled = false;
  /** @type {boolean} a demand arrived while a fetch was in flight; the
   *  fetch completion re-queues it (its answer may not have covered the
   *  demand — the tree kept filling after the request left) */
  let metaDemandQueued = false;
  /** @type {number} Date.now() of the last on-demand refresh */
  let lastMetaRefreshAt = 0;
  /** @type {number} on-demand refreshes performed this boot */
  let metaRefreshCount = 0;
  /** @type {ReturnType<typeof setTimeout>|null} pending on-demand refresh */
  let metaRefreshTimer = null;
  /** @type {Promise<object>|null} lazy load of the dogfood example set */
  let starterExamples = null;

  // --- Example tile sets (doc/example-tiles-plan.md) ------------------
  // This plugin both *provides* a dogfood set and *consumes* sets from
  // other plugins via the `statusTileExamples` resource type. Provision
  // is gated by `running` (returns {} when stopped) and registered at
  // most once per plugin instance (a re-start without stop is possible);
  // consumption is the webapp's job (it fetches the resources API).
  /** @type {boolean} */
  let running = false;
  /** @type {boolean} resource provider registered with the server */
  let providerRegistered = false;
  /** @type {boolean} plotter-extension provider registered with the server */
  let plotterExtRegistered = false;
  /** @type {Function|null} plotter-extension teardown (empties the listing) */
  let plotterExtTeardown = null;
  /**
   * The `restart` callback `start(config, restart)` receives, captured
   * so the examples copy route can re-apply a merged config in-memory
   * (republishing the config hash → connected webapps reload).
   * @type {((newConfiguration: object) => void)|null}
   */
  let restartFn = null;

  /**
   * Registers this plugin's own `statusTileExamples` resource provider
   * (read-only, running-gated). Idempotent per plugin instance — a
   * re-start reuses the existing registration. Skipped silently on
   * servers without the resource provider registry (older servers);
   * example discovery simply won't include this plugin's dogfood set.
   */
  /**
   * Lazily loads this plugin's own dogfood example set
   * (doc/example-tiles-plan.md): the energy-predictor tiles from SPEC
   * §7.1, self-discovered via the same `statusTileExamples` resource
   * provider any other plugin registers. Read asynchronously on first
   * use — never synchronously on the server's event loop (a plugin
   * must not block the process, even briefly, at module load). A
   * malformed file (it ships with the package, so this should not
   * happen) logs and yields an empty set rather than crashing the
   * server's plugin load.
   */
  function loadStarterExamples() {
    starterExamples ??= readFile(
      new URL("./status-tiles-examples.json", import.meta.url),
      "utf8",
    ).then(
      (json) => JSON.parse(json),
      (err) => {
        app.error(
          `[status-tiles] failed to load example tile set: ${err?.message || err}`,
        );
        return {};
      },
    );
    return starterExamples;
  }

  function registerExamplesProvider() {
    if (providerRegistered) return;
    if (typeof app.registerResourceProvider !== "function") {
      app.error(
        `[status-tiles] server has no resource provider registry; example discovery disabled`,
      );
      return;
    }
    app.registerResourceProvider({
      type: EXAMPLES_RESOURCE_TYPE,
      methods: {
        listResources: async () =>
          running ? { [PLUGIN_ID]: await loadStarterExamples() } : {},
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(
              `No such ${EXAMPLES_RESOURCE_TYPE} resource: ${id}`,
            );
          }
          return loadStarterExamples();
        },
        setResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
        deleteResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`);
        },
      },
    });
    providerRegistered = true;
  }

  /**
   * Registers the plotter-extension provider (read-only, running-gated).
   * Idempotent per plugin instance — a re-start reuses the existing
   * registration; the manifest itself is rebuilt from the live config
   * on every provider call, so tile edits are reflected without
   * re-registering. Skipped silently on servers without the resource
   * provider registry (older servers): no plotter host can discover
   * the extension there, so there is nothing to advertise.
   */
  function registerPlotterExtensionProvider() {
    if (plotterExtRegistered) return;
    if (typeof app.registerResourceProvider !== "function") return;
    plotterExtTeardown = registerPlotterExtension(app, {
      id: PLUGIN_ID,
      getTiles: () => {
        const cfg = unwrapConfig(pluginConfig);
        return Array.isArray(cfg?.tiles) ? cfg.tiles : [];
      },
    });
    plotterExtRegistered = true;
  }

  /**
   * Tears down the server-side evaluation: stops the tick, drops the
   * subscription, and optionally nulls the published statuses so
   * consumers don't keep rendering the last state of a gone tile.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.publishClears] - publish null for every tile
   *   that currently has a non-null status on the bus
   */
  function teardown({ publishClears = false } = {}) {
    if (evalTimer != null) clearInterval(evalTimer);
    evalTimer = null;
    if (pendingEval != null) clearTimeout(pendingEval);
    pendingEval = null;
    if (prefsListener != null) {
      try {
        app.removeListener?.("unitpreferencesChanged", prefsListener);
      } catch {
        // EventEmitter already gone; nothing to detach.
      }
      prefsListener = null;
    }
    if (restMetaRetryTimer != null) clearTimeout(restMetaRetryTimer);
    restMetaRetryTimer = null;
    restMetaRetries = REST_META_RETRIES;
    if (restMetaRefreshTimer != null) clearTimeout(restMetaRefreshTimer);
    restMetaRefreshTimer = null;
    restMetaRefreshesLeft = REST_META_REFRESH_MS.length;
    if (metaRefreshTimer != null) clearTimeout(metaRefreshTimer);
    metaRefreshTimer = null;
    metaRefreshScheduled = false;
    metaRefreshCount = 0;
    metaDemandQueued = false;
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Server already tore the subscription down; nothing to do.
      }
    }
    unsubscribes.length = 0;
    if (publishClears) {
      const values = [];
      for (const tile of tiles) {
        if (lastPublished.get(tile.id) != null) {
          values.push({ path: tileStatusPath(tile.id), value: null });
        }
        if (lastPublished.get(displayKey(tile.id)) != null) {
          values.push({ path: tileDisplayValuePath(tile.id), value: null });
        }
        if (lastPublished.get(reasonKey(tile.id)) != null) {
          values.push({ path: tileReasonPath(tile.id), value: null });
        }
        if (lastPublished.get(footerKey(tile.id)) != null) {
          values.push({ path: tileFooterPath(tile.id), value: null });
        }
      }
      if (values.length > 0) publishStatusValues(values);
    }
    engine = null;
    tiles = [];
    lastPublished.clear();
  }

  /**
   * Builds the engine, publishes path metadata, subscribes to every
   * config-referenced path, and starts the staleness tick. Both SPEC §8
   * triggers funnel into the same evaluate().
   */
  function startStatusEngine() {
    // Defensive: a start() without a preceding stop() (possible when a
    // server restarts the plugin in place) must not double-subscribe.
    teardown({ publishClears: false });
    const cfg = unwrapConfig(pluginConfig);
    tiles = Array.isArray(cfg?.tiles) ? cfg.tiles : [];
    engine = createEngine(pluginConfig, onEngineEval);
    seedPathMeta();
    watchUnitPreferences();
    sendTileMeta(tiles);
    subscribeToPaths();
    // Baseline publish before any data arrives (mirrors the webapp's
    // initial paint): absent inputs evaluate to their stale state.
    runEvaluate();
    evalTimer = setInterval(runEvaluate, STATUS_TICK_MS);
  }

  /** Runs one evaluation, isolating errors from the timer/subscription. */
  function runEvaluate() {
    lastEvalAt = Date.now();
    try {
      engine?.evaluate();
    } catch (err) {
      app.error(`Status evaluation error: ${err?.message || err}`);
    }
  }

  /**
   * Schedules a delta-driven evaluation (SPEC §8), throttled to at most
   * one per EVAL_THROTTLE_MS with a trailing edge: a burst of deltas
   * costs one evaluation, and the final change always lands. Callers
   * only invoke this when the engine reported an actual value change.
   */
  function scheduleDeltaEvaluate() {
    if (pendingEval != null) return;
    const wait = Math.max(0, EVAL_THROTTLE_MS - (Date.now() - lastEvalAt));
    if (wait === 0) {
      runEvaluate();
      return;
    }
    pendingEval = setTimeout(() => {
      pendingEval = null;
      runEvaluate();
    }, wait);
  }

  /**
   * Bus keys under which a tile's reason line / footer entries are
   * change-tracked.
   * @param {string} id - tile id
   * @returns {string}
   */
  function reasonKey(id) {
    return `${id}|reason`;
  }

  function footerKey(id) {
    return `${id}|footer`;
  }

  /**
   * Seeds the engine's path cache with the metadata the webapp gets but
   * the plugin's deltas never replay: `sendMeta=all` (the webapp's WS
   * query) re-sends resolved metadata on every connect, while the
   * plugin's subscriptionmanager deltas carry values only until some
   * provider happens to republish meta after we subscribed — so without
   * seeding, every meta-dependent decision (displayUnits unit
   * conversion, zone classification, footer units) degrades on the
   * published statuses: "4307" instead of "2.3 nmi", a zone-less
   * freshwater check stuck at neutral "N/A" where the webapp says
   * amber "13%".
   *
   * Three sources, most-live-wins per field:
   *
   * 1. `app.getMetadata()` — the path-metadata registry (spec metadata,
   *    user-authored meta, runtime meta deltas). Available on released
   *    servers.
   * 2. The loopback REST meta answer (`queueRestMetaSeed`), overlaid
   *    when it arrives: the live tree's metadata (zones a provider
   *    published before we subscribed) plus the server-resolved
   *    displayUnits the WS meta messages carry. This is what released
   *    servers offer instead of the plugin-side API below.
   * 3. `app.getDisplayUnits()` — the same per-path unit-preference
   *    resolution as (2) without the HTTP hop (Oct 2026 servers).
   *
   * All sources are guarded: whatever a server lacks, the cache keeps
   * whatever the remaining sources provide — a server with none of
   * them degrades to the pre-seeding behavior rather than crashing.
   *
   * @returns {void}
   */
  function seedPathMeta() {
    if (!engine) return;
    const paths = collectPaths(pluginConfig);
    const getMeta =
      typeof app.getMetadata === "function" ? app.getMetadata : null;
    const getDu =
      typeof app.getDisplayUnits === "function" ? app.getDisplayUnits : null;
    let seeded = 0;
    for (const path of paths) {
      const merged = {};
      const registry = getMeta ? getMeta(`vessels.self.${path}`) : undefined;
      if (registry && typeof registry === "object") {
        Object.assign(merged, registry);
      }
      // The REST answer is the more live snapshot: its tree carries
      // provider-published zones and server-resolved displayUnits, so
      // it wins per field over the registry's copy.
      const rest = restMetaCache?.[path];
      if (rest && typeof rest === "object") {
        Object.assign(merged, rest);
      }
      const displayUnits = getDu ? getDu(path) : undefined;
      if (displayUnits) merged.displayUnits = displayUnits;
      if (Object.keys(merged).length > 0) {
        engine.cache.setMeta(path, merged);
        seeded += 1;
      }
    }
    // Status-line visibility: which layer actually carries the units
    // and zones. "registry" means a released server whose answer has
    // no resolved displayUnits — the loopback fetch below upgrades it
    // to "rest" when it lands.
    if (seeded === 0) metaSeedVia = "none";
    else if (restMetaCache) metaSeedVia = "rest";
    else if (getDu) metaSeedVia = "api";
    else metaSeedVia = "registry";
    updateSeedStatus();
    queueRestMetaSeed();
  }

  /**
   * Re-renders the plugin status line with the current metadata-seed
   * source — the glanceable answer to "why do the tiles show raw
   * numbers" (meta via rest/api = converted; registry/none = not).
   *
   * @returns {void}
   */
  function updateSeedStatus() {
    if (statusBase == null) return;
    setStatus?.(`${statusBase} · meta ${metaSeedVia ?? "none"}`);
  }

  /**
   * Fetches the server's own REST meta answer over loopback and applies
   * it to the engine cache (then re-evaluates, so the re-formatted
   * values publish). Deduplicated; a failure retries a bounded number
   * of times (the plugin can start before the HTTP interface finishes
   * booting, and a secured server answers 401 — both degrade to the
   * remaining metadata sources rather than erroring the plugin).
   *
   * @returns {void}
   */
  function queueRestMetaSeed(force = false) {
    if (!running || restMetaFetch || restMetaRetryTimer != null) return;
    // A scheduled tree-fill refresh already covers the need — unless
    // the caller forces (an on-demand refresh for a data-bearing path
    // must not wait out the schedule).
    if (!force && restMetaRefreshTimer != null) return;
    const port = Number(app.config?.settings?.port);
    if (!Number.isFinite(port)) return;
    const url = `http://127.0.0.1:${port}${REST_META_PATH}`;
    const attempt = fetch(url, {
      signal: AbortSignal.timeout(REST_META_FETCH_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((map) => {
        restMetaCache = map && typeof map === "object" ? map : null;
        restMetaRetries = REST_META_RETRIES;
        if (engine) {
          seedPathMeta();
          // Change-driven publishing means format-only changes still
          // need an explicit evaluation pass to be seen.
          runEvaluate();
        }
        // Boot-race backstop: the first snapshot lands while the vessel
        // tree is still filling (it parsed 108 paths where the settled
        // server serves ~400), so keep re-fetching on the refresh
        // schedule. Each landing re-applies and re-publishes; a settled
        // tree makes later snapshots identical and the change-driven
        // publish stays silent.
        if (
          running &&
          engine &&
          restMetaRefreshesLeft > 0 &&
          restMetaRefreshTimer == null
        ) {
          const delay =
            REST_META_REFRESH_MS[
              REST_META_REFRESH_MS.length - restMetaRefreshesLeft
            ];
          restMetaRefreshesLeft -= 1;
          restMetaRefreshTimer = setTimeout(() => {
            restMetaRefreshTimer = null;
            restMetaFetch = null;
            queueRestMetaSeed();
          }, delay);
        }
      })
      .catch((err) => {
        // First failure surfaces as an error (visible in the server log
        // and admin UI — a silent fallback failure would look exactly
        // like the pre-seeding behavior); retries stay quiet.
        if (restMetaRetries === REST_META_RETRIES) {
          app.error(
            `[status-tiles] loopback meta fetch failed (${err?.message || err})`,
          );
        } else {
          app.debug?.(
            `[status-tiles] loopback meta fetch retry failed: ${err?.message || err}`,
          );
        }
        if (!running) return;
        if (restMetaRetries > 0) {
          restMetaRetries -= 1;
          restMetaRetryTimer = setTimeout(() => {
            restMetaRetryTimer = null;
            restMetaFetch = null;
            queueRestMetaSeed();
          }, REST_META_RETRY_MS);
        } else {
          app.error(
            `[status-tiles] loopback meta fetch gave up after ${REST_META_RETRIES} retries — display values will format without unit conversion`,
          );
        }
      });
    restMetaFetch = attempt;
    attempt.finally(() => {
      if (restMetaFetch === attempt) restMetaFetch = null;
      if (metaDemandQueued && running) {
        metaDemandQueued = false;
        queueRestMetaSeed(true);
      }
    });
  }

  /**
   * A watched path received a value but has no cached metadata: it was
   * absent from every meta snapshot so far (metadata attaches to
   * first-seen values in the server's tree, so paths whose first data
   * arrives after boot — a tank level that updates hourly, a sensor
   * that wakes on change — are missing from the boot-time answer and
   * from the fixed tree-fill refreshes). Schedule one rate-limited
   * refresh covering all such paths, so late-first-data paths still
   * format instead of pinning raw numbers for the whole run. The
   * refreshes stop after a bounded count per boot: a path with no
   * metadata anywhere would otherwise trigger one per value change.
   *
   * @returns {void}
   */
  function requestMetaRefresh() {
    if (!running || metaRefreshScheduled) return;
    if (metaRefreshCount >= META_REFRESH_MAX_PER_BOOT) return;
    if (restMetaFetch) {
      // A fetch is already in flight. Its answer may not cover this
      // demand (the tree kept filling after the request left), so the
      // fetch completion re-queues one forced refresh.
      metaDemandQueued = true;
      return;
    }
    const wait = Math.max(
      0,
      META_REFRESH_MIN_INTERVAL_MS - (Date.now() - lastMetaRefreshAt),
    );
    metaRefreshScheduled = true;
    metaRefreshTimer = setTimeout(() => {
      metaRefreshTimer = null;
      metaRefreshScheduled = false;
      lastMetaRefreshAt = Date.now();
      metaRefreshCount += 1;
      // Forced: demand from a data-bearing path outranks the pending
      // tree-fill schedule (which would otherwise swallow the request).
      queueRestMetaSeed(true);
    }, wait);
  }

  /**
   * Re-seeds + re-publishes when the server's unit preferences change:
   * displayUnits are resolved against those preferences, so a units
   * edit (e.g. distance nmi ↔ km) must re-format every headline the
   * same way the webapp's meta re-send does. The listener is removed in
   * teardown(); a plugin restart (config edit) re-registers it.
   *
   * @returns {void}
   */
  function watchUnitPreferences() {
    if (prefsListener != null || typeof app.on !== "function") return;
    prefsListener = () => {
      seedPathMeta();
      // Change-driven publishing means a format-only change still needs
      // an explicit evaluation pass to be seen.
      runEvaluate();
    };
    app.on("unitpreferencesChanged", prefsListener);
  }

  /**
   * Bus key under which a tile's display value is change-tracked.
   * @param {string} id - tile id
   * @returns {string}
   */
  function displayKey(id) {
    return `${id}|dv`;
  }

  /**
   * Engine output callback: publishes each tile's state (and headline
   * display value, SPEC §3.4) as plain scalars, change-driven. Tiles
   * hidden by an inactive context (SPEC §5, revised) are absent from
   * the output — publish null for them rather than letting the last
   * state linger on the bus.
   *
   * @param {Array<{id: string, state: string, displayValue?: string}>} tileOut
   */
  function onEngineEval(tileOut) {
    const byId = new Map(tileOut.map((t) => [t.id, t]));
    const values = [];
    for (const tile of tiles) {
      const t = byId.get(tile.id) ?? null;
      const state = t?.state ?? null;
      if (lastPublished.get(tile.id) !== state) {
        lastPublished.set(tile.id, state);
        values.push({ path: tileStatusPath(tile.id), value: state });
      }
      const dv = t?.displayValue ?? null;
      if (lastPublished.get(displayKey(tile.id)) !== dv) {
        lastPublished.set(displayKey(tile.id), dv);
        values.push({ path: tileDisplayValuePath(tile.id), value: dv });
      }
      const reason = t?.reason ?? null;
      if (lastPublished.get(reasonKey(tile.id)) !== reason) {
        lastPublished.set(reasonKey(tile.id), reason);
        values.push({ path: tileReasonPath(tile.id), value: reason });
      }
      // Footer entries don't fit a scalar leaf, so they ride as a JSON
      // string (the render-side contract, see status-paths.js); empty
      // publishes null so consumers never keep stale entries.
      const footer = t?.footer?.length ? JSON.stringify(t.footer) : null;
      if (lastPublished.get(footerKey(tile.id)) !== footer) {
        lastPublished.set(footerKey(tile.id), footer);
        values.push({ path: tileFooterPath(tile.id), value: footer });
      }
    }
    if (values.length > 0) publishStatusValues(values);
  }

  /**
   * Subscribes to every path the config references (contexts, checks,
   * footers, concrete coverage candidates) — the same set the webapp
   * subscribes to, minus the webapp-only `name`/config-hash paths.
   */
  function subscribeToPaths() {
    const paths = collectPaths(pluginConfig);
    if (!app.subscriptionmanager || paths.length === 0) return;
    app.subscriptionmanager.subscribe(
      {
        context: "vessels.self",
        subscribe: paths.map((path) => ({
          path,
          policy: "instant",
          minPeriod: 1000,
        })),
      },
      unsubscribes,
      (subscriptionError) => {
        app.error(`Subscription error: ${subscriptionError}`);
      },
      (delta) => {
        // Delta-driven trigger (SPEC §8): feed the cache; re-evaluate
        // only when a value actually changed (a quiet system
        // re-broadcasting identical values costs no evaluation), and
        // then no more often than EVAL_THROTTLE_MS.
        try {
          const changed = engine?.onDelta(delta);
          if (changed && changed.size > 0) {
            // A path whose first value just arrived may still lack
            // cached metadata (absent from every meta snapshot so far
            // — see requestMetaRefresh). Queue one rate-limited
            // refresh covering all such paths, so late-first-data
            // paths still format instead of pinning raw numbers.
            for (const path of changed) {
              if (engine.cache.metaFor(path) == null) requestMetaRefresh();
            }
            scheduleDeltaEvaluate();
          }
        } catch (err) {
          app.error(`Status evaluation error: ${err?.message || err}`);
        }
      },
    );
  }

  /**
   * Publishes metadata (displayName/description) for every tile status
   * path so instrument panels render labels instead of raw paths.
   *
   * @param {Array<{id: string, label?: string}>} tileList
   */
  function sendTileMeta(tileList) {
    if (tileList.length === 0) return;
    app.handleMessage?.(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          meta: tileList.flatMap((t) => [
            {
              path: tileStatusPath(t.id),
              value: {
                displayName: `${t.label || t.id} status`,
                description: TILE_STATUS_DESCRIPTION,
              },
            },
            {
              path: tileDisplayValuePath(t.id),
              value: {
                displayName: `${t.label || t.id} display value`,
                description: TILE_DISPLAY_VALUE_DESCRIPTION,
              },
            },
            {
              path: tileReasonPath(t.id),
              value: {
                displayName: `${t.label || t.id} reason`,
                description: TILE_REASON_DESCRIPTION,
              },
            },
            {
              path: tileFooterPath(t.id),
              value: {
                displayName: `${t.label || t.id} footer`,
                description: TILE_FOOTER_DESCRIPTION,
              },
            },
          ]),
        },
      ],
    });
  }

  /**
   * Publishes tile status values as one delta (batching every change
   * from a single evaluation into a single update).
   *
   * @param {Array<{path: string, value: string|null}>} values
   */
  function publishStatusValues(values) {
    app.handleMessage?.(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          source: { label: PLUGIN_ID },
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
  }

  const plugin = {
    id: PLUGIN_ID,
    name: "Status Tiles",
    description:
      "Reduce raw Signal K paths to a small grid of context-aware status tiles",

    /**
     * JSON Schema for the admin-UI config editor. Contexts and tiles live
     * as arrays directly in the config; checks are a discriminated union
     * keyed on `type` (SPEC §9).
     */
    schema: buildSchema(),

    /**
     * Starts the plugin. Validates config and records it for the REST
     * endpoint, then starts the server-side evaluation engine: a
     * subscription to every config-referenced path drives it (SPEC §8
     * delta trigger), alongside a timer tick for staleness discovery.
     *
     * @param {object} config - Plugin configuration
     * @param {(newConfiguration: object) => void} restart - server-provided
     *   callback to re-apply a config in-memory (republishes the config
     *   hash → connected webapps reload). Captured for the examples copy route.
     */
    start(config, restart) {
      const { errors, warnings } = validateConfig(config);
      // The server app has no `warn` (only error/debug/setPluginStatus) —
      // warnings are advisory, so no-op rather than crash when absent.
      for (const w of warnings) app.warn?.(w);
      if (errors.length > 0) {
        // Surface every error; the server still starts so the user can
        // fix the form rather than being locked out.
        for (const e of errors) app.error(e);
        setStatus?.(`Started with ${errors.length} config error(s)`);
      } else {
        const tileCount = config?.tiles?.length ?? 0;
        const ctxCount = config?.contexts?.length ?? 0;
        statusBase = `Ready: ${tileCount} tile(s), ${ctxCount} context(s)`;
        setStatus?.(statusBase);
      }
      pluginConfig = config || {};
      pluginConfigHash = configHash(pluginConfig);
      running = true;
      restartFn = typeof restart === "function" ? restart : null;
      app.debug?.(`[status-tiles] start() configHash=${pluginConfigHash}`);
      // Register this plugin's dogfood example-set provider (idempotent
      // per instance; running-gated). Other plugins' sets are discovered
      // by the webapp via the resources API — nothing to do here for those.
      registerExamplesProvider();
      // Plotter-extension provider: one widget per configured tile,
      // manifest rebuilt from the live config on every provider call.
      registerPlotterExtensionProvider();
      // Public config endpoint. Mounted on the app (not the plugin
      // router) so anonymous/read-only clients can load it; see
      // CONFIG_PATH. Registered in start() so the route is live only
      // while the plugin is running.
      registerConfigEndpoint(
        app,
        () => pluginConfig,
        () => pluginConfigHash,
      );
      // Signal config changes to connected webapps. Server-side edits
      // restart the plugin (stop + start), so start() is exactly the
      // moment a new config becomes visible: publish its hash as a
      // delta on the same stream the webapp already consumes, and the
      // webapp re-fetches the config when the hash differs from what
      // it loaded (public/lib/config-hash.js).
      app.handleMessage?.(PLUGIN_ID, {
        context: "vessels.self",
        updates: [
          {
            timestamp: new Date().toISOString(),
            values: [{ path: CONFIG_HASH_PATH, value: pluginConfigHash }],
          },
        ],
      });
      // Server-side evaluation + publication of per-tile statuses as
      // plain string deltas (public/lib/status-paths.js).
      startStatusEngine();
    },

    stop() {
      // Null out the published statuses so consumers don't keep
      // rendering tiles that no longer evaluate.
      teardown({ publishClears: true });
      pluginConfig = null;
      pluginConfigHash = null;
      running = false;
      restartFn = null;
      // Empties the plotterExtensions listing so hosts tear the widget
      // contexts down (the static asset mount stays; Express has no
      // unmount, and the files are inert).
      plotterExtTeardown?.();
      plotterExtTeardown = null;
      setStatus?.("Stopped");
    },

    /**
     * Admin routes for copying example tile sets into the active config
     * (doc/example-tiles-plan.md). Mounted by the server at
     * `/plugins/${PLUGIN_ID}`; every route here is admin-gated by default.
     *
     * - `GET /examples` — admin probe: the webapp uses a 200 vs 401/403 to
     *   decide whether to show the chrome-bar "+" (read-only users can
     *   read the resources API but must not see the copy affordance). The
     *   set list itself comes from the resources API, not this route.
     * - `PUT /examples` — copy a set's tiles/contexts into the stored
     *   config. The body is the set object `{ contexts?, tiles }` (the
     *   webapp already has the full objects from the resources fetch);
     *   an admin can already edit the config arbitrarily, so trusting the
     *   body lowers no security floor. Merges skip-and-report per id
     *   (idempotent re-add), validates the merged config, persists via
     *   `savePluginOptions`, and re-applies in-memory via `restart` so the
     *   config-hash reload path refreshes connected webapps.
     *
     * @param {import("express-serve-static-core").Router} router
     */
    registerWithRouter(router) {
      router.get("/examples", (_req, res) => {
        res.json({ ok: true });
      });

      router.put("/examples", (req, res) => {
        const set = req?.body;
        if (
          !set ||
          typeof set !== "object" ||
          !Array.isArray(set.tiles) ||
          set.tiles.length === 0
        ) {
          res.status(400).json({
            message: "Body must be a set object with a non-empty tiles array",
          });
          return;
        }
        if (typeof restartFn !== "function") {
          res.status(503).json({ message: "Plugin not started" });
          return;
        }
        const stored = app.readPluginOptions();
        const { merged, added, skipped } = mergeIntoConfig(stored, set);
        // `app.readPluginOptions()` returns the server's own envelope
        // shape (`{ configuration, enabled }`); mergeIntoConfig detects
        // that and round-trips it in `merged` (its documented, unit-
        // tested contract). But `app.savePluginOptions()` and the
        // `restart` callback both expect the *bare* inner config — the
        // same shape `start(config)` itself receives — and wrap it
        // themselves on persist. Handing them the still-wrapped
        // `merged` therefore nested the stored config one level deeper
        // on every single call, silently corrupting it after repeated
        // Add clicks (issue #1). Unwrap once here, at the point of use,
        // rather than changing what mergeIntoConfig returns.
        const mergedInner = unwrapConfig(merged);
        const { errors } = validateConfig(mergedInner);
        if (errors.length > 0) {
          res.status(400).json({ message: "Merged config is invalid", errors });
          return;
        }
        app.savePluginOptions(mergedInner, (err) => {
          if (err) {
            app.error(
              `[status-tiles] failed to save merged examples config: ${err?.message || err}`,
            );
            res.status(500).json({
              message: "Failed to save",
              error: err?.message || String(err),
            });
            return;
          }
          // Belt and braces: persist above, re-apply in-memory here. The
          // restart republishes the config hash → connected webapps
          // reload. Whether restart alone persists varies across server
          // versions, so savePluginOptions is called regardless.
          try {
            restartFn(mergedInner);
          } catch (e) {
            app.error(
              `[status-tiles] restart() threw after examples merge: ${e?.message || e}`,
            );
          }
          res.json({ added, skipped });
        });
      });
    },
  };

  return plugin;
}

/**
 * Mounts the public config endpoint on the app. A bare `app.get` under
 * `/signalk/v2/api/` is the Signal K convention for a plugin-provided
 * read endpoint reachable by anonymous clients; the plugin router would
 * gate the same path behind admin auth (and the reserved `/config` path
 * can't be downgraded at all).
 */
function registerConfigEndpoint(app, getConfig, getConfigHash) {
  app.get(CONFIG_PATH, (_req, res) => {
    const config = getConfig();
    if (!config) {
      res.status(503).json({ message: "Plugin not started" });
      return;
    }
    // Never cache: a config edit restarts the plugin and the
    // configHash changes, but the URL stays the same. A browser
    // that serves a stale cached 200 would hand back the OLD hash,
    // which equals the webapp's current hash => the reload becomes
    // a no-op and the new config never applies.
    res.set("Cache-Control", "no-store");
    res.json({ config, configHash: getConfigHash() });
  });
}

export { buildSchema, CONFIG_PATH, PLUGIN_ID, validateConfig };
