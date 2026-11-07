/**
 * `<tile-ext-widget>` — one configured status tile as a plotter widget
 * (Plotter Extensions API v1 hosts). The manifest (plotterext.js) lists
 * one widget entry per configured tile; every entry points at this same
 * page, and `?tile=<id>` says which tile to render.
 *
 * Runs inside a chart plotter's sandboxed iframe: connects over the
 * vendored bus client, subscribes to the tile's two published paths
 * through the host's multiplexed Signal K relay, and renders the tile
 * in the webapp's visual language (st-tile-grid: flat panel, corner
 * brackets, theme classes, day/night palettes). The server runs the
 * full evaluation engine — the widget deliberately re-evaluates
 * nothing; it is a pure view over the published scalars. The pure
 * wording/mapping decisions live in `tile-ext-model.js`.
 *
 * Bootstrapping: bus deltas are change-driven, so the current values
 * are fetched over REST before any delta arrives (a quiet green tile
 * must not sit at NO DATA until its next change). The tile label comes
 * from the public config endpoint; the `statusTiles.configHash` delta
 * (public/lib/config-hash.js) triggers a re-fetch when the config
 * changes server-side. Long-press → host config/remove dialog (the
 * family gesture); a tile is glance-only, so a short tap does nothing.
 *
 * @file tile-ext-widget.js
 */

import { CONFIG_HASH_PATH } from "./lib/config-hash.js";
import { tileDisplayValuePath, tileStatusPath } from "./lib/status-paths.js";
import { tileIdFromSearch, tileWidgetModel } from "./tile-ext-model.js";
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

/** The widget's own tile id, from the manifest's ?tile= contract. */
const TILE_ID = tileIdFromSearch(window.location.search);

/** Public config endpoint (same one the webapp boots from). */
const CONFIG_URL = "/signalk/v2/api/status-tiles/configuration";
/** REST bootstrap of the tile's current values (change-driven deltas
 * alone would leave a quiet tile at NO DATA until its next change). */
const SELF_URL = "/signalk/v2/api/vessels/self";
/** Config/REST fetch retries: a config edit restarts the plugin, and
 * fetches racing that restart see a 503 for a moment. */
