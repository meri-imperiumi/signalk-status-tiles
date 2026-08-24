/**
 * Signal K Status Tiles plugin.
 *
 * The server side is intentionally thin: it serves the plugin configuration
 * (contexts + tiles) to the webapp via a single REST endpoint and validates
 * it on start. All evaluation — context predicates, checks, staleness,
 * tile aggregation, coverage — runs in the webapp, which subscribes to the
 * Signal K stream directly. See SPEC.md.
 *
 * @file index.js */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

import { validateConfig } from "./public/lib/config.js";
import { buildSchema } from "./public/lib/schema.js";

const PLUGIN_ID = "signalk-status-tiles";

/**
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin} Plugin instance
 */
export default function (app) {
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);

  /** @type {object|null} */
  let pluginConfig = null;

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
    },

    stop() {
      pluginConfig = null;
      setStatus?.("Stopped");
    },

    /**
     * Serves the current config to the webapp, plus the candidate-path
     * patterns for the coverage layer (SPEC §10). The webapp fetches this
     * on load to build its subscription set and evaluation engine.
     *
     * @param {object} router - Express router mounted at /plugins/<id>
     */
    registerWithRouter(router) {
      router.get("/config", (_req, res) => {
        if (!pluginConfig) {
          res.status(503).json({ message: "Plugin not started" });
          return;
        }
        res.json(pluginConfig);
      });
    },
  };

  return plugin;
}

export { buildSchema, PLUGIN_ID, validateConfig };
