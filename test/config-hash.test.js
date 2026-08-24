import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIG_HASH_PATH,
  canonicalJson,
  configHashFromDelta,
} from "../public/lib/config-hash.js";

test("canonicalJson is key-order independent at every level", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 3, c: [2, { z: 1, y: 2 }] } }),
    canonicalJson({ a: { c: [2, { y: 2, z: 1 }], d: 3 }, b: 1 }),
  );
});

test("canonicalJson preserves array order", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonicalJson serializes scalars like JSON", () => {
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson(42), "42");
  assert.equal(canonicalJson('"'), '"\\""');
  assert.equal(canonicalJson("x"), '"x"');
});

test("configHashFromDelta extracts the hash from a delta", () => {
  const delta = {
    context: "vessels.self",
    updates: [
      {
        values: [
          { path: "name", value: "Boaty" },
          { path: CONFIG_HASH_PATH, value: "abc123" },
        ],
      },
    ],
  };
  assert.equal(configHashFromDelta(delta), "abc123");
});

test("configHashFromDelta returns the last hash when several are batched", () => {
  const delta = {
    updates: [
      { values: [{ path: CONFIG_HASH_PATH, value: "first" }] },
      { values: [{ path: CONFIG_HASH_PATH, value: "second" }] },
    ],
  };
  assert.equal(configHashFromDelta(delta), "second");
});

test("configHashFromDelta returns null when the delta carries no hash", () => {
  assert.equal(
    configHashFromDelta({
      updates: [{ values: [{ path: "name", value: "Boaty" }] }],
    }),
    null,
  );
  assert.equal(configHashFromDelta({}), null);
  assert.equal(configHashFromDelta(null), null);
});

test("configHashFromDelta ignores non-string hash values", () => {
  const delta = {
    updates: [{ values: [{ path: CONFIG_HASH_PATH, value: 123 }] }],
  };
  assert.equal(configHashFromDelta(delta), null);
});
