/**
 * Smoketest for the tile-grid DOM-leak fix (st-tile-grid.js). The engine
 * re-evaluates every second + on every delta; the grid must NOT rebuild
 * its entire DOM on each evaluation or a long-running kiosk tab OOMs
 * (detached nodes / animation frames outpacing GC). This verifies the
 * keyed reconciliation: repeated `set tiles`/`set coverage` calls reuse
 * the same elements instead of creating new ones, and tiles that leave
 * the output (a context toggled off) are dropped while reappearing ones
 * are rebuilt.
 *
 * @file grid-reconcile.test.js */

import assert from "node:assert/strict";
import test from "node:test";

// --- Minimal DOM stub ----------------------------------------------------

class FakeShadowRoot {
  constructor() {
    this.children = [];
  }
  append(...els) {
    this.children.push(...els);
  }
}

let createCount = 0;

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    createCount++;
    this.children = [];
    this.parentNode = null;
    this.style = {
      setProperty: () => {},
      removeProperty: () => {},
      display: "",
    };
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {} };
    this.dataset = {};
    this.textContent = "";
    this._innerHTML = "";
  }
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
  }
  get innerHTML() {
    return this._innerHTML;
  }
  append(...els) {
    for (const el of els) {
      el.parentNode = this;
      this.children.push(el);
    }
  }
  replaceChildren(...els) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...els);
  }
  insertBefore(el, ref) {
    el.parentNode = this;
    if (ref == null) {
      this.children.push(el);
      return el;
    }
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(el);
    else this.children.splice(i, 0, el);
    return el;
  }
  remove() {
    if (this.parentNode == null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i !== -1) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get nextSibling() {
    if (this.parentNode == null) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] ?? null;
  }
  get parentElement() {
    return this.parentNode;
  }
  querySelectorAll() {
    return [];
  }
}

const elementClasses = new Map();

globalThis.HTMLElement = class HTMLElement extends FakeElement {
  attachShadow() {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }
};
globalThis.customElements = {
  define: (name, cls) => elementClasses.set(name, cls),
};
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
};

await import("../public/st-tile-grid.js");

const Grid = elementClasses.get("st-tile-grid");
assert.ok(Grid, "st-tile-grid registered");

/** One configured tile, one reserved overflow slot. */
function tile(id, state = "green", opts = {}) {
  return {
    id,
    label: id.toUpperCase(),
    state,
    reason: opts.reason ?? "",
    displayValue: opts.displayValue,
    footer: opts.footer,
  };
}

function newGrid() {
  createCount = 0;
  const g = new Grid();
  g.slotCount = 1;
  return g;
}

test("repeated evaluations with the same tile set reuse DOM elements (no leak)", () => {
  const g = newGrid();
  const list = [
    tile("a", "green", { displayValue: "12" }),
    tile("b", "amber", { displayValue: "9", reason: "low" }),
  ];
  g.tiles = list;
  const createdAfterFirst = createCount;
  assert.ok(createdAfterFirst > 0, "first paint built elements");

  // Re-evaluate many times — the engine does this every second + on deltas.
  for (let i = 0; i < 100; i++) {
    g.tiles = list;
    g.coverage = [];
  }
  assert.equal(
    createCount,
    createdAfterFirst,
    "100 re-evaluations created zero new elements (all reused)",
  );
});

test("value/reason updates happen in place without rebuilding", () => {
  const g = newGrid();
  g.tiles = [tile("a", "green", { displayValue: "12" })];
  const tileEl = g.gridEl.children[0];
  // children: label + value + reason + footer (corner brackets are
  // CSS pseudo-elements, not DOM)
  const valueEl = tileEl.children[1];
  assert.equal(valueEl.textContent, "12");

  g.tiles = [tile("a", "green", { displayValue: "99" })];
  const valueElAfter = g.gridEl.children[0].children[1];
  assert.equal(valueElAfter.textContent, "99", "value updated in place");
  assert.equal(
    g.gridEl.children[0],
    tileEl,
    "same tile element reused across value change",
  );
});

test("a tile leaving the output (context off) is dropped; returning rebuilds it", () => {
  const g = newGrid();
  g.tiles = [tile("a"), tile("b")];
  assert.equal(g.gridEl.children.length, 3, "2 tiles + 1 slot");

  // Context toggle: tile b disappears from the engine output.
  g.tiles = [tile("a")];
  assert.equal(g.gridEl.children.length, 2, "1 tile + 1 slot after drop");

  // Tile b returns — it must be rebuilt (we discard dropped tile trees to
  // avoid holding detached nodes, the very leak we're fixing).
  const before = createCount;
  g.tiles = [tile("a"), tile("b")];
  assert.ok(createCount > before, "returning tile rebuilt its element tree");
  assert.equal(g.gridEl.children.length, 3, "2 tiles + 1 slot after return");
});

test("stylesheet handles portrait: row flow, two columns, scroll", () => {
  // Phone/on-watch layout (spec §4): portrait must not reuse the
  // column-wise fill that produces narrow strips. Smoketest on the
  // constructed stylesheet — the node test DOM can't lay out CSS.
  const g = newGrid();
  const style = g.shadowRoot.children[0]; // style is appended first
  assert.match(style.textContent, /@media \(orientation: portrait\)/);
  const portrait = style.textContent.split("@media (orientation: portrait)")[1];
  assert.match(portrait, /grid-auto-flow: row/);
  assert.match(
    portrait,
    /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(portrait, /overflow-y: auto/);
  assert.match(portrait, /font-size: 5.5vh/);
});

test("slot pool is reused across evaluations; occupants update in place", () => {
  const g = newGrid();
  g.tiles = [tile("a")];
  g.coverage = [];
  const slotEl = g.slotEls[0];
  assert.ok(slotEl, "slot element exists");

  for (let i = 0; i < 50; i++) g.tiles = [tile("a")];
  assert.equal(g.slotEls[0], slotEl, "same slot element reused");

  // Anomaly occupies the slot.
  g.coverage = [
    { path: "electrical.batteries.0.voltage", state: "red", zone: "alarm" },
  ];
  const labelEl = g.slotEls[0].children[0];
  assert.match(labelEl.textContent, /voltage/, "slot shows anomaly path");

  // Anomaly clears — slot empties but the element persists.
  g.coverage = [];
  assert.equal(g.slotEls[0].className, "tile slot", "slot cleared in place");
  assert.equal(
    g.slotEls[0].children.length,
    0,
    "slot children removed on clear",
  );
});

test("growing the slot count adds elements; shrinking removes them", () => {
  const g = newGrid();
  g.slotCount = 2;
  g.tiles = [tile("a")];
  assert.equal(g.slotEls.length, 2, "2 slots created");
  g.slotCount = 1;
  g.tiles = [tile("a")];
  assert.equal(g.slotEls.length, 1, "excess slot removed");
  assert.equal(g.gridEl.children.length, 2, "1 tile + 1 slot");
});
