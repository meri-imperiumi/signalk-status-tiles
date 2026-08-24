/**
 * Frontend entry point: fetches the plugin config, builds the engine,
 * wires the live Signal K stream, and renders the tile grid. Drives the
 * timer-driven re-evaluation tick (the only way staleness is discovered,
 * SPEC §8).
 *
 * @file app.js */

import { createEngine } from "./lib/engine.js";
import { collectPaths } from "./lib/paths.js";
import { fetchVesselName } from "./lib/vessel.js";
import { SignalKStream } from "./st-stream.js";
import "./st-tile-grid.js";

const API_BASE = "/plugins/signalk-status-tiles";
const EVAL_INTERVAL_MS = 1000; // timer-driven staleness discovery tick

class StApp extends HTMLElement {
  constructor() {
    super();
    /** @type {object|null} */
    this.config = null;
    /** @type {import("./lib/engine.js").Engine|null} */
    this.engine = null;
    /** @type {SignalKStream|null} */
    this.stream = null;
    /** @type {number|null} */
    this.timer = null;
    this.attachShadow({ mode: "open" });
    const grid = document.createElement("st-tile-grid");
    this.shadowRoot.append(grid);
    /** @type {HTMLElement} */
    this.gridEl = grid;
  }

  async connectedCallback() {
    try {
      const res = await fetch(`${API_BASE}/config`);
      if (!res.ok) {
        this.gridEl.error = `Could not load config (${res.status})`;
        return;
      }
      this.config = await res.json();
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

    // Watched paths: everything the engine needs (contexts, checks,
    // footers, coverage candidates) plus `name` for the chrome bar's
    // vessel identity — same stream, one extra subscription.
    const paths = [...new Set([...collectPaths(this.config), "name"])];
    this.engine = createEngine(
      this.config,
      (tiles, coverage, activeContexts) => {
        this.gridEl.tiles = tiles;
        this.gridEl.coverage = coverage;
        this.gridEl.activeContexts = activeContexts;
        const nm = this.engine.cache.value("name");
        if (typeof nm === "string" && nm) this.gridEl.vessel = nm;
      },
    );

    const fail = (where, err) => {
      console.error(`status-tiles ${where}:`, err);
      this.gridEl.error = `${where}: ${err?.message || err}`;
    };

    // Delta-driven: feed every raw delta into the engine and re-evaluate.
    // Link state feeds the chrome bar's connectivity indicator: the
    // stream knows the link died instantly, while staleness takes ~60s
    // to degrade tiles (SPEC §4) — the dot answers "why" right away.
    this.stream = new SignalKStream(
      paths,
      (delta) => {
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
}

customElements.define("st-app", StApp);
