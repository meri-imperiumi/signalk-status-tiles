# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

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