const FETCH_RETRIES = 4;
const FETCH_RETRY_MS = 500;

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <style>
    /* Webapp tile palette (index.html day vars) as fallbacks: the
       iframe has no index.html, so the widget is self-contained. */
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      --color-green: #8dfcbb;
      --color-green-rgb: 141, 252, 187;
      --color-teal: #66c6db;
      --color-teal-rgb: 102, 198, 219;
      --color-orange: #fca847;
      --color-orange-rgb: 252, 168, 71;
      --color-red: #ff5e5e;
      --color-red-rgb: 255, 94, 94;
      --color-grey: #666666;
      --color-grey-rgb: 102, 102, 102;
      --bg-panel: #111414;
      --bg-panel-muted: #0a0c0c;
      --text-muted: #a0a0b5;
    }
    /* Night mode (host nightMode capability): the webapp's night
       palette — dimmed so the tile doesn't glow on a dark bridge. */
    :host(.night) {
      --color-green: #4a7555;
      --color-green-rgb: 74, 117, 85;
      --color-teal: #33616b;
      --color-teal-rgb: 51, 97, 107;
      --color-orange: #8a5318;
      --color-orange-rgb: 138, 83, 24;
      --color-red: #8f3333;
      --color-red-rgb: 143, 51, 51;
      --color-grey: #333333;
      --color-grey-rgb: 51, 51, 51;
      --bg-panel: #060707;
      --bg-panel-muted: #060707;
    }
    /* Spec theme classes (st-tile-grid): the class assigns the local
       --c/--c-rgb pair; JS never handles colors, so a night switch is
       a class flip and the palette vars do the rest. */
    .theme-green { --c: var(--color-green); --c-rgb: var(--color-green-rgb); }
    .theme-orange { --c: var(--color-orange); --c-rgb: var(--color-orange-rgb); }
    .theme-red { --c: var(--color-red); --c-rgb: var(--color-red-rgb); }
    .theme-teal { --c: var(--color-teal); --c-rgb: var(--color-teal-rgb); }
    .tile {
      position: relative;
      display: grid;
      grid-template-rows: auto 1fr auto;
      grid-template-areas:
        "label"
        "value"
        "word";
      height: 100%;
      box-sizing: border-box;
      padding: 1.2vh 0.9vw;
      overflow: hidden;
      background: var(--bg-panel);
      /* 4px strokes, thicker than the spec's 2px: the border carries
         the state color and must survive glance distance (the same
         low-contrast-screen divergence as the webapp grid). */
      border: 4px solid rgba(var(--color-grey-rgb, 102, 102, 102), 0.35);
      transition: background 0.2s, border-color 0.2s;
      font-family: system-ui, -apple-system, sans-serif;
      color: #ffffff;
    }
    /* Corner brackets (SPEC §11): top-left and bottom-right, in the
       theme color when lit, dimmed grey when neutral. */
    .tile::before,
    .tile::after {
      content: "";
      position: absolute;
      width: 2.4vh;
      height: 2.4vh;
      pointer-events: none;
    }
    .tile::before {
      top: 0.6vh;
      left: 0.6vh;
      border-top: 4px solid var(--c, var(--color-grey));
      border-left: 4px solid var(--c, var(--color-grey));
    }
    .tile::after {
      bottom: 0.6vh;
      right: 0.6vh;
      border-bottom: 4px solid var(--c, var(--color-grey));
      border-right: 4px solid var(--c, var(--color-grey));
    }
    .tile.lit {
      border-color: rgba(var(--c-rgb), 0.65);
      background: rgba(var(--c-rgb), 0.16);
    }
    .tile.neutral {
      border-color: rgba(var(--color-grey-rgb), 0.5);
      background: var(--bg-panel-muted);
    }
    /* Only red pulses (SPEC §2: motion is reserved for "look at this
       now"); strictly flat, no glow. */
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
      font-size: clamp(0.55rem, 2.4vh, 1rem);
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--c, var(--color-grey));
      text-align: center;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .tile.neutral .label { color: var(--color-grey); }
    .value {
      grid-area: value;
      align-self: center;
      justify-self: center;
      font-family: ui-monospace, "Fira Code", monospace;
      font-variant-numeric: tabular-nums;
      font-size: clamp(1rem, 6vh, 2.4rem);
      font-weight: 800;
      line-height: 1;
      text-align: center;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .value:empty { display: none; }
    .word {
      grid-area: word;
      font-size: clamp(0.5rem, 2vh, 0.85rem);
      font-weight: 700;
      letter-spacing: 0.14em;
      text-align: center;
      color: var(--c, var(--color-grey));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tile.neutral .word { color: var(--text-muted); }
  </style>
  <div class="tile">
    <div class="label" id="label">—</div>
    <div class="value" id="value"></div>
    <div class="word" id="word">NO DATA</div>
  </div>
`;

class TileExtWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.append(template.content.cloneNode(true));

    /** @type {string|null} last config hash seen (reload trigger) */
    this.configHash = null;
    /** @type {string|null} tile label from the config */
    this.label = null;
    /** @type {string|null} last published state string */
    this.state = null;
    /** @type {string|null} last published display value */
    this.displayValue = null;
    this.connected = false;

    // Long-press → host config/remove dialog (pointer events inside the
    // iframe are invisible to the host, so the widget detects the
    // gesture itself). A short tap has no action — the tile is
    // glance-only; the flag keeps a future tap handler from firing
    // after a hold.
    /** @type {number|null} */
    this.pressTimer = null;
    /** @type {boolean} */
    this.longPressed = false;
    this.addEventListener("pointerdown", this.onPointerDown);
    this.addEventListener("pointerup", this.onPointerUp);
    this.addEventListener("pointercancel", this.onPointerUp);
    this.addEventListener("pointerleave", this.onPointerUp);
    this.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * @param {PointerEvent} e
   * @returns {void}
   */
  onPointerDown(e) {
    if (!this.connected || e.button !== 0) return;
    this.longPressed = false;
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      this.client?.call("ui.toggleConfigPanel").catch(() => {});
    }, 1200);
  }

  /**
   * @returns {void}
   */
  onPointerUp() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }

  async connectedCallback() {
    if (this.connected) return;
    this.connected = true;

    // REST bootstrap before the bus connect: current values + label,
    // so a quiet tile paints its real state immediately (a delta only
    // travels on change).
    await this.fetchConfig();
    await this.fetchCurrentValues();
    this.render();

    let client;
    try {
      client = await connectExtension();
    } catch {
      // No host handshake (opened standalone while developing, or the
      // host vanished): the REST bootstrap above is still on screen.
      return;
    }
    this.client = client;

    if (TILE_ID) {
      try {
        await client.signalk.subscribe(
          [
            tileStatusPath(TILE_ID),
            tileDisplayValuePath(TILE_ID),
            CONFIG_HASH_PATH,
          ],
          (ev) => {
            const path = ev?.path;
            if (path === tileStatusPath(TILE_ID)) {
              this.state = typeof ev.value === "string" ? ev.value : null;
            } else if (path === tileDisplayValuePath(TILE_ID)) {
              this.displayValue = ev.value == null ? null : String(ev.value);
            } else if (path === CONFIG_HASH_PATH) {
              // A config edit restarts the plugin and republishes the
              // hash; a differing hash re-fetches the label (the tile's
              // name may have changed). Content-addressed, so equal
              // hashes are never a real change.
              if (
                typeof ev.value === "string" &&
                ev.value !== this.configHash
              ) {
                this.fetchConfig().then(() => this.render());
              }
            }
            this.render();
          },
        );
      } catch {
        // Host without signalk.stream (or relay failure): the manifest
        // `requires` should prevent this, but the widget degrades to
        // the REST bootstrap rather than blanking.
      }
    }

    if (client.hasCapability("nightMode")) {
      try {
        const { enabled } = await client.nightMode.get();
        this.classList.toggle("night", Boolean(enabled));
      } catch {
        /* best-effort seed */
      }
      await client
        .subscribe(["nightMode.changed"], (_name, params) => {
          this.classList.toggle("night", Boolean(params?.enabled));
        })
        .catch(() => {});
    }

    this.render();
  }

  disconnectedCallback() {
    this.onPointerUp();
    this.client?.close();
    this.client = null;
    this.connected = false;
  }

  /**
   * Fetches the public config endpoint for the tile label, with the
   * short retry loop the webapp uses (a config edit restarts the
   * plugin and the endpoint answers 503 for a moment). A missing tile
   * id (widget whose tile was removed from the config) keeps the id
   * itself as the label and renders no-data.
   *
   * @returns {Promise<void>}
   */
  async fetchConfig() {
    if (!TILE_ID) return;
    try {
      const body = await fetchRetry(CONFIG_URL);
      const cfg = body?.config ?? body;
      const tile = (cfg?.tiles ?? []).find((t) => t?.id === TILE_ID);
      this.label = tile?.label || TILE_ID;
      this.configHash =
        typeof body?.configHash === "string"
          ? body.configHash
          : this.configHash;
    } catch {
      // Config unavailable (stopped plugin, offline host): keep the
      // current label; the tile id is the fallback.
      this.label ??= TILE_ID;
    }
  }

  /**
   * Fetches the tile's currently-published values over the REST API —
   * the boot-time snapshot that change-driven bus deltas never replay.
   * Two leaf reads (state, display value); a missing leaf (tile not
   * published yet, 404) just leaves that field unset.
   *
   * @returns {Promise<void>}
   */
  async fetchCurrentValues() {
    if (!TILE_ID) return;
    // Dots become slashes in the REST API (SK path convention).
    const readLeaf = async (path) => {
      try {
        const body = await fetchRetry(
          `${SELF_URL}/${path.split(".").join("/")}`,
        );
        // A leaf read returns the leaf node ({value, timestamp, ...});
        // take .value with a bare-value fallback across versions.
        return body?.value ?? body;
      } catch {
        return null;
      }
    };
    const state = await readLeaf(tileStatusPath(TILE_ID));
    if (typeof state === "string") this.state = state;
    const dv = await readLeaf(tileDisplayValuePath(TILE_ID));
    this.displayValue = dv == null ? null : String(dv);
  }

  /**
   * Applies the latest values to the DOM through the pure model.
   *
   * @returns {void}
   */
  render() {
    const model = tileWidgetModel({
      label: this.label,
      state: this.state,
      displayValue: this.displayValue,
    });
    const root = this.shadowRoot;
    const tile = root.querySelector(".tile");
    tile.className =
      `tile ${model.theme ? `theme-${model.theme} lit` : "neutral"}` +
      `${model.theme === "red" ? " alarm" : ""}`;
    root.querySelector("#label").textContent = model.label;
    root.querySelector("#value").textContent = model.value;
    root.querySelector("#word").textContent = model.word;
  }
}

/**
 * Fetches JSON with the short retry loop used for boot-time reads
 * (see FETCH_RETRIES).
 *
 * @param {string} url
 * @returns {Promise<object>} parsed body
 */
async function fetchRetry(url) {
  let lastErr = new Error("not attempted");
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, FETCH_RETRY_MS));
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

customElements.define("tile-ext-widget", TileExtWidget);
