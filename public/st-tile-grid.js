/**
 * Full-viewport tile grid renderer (SPEC §11). Expanse-style HUD aesthetic:
 * dark bridge, high-contrast emissive panels, angular corner brackets,
 * condensed labels. Neutral is visually distinct from green — rendered
 * as a dimmed outline panel rather than a lit color, so "no judgment
 * possible" never reads as "fine" (SPEC §11).
 *
 * Packing is deterministic and layout-time-only (SPEC §11.1): recomputed
 * only on config/screen change, never on a state change. This first cut
 * uses a CSS grid sized in viewport units; richer multi-size packing
 * arrives later.
 *
 * @file st-tile-grid.js */

const STATE_HUE = {
  green: 130, // emissive green
  amber: 38, // warm amber
  red: 0, // alert red
  // SPEC §2.1/§11: opportunity is its own branch, not a rung on the
  // green→amber→red ramp. A cyan/teal hue reads as "different in kind"
  // rather than a milder amber or bonus green.
  opportunity: 190,
};

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
        background: #37c26a;
        box-shadow: 0 0 1vh #37c26a;
      }
      .link.lost {
        color: #ff8a7a;
      }
      .link.lost .dot {
        background: #ff5a5a;
        box-shadow: 0 0 1.2vh #ff5a5a;
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
        grid-template-columns: repeat(auto-fill, minmax(20vw, 1fr));
        grid-auto-rows: minmax(22vh, 1fr);
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
        border: 1px solid #1c2733;
        clip-path: polygon(
          0 0, calc(100% - 2vh) 0, 100% 2vh, 100% 100%,
          2vh 100%, 0 calc(100% - 2vh)
        );
        transition: background 0.2s, box-shadow 0.2s, border-color 0.2s;
      }
      .tile.lit {
        border-color: hsl(var(--hue) 70% 45%);
        background: hsl(var(--hue) 55% 10%);
        box-shadow:
          inset 0 0 0 1px hsl(var(--hue) 70% 35% / 0.35),
          0 0 3vh hsl(var(--hue) 80% 40% / 0.18);
      }
      .tile.lit .label { color: hsl(var(--hue) 85% 70%); }
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
        0%, 100% { box-shadow: inset 0 0 0 1px hsl(var(--hue) 70% 40% / 0.4), 0 0 2.5vh hsl(var(--hue) 85% 45% / 0.25); }
        50% { box-shadow: inset 0 0 0 1px hsl(var(--hue) 80% 55% / 0.6), 0 0 5vh hsl(var(--hue) 90% 55% / 0.45); }
      }
      .label {
        grid-area: label;
        font-size: 2.6vh;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #9fb0c2;
      }
      .value {
        grid-area: value;
        align-self: center;
        justify-self: center;
        font-size: 6.5vh;
        font-weight: 700;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        color: #9fb0c2;
      }
      .reason {
        grid-area: reason;
        font-size: 1.8vh;
        letter-spacing: 0.04em;
        color: #7c8a9b;
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
      .footer-item { display: inline-flex; gap: 0.5vw; }
      .footer-label { color: #5b6b7d; }
      .footer-value { color: #9fb0c2; font-variant-numeric: tabular-nums; }
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
        width: 2.2vh;
        height: 2.2vh;
        border: 2px solid hsl(var(--hue, 210) 60% 50% / 0.5);
      }
      .bracket.tl { top: 0.6vh; left: 0.6vw; border-right: 0; border-bottom: 0; }
      .bracket.tr { top: 0.6vh; right: 0.6vw; border-left: 0; border-bottom: 0; }
      .bracket.bl { bottom: 0.6vh; left: 0.6vw; border-right: 0; border-top: 0; }
      .bracket.br { bottom: 0.6vh; right: 0.6vw; border-left: 0; border-top: 0; }
      .tile.neutral .bracket { border-color: #33414f; opacity: 0.5; }
      .error {
        color: #ff5a5a;
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
    this.gridEl.innerHTML = "";
    for (const t of list || []) {
      const tile = document.createElement("div");
      const isAlarm = t.state === "amber" || t.state === "red";
      // opportunity is a lit, noticed state but never an alarm/pulse
      // (SPEC §2.1: it ranks below amber/red for urgency).
      tile.className = `tile ${t.state === "neutral" ? "neutral" : "lit"} ${isAlarm ? "alarm" : ""}`;
      if (STATE_HUE[t.state] != null)
        tile.style.setProperty("--hue", STATE_HUE[t.state]);

      for (const pos of ["tl", "tr", "bl", "br"]) {
        const b = document.createElement("span");
        b.className = `bracket ${pos}`;
        tile.append(b);
      }

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = t.label;
      tile.append(label);

      if (t.displayValue != null) {
        const v = document.createElement("div");
        v.className = "value";
        v.textContent = String(t.displayValue);
        tile.append(v);
      }
      if (t.reason && t.state !== "green") {
        const r = document.createElement("div");
        r.className = "reason";
        r.textContent = t.reason.toUpperCase();
        tile.append(r);
      }
      if (Array.isArray(t.footer) && t.footer.length > 0) {
        const f = document.createElement("div");
        f.className = "footer";
        for (const e of t.footer) {
          const span = document.createElement("span");
          span.className = "footer-item";
          const lab = document.createElement("span");
          lab.className = "footer-label";
          lab.textContent = e.label;
          const val = document.createElement("span");
          val.className = "footer-value";
          val.textContent = e.value;
          span.append(lab, val);
          f.append(span);
        }
        tile.append(f);
      }
      this.gridEl.append(tile);
    }
    // Reserved overflow slots, always rendered (SPEC §10): empty cells
    // when no anomaly is showing, filled by `set coverage` below.
    for (let i = 0; i < (this._slotCount ?? 0); i++) {
      const s = document.createElement("div");
      s.className = "tile slot";
      this.gridEl.append(s);
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
    const slots = this.gridEl.querySelectorAll(".tile.slot");
    slots.forEach((slot, i) => {
      slot.className = "tile slot";
      slot.style.removeProperty("--hue");
      slot.style.outline = "";
      slot.replaceChildren();
      const c = list?.[i];
      if (!c) return;
      slot.className = "tile slot lit alarm";
      slot.style.setProperty("--hue", STATE_HUE[c.state] ?? 0);
      slot.style.outline = "2px dashed hsl(0 70% 55%)";
      slot.style.outlineOffset = "-0.6vh";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = shortPath(c.path);
      const r = document.createElement("div");
      r.className = "reason";
      r.textContent = `${c.zone.toUpperCase()} ANOMALY`;
      slot.append(label, r);
    });
  }
}

/** Last two dot-segments of a path — full paths overflow a tile label. */
function shortPath(p) {
  const parts = String(p).split(".");
  return parts.slice(-2).join(".");
}

customElements.define("st-tile-grid", StTileGrid);
