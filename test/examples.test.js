/**
 * Pure helpers for the example-tile-sets feature
 * (public/lib/examples.js): defensive flattening of the resources-API
 * collection, skip-and-report merging into a config, and the
 * already-added marker. No plugin, no fetch — just logic.
 *
 * @file examples.test.js */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateConfig } from "../public/lib/config.js";
import {
  flattenExamplesCollection,
  fullyAddedSetIds,
  mergeIntoConfig,
} from "../public/lib/examples.js";

/** A minimal valid set. */
function set(id, tileIds = ["t1"]) {
  return {
    id,
    name: id,
    tiles: tileIds.map((tid) => ({
      id: tid,
      checks: [{ type: "boolean", path: "p" }],
    })),
  };
}

test("flattenExamplesCollection flattens a {pluginId: {sets}} shape", () => {
  const collection = {
    "signalk-energy-predictor": {
      name: "Energy",
      sets: [set("a"), set("b", ["b1", "b2"])],
    },
    "other-plugin": { sets: [set("c")] },
  };
  const flat = flattenExamplesCollection(collection);
  assert.deepEqual(
    flat.map((f) => `${f.source}/${f.set.id}`),
    [
      "signalk-energy-predictor/a",
      "signalk-energy-predictor/b",
      "other-plugin/c",
    ],
  );
});

test("flattenExamplesCollection accepts a bare array under a plugin id", () => {
  // Some providers may return the sets array directly instead of { sets }.
  const flat = flattenExamplesCollection({ p1: [set("x")] });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].set.id, "x");
});

test("flattenExamplesCollection skips malformed entries, never throws", () => {
  const collection = {
    good: { sets: [set("good")] },
    // missing id
    bad1: { sets: [{ name: "n", tiles: [{ id: "t" }] }] },
    // missing name
    bad2: { sets: [{ id: "i", tiles: [{ id: "t" }] }] },
    // empty tiles
    bad3: { sets: [{ id: "i", name: "n", tiles: [] }] },
    // contexts not an array
    bad4: {
      sets: [{ id: "i", name: "n", tiles: [{ id: "t" }], contexts: "nope" }],
    },
    // provider payload not an object
    bad5: "garbage",
    // provider with no sets field
    bad6: { name: "no sets" },
    // null entries
    bad7: { sets: [null, set("survives")] },
  };
  const flat = flattenExamplesCollection(collection);
  assert.deepEqual(
    flat.map((f) => f.set.id),
    ["good", "survives"],
  );
});

test("flattenExamplesCollection tolerates non-object input", () => {
  assert.deepEqual(flattenExamplesCollection(null), []);
  assert.deepEqual(flattenExamplesCollection(undefined), []);
  assert.deepEqual(flattenExamplesCollection("string"), []);
  assert.deepEqual(flattenExamplesCollection([]), []);
});

test("mergeIntoConfig appends new tiles/contexts preserving order", () => {
  const config = {
    contexts: [
      { id: "existing", predicate: { path: "p", compare: "gt", value: 1 } },
    ],
    tiles: [{ id: "old", checks: [{ type: "boolean", path: "p" }] }],
  };
  const { merged, added, skipped } = mergeIntoConfig(config, {
    contexts: [
      { id: "newctx", predicate: { path: "q", compare: "lt", value: 2 } },
    ],
    tiles: [set("s", ["newt"]).tiles[0]],
  });
  assert.deepEqual(
    merged.contexts.map((c) => c.id),
    ["existing", "newctx"],
  );
  assert.deepEqual(
    merged.tiles.map((t) => t.id),
    ["old", "newt"],
  );
  assert.deepEqual(added, { contexts: ["newctx"], tiles: ["newt"] });
  assert.deepEqual(skipped, { contexts: [], tiles: [] });
});

test("mergeIntoConfig skips (never clobbers) duplicate ids", () => {
  const config = {
    contexts: [
      { id: "ctx", predicate: { path: "p", compare: "gt", value: 1 } },
    ],
    tiles: [
      { id: "t", label: "mine", checks: [{ type: "boolean", path: "p" }] },
    ],
  };
  const { merged, added, skipped } = mergeIntoConfig(config, {
    contexts: [
      { id: "ctx", predicate: { path: "q", compare: "lt", value: 2 } },
    ],
    tiles: [
      { id: "t", label: "theirs", checks: [{ type: "boolean", path: "q" }] },
    ],
  });
  // User's existing entries untouched
  assert.equal(merged.contexts[0].predicate.path, "p");
  assert.equal(merged.tiles[0].label, "mine");
  assert.deepEqual(added, { contexts: [], tiles: [] });
  assert.deepEqual(skipped, { contexts: ["ctx"], tiles: ["t"] });
});

