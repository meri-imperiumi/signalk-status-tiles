/**
 * Signal K stream subscription for the Status Tiles webapp.
 *
 * Opens a WebSocket to `/signalk/v1/stream?subscribe=none` and subscribes
 * to every path the engine needs (collected from the config — contexts,
 * checks, coverage candidates — de-duplicated). Forwards each value and
 * meta update to a callback. Auto-reconnects on loss.
 *
 * @file st-stream.js */

class SignalKStream {
  /**
   * @param {string[]} paths - paths to subscribe to
   * @param {(delta: object) => void} onDelta - called with each raw delta
   */
  constructor(paths, onDelta) {
    /** @type {string[]} */
    this.paths = paths;
    /** @type {((delta: object) => void)|null} */
    this.onDelta = onDelta;
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.reconnectTimer = null;
    /** @type {boolean} */
    this.closed = false;
  }

  connect() {
    if (this.closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${proto}://${window.location.host}/signalk/v1/stream?subscribe=none&sendMeta=all`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.paths.length > 0) {
        const msg = {
          context: "vessels.self",
          subscribe: this.paths.map((p) => ({ path: p })),
        };
        console.log(
          "[status-tiles] subscribing to",
          this.paths.length,
          "paths:",
          this.paths,
        );
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
      // Surface server-side errors and acks so a failed/empty subscription
      // is visible rather than a silent black screen. The Signal K stream
      // sends a `hello` on connect and may send an `errorMessage` if a
      // subscription is rejected.
      if (data.errorMessage) {
        console.error("[status-tiles] stream error:", data.errorMessage);
        this.onDelta?.({ __streamError: data.errorMessage });
      }
      // Deltas carry updates; hello/ack messages don't — pass only deltas.
      if (data.updates) {
        this.onDelta?.(data);
      }
    });

    socket.addEventListener("close", () => {
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  /** Updates the subscription path set (after a config reload) and reconnects. */
  setPaths(paths) {
    this.paths = paths;
    this.socket?.close();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

export { SignalKStream };
