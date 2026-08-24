/**
 * Frontend entry point: fetches the plugin config, builds the engine,
 * wires the live Signal K stream, and renders the tile grid. Drives the
 * timer-driven re-evaluation tick (the only way staleness is discovered,
 * SPEC §8).
 *
 * Config changes server-side (admin UI edits restart the plugin, which
 * republishes the config hash as a delta — public/lib/config-hash.js)
 * hot-swap the engine in place: re-fetch, rebuild, re-subscribe. No
 * page reload, no blank grid — the old engine keeps evaluating until
 * the new one takes over, and its path cache is carried over so
 * slow-updating paths don't go stale-neutral mid-swap.
 *
 * @file app.js */

import { AnomalyLog } from "./lib/anomaly-log.js";
import { CONFIG_HASH_PATH, configHashFromDelta } from "./lib/config-hash.js";
import { createEngine } from "./lib/engine.js";
import { collectPaths, unwrapConfig } from "./lib/paths.js";
import { fetchVesselName } from "./lib/vessel.js";
import { SignalKStream } from "./st-stream.js";
import "./st-tile-grid.js";

const API_BASE = "/plugins/signalk-status-tiles";
const EVAL_INTERVAL_MS = 1000; // timer-driven staleness discovery tick
/** Config-fetch retries: a plugin restart answers 503 for a moment. */
const CONFIG_RETRIES = 4;
const CONFIG_RETRY_MS = 500;

class StApp extends HTMLElement {
  constructor() {
    super();
    /** @type {object|null} */
    this.config = null;
    /** @type {string|null} hash of the config currently in use */
    this.configHash = null;
    /** @type {import("./lib/engine.js").Engine|null} */
    this.engine = null;
    /** @type {SignalKStream|null} */
    this.stream = null;
    /** @type {number|null} */
    this.timer = null;
    /** Durable across engine rebuilds (SPEC §10). */
    this.anomalyLog = new AnomalyLog(safeLocalStorage());
    /** @type {boolean} reload guard: one re-fetch in flight at a time */
    this.reloading = false;
    this.attachShadow({ mode: "open" });
    const grid = document.createElement("st-tile-grid");
    this.shadowRoot.append(grid);
    /** @type {HTMLElement} */
    this.gridEl = grid;
  }

  async connectedCallback() {
    try {
      const { config, configHash } = await fetchPluginConfig();
      this.config = config;
      this.configHash = configHash;
    } catch (err) {
      this.gridEl.error = `Config load failed: ${err.message}`;
      return;
    }

    // Vessel name: static identity, never re-broadcast as a delta after
    // we subscribe (streams are change-driven), so fetch it once via the
    // standard REST API. The stream subscription below covers a rare
    // live rename; the REST value paints first.
    fetchVesselName().then((name) => {
      if (name) this.gridEl.vessel = name;
    });

    // Reserved overflow slots are layout-time config (SPEC §10/§11.1):
    // set once, before the first evaluation renders the grid — and
    // again on a config reload.
    this.gridEl.slotCount = this.config?.coverage?.slots ?? 1;
    this.#noteConfigState();
    this.engine = this.#buildEngine();

    const fail = (where, err) => {
      console.error(`status-tiles ${where}:`, err);
      this.gridEl.error = `${where}: ${err?.message || err}`;
    };

    // Delta-driven: feed every raw delta into the engine and
    // re-evaluate. A config-hash delta instead triggers a config
    // reload. Link state feeds the chrome bar's connectivity indicator:
    // the stream knows the link died instantly, while staleness takes
    // ~60s to degrade tiles (SPEC §4) — the dot answers "why" right
    // away.
    this.stream = new SignalKStream(
      this.#watchedPaths(),
      (delta) => {
        const hash = configHashFromDelta(delta);
        if (hash && hash !== this.configHash) {
          this.#reloadIfChanged().catch((err) => fail("reloading config", err));
        }
        if (!this.engine) return;
        try {
          this.engine.onDelta(delta);
          this.engine.evaluate();
        } catch (err) {
          fail("evaluating delta", err);
        }
      },
      {
        onStatus: (s) => {
          this.gridEl.link = s.state;
          // On (re)connect: the hash delta may have been missed while
          // the link was down (deltas are change-driven, never
          // replayed), so re-verify instead of running a stale config
          // until the next server-side change. On the initial connect
          // the hash still matches — a no-op fetch.
          if (s.state === "open") {
            this.#reloadIfChanged().catch((err) =>
              console.error("status-tiles verifying config:", err),
            );
          }
        },
      },
    );
    this.stream.connect();