test("mergeIntoConfig re-adding the same set is idempotent", () => {
  const config = { contexts: [], tiles: [] };
  const s = set("s", ["t1", "t2"]);
  const first = mergeIntoConfig(config, s);
  const second = mergeIntoConfig(first.merged, s);
  assert.deepEqual(second.added, { contexts: [], tiles: [] });
  assert.deepEqual(second.skipped.tiles.sort(), ["t1", "t2"]);
  // No duplication
  assert.equal(second.merged.tiles.length, 2);
});

test("mergeIntoConfig preserves the {configuration, enabled} wrapper shape", () => {
  const wrapped = {
    enabled: true,
    configuration: { contexts: [], tiles: [] },
  };
  const { merged } = mergeIntoConfig(wrapped, set("s"));
  assert.ok("configuration" in merged);
  assert.ok("enabled" in merged);
  assert.equal(merged.configuration.tiles.length, 1);
  // inner shape intact
  assert.deepEqual(Object.keys(merged.configuration).sort(), [
    "contexts",
    "tiles",
  ]);
});

test("mergeIntoConfig merges into a wrapped config that already has tiles", () => {
  const wrapped = {
    enabled: true,
    configuration: {
      contexts: [],
      tiles: [{ id: "old", checks: [{ type: "boolean", path: "p" }] }],
    },
  };
  const { merged } = mergeIntoConfig(wrapped, set("s", ["newt"]));
  assert.deepEqual(
    merged.configuration.tiles.map((t) => t.id),
    ["old", "newt"],
  );
});

test("mergeIntoConfig handles a set with no contexts field", () => {
  const config = { contexts: [], tiles: [] };
  const s = set("tilesonly");
  const { merged, added } = mergeIntoConfig(config, s);
  assert.deepEqual(merged.contexts, []);
  assert.deepEqual(added.contexts, []);
  assert.equal(merged.tiles.length, 1);
});

test("mergeIntoConfig handles tiles/contexts with no id (passed through, never skipped)", () => {
  // A tile lacking an id can't collide, so it's always appended.
  const config = { contexts: [], tiles: [] };
  const { merged, added } = mergeIntoConfig(config, {
    contexts: [],
    tiles: [{ checks: [{ type: "boolean", path: "p" }] }],
  });
  assert.equal(merged.tiles.length, 1);
  assert.deepEqual(added.tiles, []);
});

test("fullyAddedSetIds marks sets whose tiles all exist in the config", () => {
  const flat = [
    { source: "p", set: set("all", ["t1", "t2"]) },
    { source: "p", set: set("partial", ["t1", "t3"]) },
    { source: "p", set: set("none", ["t9"]) },
  ];
  const config = {
    contexts: [],
    tiles: [
      { id: "t1", checks: [] },
      { id: "t2", checks: [] },
    ],
  };
  const added = fullyAddedSetIds(flat, config);
  assert.ok(added.has("all"));
  assert.ok(!added.has("partial"));
  assert.ok(!added.has("none"));
});

test("fullyAddedSetIds works against a wrapped config", () => {
  const flat = [{ source: "p", set: set("s", ["t1"]) }];
  const wrapped = {
    enabled: true,
    configuration: { contexts: [], tiles: [{ id: "t1", checks: [] }] },
  };
  assert.ok(fullyAddedSetIds(flat, wrapped).has("s"));
});

test("dogfood starter set validates and round-trips cleanly", () => {
  const examples = JSON.parse(
    readFileSync(new URL("../status-tiles-examples.json", import.meta.url)),
  );
  const flat = flattenExamplesCollection({ "signalk-status-tiles": examples });
  assert.equal(flat.length, 1);
  const { set: starter } = flat[0];

  // Each set validates in isolation.
  const { errors, warnings } = validateConfig({
    contexts: starter.contexts || [],
    tiles: starter.tiles,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);

  // Merging into empty, then validating the merged result, is clean.
  const { merged, added } = mergeIntoConfig(
    { contexts: [], tiles: [] },
    starter,
  );
  const v = validateConfig(merged);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(added.contexts, ["energySurplusWindow"]);
  // Declaration order from the JSON is preserved (SPEC §11.1).
  assert.deepEqual(added.tiles, ["energySurplus", "engineRun", "deployAdvice"]);

  // Re-add is a no-op skip.
  const again = mergeIntoConfig(merged, starter);
  assert.deepEqual(again.added, { contexts: [], tiles: [] });

  // The set is reported as fully added after one copy.
  assert.ok(fullyAddedSetIds(flat, merged).has(starter.id));
});
