import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fetchVesselName, VESSEL_NAME_URL } from "../public/lib/vessel.js";

/** Minimal fetch mock returning `payload` as the JSON body. */
function okFetch(payload) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      };
    },
  };
}

describe("vessel", () => {
  test("fetchVesselName returns the bare-string name from the api endpoint", async () => {
    // /signalk/v1/api/vessels/self/name addresses the name node itself,
    // so a conforming server answers with the bare JSON string.
    const mock = okFetch("S/Y Pi");
    const name = await fetchVesselName(mock.fn);
    assert.strictEqual(name, "S/Y Pi");
    // Hits the standard REST API route (relative URL — the webapp is
    // served by the Signal K host).
    assert.deepStrictEqual(mock.calls, [VESSEL_NAME_URL]);
    assert.strictEqual(VESSEL_NAME_URL, "/signalk/v1/api/vessels/self/name");
  });

  test("fetchVesselName accepts an object-wrapped name as a fallback shape", async () => {
    assert.strictEqual(
      await fetchVesselName(okFetch({ name: "S/Y Pi" }).fn),
      "S/Y Pi",
    );
  });

  test("fetchVesselName is null for missing/empty/non-string names", async () => {
    // Unnamed vessel: the node is absent.
    assert.strictEqual(await fetchVesselName(okFetch(null).fn), null);
    assert.strictEqual(await fetchVesselName(okFetch("").fn), null);
    assert.strictEqual(await fetchVesselName(okFetch({ name: "" }).fn), null);
    assert.strictEqual(
      await fetchVesselName(okFetch({ name: 12345 }).fn),
      null,
    );
    assert.strictEqual(await fetchVesselName(okFetch({}).fn), null);
  });

  test("fetchVesselName is null on HTTP error and network failure", async () => {
    // HTTP error status.
    const httpErr = async () => ({ ok: false, status: 500 });
    assert.strictEqual(await fetchVesselName(httpErr), null);
    // Network-level rejection (server restarting, link down).
    const netErr = async () => {
      throw new Error("fetch failed");
    };
    assert.strictEqual(await fetchVesselName(netErr), null);
    // Malformed JSON body.
    const badJson = async () => ({
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    });
    assert.strictEqual(await fetchVesselName(badJson), null);
  });
});
