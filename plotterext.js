/**
 * Plotter-extension integration (Plotter Extensions API v1 — Freeboard-SK
 * and any compatible chart plotter host): exposes one glanceable widget
 * per configured tile, so the user can show the tiles they care about in
 * the plotter's own widget grid. Deliberately minimal — unlike
 * signalk-dead-reckoning this plugin is not a plotter host and has no
 * panels, buttons, or overlays; the tile widgets are the whole surface.
 *
 * Two server-side responsibilities (see freeboard-sk
 * docs/api/plotter_extension_provider_plugins.md):
 *
 * 1. Register a read-only `plotterExtensions` resource provider whose
 *    single entry is this plugin's manifest — the host discovers the
 *    extension there. The manifest is rebuilt from the live config on
 *    every provider call (a config edit restarts the plugin, so the
 *    provider reflects added/removed/renamed tiles without
 *    re-registration). Presence in the collection *is* the enablement
 *    signal; the provider goes empty on plugin stop so the host tears
 *    the contexts down.
 * 2. Serve the extension's iframe assets at a publicly readable,
 *    non-admin-gated route. `/plugins/*` is admin-only on the server, so
 *    the manifest URLs point at a self-mounted namespaced prefix instead.
 *    The assets are inert UI code — all data flows over the host bus.
 *    Served by a minimal in-repo static handler rather than
 *    `express.static`: this plugin is zero-dependency by design (SPEC §2)
 *    and `express` is not resolvable from a plugin's own tree — only
 *    from inside the server.
 *
 * @file plotterext.js
 */

import fs from "node:fs";
import path from "node:path";
import pkg from "./package.json" with { type: "json" };

/** Directory holding the extension's iframe assets: the same `public/`
 * the webapp is served from — the widget entry page lives alongside the
 * ES modules it imports (the shared lib/ engine modules, the tile
 * styling vocabulary), so relative imports keep working under either
 * mount (webapp keyword path or the plotterext prefix). */
const PUBLIC_DIR = path.join(import.meta.dirname, "public");

/** Content types for the extension's asset kinds (inert UI code). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Builds the extension manifest: one widget per configured tile.
 *
 * `requires` lists only what the widget cannot run without at all;
 * `nightMode` is optional (the widget guards with hasCapability).
 *
 * @param {object} opts
 * @param {string} opts.assetBase - server-relative URL prefix for assets
 * @param {string} [opts.version] - plugin version for display metadata
 * @param {Array<{id: string, label?: string, size?: string}>} [opts.tiles]
 *   - the configured tiles; one widget each, in config order
 * @returns {object} manifest per the Plotter Extensions API v1
 */
export function buildManifest({ assetBase, version, tiles }) {
  const tileList = Array.isArray(tiles) ? tiles : [];
  return {
    name: "Status Tiles",
    description:
      "One glanceable widget per configured Status Tiles tile: state color, label and display value straight from the plugin's published tile statuses.",
    version: version ?? pkg.version,
    apiVersion: "1",
    requires: ["widgets", "signalk.stream"],
    optional: ["nightMode"],
    widgets: tileList.map((tile) => ({
      // Stable per-tile id: adding/removing other tiles must not
      // re-key this widget's host-side position/persistence.
      id: `tile-${tile.id}`,
      title: tile.label || tile.id,
      type: "iframe",
      // ?tile=<id> is the widget's contract with the page: one shared
      // widget entry renders whichever tile the manifest pointed it at.
      // Tile ids are validated to [A-Za-z][A-Za-z0-9_-]* (config.js),
      // so they are safe as query values without escaping.
      url: `${assetBase}/tile-ext-widget.html?tile=${tile.id}`,
      // The tile's configured size class is the same grid-unit
      // vocabulary the plotter hosts use (SPEC §11.1) — pass through.
      size: tile.size ?? "1x1",
      lifecycle: "whileEnabled",
    })),
  };
}

/**
 * Minimal static-asset middleware for the extension's files. Not a
 * general file server: only regular files directly under `root` are
 * served (directory indexes and anything escaping `root` fall through).
 *
 * @param {string} root - absolute directory to serve
 * @param {string} assetBase - mount prefix, stripped when the host did
 *   not already strip it (Express strips it for `app.use(path, fn)`;
 *   other hosts may pass the full path)
 * @returns {(req: object, res: object, next: Function) => void}
 */
