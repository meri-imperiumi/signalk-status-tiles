# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

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
