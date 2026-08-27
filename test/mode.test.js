/**
 * Day/night mode handling (public/lib/mode.js): extracting the mode
 * from deltas, applying data-mode to the document root, and the REST
 * bootstrap fetch. The mode is what the spec's palette keys off — a
 * stuck "night" here would dim the whole kiosk, so unknown values must
 * never reach the root element.
 *
 * @file mode.test.js */

import assert from "node:assert/strict";
import test from "node:test";

const {
  ENVIRONMENT_MODE_PATH,
  ENVIRONMENT_MODE_URL,
  applyMode,
  fetchEnvironmentMode,
  modeFromDelta,
} = await import("../public/lib/mode.js");

test("path constants target the standard environment.mode node", () => {
  assert.equal(ENVIRONMENT_MODE_PATH, "environment.mode");
  assert.equal(
    ENVIRONMENT_MODE_URL,
    "/signalk/v1/api/vessels/self/environment/mode",
  );
});

test("modeFromDelta extracts the last environment.mode value", () => {
  const delta = {
    updates: [{ values: [{ path: "environment.mode", value: "night" }] }],
  };
  assert.equal(modeFromDelta(delta), "night");

  // Deltas may batch updates: the last matching value wins.
  const batched = {
    updates: [
      { values: [{ path: "name", value: "S/Y Pi" }] },
      { values: [{ path: "environment.mode", value: "day" }] },
      { values: [{ path: "environment.mode", value: "night" }] },
    ],
  };
  assert.equal(modeFromDelta(batched), "night");
});

test("modeFromDelta ignores deltas without the path or with junk values", () => {
  assert.equal(
    modeFromDelta({ updates: [{ values: [{ path: "name", value: "x" }] }] }),
    null,
  );
  assert.equal(modeFromDelta({}), null);
  assert.equal(modeFromDelta(null), null);
  // A value outside the day/night vocabulary must not re-skin the
  // display.
  assert.equal(
    modeFromDelta({
      updates: [{ values: [{ path: "environment.mode", value: "dusk" }] }],
    }),
    null,
  );
});

test("applyMode sets data-mode on the document root", () => {
  const doc = { documentElement: { dataset: {} } };
  applyMode("night", doc);
  assert.equal(doc.documentElement.dataset.mode, "night");
  applyMode("day", doc);
  assert.equal(doc.documentElement.dataset.mode, "day");
});

test("applyMode ignores unknown values and a missing document root", () => {
  const doc = { documentElement: { dataset: {} } };
  applyMode("twilight", doc);
  assert.equal(doc.documentElement.dataset.mode, undefined);
  // No document in this environment: must not throw (app.js calls this
  // opportunistically from the delta handler).
  applyMode("night");
});

test("fetchEnvironmentMode reads the endpoint shapes and tolerates junk", async () => {
  // The REST endpoint addresses the mode node itself: bare string.
  const bare = async () => ({ ok: true, json: async () => "night" });
  assert.equal(await fetchEnvironmentMode(bare), "night");

  // A wrapped object shape, in case a server build wraps the node.
  const wrapped = async () => ({
    ok: true,
    json: async () => ({ value: "day" }),
  });
  assert.equal(await fetchEnvironmentMode(wrapped), "day");

  // Non-mode values -> null (never re-skin the display).
  const junk = async () => ({ ok: true, json: async () => "twilight" });
  assert.equal(await fetchEnvironmentMode(junk), null);

  // Failures -> null, never throw (mode is chrome, not data).
  const httpFail = async () => ({ ok: false });
  assert.equal(await fetchEnvironmentMode(httpFail), null);
  const networkFail = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchEnvironmentMode(networkFail), null);
});
