# Signal K Status Tiles — Design Spec

## 1. Purpose

Reduce a large number of raw Signal K paths to a small number of tiles, each
answering "does this need attention?" with one of four states. Tiles are
context-aware: a tile can be gated so it only evaluates (and is only
"live") under conditions defined elsewhere in the config — at anchor,
engine running, underway, etc. — rather than every tile being always-on.

Non-goals: this is not a safety layer. Smoke/CO/bilge/nav hardware must
continue to alarm on their own, independent of this system being installed,
running, or correctly configured.

## 2. States

Four states, ordered by severity:

| State     | Meaning                                              |
|-----------|-------------------------------------------------------|
| `green`   | No action needed.                                     |
| `amber`   | Look at this today.                                    |
| `red`     | Look at this now.                                      |
| `neutral` | Not applicable right now, or genuinely unknown. Not a severity — a statement that no severity judgment can honestly be made. |

A tile's state is the worst state among its checks, `neutral` ranking below
`amber`/`red` but the tile is `neutral` outright (skipping checks) when its
context is inactive.

`neutral` must be a first-class, deliberately-chosen output of every check
type — never an accidental default that hides an unhandled case.

### 2.1 Valence: problem vs. opportunity

The four states above all answer one question: *how urgently does
something bad need attention?* Some metrics are actionable in the
opposite direction too — not "something is wrong," but "there's a
beneficial window open that will close." Energy forecasting is the
motivating case: a forecasted **deficit** (SoC trending down — reduce
discretionary load) is a problem; a forecasted **surplus** (heading for
100%, solar/wind about to go to waste) is the mirror image — actionable,
worth a glance, but not a problem at all. Collapsing that onto the
amber/red scale (as §7.1 originally did, mapping a plugin's `WARN`
straight through) misrepresents good news as a warning.

**A fifth state, `opportunity`, is added — structurally separate from
amber/red, not a variant of either.**

