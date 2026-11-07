/**
 * Plotter tile-widget view model (public/tile-ext-model.js): state →
 * theme/word mapping, display-value passthrough, neutral/no-data
 * honesty (SPEC §2, §11), and the ?tile= contract parse.
 *
 * @file tile-ext-model.test.js */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STATE_WORDS,
  tileIdFromSearch,
  tileWidgetModel,
} from "../public/tile-ext-model.js";

test("each published state maps to its own theme and glance word", () => {
  const cases = [
    { state: "green", theme: "green", lit: true, word: "OK" },
    { state: "amber", theme: "orange", lit: true, word: "TODAY" },
    { state: "red", theme: "red", lit: true, word: "NOW" },
    { state: "opportunity", theme: "teal", lit: true, word: "OPEN" },
    // neutral: its own branch — no theme, un-lit, never confusable
    // with green (SPEC §11)
    { state: "neutral", theme: null, lit: false, word: "N/A" },
  ];
  for (const c of cases) {
    const m = tileWidgetModel({ label: "T", state: c.state });
    assert.equal(m.theme, c.theme, c.state);
    assert.equal(m.lit, c.lit, c.state);
    assert.equal(m.word, c.word, c.state);
    assert.equal(m.value, "", `${c.state}: no display value`);
  }
});

test("an unpublished state renders as honest no-data, not green", () => {
  const m = tileWidgetModel({ label: "T", state: null });
  assert.equal(m.theme, null);
  assert.equal(m.lit, false);
  assert.equal(m.word, "NO DATA");
});

test("an unknown state string degrades to neutral, not an uncolored lit tile", () => {
  const m = tileWidgetModel({ label: "T", state: "chartreuse" });
  assert.equal(m.theme, null);
  assert.equal(m.lit, false);
  assert.equal(m.word, "NO DATA");
});

test("the display value rides through as the headline", () => {
  const m = tileWidgetModel({
    label: "House Bank",
    state: "green",
    displayValue: "92%",
  });
  assert.equal(m.value, "92%");
  // Numbers too: the widget stringifies at the edge
  const num = tileWidgetModel({
    label: "T",
    state: "amber",
    displayValue: 12.5,
  });
  assert.equal(num.value, "12.5");
  const none = tileWidgetModel({
    label: "T",
    state: "amber",
    displayValue: null,
  });
  assert.equal(none.value, "");
});

test("label passes through; a missing label falls back honestly", () => {
  assert.equal(
    tileWidgetModel({ label: "Bilge", state: "green" }).label,
    "Bilge",
  );
  assert.equal(tileWidgetModel({ label: null, state: "green" }).label, "—");
  assert.equal(tileWidgetModel({ state: "green" }).label, "—");
});

test("the glance word vocabulary stays closed and severity-honest", () => {
  // SPEC §2.1: opportunity must never borrow severity language
  assert.notEqual(STATE_WORDS.opportunity, STATE_WORDS.amber);
  assert.notEqual(STATE_WORDS.opportunity, STATE_WORDS.red);
  assert.deepEqual(Object.keys(STATE_WORDS).sort(), [
    "amber",
    "green",
    "neutral",
    "opportunity",
    "red",
  ]);
});

test("tileIdFromSearch reads the manifest's ?tile= contract", () => {
  assert.equal(tileIdFromSearch("?tile=soc"), "soc");
  assert.equal(tileIdFromSearch("?tile=anchor-watch"), "anchor-watch");
  assert.equal(tileIdFromSearch(""), null);
  assert.equal(tileIdFromSearch("?other=1"), null);
});
