/**
 * Signal K stream subscription for the Status Tiles webapp.
 *
 * Opens a WebSocket to `/signalk/v1/stream?subscribe=none` and subscribes
 * to every path the engine needs (collected from the config — contexts,
 * checks, coverage candidates — de-duplicated). Forwards each value and
 * meta update to a callback.
 *
 * Connection loss (server restart, network drop) is handled on two
 * independent layers:
 *
 *   1. **Link level (this module)**: auto-reconnect with a fixed retry
 *      interval, re-subscribing on every successful open. Connection
 *      state transitions are reported through `onStatus` so the UI can
 *      say "link lost" the instant the socket dies — long before
 *      staleness (SPEC §4) would surface it as neutral tiles.
 *   2. **Data level (staleness.js)**: the engine's timer-driven tick
 *      keeps aging paths from their last delta timestamp, so during an
 *      outage every check degrades to its configured stale state
 *      (missing data is never silently green, SPEC §4/§8). The cache is
 *      deliberately NOT cleared on reconnect — a brief blip shouldn't
 *      blank fresh values, and a path that no longer exists after a
 *      restart goes stale on its own.
 *
 * The socket implementation and URL are injectable for testing (node's
 * test runner has no WebSocket); production defaults resolve from
 * `window.location`.
 *
 * @file st-stream.js */

/** Reconnect retry interval (ms). Fixed, not backed off: a restarting
 * server typically comes back within seconds, and a steady 5s cadence is
 * harmless noise compared to an exponential backoff stretching to
 * minutes on a helm display that must recover the moment the link does. */
const RETRY_MS = 5000;

class SignalKStream {
  /**
   * @param {string[]} paths - paths to subscribe to
   * @param {(delta: object) => void} onDelta - called with each raw delta
   * @param {object} [options]
   * @param {(status: {state: "connecting"|"open"|"retrying"}) => void} [options.onStatus]
   *   link-state transitions; `retrying` means the link was lost and a
   *   reconnect is scheduled
   * @param {(url: string) => WebSocket} [options.socketFactory]
   * @param {string} [options.streamUrl]
   */
  constructor(paths, onDelta, options = {}) {
    /** @type {string[]} */
    this.paths = paths;
    /** @type {((delta: object) => void)|null} */
    this.onDelta = onDelta;
    /** @type {((status: object) => void)|null} */
    this.onStatus = options.onStatus ?? null;
    /** @type {(url: string) => WebSocket} */
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    /** @type {string|null} */
    this.streamUrl = options.streamUrl ?? null;
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.reconnectTimer = null;
    /** @type {boolean} */
    this.closed = false;
  }

  /**
   * @param {"connecting"|"open"|"retrying"} state
   * @param {object} [extra]
   */
  #status(state, extra) {
    this.onStatus?.({ state, ...extra });
  }

  /** @returns {string} */
  #url() {
    if (this.streamUrl) return this.streamUrl;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/signalk/v1/stream?subscribe=none&sendMeta=all`;
  }

  connect() {
    if (this.closed) return;
    this.#status("connecting");
    const socket = this.socketFactory(this.#url());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.#status("open");
      if (this.paths.length > 0) {
        const msg = {
          context: "vessels.self",
          subscribe: this.paths.map((p) => ({ path: p })),
        };
        socket.send(JSON.stringify(msg));
      } else {
        console.warn(
          "[status-tiles] no paths to subscribe to — config has no watchable paths",
        );
      }
    });

    socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      // The Signal K stream sends a `hello` on connect and may send an
      // `errorMessage` if a subscription is rejected. A rejected
      // subscription is a config problem, not a link problem — log it
      // loudly; the link itself stays open.
      if (data.errorMessage) {
        console.error("[status-tiles] stream error:", data.errorMessage);
      }
      // Deltas carry updates; hello/ack messages don't — pass only deltas.
      if (data.updates) {
        this.onDelta?.(data);
      }
    });

    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.#status("retrying");
      this.reconnectTimer = setTimeout(() => this.connect(), RETRY_MS);
    });

    socket.addEventListener("error", () => {
      // The error event carries no actionable detail; close() triggers
      // the reconnect path above (and is a no-op if already closed).
      socket.close();
    });
  }

  /**
   * Updates the subscription path set (after a config reload) and
   * reconnects with the new paths.
   * @param {string[]} paths
   */
  setPaths(paths) {
    this.paths = paths;
    this.socket?.close();
  }

  /** Permanently closes the stream; no further reconnects are scheduled. */
  close() {
    this.closed = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

export { RETRY_MS, SignalKStream };
