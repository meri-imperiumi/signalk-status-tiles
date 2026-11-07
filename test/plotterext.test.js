/**
 * Plotter-extension integration (plotterext.js + index.js wiring): the
 * manifest exposes one widget per configured tile, the static handler
 * serves the widget assets safely, and the plugin registers a
 * read-only plotterExtensions provider that mirrors the live config
 * and goes empty on stop.
 *
 * @file plotterext.test.js */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pluginFactory, { PLUGIN_ID } from "../index.js";
import {
  buildManifest,
  registerPlotterExtension,
  staticAssetHandler,
} from "../plotterext.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "public");
const BASE = "/plotterext/signalk-status-tiles";

const TILES = [
  { id: "soc", label: "House Bank", size: "2x1" },
  { id: "anchor", label: "Anchor watch" },
  { id: "bilge" },
];

// --- buildManifest ---------------------------------------------------

test("manifest has one widget per configured tile, in config order", () => {
  const manifest = buildManifest({
    assetBase: BASE,
    version: "1.2.3",
    tiles: TILES,
  });
  assert.equal(manifest.name, "Status Tiles");
  assert.equal(manifest.apiVersion, "1");
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.requires, ["widgets", "signalk.stream"]);
  assert.deepEqual(manifest.optional, ["nightMode"]);
  assert.equal(manifest.widgets.length, 3);

  const [soc, anchor, bilge] = manifest.widgets;
  assert.equal(soc.id, "tile-soc");
  assert.equal(soc.title, "House Bank");
  assert.equal(soc.url, `${BASE}/tile-ext-widget.html?tile=soc`);
  assert.equal(soc.size, "2x1");
  assert.equal(soc.lifecycle, "whileEnabled");

  assert.equal(anchor.id, "tile-anchor");
  assert.equal(anchor.size, "1x1", "size defaults to the smallest class");
  assert.equal(bilge.title, "bilge", "label falls back to the tile id");
  // One shared widget page; the ?tile= query is the per-tile contract
  assert.equal(bilge.url, `${BASE}/tile-ext-widget.html?tile=bilge`);
  for (const w of manifest.widgets) {
    assert.equal(w.type, "iframe");
  }
});

test("manifest tolerates missing or non-array tiles", () => {
  assert.deepEqual(buildManifest({ assetBase: BASE }).widgets, []);
  assert.deepEqual(
    buildManifest({ assetBase: BASE, tiles: "nope" }).widgets,
    [],
  );
  assert.ok(buildManifest({ assetBase: BASE }).version, "version defaults");
});

// --- staticAssetHandler ----------------------------------------------

/** Minimal req/res pair for the static handler. */
function mockReq(url, headers = {}) {
  return { url, headers };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = v;
    },
    end(data) {
      res.ended = true;
      res.body = data ?? null;
    },
  };
  return res;
}

function serve(url, headers = {}) {
  return new Promise((resolve) => {
    const res = mockRes();
    const handler = staticAssetHandler(PUBLIC_DIR, BASE);
    handler(mockReq(url, headers), res, () => {
      resolve({ next: true });
    });
    // The handler answers asynchronously (fs.stat); wait a tick.
    setTimeout(() => resolve({ res }), 20);
  });
}

test("serves the widget page and code assets under the mount", async () => {
  const html = await serve(`${BASE}/tile-ext-widget.html`);
  assert.ok(!html.next, "answered, not fell through");
  assert.equal(html.res.statusCode, 200);
  assert.match(html.res.headers["content-type"], /text\/html/);
  assert.ok(html.res.body.includes("tile-ext-widget"));

  const js = await serve(`${BASE}/tile-ext-widget.js`);
  assert.equal(js.res.statusCode, 200);
  assert.match(js.res.headers["content-type"], /javascript/);

  // The vendored bus client resolves via its relative chunk imports —
  // the whole vendor directory must be reachable under the mount.
  const bus = await serve(`${BASE}/vendor/plotterext-bus/extension.js`);
  assert.equal(bus.res.statusCode, 200);
});

test("shared lib modules resolve under the mount (widget imports)", async () => {
  const model = await serve(`${BASE}/tile-ext-model.js`);
  assert.equal(model.res.statusCode, 200);
});

test("code assets revalidate (no-cache + ETag), images cache", async () => {
  const js = await serve(`${BASE}/tile-ext-widget.js`);
  assert.equal(js.res.headers["cache-control"], "no-cache");
  assert.ok(js.res.headers.etag);

  const notModified = await serve(`${BASE}/tile-ext-widget.js`, {
    "if-none-match": js.res.headers.etag,
  });
  assert.equal(notModified.res.statusCode, 304);
  assert.equal(notModified.res.body, null);

  const png = await serve(`${BASE}/icon.png`);
  if (!png.next) {
    assert.equal(png.res.headers["cache-control"], "public, max-age=3600");
  }
});

