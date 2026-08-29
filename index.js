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
import { readFileSync } from "node:fs";
import { validateConfig } from "./public/lib/config.js";
import { CONFIG_HASH_PATH, canonicalJson } from "./public/lib/config-hash.js";
import { createEngine } from "./public/lib/engine.js";
import { mergeIntoConfig } from "./public/lib/examples.js";
import { collectPaths, unwrapConfig } from "./public/lib/paths.js";
import { buildSchema } from "./public/lib/schema.js";
import {
  TILE_STATUS_DESCRIPTION,
  tileStatusPath,
} from "./public/lib/status-paths.js";

/**
 * This plugin's own dogfood example set (doc/example-tiles-plan.md): the
 * energy-predictor tiles from SPEC §7.1, self-discovered via the same
 * `statusTileExamples` resource provider any other plugin registers.
 * Read once at module load; a malformed file crashes plugin load on
 * purpose (it ships with the package, so it is always well-formed).
 */
const STARTER_EXAMPLES = JSON.parse(
  readFileSync(new URL("./status-tiles-examples.json", import.meta.url)),
);

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
 * emits nothing.
 */
const STATUS_TICK_MS = 1000;

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
  /** @type {Map<string, string|null>} last status published per tile id */
  const lastPublished = new Map();

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
          running ? { [PLUGIN_ID]: STARTER_EXAMPLES } : {},
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(
              `No such ${EXAMPLES_RESOURCE_TYPE} resource: ${id}`,
            );
          }
          return STARTER_EXAMPLES;
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
        if (lastPublished.get(tile.id) == null) continue;
        values.push({ path: tileStatusPath(tile.id), value: null });
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
    sendTileMeta(tiles);
    subscribeToPaths();
    // Baseline publish before any data arrives (mirrors the webapp's
    // initial paint): absent inputs evaluate to their stale state.
    runEvaluate();
    evalTimer = setInterval(runEvaluate, STATUS_TICK_MS);
  }

  /** Runs one evaluation, isolating errors from the timer/subscription. */
  function runEvaluate() {
    try {
      engine?.evaluate();
    } catch (err) {
      app.error(`Status evaluation error: ${err?.message || err}`);
    }
  }

  /**
   * Engine output callback: publishes each tile's state as a plain
   * string, change-driven. Tiles hidden by an inactive context (SPEC
   * §5, revised) are absent from the output — publish null for them
   * rather than letting the last state linger on the bus.
   *
   * @param {Array<{id: string, state: string}>} tileOut
   */
  function onEngineEval(tileOut) {
    const byId = new Map(tileOut.map((t) => [t.id, t.state]));
    const values = [];
    for (const tile of tiles) {
      const state = byId.get(tile.id) ?? null;
      if (lastPublished.get(tile.id) === state) continue;
      lastPublished.set(tile.id, state);
      values.push({ path: tileStatusPath(tile.id), value: state });
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
        // Delta-driven trigger (SPEC §8): feed the cache, re-evaluate.
        try {
          engine?.onDelta(delta);
          engine?.evaluate();
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
          meta: tileList.map((t) => ({
            path: tileStatusPath(t.id),
            value: {
              displayName: `${t.label || t.id} status`,
              description: TILE_STATUS_DESCRIPTION,
            },
          })),
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
        setStatus?.(`Ready: ${tileCount} tile(s), ${ctxCount} context(s)`);
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
        const { errors } = validateConfig(merged);
        if (errors.length > 0) {
          res.status(400).json({ message: "Merged config is invalid", errors });
          return;
        }
        app.savePluginOptions(merged, (err) => {
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
            restartFn(merged);
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
