/**
 * Full-viewport tile grid renderer (SPEC §11), styled per the Signal K
 * plugin UI spec: strictly flat panels (border-radius 0, no shadows, no
 * gradients), 2px corner brackets, monospace telemetry with tabular
 * numerals, and a day/night-reactive palette. Colors live as custom
 * properties on <html> (index.html) keyed by data-mode="day"|"night",
 * which app.js sets from the environment.mode delta (lib/mode.js) —
 * they pierce the shadow DOM, so a mode switch re-skins the whole grid
 * with zero DOM work.
 *
 * Divergences from the spec, all for the same reason — the primary
 * consumer is a somewhat dim kiosk screen that washes out subtle
 * styling, and the screen has read as "a little too dim" even before
 * this spec:
 *   - base is pure black (--bg-base #000000; spec says #080a0c)
 *   - lit panel borders run at ~0.65 alpha (spec suggests "faint",
 *     ~0.3) and the state tint at 0.16 (spec: "ultra-faint"), so the
 *     state survives glare at glance distance
 *   - neutral tiles use a solid grey border + muted text instead of
 *     whole-tile opacity dimming — on a washed-out screen opacity only
 *     makes things illegible, and grey-vs-lit-color already reads as
 *     "no judgment possible" (SPEC §2/§11)
 *   - only red tiles pulse; amber stays steady lit (SPEC §2 severity
 *     semantics — motion is reserved for "look at this now")
 *
 * Portrait (phone/on-watch) is handled by a CSS orientation media
 * query: row-wise flow, at most two tiles across, vertical scroll —
 * see the block after .grid.
 *
 * Packing is deterministic and layout-time-only (SPEC §11.1):
 * recomputed only on config/screen change, never on a state change.
 *
 * @file st-tile-grid.js */

/**
 * Tile state → spec theme class (signalk-visuals.md §5). The class
 * assigns the local --c/--c-rgb pair from the day/night palette
 * variables, so JS never handles colors and a mode switch re-skins the
 * grid for free. `amber` maps to the spec's orange ramp position,
 * `opportunity` to teal — its own branch outside the problem ramp
 * (SPEC §2.1), never a milder amber or bonus green.
 */