test("falls through for directories, missing files, and traversal", async () => {
  assert.ok((await serve(`${BASE}/lib`)).next, "directory index");
  assert.ok((await serve(`${BASE}/no-such-file.js`)).next);
  assert.ok(
    (await serve(`${BASE}/../package.json`)).next,
    "traversal escapes are not served",
  );
  assert.ok((await serve(`${BASE}/%2e%2e/index.js`)).next);
});

// --- registerPlotterExtension ----------------------------------------

/** Records the provider and static-mount registrations. */
function fakeApp() {
  return {
    providers: [],
    mounts: [],
    registerResourceProvider(provider) {
      this.providers.push(provider);
    },
    use(prefix, _handler) {
      this.mounts.push(prefix);
    },
  };
}

test("registers a read-only provider whose listing is the manifest", async () => {
  const app = fakeApp();
  const tiles = [TILES[0]];
  const teardown = registerPlotterExtension(app, {
    id: PLUGIN_ID,
    version: "9.9.9",
    getTiles: () => tiles,
  });

  assert.equal(app.providers.length, 1);
  assert.equal(app.providers[0].type, "plotterExtensions");
  assert.equal(app.mounts[0], BASE, "assets mounted at the namespaced prefix");

  const provider = app.providers[0].methods;
  const listed = await provider.listResources();
  assert.equal(Object.keys(listed).length, 1);
  const manifest = listed[PLUGIN_ID];
  assert.equal(manifest.version, "9.9.9");
  assert.deepEqual(
    manifest.widgets.map((w) => w.id),
    ["tile-soc"],
  );
  assert.deepEqual(await provider.getResource(PLUGIN_ID), manifest);
  await assert.rejects(() => provider.getResource("other"));
  await assert.rejects(() => provider.setResource(PLUGIN_ID, {}));
  await assert.rejects(() => provider.deleteResource(PLUGIN_ID));

  teardown();
  assert.deepEqual(await provider.listResources(), {}, "empty after teardown");
  await assert.rejects(() => provider.getResource(PLUGIN_ID));
});

test("the manifest mirrors the live tile list on every provider call", async () => {
  const app = fakeApp();
  const tileSets = [
    [{ id: "a", label: "A" }],
    [
      { id: "a", label: "A renamed" },
      { id: "b", label: "B", size: "2x2" },
    ],
    [],
  ];
  let cursor = 0;
  const teardown = registerPlotterExtension(app, {
    id: PLUGIN_ID,
    getTiles: () => tileSets[cursor],
  });
  const provider = app.providers[0].methods;

  assert.deepEqual(
    (await provider.listResources())[PLUGIN_ID].widgets.map((w) => w.title),
    ["A"],
  );
  cursor = 1;
  const updated = (await provider.listResources())[PLUGIN_ID];
  assert.deepEqual(
    updated.widgets.map((w) => [w.id, w.title, w.size]),
    [
      ["tile-a", "A renamed", "1x1"],
      ["tile-b", "B", "2x2"],
    ],
  );
  cursor = 2;
  assert.deepEqual((await provider.listResources())[PLUGIN_ID].widgets, []);
  teardown();
});

// --- plugin wiring -----------------------------------------------------

test("start registers the plotter-extension provider, stop empties it", async (t) => {
  t.mock.timers.enable({ now: Date.now() });
  const app = {
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    get: () => {},
    handleMessage: () => {},
    subscriptionmanager: {
      subscribe(_sub, unsubscribes) {
        unsubscribes.push(() => {});
      },
    },
    providers: [],
    mounts: [],
    registerResourceProvider(provider) {
      app.providers.push(provider);
    },
    use(prefix) {
      app.mounts.push(prefix);
    },
  };
  const plugin = pluginFactory(app);
  const config = {
    contexts: [],
    tiles: [{ id: "soc", label: "House Bank", checks: [] }],
  };
  plugin.start(config);
  t.after(() => plugin.stop());

  const plotterProvider = app.providers.find(
    (p) => p.type === "plotterExtensions",
  );
  assert.ok(plotterProvider, "provider registered on start");
  assert.ok(app.mounts.includes(BASE));

  const listed = await plotterProvider.methods.listResources();
  assert.deepEqual(
    listed[PLUGIN_ID].widgets.map((w) => w.id),
    ["tile-soc"],
  );

  plugin.stop();
  assert.deepEqual(
    await plotterProvider.methods.listResources(),
    {},
    "listing empties on stop so hosts tear the widgets down",
  );
});

test("start tolerates servers without the resource provider registry", () => {
  const app = {
    setPluginStatus: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    get: () => {},
    handleMessage: () => {},
    subscriptionmanager: {
      subscribe(_sub, unsubscribes) {
        unsubscribes.push(() => {});
      },
    },
  };
  const plugin = pluginFactory(app);
  assert.doesNotThrow(() =>
    plugin.start({ contexts: [], tiles: [{ id: "x", checks: [] }] }),
  );
  plugin.stop();
});
