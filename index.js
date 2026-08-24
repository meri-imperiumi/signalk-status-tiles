/**
 * Signal K Status Tiles plugin.
 *
 * The server side is intentionally thin: it serves the plugin configuration
 * (contexts + tiles) to the webapp via a single REST endpoint and validates
 * it on start. On every start it publishes a hash of the config contents as
 * a delta so connected webapps can reload when the config changes
 * server-side (public/lib/config-hash.js). All evaluation — context
 * predicates, checks, staleness, tile aggregation, coverage — runs in the
 * webapp, which subscribes to the Signal K stream directly. See SPEC.md.
 *
 * @file index.js */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

import { createHash } from "node:crypto";
import { validateConfig } from "./public/lib/config.js";
import { CONFIG_HASH_PATH, canonicalJson } from "./public/lib/config-hash.js";
import { buildSchema } from "./public/lib/schema.js";

const PLUGIN_ID = "signalk-status-tiles";

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
     * endpoint. The server subscribes to nothing — the webapp streams
     * directly (SPEC §6, §8).
     *
     * @param {object} config - Plugin configuration
     */
    start(config) {
      const { errors, warnings } = validateConfig(config);
      for (const w of warnings) app.warn(w);
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
      app.debug?.(`[status-tiles] start() configHash=${pluginConfigHash}`);
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
    },

    stop() {
      pluginConfig = null;
      pluginConfigHash = null;
      setStatus?.("Stopped");
    },

    /**
     * Serves the current config to the webapp, plus the candidate-path
     * patterns for the coverage layer (SPEC §10). The webapp fetches this
     * on load to build its subscription set and evaluation engine.
     * `configHash` is the same change token published as a delta on
     * start, so the webapp has a baseline to compare against.
     *
     * @param {object} router - Express router mounted at /plugins/<id>
     */
    registerWithRouter(router) {
      router.get("/config", (_req, res) => {
        if (!pluginConfig) {
          res.status(503).json({ message: "Plugin not started" });
          return;
        }
        // Never cache: a config edit restarts the plugin and the
        // configHash changes, but the URL stays the same. A browser
        // that serves a stale cached 200 would hand back the OLD hash,
        // which equals the webapp's current hash => the reload becomes
        // a no-op and the new config never applies.
        res.set("Cache-Control", "no-store");
        res.json({ config: pluginConfig, configHash: pluginConfigHash });
      });
    },
  };

  return plugin;
}

export { buildSchema, PLUGIN_ID, validateConfig };