- `opportunity` is **not on the problem-severity ladder.** It doesn't
  rank between `amber` and `red`, or above `red` — it's a different
  branch, not a rung. The worst-of aggregation defined above (§2, "a
  tile's state is the worst state among its checks") applies only
  within the problem branch (`green`/`neutral`/`amber`/`red`).
- **A tile is in exactly one state at any given evaluation** — a
  problem-severity state, `neutral`, or `opportunity`, never a
  simultaneous mix. For a single metric with an asymmetric two-sided
  check (e.g. a forecast trajectory where the low side means deficit
  and the high side means surplus), this falls out naturally: the
  underlying value can't be trending both down and up at once, so only
  one branch is ever live.
- **Multiple checks on one tile must not straddle both branches.** If a
  tile's checks could independently produce a problem state from one
  path and an `opportunity` state from an unrelated path at the same
  time, that's a real ambiguity (which does the tile show?) — split
  into two tiles rather than resolving it with an arbitrary tie-break.
  A single check with genuinely asymmetric bands on one metric (the
  energy-outlook case) is not this situation and stays as one tile.
- **`opportunity` ranks below `amber`/`red` for urgency/interrupt
  purposes**, even though it's "above `green`" for noticing purposes.
  It must never be eligible for the full-screen-interrupt tier discussed
  in §11.2 (open question there) even if that tier is later adopted for
  genuine problems — there is nothing urgent about a chance to make
  water.
- **Out of scope for §10's coverage/unclaimed-anomaly detection.** That
  mechanism exists to guarantee nothing dangerous slips through
  curation; missing a surplus window has no safety stakes comparable to
  missing a real fault, so the automatic overflow-slot mechanism
  surfaces unclaimed problem states only. This is a deliberate scope
  limit, not an oversight — worth revisiting only if a future
  opportunity case turns out to have real cost to missing it.
- Rendering: `opportunity` needs its own color, distinct from the
  green→amber→red ramp (not a shade of any of them) — see §11.

## 3. Core entities

### 3.1 Context

A named, reusable boolean predicate evaluated against current Signal K
state (e.g. `anchored`, `engineRunningPort`, `underway`). Contexts are
declared once and referenced by id from any tile or check.

Predicate forms:
- path comparison: equals / gt / gte / lt / lte against a path's current value
- `allOf` / `anyOf` / `not` combinators over other predicate forms
- **between** — now falls between two timestamps, each either a literal
  or a path reference (e.g. a plugin-published forecast window like
  `surplus.from`/`surplus.to`). Motivated by upstream forecasting
  plugins that already publish a validity window as data rather than
  requiring it to be recomputed here.
- explicit policy for a referenced path being unknown: `whenMissing`
  (default: predicate evaluates false — i.e. contexts fail closed when
  their inputs are absent)

### 3.2 Tile

The unit shown on screen. Has:
- `id`, `label`
- optional `context` reference — if inactive, tile state is `neutral`
  and no checks run
- one or more `checks`
- resulting `{state, reason}`, where `reason` is a short human string
  identifying which check produced the worst state (for debugging /
  hover text, not primary UI)
- optional `{displayValue}` — see §3.4. Distinct from `reason`: `reason`
  explains *why* the state is what it is (usually only interesting when
  something isn't green); `displayValue` is a value worth showing on a
  healthy tile too (SoC%, tank level, temperature) because the number
  itself is useful at a glance, not just its severity.
- optional `size` — a size class (§11.1), config-declared, independent
  of runtime data. Defaults to the smallest class unless the tile has a
  display value, in which case it defaults one class larger to leave
  room for the number; always explicitly overridable.

### 3.4 Display value

Some tiles are more useful with a headline number on them even when
green — "House Bank: 92%" tells you more than a green square, without
requiring a drill-down. This is additive to the state/severity model,
not a replacement for it: the tile is still fundamentally answering
"does this need attention," the number is a bonus for the common case
where the answer is no.

Requirements:
- A tile has **at most one** display value. If a tile has multiple
  checks, the tile config designates which single check supplies it
  (e.g. a `display: true` flag on that check) — there is no automatic
  "show all the numbers" behavior. This keeps a tile's information
  density fixed regardless of how many checks back it, preserving the
  "no dense grids of raw numbers" property in §11: one designated
  number per tile is a headline, not a readout panel.
- Display is opt-in per tile. Most tiles (booleans, alarm groups,
  stateMatch, agreement) have no natural single number to show and
  should show none — a display value should never be invented just to
  fill space.
- Each check type that can reasonably produce one (`banded`, `zone`,
  `differential`, `notification`'s underlying numeric field if present)
  defines its own formatting for the value it's already reading — e.g.
  a percentage vs. a raw voltage vs. an already-formatted string from a
  `notification` payload. Formatting is the check type's responsibility,
  not a separate general-purpose formatter bolted on afterward.
- **Staleness governs the display value the same way it governs state**
  (§4): once a check's input is stale, its display value must not keep
  showing the last known number as if current — that would silently
  contradict the "missing data is not good data" principle by looking
  authoritative on screen while the state itself has gone `neutral`/
  `red`. A stale check's display value is replaced with an explicit
  "unknown" marker (e.g. a dash), not the frozen last reading.
- A tile whose overall state is `neutral` because its **context** is
  inactive (not because of staleness) does not show a stale-looking
  dash by default — it simply shows nothing, consistent with "not
  applicable right now" rather than "value unknown." These are different
  situations (§2's distinction between the two reasons a tile can be
  `neutral`) and should look different on screen, not just read the same
  under the hood.

### 3.3 Check

A single typed, declarative rule within a tile. Types, minimum viable set:

- **boolean** — a path's truthiness maps to two configurable states
  (which value means "bad" is configurable, since "bad" isn't always
  `true`)
- **banded** — numeric value against warn/crit thresholds on either or
  both sides (low and/or high). The two sides' target states are
  independently configurable, not hardcoded to "low is bad, high is
  bad" — this is what lets one check express an asymmetric metric like
  an energy forecast, where the low side means `amber`/`red` (deficit)
  and the high side means `opportunity` (surplus), rather than treating
  both directions as the same kind of bad (§2.1).
- **differential** — absolute difference between two paths against
  warn/crit thresholds (e.g. cell voltage spread)
- **alarmGroup** — a list of boolean/alarm paths; any tripped *or stale*
  → red; optional secondary numeric sub-check (e.g. battery level) for
  amber
- **stateMatch** — a path's discrete value looked up in an explicit
  state→tile-state map, with a default for unmapped values. The map's
  target values are not restricted to problem states — a matched value
  may map to `opportunity` where that's the honest read (§2.1).
- **zone** — reads the path's own Signal K metadata `zones` (nominal /
  alert / warn / alarm / emergency) rather than thresholds declared in
  this config; a configurable severity map collapses the 5 zone states
  onto the tile states; an inline `zones` fallback may be supplied on
  the check itself for paths without published metadata yet. Note: SK's
  own zone vocabulary has no native "good/opportunity" concept — it's
  inherently a badness scale — so a `zone` check cannot itself produce
  `opportunity`; use `banded` or `notification` for asymmetric metrics.
- **notification** — reads a `notifications.*` path directly: the
  upstream plugin has already done its own severity classification
  (`normal`/`alert`/`warn`/`alarm`/`emergency`) and usually already
  written a human-readable sentence into the notification's message.
  This check maps that state through a severity map (same shape as
  `zone`'s, and likewise able to target `opportunity`) and defaults
  `reason` to the notification's own message rather than requiring one
  to be authored per rule. This is the formal version of "just point a
  check at the server's own notification" — useful for any plugin, not
  only zone-backed ones, that already publishes its own alarm or
  informational state. §2.1's whole motivation was a `notification`
  check whose source plugin used `WARN` for good news — the severity
  map targeting `opportunity` is the fix, not a workaround.
- **agreement** — two paths must be equal (e.g. a commanded/expected
  state vs. an actual/detected state); mismatch maps to a configurable
  state — `amber` for most cases, but `opportunity` is often the more
  honest read when the mismatch represents missed upside rather than
  risk (e.g. a solar-deployable device that should have been deployed
  and wasn't — see §7.1's FLINsail example, arguably an opportunity
  case rather than a problem, revisited there). Not limited to numeric
  paths — string and enum values are the common case (e.g.
  `recommendedState` vs. `detectedState` from a device-automation
  plugin, or a switch's commanded vs. relay-confirmed state).

Every check type must independently define its behavior for: value
absent, and value stale (see §4). These are not always the same
treatment — e.g. an unpowered fridge sensor reading "off" is different
from a fridge sensor that has stopped reporting entirely.

Check types are meant to be a small, closed, reusable set — adding a new
tile should almost always mean writing config, not writing a new check
type. New check types are added only when an existing type genuinely
cannot express the rule (see §7, forecast/derived values).

## 4. Staleness policy

Every watched path has an age, tracked from the timestamp on the delta
that last updated it, not wall-clock arrival time.

A path is "stale" once its age exceeds a threshold — a global default,
overridable per check.

**Missing data is not treated as its last known value and is never
silently treated as green.** Each check type has an explicit, configured
answer for what staleness means for it:
- safety-relevant checks (`alarmGroup`) default to stale → `red`
- most other checks default to stale → `neutral`
- the default is overridable per check, because the right answer is
  domain-specific (a stale anchor-alarm feed should not read the same as
  a stale bilge-sensor feed)

This is a first-order design requirement, not an edge case: the spec
should be reviewed for any path where a check's stale-state default
hasn't been explicitly considered.

## 5. Context/tile interaction (worked requirement)

Requirement, stated plainly, that any implementation must satisfy:

- A tile gated on context `X` shows `neutral` whenever `X` is inactive,
  regardless of what its underlying paths are doing.
- A tile gated on context `X` evaluates its checks normally whenever `X`
  is active — including going stale/`neutral` or `red` if its own inputs
  disappear *while the context is active*.
- Contexts themselves must handle their own inputs being absent
  (`whenMissing`) so that an unknown navigation state doesn't default to
  "every context is active" or "every context is inactive" without that
  being a deliberate config choice.

Worked example the spec must satisfy: an anchor-watch tile gated on
`anchored`. Off anchor, it reads neutral no matter what the anchor-alarm
feed is doing. At anchor, if the anchor-alarm feed goes stale, the tile
must go to a state that says "we don't know" — not silently green, not
carried over from the last known reading.

## 6. Output

Two independent outputs per tile evaluation, not coupled to each other:

1. A structured value per tile (state + label + reason + optional
   displayValue, §3.4 + timestamp), published at evaluation time, on
   every re-evaluation (delta-triggered and timer-triggered — see §8),
   consumed by the tile UI.
2. Optionally, `amber`/`red` tile states mirrored into the platform's
   standard alarm/notification mechanism, so existing alarm consumers
   (sound, other apps, home automation) see them without needing to know
   this system exists. This mirroring is a policy switch, not mandatory
   — some tiles may be display-only.

## 7. Explicitly out of scope for the check-type system

Forecast/derived tiles (e.g. "3-day trough state of charge" /
"can I cook?") are not expressible as a threshold check on a raw path —
they require a model run over history plus an external forecast input.

Spec position: these are computed *upstream*, as their own derived value
published back onto the data bus under a normal path, then consumed by an
ordinary `banded` or `zone` check like any other path. The rule-evaluation
system stays declarative and closed; forecasting logic lives elsewhere and
is treated as just another data source.

### 7.1 Worked example: an upstream energy-forecasting plugin

Grounding the above in a real plugin (`signalk-energy-predictor`) rather
than a hypothetical, to check the abstraction actually holds:

- **`electrical.energy.prediction.surplus.from`/`.to`** — a forecast
  window published as two ordinary timestamp paths. This is exactly what
  the `between` context predicate (§3.1) is for: an `energySurplusWindow`
  context, usable by any other tile that wants to gate on "is now a good
  time to run something power-hungry" (e.g. a watermaker or fridge tile),
  without that tile needing to know anything about forecasting.
- **`notifications.electrical.energy.deploy_<device>`,
  `notifications.electrical.energy.engine_run`,
  `notifications.electrical.energy.surplus`** — the plugin already
  classifies its own severity (`NORMAL`/`WARN`) and writes a complete,
  human-readable sentence. These are the direct motivating case for the
  new `notification` check type: a tile can consume each with zero
  threshold logic of its own, and get its `reason` text for free instead
  of authoring one.
- **`deployment.<device>.detectedState` vs. `.recommendedState`**,
  alongside **`.missedYieldWh`** — the motivating case for `agreement`:
  the two states disagreeing is the actual signal ("you should have
  deployed FLINsail and didn't"), and `missedYieldWh` is a ready-made
  number for the tile's `reason` beyond just "mismatch detected."
- **`forecast.hourly[]`** — a genuinely model-computed array (24–48h of
  SoC trajectory, wind, and recommended actions). Confirms the §7
  position: no check type should try to reason over this array directly;
  it's exactly the kind of thing that should already have been reduced
  to a scalar or a small set of paths (like `surplusWh`, `surplus.from`)
  before this system ever sees it. If a tile wants something the plugin
  hasn't reduced yet (e.g. "lowest predicted SoC in the next 24h"), that
  reduction is the upstream plugin's job to add, not this system's.

**Resolved by §2.1: opportunity is a distinct state, not a severity-map
patch.** This example originally surfaced an open question — a
`notification`-check severity map assumes the upstream plugin's
`warn`/`alarm` vocabulary means what this system means by `amber`/`red`.
`notifications.electrical.energy.surplus` publishes
`WARN: 1.3kWh surplus available...`, which is a *positive* notice, not a
fault, despite reusing the `WARN` state. The fix isn't to defuse it down
to `green` (that discards genuinely actionable information — there's a
window to run the watermaker) or leave it `amber` (misrepresents good
news as a warning) — it's to map it to `opportunity`, a state that means
"actionable, worth a glance" without borrowing severity language that
implies risk. The general caution stands regardless: `notification` and
`zone` checks inherit whatever vocabulary the source plugin or metadata
author intended, and that has to be read case by case (§10's same point
about vendor-authored zone metadata), not assumed to align with this
system's meaning.

**Retroactive read on the FLINsail example above:** `detectedState` vs.
`recommendedState` disagreeing, with `missedYieldWh` quantifying what's
being left on the table, is the same shape as the surplus case — missed
upside, not risk. It's arguably better classified as an `agreement`
check targeting `opportunity` than the `amber` framing implied earlier
in this section, consistent with §3.3's `agreement` guidance. Whether
that reclassification is right in practice is a judgment call about this
specific plugin's intent, not something this spec can settle in the
abstract — but the two examples clearly belong to the same category, and
should probably land on the same side of the problem/opportunity line.

## 8. Evaluation triggers

Two triggers, both required:
- **Delta-driven**: re-evaluate (at least) the affected tiles when a
  watched path updates.
- **Timer-driven**: re-evaluate all tiles on a fixed interval regardless
  of new data. This is the only way staleness is ever discovered for a
  path that has simply stopped sending updates — a delta-only design
  cannot detect silence.

## 9. Configuration shape

Config is authored entirely through the Signal K admin UI's standard
plugin-config editor — a form generated from the plugin's JSON Schema
(`react-jsonschema-form`), not a hand-edited external file. This is a
firm constraint, not a stylistic preference, and it shapes what's
practical to spec below.

- Contexts and tiles live as arrays of objects directly in the plugin's
  config (config *is* the schema-editor's output) — adding a system is
  filling in a form, not editing JSON by hand or referencing an external
  file path. (This supersedes any earlier framing of config as a
  separately-maintained file the schema editor merely points at.)
- A tile references at most one top-level context by name; more complex
  gating is expressed via the context's own `allOf`/`anyOf`/`not`, not by
  attaching multiple contexts to one tile.
- `zone` checks prefer metadata already defined elsewhere (device
  plugins, or an existing metadata editor) over redeclaring thresholds in
  this config, to avoid two sources of truth for the same threshold. An
  inline fallback is permitted for paths without metadata yet, understood
  as temporary.
- **Check `type` variants must be expressible as a JSON Schema
  discriminated union** (`oneOf`, keyed on `type`), since checks are
  structurally different per type (§3.3) but need to live in one array
  a person can add to from the form. This is achievable but is known to
  render as a somewhat clunky picker in `react-jsonschema-form` — worth
  a usability pass once built, not assumed free.
- **Recursive context predicates need a practical depth cap.**
  `allOf`/`anyOf`/`not` nesting (§3.1) is unbounded in principle, but
  JSON-Schema-form editors handle deep recursive structures poorly —
  both to render sensibly and to not overwhelm a non-technical editor.
  Spec position: cap nesting at a small fixed depth (e.g. 2) sufficient
  for realistic contexts (an anchored-and-not-charging combination is
  depth 1; something needing more is probably better split into two
  named contexts referencing each other via `anyOf`, keeping any single
  context's own predicate shallow).
- Given the above two points, a raw-JSON escape hatch (a single
  freeform field accepting the full tile/context/check JSON, bypassing
  the generated form) is worth keeping available for configs the form
  genuinely can't express well — understood as a deliberate pressure
  valve, not the primary editing path.

## 10. Coverage: surfacing unclaimed anomalies

**Motivation.** The whole system is built on deliberate curation — ~90
values down to ~12 tiles (§1). Everything left off is left off on the
assumption that it doesn't need a permanent tile. That assumption holds
most of the time, by definition — but "not currently claimed by a tile"
and "safe to ignore" are not the same guarantee, and the day they diverge
is exactly the day this system exists to catch. A path that's fine 99% of
the time and genuinely doesn't warrant a standing tile can still go out of
bounds on the 1% day. If nothing is watching it, the curation has become
the blind spot.

**Requirement.** Maintain a secondary layer that continuously checks
paths *not claimed* by any tile's checks against those paths' own zone
metadata (reusing `zone` semantics from §3.3), and surfaces any that are
outside nominal.

**Definitions.**
- *Claimed*: a path referenced by any check on any tile in the current
  config — regardless of whether that tile's context is presently active.
- *Claimed-but-not-currently-evaluated*: a path claimed only by a
  context-gated tile whose context is currently inactive (e.g. a value
  only tracked at anchor, while underway). Treat this as **unclaimed for
  the duration the context is inactive** — the tile isn't actually
  watching it right now, so the coverage gap is real, not theoretical.
  This is the case that most directly motivated the idea: contextual
  gating is exactly what creates temporary blind spots on otherwise-owned
  paths.
- *Candidate paths*: an explicit include-list or pattern, not literally
  every Signal K path. Must exclude inherently noisy, transient, or
  non-actionable telemetry (AIS targets, raw position streams, etc.).
  Coverage detection inherits false positives from whatever authored a
  path's zones (often a vendor default, not tuned for this boat), so
  scope must be curated too — an unbounded "watch everything with
  metadata" defeats the same trust-erosion principle already in the spec
  (§4, "every red tile you learn to ignore").

**Design tension with §11 (UI requirements) — resolve explicitly.**
Swapping a currently-green, *expected* tile for an unrelated anomalous
value breaks the "readable at a glance, consistent layout" property —
part of what makes the screen fast to read is that a tile's position and
identity are stable (top-left is always the house bank). Silently
repurposing a known tile for something else undermines the muscle memory
the whole design depends on.

Recommended resolution: don't repurpose arbitrary nominal tiles. Reserve
a small, fixed number of **overflow slots** in the layout (e.g. 1–2)
whose sole job is displaying unclaimed anomalies when present, and
sitting empty/neutral otherwise. This keeps every claimed tile's position
fixed while still giving unclaimed problems somewhere to appear.

If reserving permanently-idle slots isn't acceptable (e.g. no screen room),
the alternative — genuinely repurposing a nominal tile — is viable but
must carry additional requirements: the overridden tile must be visually
marked as a temporary override (distinct border/icon, not just a new
label) so it's never mistaken for that tile's normal identity, and it
must revert automatically once the anomaly clears.

**Additional requirements.**
- Severity classification for unclaimed paths uses the same `zone`
  logic and severity map as claimed tiles (§3.3) — not a separate,
  looser threshold. Only `warn`/`alarm`-equivalent (amber/red) zone
  states trigger surfacing; `alert`-level noise should not, for the same
  reason nominal fluctuation shouldn't page anyone.
- Hysteresis/debounce required on both surfacing and reverting, to avoid
  flicker on borderline values — same requirement already implicit for
  ordinary tiles, made explicit here because overflow slots are more
  exposed to churn (many more paths feeding a smaller number of slots).
- Bounded slot count needs an explicit ranking policy for when more
  anomalies exist than slots (e.g. severity first, then longest since
  first detected), and an explicit answer for what happens to anomalies
  that don't fit a slot: they are not simply dropped.
- Persisted log: every detected unclaimed anomaly — surfaced or not,
  including ones bumped by something more severe — is appended to a
  durable log. Natural fit with a "Squawks"-style running list, so a
  transient anomaly that reverts before anyone looks at the screen isn't
  lost entirely.

## 11. UI requirements

- Legible at a glance, from a distance, without requiring the viewer to
  already know what a specific number means.
- No dense grids of raw numbers as the default view — tiles only. Raw
  values may exist behind a drill-down but are not the primary surface.
  A single designated display value per tile (§3.4, e.g. "92%" on an
  otherwise-green tile) is not an exception to this — it's a headline
  number on a tile, not a numbers panel — but a tile showing more than
  one number would be.
- A tile in `neutral` must be visually distinct from `green` (not simply
  a lighter or absent color) — the two mean different things
  ("fine" vs. "no judgment possible") and must never be visually
  confusable. Reduced contrast/weight (dimming) is an acceptable and
  recommended *additional* signal on top of a distinct color, not a
  substitute for one — see below.
- `opportunity` (§2.1) gets its own color, outside the green→amber→red
  ramp entirely (a gold/blue treatment, not a tint of green or amber) —
  it must read as "different in kind," not "a milder amber" or "a
  bonus green." Getting this wrong is the same failure as amber/red
  blurring together: it would train the eye to lump "good news" and
  "low-grade warning" into one glance-read, defeating the reason the
  state was split out in the first place.
- No dependency on the viewer being close enough to read fine print;
  color + short label carries the meaning, not body text.
- **Full-viewport layout.** The tile display is designed to fill the
  screen it's on, not to be a fixed-pixel widget dropped into a page.
  Every dimension that determines layout — tile size, grid gaps, label
  and reason text, the overflow-slot region (§10) — is expressed
  relative to the viewport (`vh`/`vw`-equivalent units), not fixed
  pixels, so the same layout scales correctly across a small helm
  display, a saloon TV, and a phone without separate breakpoint-specific
  designs. Fixed-pixel dimensions are permitted only for things that
  must not scale with the screen regardless of size (e.g. a minimum
  touch-target size, if the display is touch-driven).

### 11.1 Tile sizing and packing

**Motivation.** Not every tile carries the same amount of information —
a boolean tile (label + color) and a tile with a display value (§3.4,
e.g. "House Bank 92%") don't want the same footprint, and forcing every
tile to the same size either wastes space on simple tiles or crowds
richer ones. Multiple tile sizes need a packing algorithm to arrange
them without gaps.

**Size classes.** A small, fixed set of size classes in grid units (e.g.
1×1, 2×1, 1×2, 2×2) — not arbitrary width/height. This keeps the packing
problem tractable and keeps the grid visually regular (a widget-grid
model, not freeform layout). Size is a config property of the tile
(§3.2), not something inferred live from current data — see below for
why that distinction matters.

**Packing must be deterministic and layout-time-only.** This is the
requirement that keeps §10's and this section's own position-stability
guarantees intact once multiple sizes are in play:
- The same tile list + sizes + viewport aspect ratio must always
  produce the same layout — no optimizer noise between runs.
- Packing is recomputed only on a **layout-invalidating event**: a
  config change (tiles added, removed, resized) or a viewport change
  (resize, orientation, a different screen entirely). It is never
  recomputed in response to ordinary data/state updates (§8). A tile's
  assigned grid cell must not move because its state went green→red —
  only because the config or the screen changed. Without this
  boundary, "multiple sizes" would quietly reopen the exact problem §10
  argued against (tiles' positions no longer being trustworthy at a
  glance).
- Grid cell size is derived from the viewport divided by the number of
  columns/rows the current layout needs — continuing the vh/vw
  requirement above — so the full grid always exactly fills the
  viewport on whatever screen it's running on, with no leftover strip
  and no scrolling.
- Where the tile set and screen aspect ratio can't tile perfectly, any
  leftover cell is rendered as empty/neutral space — never stretched to
  fake-fill a tile at a size larger than its configured class, which
  would misrepresent it as carrying more content or priority than it
  was given.
- When more than one valid packing exists, position priority (e.g. what
  lands top-left) follows config declaration order, not a computed
  relevance score — matching the "the order I entered them in the form
  is the order they appear" expectation for someone authoring via the
  JSON-Schema editor (§9).

**Interaction with overflow slots (§10).** An overflow slot's size class
is fixed at config time exactly like any other tile's — only its
*occupant* changes at runtime (which unclaimed anomaly, if any, is
showing), never its size or grid position. Same guarantee as an ordinary
tile, just driven by detection instead of direct configuration.

**Interaction with display values (§3.4).** A tile's size does not
retroactively grow because a check happens to produce a display value at
a given moment — that would require re-packing on data change, which the
determinism requirement above rules out. If a tile is meant to carry a
display value, its size class should be set for that in config from the
start (and defaults to one class larger automatically when a display
value is configured, per §3.2), not inferred from what the data happens
to be doing right now.

### 11.2 Visual reference notes

Observations from an unrelated sci-fi UI reference, worth keeping in
mind as prior art rather than treated as this system's design:

- **Rollup indicators as an alternate tile rendering.** A single colored
  dot next to a category label (e.g. next to a menu entry) is
  structurally the same thing as a tile — one state, one reason,
  summarizing everything beneath it — just rendered as a list-row
  indicator instead of a card. The state/reason model (§3.2) should not
  assume a card-grid is the only valid rendering; a secondary screen or
  a menu context might reasonably want the same tile data as a compact
  dot instead.
- **Dimming as a concrete mechanism for the neutral/green distinction.**
  Rather than (or in addition to) a fourth color, a `neutral` row can be
  rendered at reduced contrast/weight relative to an active `green` row.
  This is a cheap, robust way to guarantee the "never visually
  confusable" requirement above, independent of color perception or
  ambient light washing out a subtle hue difference.
- **Open question: does anything ever warrant a full-screen interrupt?**
  The reference UI has a distinct tier above its normal status rows — a
  full-viewport takeover for a single critical event, visually separate
  from the everyday state list. This spec has so far deliberately kept
  `red` *inside* the fixed tile grid (§10 argues explicitly against
  disrupting layout stability for anomalies). Not resolved here: whether
  a small number of truly critical events should be allowed to break
  that rule and take over the full viewport, which would be a genuinely
  new tier above `red` rather than a tile state — or whether that
  temptation should be resisted entirely in favor of everything staying
  inside the tile grid, on the theory that an interrupt is itself a
  layout-stability violation of the kind §10 already warned against.
- **Keep drill-down/raw-data views visually subordinate.** Where raw
  logs or detail views exist alongside a summary, they should be
  smaller, lower-contrast, and spatially separate from the tiles/rows a
  glance is meant to read — consistent with the "no dense grids of raw
  numbers as the default view" requirement above.
- Not adopted: the reference UI's use of red for "currently selected,"
  unrelated to severity. A reminder that color conventions belong to
  their own system and don't transfer — nothing about this reference's
  palette should be treated as precedent for this spec's color meanings.

## 12. Explicit non-requirements

- This system does not replace, gate, or sit in front of any independent
  safety alarm.
- This system does not need to be highly available for the underlying
  safety systems to keep functioning — if it's down, standalone alarms
  still work.
