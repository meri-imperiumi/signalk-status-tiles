# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Bigger tile headline values, same tile sizes: the default headline
  grows from 6.5vh to 7.5vh and the step-down sizes for longer
  composed headlines rise from 4vh/3.4vh to 6.5vh/5.5vh. On the
  real-world installation the old default proved to be the smallest
  size actually readable, so the smaller steps were illegible; longer
  headlines now wrap at word boundaries instead of shrinking below
  readable. Portrait (phone) keeps deliberately smaller sizes that fit
  the two-across tiles — that portrait override was previously dead
  CSS (shadowed by rule order, so portrait actually rendered at the
  landscape size and overflowed the tiles); it now applies and also
  overrides the per-length buckets.

## [0.6.1] - 2026-09-06

### Added

- `differential` checks accept a `direction` option: `"above"` only
  counts when Path A exceeds Path B, `"below"` only when it falls
  short, while the default `"both"` keeps the absolute-spread
  semantics. This enables one-sided limits against a dynamic
  threshold from another path (e.g. anchor `currentRadius` vs
  `maxRadius`: green while inside, amber at the threshold, red past
  it) — previously any absolute spread, including being safely below
  the threshold, tripped warn/crit.

## [0.6.0] - 2026-08-28

### Added

- Example tile sets from other plugins: any Signal K plugin can ship
  ready-made example tiles by registering a read-only
  `statusTileExamples` resource provider. Boat owners copy a set into
  their active panel from the webapp via a new chrome-bar "+" button
  (admin-only — the resources API can't distinguish admin from
  read-only, so the affordance itself is gated by an admin probe).
  The picker renders each set's tiles through the real evaluator
  against the boat's LIVE data: while the picker is open the webapp
  extends its stream subscription with the sets' paths and feeds their
  deltas into a preview cache, so each preview shows real states,
  values, and units; paths the boat doesn't publish stay honestly
  stale/neutral. Copying merges the set's tiles and contexts into the
  stored config,
  skipping (never overwriting) any whose id already exists —
  re-adding is idempotent, and a user's edits are never clobbered.
  The merged config is validated before persisting; a conflict surfaces
  the errors in the overlay. This plugin ships its own dogfood set
  (energy-predictor tiles from SPEC §7.1) via the same mechanism.

## [0.5.3] - 2026-08-27

### Fixed

- Footer readouts and headline parts render a published `null` as "—"
  instead of the string "null" — upstream plugins legitimately publish
  NULL to mean "figure suppressed right now" (e.g. dead-reckoning
  divergence while moored).
- A `banded` check's explicit `reason` now wins over the generated
  threshold text ("fix 3h old — confirm position" instead of
  "elapsedSinceFix above 10800") when a band trips.
- An empty per-tile `active` predicate is now a warning, not a config
  error: the admin UI's form emits blank scaffolds on save, and the
  engine deliberately ignores them — the form's own output must
  validate instead of reporting "Started with N config error(s)" on
  every restart. Surfacing those warnings no longer crashes plugin
  start on servers whose app object has no `warn` method
  ("app.warn is not a function" → config endpoint 404).

## [0.5.2] - 2026-08-27

### Added

- Composed headlines: a tile may declare `displayParts`, extra Signal K
  paths appended to the headline value and joined with spaces — e.g. an
  Energy status check displaying "surplus" plus a state-of-charge part
  renders "surplus 95%", or a deploy state plus a side renders "deployed
  starboard". Parts format via their displayUnits metadata like footer
  entries, never affect tile state, and get their own subscriptions
  (server and webapp). A part whose value is NULL is omitted from the
  headline entirely; a stale-but-present part shows "—" (SPEC §3.4).
  Configurable in the admin UI as "Headline parts".
- Headline font auto-fitting in the tile grid: longer composed headlines
  step down from the default 6.5vh size and wrap at word boundaries
  instead of overflowing the tile.
