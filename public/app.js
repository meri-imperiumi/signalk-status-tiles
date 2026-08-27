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
import {
  applyMode,
  ENVIRONMENT_MODE_PATH,
  fetchEnvironmentMode,
  modeFromDelta,
} from "./lib/mode.js";
import { collectPaths, unwrapConfig } from "./lib/paths.js";
import { fetchVesselName } from "./lib/vessel.js";
import { SignalKStream } from "./st-stream.js";
import "./st-tile-grid.js";

const API_BASE = "/signalk/v2/api/status-tiles";
const EVAL_INTERVAL_MS = 1000; // timer-driven staleness discovery tick
/** Config-fetch retries: a plugin restart answers 503 for a moment. */
const CONFIG_RETRIES = 4;
const CONFIG_RETRY_MS = 500;
/**
 * Poll the config hash for changes. The hash-delta over the stream is
 * the fast path, but it depends on the server delivering a delta for a
 * non-schema path (`statusTiles.configHash` under vessels.self), which
 * not all Signal K server versions do. The poll is the reliable
 * backstop: a config save is rare, so a light GET every few seconds is
 * cheap and catches the change regardless of stream behavior.
 */
const CONFIG_POLL_MS = 5000;

/**
 * Debug logging, off by default. Enable with `?st-debug=1` in the URL
 * or `localStorage.stDebug = "1"`. Prints the config-hash lifecycle
 * (boot, delta, poll, reload decision) so a config change that isn't
 * reaching the screen can be traced in the browser console.
 */
const ST_DEBUG = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const p = new URLSearchParams(window.location.search || "").get("st-debug");
    return p === "1" || window.localStorage?.stDebug === "1";
  } catch {
    return false;
  }
})();
function dbg(...args) {
  if (ST_DEBUG) console.log("[status-tiles]", ...args);
}

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
      dbg("boot configHash=", configHash);
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

    // Day/night mode drives the palette via data-mode on <html>. Like
    // the name, environment.mode is typically set long before we
    // subscribe, so the initial value comes from REST; the delta
    // subscription covers live changes (e.g. an automatic day/night
    // switch). The served HTML defaults to "day" — the kiosk must
    // never boot dim.
    fetchEnvironmentMode().then((mode) => {
      if (mode) applyMode(mode);
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
        if (hash) dbg("delta configHash=", hash, "current=", this.configHash);
        if (hash && hash !== this.configHash) {
          if (this.configHash === null) {
            // First hash we've seen (REST /configuration didn't give us one —
            // see fetchPluginConfig). Adopt it as the baseline instead
            // of reloading: this delta describes the config the page
            // already booted with, not a change.
            this.configHash = hash;
            dbg("adopted first delta hash as baseline");
          } else {
            // A real change. The delta hash is content-addressed
            // (canonical JSON), so a differing value is authoritative
            // — reload directly, no re-fetch needed (REST may not even
            // serve a hash on this server).
            dbg("delta differs -> reloading page");
            window.location.reload();
          }
        }
        // Theme mode changes ride the same deltas: applying data-mode
        // to <html> re-skins every tile through CSS variables — no
        // per-tile repainting, no layout work. Independent of the
        // engine: the theme must follow mode even if evaluation is
        // erroring.
        const mode = modeFromDelta(delta);
        if (mode) applyMode(mode);
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

    // Poll-driven config reload (reliable backstop to the stream hash
    // delta, which some servers drop for the non-schema path).
    this.pollTimer = setInterval(
      () =>
        this.#reloadIfChanged().catch((err) =>
          console.error("status-tiles poll:", err),
        ),
      CONFIG_POLL_MS,
    );

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
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
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
      ...new Set([
        ...collectPaths(this.config),
        "name",
        CONFIG_HASH_PATH,
        ENVIRONMENT_MODE_PATH,
      ]),
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
   * A config change (server-side edit restarting the plugin) is
   * handled the simple, reliable way: a full page reload. In-page
   * hot-swapping is attractive but fragile (stream re-subscription
   * races, stale sockets, cached fetches), and on a helm display a
   * config save is rare enough that a reload beats a half-applied
   * config. The hash is content-addressed (canonical JSON), so a
   * differing hash is always a real change — never a spurious reload.
   *
   * Same hash => no-op, which is what the on-reconnect verification
   * (catching a hash delta missed while the link was down) relies on.
   */
  async #reloadIfChanged() {
    if (this.reloading) return;
    this.reloading = true;
    try {
      const { configHash } = await fetchPluginConfig();
      dbg("reload-check fetched=", configHash, "current=", this.configHash);
      if (!configHash) {
        // REST isn't serving a hash (older server, or a stale
        // handler). The stream delta is the source of truth in that
        // case; nothing to compare here.
        dbg("no hash from REST -> no reload");
        return;
      }
      if (configHash === this.configHash) {
        dbg("hash matches -> no reload");
        return;
      }
      if (this.configHash === null) {
        // First real hash from REST: adopt as baseline, don't reload
        // (the delta path may have set this already; harmless to set
        // again to the same value).
        this.configHash = configHash;
        dbg("adopted first REST hash as baseline");
        return;
      }
      // A real change: reload the whole app — fresh config, fresh
      // stream, fresh cache. Guard against a reload loop: we did NOT
      // update this.configHash, so a reconnect verify during the
      // dying page still sees the OLD hash and won't re-trigger; the
      // fresh page boots with the new hash as its baseline.
      dbg("hash differs -> reloading page");
      window.location.reload();
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
      const res = await fetch(`${API_BASE}/configuration`);
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

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
