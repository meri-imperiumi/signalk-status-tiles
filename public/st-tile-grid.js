/**
 * Full-viewport tile grid renderer (SPEC §11). Expanse-style HUD aesthetic:
 * dark bridge, high-contrast emissive panels, angular corner brackets,
 * condensed labels. The state palette is Grafana's dark-theme set — full
 * colors rather than a shared HSL hue ramp — because the display this
 * runs on (a dim nav-station screen) washes out subtle saturation
 * differences; these are the colors already proven readable there.
 * Neutral is visually distinct from green — rendered
 * as a dimmed outline panel rather than a lit color, so "no judgment
 * possible" never reads as "fine" (SPEC §11).
 *
 * Packing is deterministic and layout-time-only (SPEC §11.1): recomputed
 * only on config/screen change, never on a state change. This first cut
 * uses a CSS grid sized in viewport units; richer multi-size packing
 * arrives later.
 *
 * @file st-tile-grid.js */

export const STATE_COLOR = {
  // Grafana dark-theme state colors, chosen for a dim nav-station
  // display: high lightness and saturation survive a washed-out screen.
  green: "#73bf69", // Grafana success green
  amber: "#ffaa00", // Grafana warning yellow
  red: "#f2495c", // Grafana critical red
  // SPEC §2.1/§11: opportunity is its own branch, not a rung on the
  // green→amber→red ramp. Grafana's cyan reads as "different in kind"
  // rather than a milder amber or bonus green.
  opportunity: "#6ed0e0",
};

/**
 * "#73bf69" → "115, 191, 105" — the r/g/b triple for
 * rgba(var(--c-rgb), α) derivations in CSS. Comma form so it works in
 * any browser that supports custom properties at all.
 * @param {string} hex
 */