export const STATE_THEME = {
  green: "green",
  amber: "orange",
  red: "red",
  opportunity: "teal",
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
        position: relative;
        background: var(--bg-base, #000000);
        color: var(--text-main, #ffffff);
        font-family: system-ui, -apple-system, sans-serif;
      }
      /* Spec theme classes: each assigns a local --c/--c-rgb consumed
         by borders, tints, labels, and brackets below. Fallbacks are
         the bright day palette so the grid is self-contained (and
         never dim) even when embedded without index.html's vars. */
      .theme-green { --c: var(--color-green, #8dfcbb); --c-rgb: var(--color-green-rgb, 141, 252, 187); }
      .theme-orange { --c: var(--color-orange, #fca847); --c-rgb: var(--color-orange-rgb, 252, 168, 71); }
      .theme-red { --c: var(--color-red, #ff5e5e); --c-rgb: var(--color-red-rgb, 255, 94, 94); }
      .theme-teal { --c: var(--color-teal, #66c6db); --c-rgb: var(--color-teal-rgb, 102, 198, 219); }
      /* Chrome band (SPEC §11.1): constant-height top strip holding
         vessel identity, active contexts, and the link indicator — plus
         the clock on the right. Always present and fixed-height, so the
         tile grid below never re-flows when its contents change. Its
         content is subordinate chrome (SPEC §11.2): small, muted,
         never competing with tiles for a glance. */
      .chrome {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1.5vw;
        flex: 0 0 auto;
        height: 4.6vh;
        padding: 0 2vw;
        border-bottom: 1px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.45);
        background: var(--bg-panel-muted, #0a0c0c);
        font-size: 1.9vh;
        letter-spacing: 0.12em;
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
        color: var(--text-main, #ffffff);
        letter-spacing: 0.22em;
      }
      .vessel:empty::after {
        content: "—";
        color: var(--color-grey, #666666);
      }
      /* Active contexts: the boat's current situation ("anchored",
         "underway"…) — exactly what contexts express (SPEC §3.1).
         Muted chips so several can coexist without noise. */
      .ctx {
        padding: 0.25vh 0.9vw;
        border: 1px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.55);
        color: var(--text-muted, #a0a0b5);
        font-size: 1.6vh;
        letter-spacing: 0.18em;
      }
      /* Connectivity indicator: dot + word. Steady green "live" while
         the Signal K stream is open; red pulse while connecting or
         reconnecting so a drop is visible instantly (SPEC §2/§4) rather
         than waiting for staleness to degrade tiles. Flat square dot —
         no glow shadow, per the strictly-flat geometry rule. */
      .link {
        display: inline-flex;
        align-items: center;
        gap: 0.6vw;
        color: var(--text-muted, #a0a0b5);
        font-size: 1.6vh;
        letter-spacing: 0.18em;
      }
      .link .dot {
        width: 1.1vh;
        height: 1.1vh;
        background: var(--color-green, #8dfcbb);
      }
      .link.lost {
        color: var(--color-red, #ff5e5e);
      }
      .link.lost .dot {
        background: var(--color-red, #ff5e5e);
        animation: linkpulse 1.1s ease-in-out infinite;
      }
      @keyframes linkpulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.25; }
      }
      .clock {
        color: var(--text-main, #ffffff);
        font-family: ui-monospace, "Fira Code", monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.12em;
        font-weight: 600;
      }
      /* Chrome-bar "+" (SPEC §11, example-tiles-plan.md): shown only
         when the server confirms admin access via the /examples probe.
         Triggers the examples picker overlay; read-only users never see
         it (the resources API they *can* read can't distinguish admin
         from read-only, so the affordance itself must be gated). */
      .add-btn {
        background: none;
        border: 1px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.55);
        color: var(--text-muted, #a0a0b5);
        font-size: 2.4vh;
        font-weight: 700;
        line-height: 1;
        width: 2.6vh;
        height: 2.6vh;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
      }
      .add-btn:hover { color: var(--text-main, #ffffff); }
      /* Full-viewport overlay listing available example sets. Covers the
         grid (z-index above tiles) so the helm view isn't half-visible
         behind a dialog. */
      .examples-overlay {
        position: absolute;
        inset: 0;
        background: var(--bg-base, #000000);
        z-index: 10;
        display: flex;
        flex-direction: column;
        padding: 3vh 5vw;
        overflow-y: auto;
      }
      .examples-overlay h2 {
        font-size: 2.4vh;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin: 0 0 0.5vh;
      }
      .examples-subtitle {
        font-size: 1.5vh;
        color: var(--text-muted, #a0a0b5);
        margin: 0 0 2vh;
      }
      .examples-close {
        position: absolute;
        top: 2vh;
        right: 3vw;
        background: none;
        border: 1px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.55);
        color: var(--text-main, #ffffff);
        font-size: 1.8vh;
        cursor: pointer;
        padding: 0.5vh 1.2vh;
        letter-spacing: 0.1em;
      }
      .examples-list {
        display: flex;
        flex-direction: column;
        gap: 1.5vh;
        flex: 1 1 auto;
      }
      .examples-set {
        border: 1px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.45);
        padding: 1.8vh 1.8vw;
        background: var(--bg-panel, #111414);
      }
      .examples-set h3 {
        font-size: 2.2vh;
        margin: 0;
        color: var(--text-main, #ffffff);
      }
      .examples-set .source {
        font-size: 1.4vh;
        color: var(--text-muted, #a0a0b5);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-top: 0.3vh;
      }
      .examples-set .desc {
        font-size: 1.6vh;
        color: var(--text-muted, #a0a0b5);
        margin: 0.8vh 0;
      }
      .examples-set .add-set-btn {
        background: none;
        border: 1px solid rgba(var(--color-green-rgb, 141, 252, 187), 0.65);
        color: var(--color-green, #8dfcbb);
        font-size: 1.6vh;
        padding: 0.6vh 2vw;
        cursor: pointer;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .examples-set .add-set-btn:disabled {
        border-color: rgba(var(--color-grey-rgb, 102, 102, 102), 0.4);
        color: var(--color-grey, #666666);
        cursor: default;
      }
      /* Per-set tile preview: each tile is rendered through the real
         #buildTile/#paintTile from the evaluator's output against the
         boat's live data (stream deltas fed into a preview cache by the
         app — public/lib/preview.js), so the user sees the actual tile
         with real values; unfed paths show the honest stale/neutral
         look. Compact fixed sizing; the full-grid vh/vw units would be
         far too large in the overlay. The .tile rules above still
         apply (brackets, theme vars); these overrides only shrink
         them. */
      .examples-preview {
        display: flex;
        flex-wrap: wrap;
        gap: 1vh 1vw;
        margin: 1.2vh 0;
      }
      .examples-tile-wrap {
        display: flex;
        flex-direction: column;
        width: 17vw;
        min-width: 0;
      }
      .examples-preview .tile {
        width: 100%;
        min-height: 11vh;
        padding: 1.2vh 1vw;
        /* border-box is load-bearing here: the shadow DOM does NOT
           inherit the host page's universal border-box rule (only custom
           properties pierce the boundary), so without this the tile
           defaults to content-box and width:100% sizes only the content
           box — padding (1vw×2) + border (2px×2) are then added on top,
           making the tile ~42px wider than its 17vw wrap and overlapping
           the next wrap horizontally. */
        box-sizing: border-box;
      }
      .examples-preview .tile .label { font-size: 1.5vh; }
      .examples-preview .tile .value { font-size: 3.5vh; }
      .examples-preview .tile .reason { font-size: 1.2vh; }
      .examples-preview .tile .footer-label { font-size: 1.1vh; }
      .examples-preview .tile .footer-value { font-size: 1.4vh; }
      .examples-preview .tile::before,
      .examples-preview .tile::after {
        width: 1.6vh;
        height: 1.6vh;
      }
      .examples-checks {
        font-size: 1.2vh;
        color: var(--text-muted, #a0a0b5);
        margin-top: 0.5vh;
        letter-spacing: 0.04em;
        overflow-wrap: anywhere;
      }
      .examples-busy,
      .examples-error-msg {
        font-size: 1.7vh;
        margin-top: 1vh;
      }
      .examples-busy { color: var(--text-muted, #a0a0b5); }
      .examples-error-msg { color: var(--color-red, #ff5e5e); }
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
      /* Portrait (phone/on-watch, spec §4): the column-wise flow above
         puts ceil(total/3) columns side by side — on a phone those are
         unreadably narrow strips. Instead: row-wise flow, at most two
         tiles across, scrolling down past the fold. A pure orientation
         media query — no JS, no resize listeners: this webapp is always
         full-viewport (SPEC §11), so viewport orientation IS grid
         orientation, and an orientation change is exactly the
         layout-invalidating event SPEC §11.1 allows. The chrome band
         wraps to two lines (its height was fixed to protect the grid
         from re-flow; in portrait it yields so vessel/context/clock
         all stay readable). */
      @media (orientation: portrait) {
        .chrome {
          height: auto;
          min-height: 4.6vh;
          flex-wrap: wrap;
          white-space: normal;
        }
        .grid {
          grid-auto-flow: row;
          grid-template-rows: none;
          grid-auto-columns: auto;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          grid-auto-rows: minmax(22vh, 1fr);
          overflow-y: auto;
        }
        .value {
          /* Two-across phone tiles have ~42vw of inner width; 6.5vh
             monospace digits overflow that on common phones, so the
             headline number steps down a notch in portrait. */
          font-size: 5.5vh;
        }
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
        background: var(--bg-panel, #111414);
        border: 2px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.35);
        transition: background 0.2s, border-color 0.2s;
      }
      /* Corner brackets (spec §5): 2px, via pseudo-elements on the
         tile's top-left and bottom-right corners. Lit tiles get them
         in the theme color; neutral/slot tiles in dimmed grey. The
         inset is 0.6vh on BOTH axes — vh and vw must not be mixed
         here, or the horizontal margin grows on widescreen displays
         and the brackets read as misaligned. */
      .tile::before,
      .tile::after {
        content: "";
        position: absolute;
        width: 2.8vh;
        height: 2.8vh;
        pointer-events: none;
      }
      .tile::before {
        top: 0.6vh;
        left: 0.6vh;
        border-top: 2px solid var(--c, var(--color-grey, #666666));
        border-left: 2px solid var(--c, var(--color-grey, #666666));
      }
      .tile::after {
        bottom: 0.6vh;
        right: 0.6vh;
        border-bottom: 2px solid var(--c, var(--color-grey, #666666));
        border-right: 2px solid var(--c, var(--color-grey, #666666));
      }
      .tile.neutral::before,
      .tile.neutral::after,
      .tile.slot:not(.lit)::before,
      .tile.slot:not(.lit)::after {
        border-color: rgba(var(--color-grey-rgb, 102, 102, 102), 0.5);
      }
      /* Grid items default to min-width:auto, so an unbreakable child
         (a long dotted path) blows the track wider than the tile and
         shoves the centered value off-center. Force them shrinkable
         and let long tokens wrap (belt-and-suspenders alongside
         shortenReason, which trims most paths to their tail). */
      .tile > * { min-width: 0; }
      /* DIVERGENCE from spec ("faint" ~0.3-alpha borders,
         "ultra-faint" tint): the dim kiosk screen washes those out at
         glance distance, so lit borders run at 0.65 and the tint at
         0.16 of the theme color. Night mode dims automatically — the
         palette vars shift, these alphas don't. */
      .tile.lit {
        border-color: rgba(var(--c-rgb), 0.65);
        background: rgba(var(--c-rgb), 0.16);
      }
      /* Neutral: "no judgment possible" — deliberately un-lit. Solid
         grey border + muted text like the other boxes (dashed read as
         "broken/reserved" rather than "not applicable"); grey-vs-lit-
         color plus the muted content is what separates it from green
         (SPEC §11.2). */
      .tile.neutral {
        border-color: rgba(var(--color-grey-rgb, 102, 102, 102), 0.5);
        background: var(--bg-panel-muted, #0a0c0c);
      }
      .tile.neutral .label { color: var(--color-grey, #666666); }
      .tile.neutral .value { color: var(--text-muted, #a0a0b5); }
      .tile.neutral .reason { color: var(--text-muted, #a0a0b5); }
      /* Only red pulses — "look at this NOW" (SPEC §2). Amber stays
         steady lit: it wants a glance today, and a blinking tile for
         every amber would train the eye to ignore motion on the kiosk
         (the same trust-erosion argument as ignoring reds). Strictly
         flat animation: border-color and tint between two alphas, no
         glow shadow (spec §5). */
      .tile.alarm {
        animation: pulse 1.6s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% {
          border-color: rgba(var(--c-rgb), 0.55);
          background: rgba(var(--c-rgb), 0.12);
        }
        50% {
          border-color: rgba(var(--c-rgb), 1);
          background: rgba(var(--c-rgb), 0.3);
        }
      }
      .label {
        grid-area: label;
        font-size: 2.6vh;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--c, var(--text-muted, #a0a0b5));
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
        font-family: ui-monospace, "Fira Code", monospace;
        font-variant-numeric: tabular-nums;
        /* Plain --text-main (pure white by day) regardless of state:
           the number is data, not a judgment — the border, brackets,
           and label carry the state color, and white keeps max contrast
           on the dim display. */
        color: var(--text-main, #ffffff);
        text-align: center;
        /* Safety net for an unbroken long token; multi-part headlines
           break at their spaces first. */
        overflow-wrap: anywhere;
      }
      /* Composed headlines (displayParts: 'surplus 95%', 'deployed
         starboard') are longer than a single number — 6.5vh fits ~7
         monospace chars in a ~16vw tile. Step down by length bucket
         (valueFit); the longest wrap at word boundaries instead of
         overflowing the tile. */
      .value[data-fit="m"] { font-size: 4vh; }
      .value[data-fit="l"] { font-size: 3.4vh; }
      .reason {
        grid-area: reason;
        font-size: 1.8vh;
        letter-spacing: 0.04em;
        color: var(--text-muted, #a0a0b5);
        text-align: center;
        overflow-wrap: anywhere;
      }
      .footer {
        grid-area: footer;
        display: flex;
        flex-wrap: wrap;
        gap: 0.4vh 1.2vw;
        margin-top: 0.4vh;
        letter-spacing: 0.04em;
      }
      .footer-item {
        display: inline-flex;
        align-items: baseline;
        gap: 0.5vw;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      /* Reviewer note: footer values bumped from 1.6vh to 2.2vh —
         they carry real telemetry (watts, temperatures) and were too
         small to read on the kiosk screen. Labels stay a step smaller
         and muted so the numbers dominate. */
      .footer-label {
        color: var(--text-muted, #a0a0b5);
        font-size: 1.7vh;
      }
      .footer-value {
        color: var(--text-main, #ffffff);
        font-family: ui-monospace, "Fira Code", monospace;
        font-variant-numeric: tabular-nums;
        font-size: 2.2vh;
      }
      .tile.neutral .footer { opacity: 0.7; }
      /* Overflow slots (SPEC §10/§11.1): reserved cells appended after
         the claimed tiles. Always present at a fixed count so the grid
         extent — and therefore every tile's position — is independent
         of whether an anomaly is showing. Empty slots recede further
         than neutral tiles: they carry no judgment at all. */
      .tile.slot {
        border-style: dashed;
        border-color: rgba(var(--color-grey-rgb, 102, 102, 102), 0.3);
        background: var(--bg-panel-muted, #0a0c0c);
        opacity: 0.35;
      }
      .tile.slot.lit {
        /* Occupied: a surfaced unclaimed anomaly — problem-colored,
           pulsing like any alarm, with a dashed outline marking it as a
           temporary overflow occupant rather than a configured tile. */
        opacity: 1;
        border-color: rgba(var(--c-rgb), 0.65);
        background: rgba(var(--c-rgb), 0.16);
        outline: 2px dashed var(--c);
        outline-offset: -0.6vh;
      }
      .error {
        color: var(--color-red, #ff5e5e);
        padding: 3vh;
        font-family: ui-monospace, "Fira Code", monospace;
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
    /** @type {HTMLButtonElement} */
    this.addBtn = document.createElement("button");
    this.addBtn.className = "add-btn";
    this.addBtn.textContent = "+";
    this.addBtn.style.display = "none";
    this.addBtn.title = "Add example tile set";
    this.addBtn.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("st-examples-open", { bubbles: true, composed: true }),
      );
    });
    /** @type {HTMLElement} */
    this.clockEl = document.createElement("span");
    this.clockEl.className = "clock";
    chromeRight.append(this.addBtn, this.clockEl);
    chrome.append(chromeLeft, chromeRight);
    const grid = document.createElement("div");
    grid.className = "grid";
    const error = document.createElement("div");
    error.className = "error";
    // Examples picker overlay (doc/example-tiles-plan.md). Hidden until
    // openExamples() — the app fetches the resources-API collection,
    // flattens it, and passes it in. Lives in the grid's shadow DOM so
    // it shares the flat-panel theme without a second stylesheet.
    const examplesOverlay = document.createElement("div");
    examplesOverlay.className = "examples-overlay";
    examplesOverlay.style.display = "none";
    const examplesH2 = document.createElement("h2");
    examplesH2.textContent = "Example tile sets";
    const examplesSubtitle = document.createElement("div");
    examplesSubtitle.className = "examples-subtitle";
    examplesSubtitle.textContent =
      "Copy a ready-made set into your panel. Existing tiles are never overwritten.";
    /** @type {HTMLButtonElement} */
    const examplesClose = document.createElement("button");
    examplesClose.className = "examples-close";
    examplesClose.textContent = "\u2715";
    examplesClose.addEventListener("click", () => this.closeExamples());
    /** @type {HTMLElement} */
    this.examplesList = document.createElement("div");
    this.examplesList.className = "examples-list";
    /** @type {HTMLElement} */
    this.examplesBusyEl = document.createElement("div");
    this.examplesBusyEl.className = "examples-busy";
    this.examplesBusyEl.textContent = "Adding…";
    this.examplesBusyEl.style.display = "none";
    /** @type {HTMLElement} */
    this.examplesErrorEl = document.createElement("div");
    this.examplesErrorEl.className = "examples-error-msg";
    examplesOverlay.append(
      examplesH2,
      examplesSubtitle,
      examplesClose,
      this.examplesList,
      this.examplesBusyEl,
      this.examplesErrorEl,
    );
    this.shadowRoot.append(style, chrome, grid, error, examplesOverlay);
    /** @type {HTMLElement} */
    this.examplesOverlay = examplesOverlay;
    /** @type {HTMLButtonElement[]} add-set buttons (for examplesBusy) */
    this._exampleButtons = [];
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

  /**
   * Formats the local date/time into the chrome's clock element.
   * Spec time rules: local ship time carries no timezone suffix, dates
   * as YYYY-MM-DD. Monospace tabular numerals keep the seconds tick
   * from jiggling the layout.
   */
  updateClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    this.clockEl.textContent =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
   * Builds the static skeleton of a tile element: label, value, reason,
   * footer containers. State and volatile content are filled in by
   * #paintTile on every evaluation. The 2px corner brackets are CSS
   * pseudo-elements (spec §5), not elements — no DOM cost per tile.
   * @param {object} t
   * @returns {HTMLElement}
   */
  #buildTile(t) {
    const tile = document.createElement("div");
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
   * Updates a tile element's volatile state in place: state class
   * (theme + lit + alarm), label, value, reason, footer. Nothing here
   * creates or removes elements except footer items (which mirror the
   * config-derived footer array). The skeleton from #buildTile is
   * reused across every evaluation. Colors are set by the theme class
   * (STATE_THEME) resolving the day/night palette vars — never inline
   * styles, so a mode switch needs zero repainting here.
   * @param {HTMLElement} tile
   * @param {object} t
   */
  #paintTile(tile, t) {
    const isAlarm = t.state === "red";
    // opportunity is a lit, noticed state but never an alarm/pulse
    // (SPEC §2.1: it ranks below amber/red for urgency), and amber
    // pulses neither — only red, "look at this now", earns motion.
    // An unmapped state (shouldn't happen) renders as neutral rather
    // than as an uncolored lit tile.
    const theme = STATE_THEME[t.state];
    tile.className =
      `tile ${theme ? `theme-${theme} lit` : "neutral"}` +
      `${isAlarm ? " alarm" : ""}`;
    // Children order (from #buildTile): label, value, reason, footer.
    const children = tile.children;
    const label = children[0];
    const value = children[1];
    const reason = children[2];
    const footer = children[3];
    // label is config-derived (rarely changes), but cheap to set.
    if (label.textContent !== t.label) label.textContent = t.label;
    const dv = t.displayValue != null ? String(t.displayValue) : "";
    if (value.textContent !== dv) value.textContent = dv;
    const fit = dv ? valueFit(dv) : "s";
    if (value.dataset.fit !== fit) value.dataset.fit = fit;
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
        slot.replaceChildren();
        continue;
      }
      // Same theme-class mechanism as ordinary tiles; red is the safe
      // default for an unknown state on an anomaly. Only a red anomaly
      // pulses — same steady-amber rule as ordinary tiles.
      const theme = STATE_THEME[c.state] ?? "red";
      slot.className = `tile slot theme-${theme} lit${
        c.state === "red" ? " alarm" : ""
      }`;
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

  // --- Example tile sets (doc/example-tiles-plan.md) --------------------

  /**
   * Shows/hides the chrome-bar "+" button. Set by the app after the
   * admin probe (GET /examples) succeeds: read-only users can read the
   * resources API but must not see the copy affordance, so the button
   * is hidden until admin access is confirmed.
   * @param {boolean} on
   */
  set adminMode(on) {
    this.addBtn.style.display = on ? "" : "none";
  }

  /**
   * Renders the examples picker overlay: a card per set with its
   * name, source plugin, description, live tile previews, and an Add
   * button. Sets whose tiles are all already present are badged "Already
   * added" and their Add buttons disabled. Clicking Add dispatches
   * `st-examples-add` carrying the set object — the app PUTs it and
   * closes the overlay (a config-hash reload refreshes the grid).
   *
   * Each set entry carries `preview`: the set's tiles rendered through
   * the real evaluator against the boat's LIVE data (the app extends
   * its stream subscription with the sets' paths for the duration the
   * picker is open, feeding a preview cache consumed by
   * public/lib/preview.js) — real states, values, and formatting;
   * paths the boat doesn't publish stay honestly stale/neutral.
   *
   * @param {{sets: Array<{source: string, set: object, preview?: Array<object>}>, alreadyAdded?: Set<string>}} opts
   */
  openExamples({ sets, alreadyAdded }) {
    this.examplesErrorEl.textContent = "";
    this.examplesBusyEl.style.display = "none";
    this._exampleButtons = [];
    this._exampleSets = Array.isArray(sets) ? sets : [];
    this._exampleAdded = alreadyAdded;
    this.examplesList.replaceChildren();
    const list = this._exampleSets;
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "examples-subtitle";
      empty.textContent = "No example tile sets available.";
      this.examplesList.append(empty);
    }
    for (const { source, set, preview: renderedTiles } of list) {
      const card = document.createElement("div");
      card.className = "examples-set";
      const h3 = document.createElement("h3");
      h3.textContent = set.name || set.id;
      const src = document.createElement("div");
      src.className = "source";
      src.textContent = source;
      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = set.description || "";
      // Live tile previews: each tile is rendered through the real
      // #buildTile/#paintTile from the evaluator's output (real data
      // fed by the app's stream subscription via
      // public/lib/preview.js), so the user sees the actual tile —
      // label, headline value, footer — with the boat's real data,
      // or honestly stale/neutral for paths the boat doesn't publish.
      const preview = document.createElement("div");
      preview.className = "examples-preview";
      const configTiles = Array.isArray(set.tiles) ? set.tiles : [];
      const rendered = Array.isArray(renderedTiles) ? renderedTiles : [];
      for (let i = 0; i < configTiles.length; i++) {
        preview.append(this.#buildPreviewTile(rendered[i], configTiles[i]));
      }
      const btn = document.createElement("button");
      btn.className = "add-set-btn";
      const added = alreadyAdded?.has(set.id);
      btn.textContent = added ? "Already added" : "Add";
      btn.dataset.added = added ? "1" : "0";
      btn.disabled = !!added;
      btn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("st-examples-add", {
            bubbles: true,
            composed: true,
            detail: { set },
          }),
        );
      });
      this._exampleButtons.push(btn);
      card.append(h3, src, desc, preview, btn);
      this.examplesList.append(card);
    }
    this.examplesOverlay.style.display = "";
  }

  /**
   * Builds a compact preview of one example tile: the rendered tile
   * (the evaluator's output against the boat's live data, supplied by
   * the app via public/lib/preview.js) is handed to the real
   * #buildTile/#paintTile, so the tile shows its actual state/color,
   * label, headline value, and footer from real data. A muted caption
   * below lists the check type(s) and watched path(s) (from the config
   * tile) so the user sees what the tile watches.
   * @param {object} rendered - the evaluator's rendered-tile shape
   *   ({id, state, label, reason, displayValue, footer})
   * @param {object} configTile - the tile in config shape (SPEC §9),
   *   used only for the caption's check summary
   * @returns {HTMLElement}
   */
  #buildPreviewTile(rendered, configTile) {
    const wrap = document.createElement("div");
    wrap.className = "examples-tile-wrap";
    // Fall back to a neutral shape if the app supplied no rendered tile
    // (defensive: a set whose preview failed to compute still lists its
    // tiles rather than blanking).
    const t = rendered || {
      id: configTile?.id,
      label: configTile?.label || configTile?.id,
      state: "neutral",
      reason: "",
      footer: [],
    };
    const tileEl = this.#buildTile(t);
    wrap.append(tileEl);
    const caption = document.createElement("div");
    caption.className = "examples-checks";
    const checks = Array.isArray(configTile?.checks) ? configTile.checks : [];
    caption.textContent = checks.map(checkSummary).join(", ");
    wrap.append(caption);
    return wrap;
  }

  /**
   * Hides the overlay (called by its own close button, or by the app
   * after a successful copy) and dispatches `st-examples-close` so the
   * app can end its preview stream subscription extension.
   */
  closeExamples() {
    this.examplesOverlay.style.display = "none";
    this.dispatchEvent(
      new CustomEvent("st-examples-close", { bubbles: true, composed: true }),
    );
  }

  /**
   * Refreshes the rendered preview tiles in place (the app calls this
   * on each preview delta while the picker is open, so previews show
   * live data). Structure-safe: if the set list or any set's tile
   * count changed since openExamples (shouldn't happen — the sets are
   * re-fetched only on open), falls back to a full re-render with the
   * stored already-added set. Buttons, scroll, and card layout are
   * untouched — only each tile wrap's contents are rebuilt.
   * @param {Array<{source: string, set: object, preview?: Array<object>}>} sets
   */
  updateExamplesPreviews(sets) {
    const list = Array.isArray(sets) ? sets : [];
    const cards = [...this.examplesList.children].filter(
      (c) => c.className === "examples-set",
    );
    if (
      cards.length !== list.length ||
      this._exampleSets?.length !== list.length
    ) {
      this.openExamples({ sets: list, alreadyAdded: this._exampleAdded });
      return;
    }
    for (let s = 0; s < list.length; s++) {
      const previewEl = [...cards[s].children].find(
        (ch) => ch.className === "examples-preview",
      );
      if (!previewEl) {
        this.openExamples({ sets: list, alreadyAdded: this._exampleAdded });
        return;
      }
      const configTiles = Array.isArray(list[s].set?.tiles)
        ? list[s].set.tiles
        : [];
      const rendered = Array.isArray(list[s].preview) ? list[s].preview : [];
      const wraps = [...previewEl.children];
      if (wraps.length !== configTiles.length) {
        this.openExamples({ sets: list, alreadyAdded: this._exampleAdded });
        return;
      }
      for (let i = 0; i < wraps.length; i++) {
        wraps[i].replaceChildren(
          ...this.#buildPreviewTile(rendered[i], configTiles[i]).children,
        );
      }
    }
  }

  /** Error message in the overlay (e.g. a 400 on the merged config). */
  set examplesError(msg) {
    this.examplesErrorEl.textContent = msg || "";
  }

  /** Shows a "Adding…" indicator and disables all Add buttons while a
   * copy is in flight (prevents double-clicks; the merge is idempotent
   * anyway, but the UX feedback matters). */
  set examplesBusy(on) {
    this.examplesBusyEl.style.display = on ? "" : "none";
    for (const btn of this._exampleButtons) {
      btn.disabled = !!on || btn.dataset.added === "1";
    }
  }
}

/** Last two dot-segments of a path — full paths overflow a tile label. */
export function shortPath(p) {
  const parts = String(p).split(".");
  return parts.slice(-2).join(".");
}

/**
 * Font-fit bucket for a headline string (see the .value CSS): tiles are
 * ~16vw wide, so the default 6.5vh headline fits ~7 monospace chars on
 * one line. Longer composed headlines step down and eventually wrap.
 * Buckets: s ≤7 chars (default size), m ≤12, l >12.
 * @param {string} s
 * @returns {"s"|"m"|"l"}
 */
export function valueFit(s) {
  const len = String(s).length;
  if (len <= 7) return "s";
  return len <= 12 ? "m" : "l";
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
 * dot-segment, leaving the surrounding words/operators intact. A
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

/**
 * One-line summary of a check for the examples-preview caption: type
 * plus the path(s) it watches, shortened to the differing tail. Lets the
 * user see what a preview tile watches even though the tile itself is
 * neutral (no live data yet). Keeps the caption compact at glance size.
 * @param {object} check
 * @returns {string}
 */
export function checkSummary(check) {
  const t = check?.type || "check";
  if (t === "alarmGroup") {
    const ps = Array.isArray(check.paths) ? check.paths : [];
    return ps.length ? `${t} · ${ps.map(shortPath).join(", ")}` : t;
  }
  if (t === "agreement") {
    return `${t} · ${shortPath(check.path || "")} ≠ ${shortPath(check.path2 || "")}`;
  }
  if (t === "compound") return t;
  const p = check?.path;
  return p ? `${t} · ${shortPath(p)}` : t;
}

customElements.define("st-tile-grid", StTileGrid);
