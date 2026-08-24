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
};

class StTileGrid extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        height: 100%;
        background: #05070a;
        color: #d8e2ee;
        font-family: "Eurostile", "Bank Gothic", "Oswald", system-ui, sans-serif;
        --tile-radius: clamp(0.8vw, 1vw, 1.4vh);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(20vw, 1fr));
        grid-auto-rows: minmax(22vh, 1fr);
        gap: 1.4vh 1.4vw;
        height: 100%;
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
    const grid = document.createElement("div");
    grid.className = "grid";
    const error = document.createElement("div");
    error.className = "error";
    this.shadowRoot.append(style, grid, error);
    /** @type {HTMLElement} */
    this.gridEl = grid;
    /** @type {HTMLElement} */
    this.errorEl = error;
  }

  set error(msg) {
    this.errorEl.textContent = msg || "";
  }

  set tiles(list) {
    this.gridEl.innerHTML = "";
    for (const t of list || []) {
      const tile = document.createElement("div");
      const isAlarm = t.state === "amber" || t.state === "red";
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
  }

  set coverage(list) {
    // Overflow slots appended after the claimed tiles (SPEC §10).
    for (const c of list || []) {
      const tile = document.createElement("div");
      tile.className = "tile lit alarm";
      tile.style.setProperty("--hue", STATE_HUE[c.state] ?? 0);
      tile.style.outline = "2px dashed hsl(0 70% 55%)";
      tile.style.outlineOffset = "-0.6vh";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = c.path;
      const r = document.createElement("div");
      r.className = "reason";
      r.textContent = `${c.zone.toUpperCase()} ANOMALY`;
      tile.append(label, r);
      this.gridEl.append(tile);
    }
  }
}

customElements.define("st-tile-grid", StTileGrid);