    // Timer-driven: re-evaluate on a fixed interval regardless of new
    // data — the only way staleness is discovered for a silent path.
    this.timer = setInterval(() => {
      try {
        this.engine?.evaluate();
      } catch (err) {
        fail("timer evaluate", err);
      }
    }, EVAL_INTERVAL_MS);

    // Initial paint before any delta arrives.
    try {
      this.engine.evaluate();
    } catch (err) {
      fail("initial evaluate", err);
    }
  }

  disconnectedCallback() {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.stream?.close();
  }

  /**
   * Watched paths: everything the engine needs (contexts, checks,
   * footers, coverage candidates) plus `name` for the chrome bar's
   * vessel identity and the config-hash change signal — same stream,
   * two extra subscriptions.
   * @returns {string[]}
   */
  #watchedPaths() {
    return [
      ...new Set([...collectPaths(this.config), "name", CONFIG_HASH_PATH]),
    ];
  }

  /** Builds an engine for the current config (initial load + reloads). */
  #buildEngine() {
    return createEngine(
      this.config,
      (tiles, coverage, activeContexts) => {
        this.gridEl.tiles = tiles;
        this.gridEl.coverage = coverage;
        this.gridEl.activeContexts = activeContexts;
        const nm = this.engine?.cache.value("name");
        if (typeof nm === "string" && nm) this.gridEl.vessel = nm;
      },
      { anomalyLog: this.anomalyLog },
    );
  }

  /**
   * A config without tiles renders as nothing at all — say so in the
   * error bar instead of showing a silent blank screen (which reads
   * as "no data" rather than "nothing configured").
   */
  #noteConfigState() {
    const tiles = unwrapConfig(this.config)?.tiles;
    this.gridEl.error =
      Array.isArray(tiles) && tiles.length > 0
        ? ""
        : "No tiles configured — add them in the server's plugin settings";
  }

  /**
   * Re-fetches the config and, when the hash differs from what we are
   * running, swaps in a new engine (carrying the path cache over so
   * nothing blanks) and re-subscribes the stream with the new path set.
   * Same hash => no-op, which is what the on-reconnect verification
   * relies on.
   */
  async #reloadIfChanged() {
    if (this.reloading) return;
    this.reloading = true;
    try {
      const { config, configHash } = await fetchPluginConfig();
      if (configHash === this.configHash) return;
      const oldEngine = this.engine;
      this.config = config;
      this.configHash = configHash;
      this.gridEl.slotCount = config?.coverage?.slots ?? 1;
      this.#noteConfigState();
      this.engine = this.#buildEngine();
      if (oldEngine) seedCache(this.engine.cache, oldEngine.cache);
      // Reconnects with the new path set (setPaths closes the socket;
      // the reconnect handler re-verifies the hash — equal now, no-op).
      this.stream?.setPaths(this.#watchedPaths());
      this.engine.evaluate();
    } finally {
      this.reloading = false;
    }
  }
}

customElements.define("st-app", StApp);

/** localStorage when usable, else null (private mode / quota errors). */
function safeLocalStorage() {
  try {
    const s = window.localStorage;
    s.setItem("__st-probe", "1");
    s.removeItem("__st-probe");
    return s;
  } catch {
    return null;
  }
}

/**
 * Fetches the config + its hash, retrying briefly: a config edit
 * restarts the plugin server-side, and fetches racing that restart see
 * a 503 for a moment.
 *
 * Accepts both response shapes: the current `{ config, configHash }`
 * envelope, and the older bare-config body (a server still running the
 * previous plugin code, or a browser-cached app.js served against a
 * new server — `configHash` is null then, and the reload mechanism
 * simply falls back to load-time-only config). A body carrying a
 * `configHash` key is the envelope; user configs never have that key.
 *
 * @returns {Promise<{config: object, configHash: string|null}>}
 */
async function fetchPluginConfig() {
  let lastErr = new Error("not attempted");
  for (let attempt = 0; attempt <= CONFIG_RETRIES; attempt++) {
    if (attempt > 0) await sleep(CONFIG_RETRY_MS);
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (res.ok) {
        const body = await res.json();
        if (body && typeof body === "object" && "configHash" in body) {
          return {
            config:
              body.config && typeof body.config === "object" ? body.config : {},
            configHash:
              typeof body.configHash === "string" ? body.configHash : null,
          };
        }
        return {
          config: body && typeof body === "object" ? body : {},
          configHash: null,
        };
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Copies a previous engine's cache into a freshly built one. */
function seedCache(target, source) {
  for (const [path, entry] of source.entries) {
    target.set(path, entry.value, entry.timestamp);
  }
  for (const [path, meta] of source.meta) {
    target.setMeta(path, meta);
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
