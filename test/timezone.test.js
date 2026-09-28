/**
 * Onboard timezone handling (public/lib/timezone.js): parsing the
 * (-)hhmm-encoded environment.time.timezoneOffset, extracting it from
 * deltas, the REST bootstrap fetch, and the ship-time Date shift that
 * the chrome clock renders.
 *
 * @file timezone.test.js */

import assert from "node:assert/strict";
import test from "node:test";

const {
  ENVIRONMENT_TIMEZONE_OFFSET_PATH,
  ENVIRONMENT_TIMEZONE_OFFSET_URL,
  fetchEnvironmentTimezoneOffset,
  parseTimezoneOffset,
  shipTime,
  timezoneOffsetFromDelta,
} = await import("../public/lib/timezone.js");

test("path constants target the standard environment.time node", () => {
  assert.equal(
    ENVIRONMENT_TIMEZONE_OFFSET_PATH,
    "environment.time.timezoneOffset",
  );
  assert.equal(
    ENVIRONMENT_TIMEZONE_OFFSET_URL,
    "/signalk/v1/api/vessels/self/environment/time/timezoneOffset",
  );
});

test("parseTimezoneOffset decodes (-)hhmm into minutes east of UTC", () => {
  assert.equal(parseTimezoneOffset(0), 0);
  assert.equal(parseTimezoneOffset(200), 120);
  assert.equal(parseTimezoneOffset(-930), -570);
  assert.equal(parseTimezoneOffset(330), 210); // India +5:30
  assert.equal(parseTimezoneOffset(545), 345); // Nepal +5:45
  assert.equal(parseTimezoneOffset(-300), -180);
  assert.equal(parseTimezoneOffset(100), 60); // single-digit hours
  assert.equal(parseTimezoneOffset(1400), 840); // UTC+14, real max
  assert.equal(parseTimezoneOffset(-1200), -720); // UTC-12, real min
});

test("parseTimezoneOffset rejects junk that would scramble the clock", () => {
  assert.equal(parseTimezoneOffset(undefined), null);
  assert.equal(parseTimezoneOffset(null), null);
  assert.equal(parseTimezoneOffset("200"), null);
  assert.equal(parseTimezoneOffset(200.5), null);
  assert.equal(parseTimezoneOffset(Number.NaN), null);
  // Minutes and hours outside the plausible UTC offset range (the
  // bound is symmetric ±14h around the real-world -12:00..+14:00 span).
  assert.equal(parseTimezoneOffset(260), null); // :60 minutes
  assert.equal(parseTimezoneOffset(1599), null); // :99 minutes
  assert.equal(parseTimezoneOffset(1500), null); // UTC+15
  assert.equal(parseTimezoneOffset(-1500), null); // UTC-15
  assert.equal(parseTimezoneOffset(2400), null); // UTC+24
});

test("timezoneOffsetFromDelta extracts the last matching value", () => {
  const delta = {
    updates: [
      { values: [{ path: "environment.time.timezoneOffset", value: 200 }] },
    ],
  };
  assert.equal(timezoneOffsetFromDelta(delta), 120);

  // Deltas may batch updates: the last matching value wins.
  const batched = {
    updates: [
      { values: [{ path: "name", value: "S/Y Pi" }] },
      { values: [{ path: "environment.time.timezoneOffset", value: 200 }] },
      { values: [{ path: "environment.time.timezoneOffset", value: -930 }] },
    ],
  };
  assert.equal(timezoneOffsetFromDelta(batched), -570);
});

test("timezoneOffsetFromDelta ignores other paths and junk values", () => {
  assert.equal(
    timezoneOffsetFromDelta({
      updates: [{ values: [{ path: "environment.mode", value: "night" }] }],
    }),
    null,
  );
  // An implausible value must not clobber a previously seen offset.
  assert.equal(
    timezoneOffsetFromDelta({
      updates: [
        { values: [{ path: "environment.time.timezoneOffset", value: 9999 }] },
      ],
    }),
    null,
  );
  assert.equal(timezoneOffsetFromDelta({}), null);
  assert.equal(timezoneOffsetFromDelta(null), null);
});

test("shipTime shifts an instant so UTC getters read ship wall-clock time", () => {
  // 2026-07-01T12:00:00Z with UTC+2 ship time reads 14:00 ship time.
  const d = new Date("2026-07-01T12:00:00Z");
  const ship = shipTime(d, 120);
  assert.equal(ship.toISOString(), "2026-07-01T14:00:00.000Z");
  // A negative offset crosses the date line backwards.
  const west = shipTime(d, -570); // UTC-9:30
  assert.equal(west.toISOString(), "2026-07-01T02:30:00.000Z");
  // Zero offset is identity: ship time is UTC.
  assert.equal(shipTime(d, 0).toISOString(), "2026-07-01T12:00:00.000Z");
});

test("fetchEnvironmentTimezoneOffset reads the endpoint shapes", async () => {
  const bare = await fetchEnvironmentTimezoneOffset(
    async () => new Response(JSON.stringify(200), { status: 200 }),
  );
  assert.equal(bare, 120);
  const wrapped = await fetchEnvironmentTimezoneOffset(
    async () => new Response(JSON.stringify({ value: -930 }), { status: 200 }),
  );
  assert.equal(wrapped, -570);
});

test("fetchEnvironmentTimezoneOffset tolerates failure and junk", async () => {
  assert.equal(
    await fetchEnvironmentTimezoneOffset(
      async () => new Response("", { status: 404 }),
    ),
    null,
  );
  assert.equal(
    await fetchEnvironmentTimezoneOffset(async () => {
      throw new Error("offline");
    }),
    null,
  );
  assert.equal(
    await fetchEnvironmentTimezoneOffset(
      async () => new Response(JSON.stringify(9999), { status: 200 }),
    ),
    null,
  );
});