export function colorTriple(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

class StTileGrid extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #05070a;
        color: #d8e2ee;
        font-family: "Eurostile", "Bank Gothic", "Oswald", system-ui, sans-serif;
        --tile-radius: clamp(0.8vw, 1vw, 1.4vh);
      }
      /* Chrome band (SPEC §11.1): constant-height top strip holding
         vessel identity, active contexts, and the link indicator — plus
         the clock on the right. Always present and fixed-height, so the
         tile grid below never re-flows when its contents change. Its
         content is subordinate chrome (SPEC §11.2): small, low-contrast,
         never competing with tiles for a glance. */
      .chrome {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5vw;
        flex: 0 0 auto;
        height: 4.6vh;
        padding: 0 2vw;
        border-bottom: 1px solid #141d28;
        background: #070b11;
        font-size: 1.9vh;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        white-space: nowrap;
        overflow: hidden;
      }
      .chrome-left,
      .chrome-right {
        display: flex;
        align-items: center;
        gap: 1.2vw;
        min-width: 0;
        overflow: hidden;
      }
      .vessel {
        font-weight: 700;
        color: #c7d6e6;
        letter-spacing: 0.22em;
      }
      .vessel:empty::after {
        content: "—";
        color: #44535f;
      }
      /* Active contexts: the boat's current situation ("anchored",
         "underway"…) — exactly what contexts express (SPEC §3.1).
         Dimmed chips so several can coexist without noise. */
      .ctx {
        padding: 0.25vh 0.9vw;
        border: 1px solid #2a3a4c;
        border-radius: 0;
        clip-path: polygon(0.6vw 0, 100% 0, calc(100% - 0.6vw) 100%, 0 100%);
        color: #8fa5ba;
        font-size: 1.6vh;
        letter-spacing: 0.18em;
      }
      /* Connectivity indicator: dot + word. Steady green "live" while
         the Signal K stream is open; red pulse while connecting or
         reconnecting so a drop is visible instantly (SPEC §2/§4) rather
         than waiting for staleness to degrade tiles. */
      .link {
        display: inline-flex;
        align-items: center;
        gap: 0.6vw;
        color: #74879b;
        font-size: 1.6vh;
        letter-spacing: 0.18em;
      }
      .link .dot {
        width: 1.1vh;
        height: 1.1vh;
        background: #73bf69;
        box-shadow: 0 0 1vh #73bf69;
      }
      .link.lost {
        color: #ff8a7a;
      }
      .link.lost .dot {
        background: #f2495c;
        box-shadow: 0 0 1.2vh #f2495c;
        animation: linkpulse 1.1s ease-in-out infinite;
      }
      @keyframes linkpulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.25; }
      }
      .clock {
        color: #9fb0c2;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.12em;
        font-weight: 600;
      }
      .grid {
        display: grid;
        grid-auto-flow: column;
        grid-template-rows: repeat(var(--grid-rows, 3), minmax(22vh, 1fr));
        grid-auto-columns: minmax(18vw, 1fr);
        gap: 1.4vh 1.4vw;
        flex: 1 1 auto;
        padding: 2vh 2vw;
        box-sizing: border-box;
      }
      .tile {
        position: relative;
        display: grid;
        grid-template-rows: auto 1fr auto auto;
        grid-template-areas:
          "label"
          "value"
          "reason"
          "footer";
        padding: 2.2vh 1.8vw;
        overflow: hidden;
        background: #0a0f16;
        border: 2px solid #1c2733;
        clip-path: polygon(
          0 0, calc(100% - 2.4vh) 0, 100% 2.4vh, 100% 100%,
          2.4vh 100%, 0 calc(100% - 2.4vh)
        );
        transition: background 0.2s, box-shadow 0.2s, border-color 0.2s;
      }
      /* Grid items default to min-width:auto, so an unbreakable child
         (a long dotted path) blows the track wider than the tile and
         shoves the centered value off-center. Force them shrinkable
         and let long tokens wrap (belt-and-suspenders alongside
         shortenReason, which trims most paths to their tail). */
      .tile > * { min-width: 0; }
      .tile.lit {
        border-color: var(--c, #6cb7f2);
        background: rgba(var(--c-rgb, 108, 183, 242), 0.15);
        box-shadow:
          inset 0 0 0 1px rgba(var(--c-rgb, 108, 183, 242), 0.4),
          0 0 3.6vh rgba(var(--c-rgb, 108, 183, 242), 0.3);
      }
      .tile.lit .label { color: var(--c, #6cb7f2); }
      .tile.neutral {
        border-style: dashed;
        border-color: #2a3645;
        background: #070a0e;
        box-shadow: none;
        opacity: 0.5;
      }
      .tile.neutral .label { color: #5b6b7d; }
      .tile.neutral .value { color: #44535f; }
      .tile.neutral .reason { color: #6b7a8c; opacity: 1; }
      .tile.alarm {
        animation: pulse 1.6s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { box-shadow: inset 0 0 0 2px rgba(var(--c-rgb, 242, 73, 92), 0.5), 0 0 3vh rgba(var(--c-rgb, 242, 73, 92), 0.32); }
        50% { box-shadow: inset 0 0 0 2px rgba(var(--c-rgb, 242, 73, 92), 0.75), 0 0 6vh rgba(var(--c-rgb, 242, 73, 92), 0.55); }
      }
      .label {
        grid-area: label;
        font-size: 2.6vh;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #9fb0c2;
        text-align: center;
        overflow-wrap: anywhere;
      }
      .value {
        grid-area: value;
        align-self: center;
        justify-self: center;
        font-size: 6.5vh;
        font-weight: 800;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        /* Plain white regardless of state: the number is data, not a
           judgment — the border, brackets, and label carry the state
           color, and white keeps max contrast on the dim display. */
        color: #ffffff;
      }
      .reason {
        grid-area: reason;
        font-size: 1.8vh;
        letter-spacing: 0.04em;
        color: #a5b7cb;
        text-align: center;
        overflow-wrap: anywhere;
      }
      .footer {
        grid-area: footer;
        display: flex;
        flex-wrap: wrap;
        gap: 0.4vh 1.2vw;
        margin-top: 0.4vh;
        font-size: 1.6vh;
        letter-spacing: 0.04em;
      }
      .footer-item { display: inline-flex; gap: 0.5vw; min-width: 0; overflow-wrap: anywhere; }
      .footer-label { color: #5b6b7d; }
      .footer-value { color: #ffffff; font-variant-numeric: tabular-nums; }
      .tile.neutral .footer { opacity: 0.7; }
      /* Overflow slots (SPEC §10/§11.1): reserved cells appended after
         the claimed tiles. Always present at a fixed count so the grid
         extent — and therefore every tile's position — is independent
         of whether an anomaly is showing. Empty slots recede further
         than neutral tiles: they carry no judgment at all. */
      .tile.slot {
        border-style: dashed;
        border-color: #131c26;
        background: #05080d;
        box-shadow: none;
        opacity: 0.25;
      }
      .tile.slot.lit {
        /* Occupied: a surfaced unclaimed anomaly — problem-colored,
           pulsing like any alarm, with a dashed outline marking it as a
           temporary overflow occupant rather than a configured tile. */
        opacity: 1;
      }
      .bracket {
        position: absolute;
        width: 2.8vh;
        height: 2.8vh;
        border: 3px solid rgba(var(--c-rgb, 108, 183, 242), 0.85);
      }
      .bracket.tl { top: 0.6vh; left: 0.6vw; border-right: 0; border-bottom: 0; }
      .bracket.tr { top: 0.6vh; right: 0.6vw; border-left: 0; border-bottom: 0; }
      .bracket.bl { bottom: 0.6vh; left: 0.6vw; border-right: 0; border-top: 0; }
      .bracket.br { bottom: 0.6vh; right: 0.6vw; border-left: 0; border-top: 0; }
      .tile.neutral .bracket { border-color: #33414f; opacity: 0.5; }
      .error {
        color: #f2495c;
        padding: 3vh;
        font-family: monospace;
        letter-spacing: 0.04em;
      }
    `;
    const chrome = document.createElement("div");
    chrome.className = "chrome";
    const chromeLeft = document.createElement("div");
    chromeLeft.className = "chrome-left";
    const vessel = document.createElement("span");
    vessel.className = "vessel";
    /** @type {HTMLElement} */
    this.ctxSlot = document.createElement("span");
    this.ctxSlot.style.display = "contents";
    const link = document.createElement("span");
    link.className = "link";
    const dot = document.createElement("span");
    dot.className = "dot";
    /** @type {HTMLElement} */
    this.linkText = document.createElement("span");
    this.linkText.textContent = "live";
    link.append(dot, this.linkText);
    chromeLeft.append(vessel, this.ctxSlot, link);
    const chromeRight = document.createElement("div");
    chromeRight.className = "chrome-right";
    /** @type {HTMLElement} */
    this.clockEl = document.createElement("span");
    this.clockEl.className = "clock";
    chromeRight.append(this.clockEl);
    chrome.append(chromeLeft, chromeRight);
    const grid = document.createElement("div");
    grid.className = "grid";
    const error = document.createElement("div");
    error.className = "error";
    this.shadowRoot.append(style, chrome, grid, error);
    /** @type {HTMLElement} */
    this.gridEl = grid;
    /** @type {HTMLElement} */
    this.errorEl = error;
    /** @type {HTMLElement} */
    this.vesselEl = vessel;
    /** @type {HTMLElement} */
    this.linkEl = link;
    /** @type {number|null} */
    this.clockTimer = null;
    /**
     * Persistent tile elements keyed by tile id, reused across
     * evaluations (SPEC §11.1: layout is layout-time-only). The engine
     * re-evaluates every second + on every delta; rebuilding the whole
     * grid each tick leaks DOM in a long-running kiosk (detached nodes,
     * animation frames, shadow-DOM bookkeeping outpacing GC). Instead we
     * build each tile's element tree once and update the volatile bits
     * (state class, value, reason, footer) in place.
     * @type {Map<string, HTMLElement>}
     */
    this.tileEls = new Map();
    /**
     * Persistent overflow-slot elements (SPEC §10): created once at the
     * configured count, only their occupants change. Reusing the same
     * elements keeps `set coverage` from allocating per tick too.
     * @type {HTMLElement[]}
     */
    this.slotEls = [];
    this.updateClock();
  }

  connectedCallback() {
    // Clock ticks on its own 1s cadence — purely presentational, kept
    // out of the engine's evaluation loop (SPEC §8 triggers are for tile
    // state, not chrome).
    if (this.clockTimer == null) {
      this.clockTimer = setInterval(() => this.updateClock(), 1000);
    }
  }

  disconnectedCallback() {
    if (this.clockTimer != null) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  /** Formats the local date/time into the chrome's clock element. */
  updateClock() {
    const d = new Date();
    const date = d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    this.clockEl.textContent = `${date} ${time}`;
  }

  /** Vessel name from the `name` path (set by the app on each eval). */
  set vessel(name) {
    this.vesselEl.textContent = name || "";
  }

  /**
   * Active contexts (from the engine's evaluation), rendered as dimmed
   * chips next to the vessel name. Empty array clears them.
   * @param {Array<{id: string, label: string}>} list
   */
  set activeContexts(list) {
    this.ctxSlot.replaceChildren(
      ...(list || []).map((c) => {
        const el = document.createElement("span");
        el.className = "ctx";
        el.textContent = c.label || c.id;
        return el;
      }),
    );
  }

  /**
   * Link-state indicator. Accepts the stream's state string:
   * "open" (steady green), "connecting"/"retrying" (red pulse).
   * @param {string} state
   */
  set link(state) {
    const live = state === "open";
    this.linkEl.classList.toggle("lost", !live);
    // "live" when the stream is open; otherwise the ongoing attempt in
    // plain words — "connecting" on first connect, "reconnecting"
    // after a drop.
    const word = state === "retrying" ? "reconnecting" : state || "connecting";
    this.linkText.textContent = live ? "live" : word;
  }

  set error(msg) {
    this.errorEl.textContent = msg || "";
  }

  /**
   * Number of reserved overflow slots (SPEC §10). Layout-time config:
   * set once from `coverage.slots`; only the *occupants* change at
   * runtime, never the count/positions (SPEC §11.1).
   * @param {number} n
   */
  set slotCount(n) {
    this._slotCount = Number.isFinite(n) ? Math.max(0, n | 0) : 0;
  }

  set tiles(list) {
    const tiles = list || [];
    // Reconcile tile elements by id: reuse existing elements (update in
    // place), create new ones, drop ids no longer present (e.g. a
    // context toggled a tile out of the output). Order in the grid
    // follows the incoming list so context-driven reordering is honored.
    const seen = new Set();
    /** @type {HTMLElement|null} */
    let cursor = this.gridEl.firstChild;
    for (const t of tiles) {
      let tile = this.tileEls.get(t.id);
      if (tile) {
        this.#paintTile(tile, t);
      } else {
        tile = this.#buildTile(t);
        this.tileEls.set(t.id, tile);
      }
      seen.add(t.id);
      // Move the tile to the current position (no-op if already there).
      if (cursor !== tile) this.gridEl.insertBefore(tile, cursor);
      cursor = tile.nextSibling;
    }
    // Drop tiles whose id disappeared from the output (a context went
    // inactive). Detach but keep them cached? No — a context can toggle
    // for hours; holding detached element trees is the very leak we're
    // fixing. Discard them; a re-appearance rebuilds cheaply (one tile).
    for (const [id, el] of this.tileEls) {
      if (seen.has(id)) continue;
      el.remove();
      this.tileEls.delete(id);
    }
    // Reserved overflow slots, always rendered (SPEC §10): empty cells
    // when no anomaly is showing, filled by `set coverage` below.
    // Persistent: grow/shrink the pool to the configured count without
    // rebuilding the existing slots.
    const want = this._slotCount ?? 0;
    while (this.slotEls.length < want) {
      const s = document.createElement("div");
      s.className = "tile slot";
      this.slotEls.push(s);
    }
    while (this.slotEls.length > want) this.slotEls.pop().remove();
    // Append any slot elements not yet in the grid after the last tile.
    for (const s of this.slotEls) {
      if (s.parentElement !== this.gridEl) this.gridEl.append(s);
    }
    // Column-wise flow: choose a row count that keeps columns wide
    // (~18vw) and the grid roughly balanced. Aim for 3 rows; use more
    // rows only when tiles would otherwise overflow into too many thin
    // columns. Total cells = tiles + reserved slots.
    const total = tiles.length + (this._slotCount ?? 0);
    let rows = 3;
    if (total <= 3) rows = total || 1;
    this.gridEl.style.setProperty("--grid-rows", String(rows));
  }

  /**
   * Builds the static skeleton of a tile element: the four corner
   * brackets and the label/value/reason/footer containers. State and
   * volatile content are filled in by #paintTile on every evaluation.
   * @param {object} t
   * @returns {HTMLElement}
   */
  #buildTile(t) {
    const tile = document.createElement("div");
    for (const pos of ["tl", "tr", "bl", "br"]) {
      const b = document.createElement("span");
      b.className = `bracket ${pos}`;
      tile.append(b);
    }
    const label = document.createElement("div");
    label.className = "label";
    tile.append(label);
    const value = document.createElement("div");
    value.className = "value";
    tile.append(value);
    const reason = document.createElement("div");
    reason.className = "reason";
    tile.append(reason);
    const footer = document.createElement("div");
    footer.className = "footer";
    tile.append(footer);
    this.#paintTile(tile, t);
    return tile;
  }

  /**
   * Updates a tile element's volatile state in place: class (state +
   * alarm), state color CSS vars, label, value, reason, footer. Nothing
   * here creates or removes elements except footer items (which mirror
   * the config-derived footer array). The skeleton from #buildTile is
   * reused across every evaluation.
   * @param {HTMLElement} tile
   * @param {object} t
   */
  #paintTile(tile, t) {
    const isAlarm = t.state === "amber" || t.state === "red";
    // opportunity is a lit, noticed state but never an alarm/pulse
    // (SPEC §2.1: it ranks below amber/red for urgency).
    tile.className = `tile ${t.state === "neutral" ? "neutral" : "lit"} ${isAlarm ? "alarm" : ""}`;
    const color = STATE_COLOR[t.state];
    if (color != null) {
      tile.style.setProperty("--c", color);
      tile.style.setProperty("--c-rgb", colorTriple(color));
    }
    const children = tile.children;
    // Children order (from #buildTile): 4 brackets, then label, value,
    // reason, footer.
    const label = children[4];
    const value = children[5];
    const reason = children[6];
    const footer = children[7];
    // label is config-derived (rarely changes), but cheap to set.
    if (label.textContent !== t.label) label.textContent = t.label;
    const dv = t.displayValue != null ? String(t.displayValue) : "";
    if (value.textContent !== dv) value.textContent = dv;
    value.style.display = dv ? "" : "none";
    const reasonText =
      t.reason && t.state !== "green"
        ? shortenReason(t.reason).toUpperCase()
        : "";
    if (reason.textContent !== reasonText) reason.textContent = reasonText;
    reason.style.display = reasonText ? "" : "none";
    // Footer items mirror the config-derived footer array; rebuild only
    // when the entry count changes, otherwise update values in place.
    const items = Array.isArray(t.footer) ? t.footer : [];
    this.#paintFooter(footer, items);
  }

  /**
   * Updates a footer container's items in place: reuses existing
   * item elements when the count matches, rebuilds when it grows or
   * shrinks. Footer entries are config-derived so the count is stable
   * across ticks in practice; values update every tick.
   * @param {HTMLElement} footer
   * @param {Array<{label: string, value: string}>} items
   */
  #paintFooter(footer, items) {
    if (footer.children.length !== items.length) {
      footer.replaceChildren();
      for (const e of items) {
        const span = document.createElement("span");
        span.className = "footer-item";
        const lab = document.createElement("span");
        lab.className = "footer-label";
        lab.textContent = e.label;
        const val = document.createElement("span");
        val.className = "footer-value";
        val.textContent = e.value;
        span.append(lab, val);
        footer.append(span);
      }
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const span = footer.children[i];
      const [lab, val] = span.children;
      if (lab.textContent !== items[i].label) lab.textContent = items[i].label;
      if (val.textContent !== items[i].value) val.textContent = items[i].value;
    }
  }

  /**
   * Fills the reserved overflow slots with surfaced anomalies, in rank
   * order. Re-fills on every evaluation (the grid is rebuilt by `set
   * tiles` first); never changes the slot count — an absent anomaly
   * leaves its cell empty, it doesn't remove it (SPEC §10/§11.1).
   * @param {Array<{path: string, state: string, zone: string}>} list
   */
  set coverage(list) {
    // Reuse the persistent slot elements (built by `set tiles`); only
    // their occupants change, never the cells themselves (SPEC §10/§11.1).
    for (let i = 0; i < this.slotEls.length; i++) {
      const slot = this.slotEls[i];
      const c = list?.[i];
      if (!c) {
        slot.className = "tile slot";
        slot.style.removeProperty("--c");
        slot.style.removeProperty("--c-rgb");
        slot.style.outline = "";
        slot.replaceChildren();
        continue;
      }
      slot.className = "tile slot lit alarm";
      const color = STATE_COLOR[c.state] ?? STATE_COLOR.red;
      slot.style.setProperty("--c", color);
      slot.style.setProperty("--c-rgb", colorTriple(color));
      slot.style.outline = `2px dashed ${color}`;
      slot.style.outlineOffset = "-0.6vh";
      // Two children: label + reason. Build once per occupancy, update in
      // place afterwards (the slot persists across ticks).
      let [label, reason] = slot.children;
      if (!label || !reason) {
        slot.replaceChildren();
        label = document.createElement("div");
        label.className = "label";
        reason = document.createElement("div");
        reason.className = "reason";
        slot.append(label, reason);
      }
      const labelText = shortPath(c.path);
      if (label.textContent !== labelText) label.textContent = labelText;
      const reasonText = `${c.zone.toUpperCase()} ANOMALY`;
      if (reason.textContent !== reasonText) reason.textContent = reasonText;
    }
  }
}

/** Last two dot-segments of a path — full paths overflow a tile label. */
export function shortPath(p) {
  const parts = String(p).split(".");
  return parts.slice(-2).join(".");
}

/**
 * Last dot-segment of a path — the differing tail is all a helm display
 * needs; the shared prefix is noise on a glanceable reason line.
 */
export function lastSegment(p) {
  const parts = String(p).split(".");
  return parts[parts.length - 1];
}

/**
 * Shortens every Signal-K-path token in a reason string to its last
 * dot-segment, leaving the surrounding words/Operators intact. A
 * reason like `...deployment.flinsail.detectedstate ≠ ...recommendedstate`
 * becomes `detectedstate ≠ recommendedstate` — the shared prefix is the
 * same for both sides, so only the differing tail is glanceable. Single
 * segments, numbers, and plain words are left alone (they are already
 * short or are not paths). Applied before uppercasing.
 */
export function shortenReason(text) {
  return String(text).replace(
    /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g,
    (m) => lastSegment(m),
  );
}

customElements.define("st-tile-grid", StTileGrid);