export function staticAssetHandler(root, assetBase) {
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  return (req, res, next) => {
    let urlPath = req.path ?? req.url ?? "/";
    const q = urlPath.indexOf("?");
    if (q >= 0) urlPath = urlPath.slice(0, q);
    if (urlPath.startsWith(assetBase)) {
      urlPath = urlPath.slice(assetBase.length);
    }
    if (!urlPath.startsWith("/")) urlPath = `/${urlPath}`;

    let resolved;
    try {
      resolved = path.normalize(
        path.join(rootPrefix, decodeURIComponent(urlPath)),
      );
    } catch {
      next(); // malformed percent-encoding
      return;
    }
    // Traversal guard: the resolved path must stay inside root.
    if (!resolved.startsWith(rootPrefix)) {
      next();
      return;
    }

    fs.stat(resolved, (err, st) => {
      if (err || !st.isFile()) {
        next();
        return;
      }
      // Code assets must never be served stale: the manifest (fresh via
      // the resources API) can promise features the cached iframe code
      // behind it predates. `no-cache` revalidates every load; the
      // validators below make that a cheap 304 when nothing changed.
      // Only rarely-changing binaries keep a lifetime.
      const ext = path.extname(resolved);
      const cacheable = ext === ".png" || ext === ".svg" || ext === ".ico";
      const etag = `"${st.size}-${st.mtimeMs}"`;
      const lastModified = st.mtime.toUTCString();
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified);
      res.setHeader(
        "Cache-Control",
        cacheable ? "public, max-age=3600" : "no-cache",
      );
      // Revalidation: a matching If-None-Match (any weak/strong
      // comparison — browsers send the ETag back verbatim) or an
      // If-Modified-Since no older than the file answers 304, body
      // skipped.
      const inm = req.headers?.["if-none-match"];
      const ims = req.headers?.["if-modified-since"];
      const imsTime = ims == null ? NaN : Date.parse(ims);
      const notModified =
        inm
          ?.split(",")
          .some((t) => t.trim() === etag || t.trim() === `W/${etag}`) ||
        (inm == null &&
          Number.isFinite(imsTime) &&
          st.mtime.getTime() <= imsTime);
      if (notModified) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      fs.readFile(resolved, (readErr, data) => {
        if (readErr) {
          next();
          return;
        }
        res.end(data);
      });
    });
  };
}

/**
 * Registers the plotter-extension provider and mounts the asset route.
 *
 * The manifest is rebuilt on every provider call from `opts.getTiles()`,
 * so it always mirrors the live config — a config edit restarts the
 * plugin (stop + start), and this registration, made in start(), is torn
 * down and re-made with the fresh config's tile list. The static mount
 * is skipped on servers without `app.use` (nothing to mount on; the
 * provider registration itself is the compatibility bar).
 *
 * @param {import("@signalk/server-api").ServerAPI} app - Signal K server API
 * @param {{id: string, version?: string, getTiles: () => Array}} opts -
 *   plugin id (manifest key and asset prefix), optional version override,
 *   and the tile-list getter the manifest is built from
 * @returns {() => void} teardown — empties the provider's listing so
 *   hosts unload the extension's contexts. The static asset mount stays
 *   (Express has no unmount, and the files are inert); that matches the
 *   webapp keyword's behaviour for a disabled plugin.
 */
export function registerPlotterExtension(app, opts) {
  const { id, version, getTiles } = opts;
  const assetBase = `/plotterext/${id}`;
  let running = true;

  app.registerResourceProvider({
    type: "plotterExtensions",
    methods: {
      listResources: async () =>
        running
          ? { [id]: buildManifest({ assetBase, version, tiles: getTiles() }) }
          : {},
      getResource: async (resourceId) => {
        if (!running || resourceId !== id) {
          throw new Error(`No such plotterExtensions resource: ${resourceId}`);
        }
        return buildManifest({ assetBase, version, tiles: getTiles() });
      },
      setResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
      deleteResource: async () => {
        throw new Error(`${id} is a read-only provider`);
      },
    },
  });

  app.use?.(assetBase, staticAssetHandler(PUBLIC_DIR, assetBase));

  return () => {
    running = false;
  };
}
