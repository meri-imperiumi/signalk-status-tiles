# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Plotter-extension support (Plotter Extensions API v1 — Freeboard-SK
  and compatible chart plotters): the plugin now registers a
  `plotterExtensions` resource provider whose manifest exposes one
  glanceable widget per configured tile, so the user can pick the
  tiles they care about into the plotter's own widget grid. The
  manifest is rebuilt from the live config on every provider call —
  tile edits (added, removed, renamed, resized) are reflected without
  re-registration, widget ids are stable per tile, and the provider
  goes empty on plugin stop so hosts tear the widget contexts down.
  The widget (`/plotterext/signalk-status-tiles/tile-ext-widget.html
  ?tile=<id>`) renders the tile in the webapp's visual language (flat
  panel, corner brackets, theme colors, red-only pulse) as a pure view
  over the published scalars — no evaluation runs in the widget. It
  subscribes to the tile's state and display-value paths through the
  host's Signal K relay, bootstraps current values via REST (bus
  deltas are change-driven; a quiet green tile must not sit at NO
  DATA), follows the host's night mode, and re-fetches its label when
  the config hash changes. Long-press opens the host's config/remove
  dialog.
- Each tile's reason line and footer entries (SPEC §6 output #1) are
  now published on the bus beside the state and display-value paths, so
  the plotter widget can render the full tile the webapp shows: a
  `statusTiles.tiles.<id>.reason` string leaf carries the short human
  reason naming which check produced the state ("CURRENTLEVEL WARN"),
  and `statusTiles.tiles.<id>.footer` carries the tile's subordinate
  readouts ("Remaining 26.8 liter") as a JSON string of {label, value}
  objects (parseFooterEntries is the shared parser). Both publish
  change-driven like the other scalars and go null when the tile's
  context is inactive or the plugin stops. The widget renders the
  footer as a muted label/value row under the headline and shows the
  reason in its bottom slot on non-green tiles (webapp parity), keeping
  the glance word on green/neutral ones.
- The plotter widget's bottom line now shows the tile's published
  reason (path tokens shortened, uppercased) on amber/red/opportunity
  tiles instead of the compressed glance word — mirroring the webapp
  grid's reason slot; green/neutral keep "OK"/"N/A".
- Each tile's headline display value (SPEC §3.4) is now published on
  the bus beside the state string, as a sibling scalar
  `statusTiles.tiles.<id>.displayValue` (the state path stays a plain
  string leaf). Published change-driven like the state, null when the
  tile has no display check or is context-hidden, the stale "—"
  marker when the display input went stale — instrument panels and
  other Signal K consumers can render "House Bank 92%" without
  re-running the evaluation engine. Path metadata (displayName
  "<label> display value") is published alongside the existing state
  metadata.

### Fixed

- The plotter widget's lit tiles no longer wash out over a bright
  daylight chart: the tile background was a bare 16%-alpha theme tint
  over the transparent iframe, so a light chart turned it pastel and
  the white value text vanished. The wash now layers over the opaque
  dark panel (the same treatment the dead-reckoning family widgets
  apply at the host root), keeping the lit hue readable at chart-
  agnostic contrast; the red pulse animates the wash layer only, so
  alarm tiles never go translucent over the chart either. The neutral
  tile's label renders in the muted text tone rather than the dimmer
  palette grey, matching glance-distance legibility. The widget now
  unwraps the server's config envelope when fetching its tile label
  (a server that hands the plugin the `{configuration, enabled}`
  wrapper made every widget fall back to its raw tile id as the
  label — "TRIP" instead of "Trip log"). The value bootstrap likewise
  read from `/signalk/v2/api/vessels/self`, which servers up to 2.29
  don't serve — every boot-time value read failed there, leaving quiet
  tiles at NO DATA until their next change; it now uses the v1 read
  API.
- Published display values now match the webapp's formatting. The
  plugin's engine cache never received path metadata (the webapp gets
  it replayed via the stream's `sendMeta=all`, but the plugin's
  subscription deltas don't carry a replay), so every meta-dependent
  decision degraded on the bus: raw SI numbers instead of unit-
  converted headlines ("4307" instead of "2.3 nmi", "surplus 0.84
  ratio" instead of "surplus 85%"), and zone checks without inline
  zones stuck at neutral "N/A" where the webapp classified amber from
  the path's published zones. The plugin now seeds its cache from
  three layered sources, most-live-wins per field: the path-metadata
  registry (`app.getMetadata`, released servers), the server's own
  loopback REST meta answer (`GET /vessels/self/meta` — the live
  tree's zones plus each path's server-resolved displayUnits, the
  same answer the webapp's WS meta carries; fetched once per start
  with a bounded retry, degrading silently on secured servers), and
  the direct `app.getDisplayUnits()` plugin API when present (Oct
  2026 servers). Because the vessel tree is still filling at plugin
  start (the first boot-time answer can lack metadata that lands
  seconds later), the REST answer is re-fetched on a short schedule
  (30s/120s) and every landing re-seeds and re-publishes — values
  only move when the formatting actually changed. A value arriving
  for a path that still has no cached metadata (a tank level that
  updates hourly, a sensor that wakes on change) triggers one
  rate-limited refresh too, so late-first-data paths don't pin raw
  numbers for the whole run. The plugin also re-seeds and re-publishes
  when the server's unit preferences change; stream meta deltas merge
  into the cached metadata instead of replacing it, so a sparse
  republish (a displayName) can't wipe seeded zones or displayUnits;
  and the loopback fetch carries a timeout, so a hung request lands
  in the retry path instead of pinning the fallback in a pending
  state.

## [0.6.5] - 2026-10-15

### Changed

- Server and webapp load reduced sharply. The timer-driven evaluation
  tick slowed from 1s to 5s on both the server plugin and the webapp
  (staleness discovery is now the worst-case surfacing delay for a
  stale tile, which needs no sub-second precision); delta-driven
  evaluations now only run when a watched value actually changed —
  identical re-broadcasts at the minPeriod cadence cost nothing — and
  coalesce to at most one full-engine evaluation per 2s on the server,
  trailing edge, so a burst of deltas costs one evaluation instead of
  one per message. The webapp's config poll backstop slowed from every
  5s to every 3 minutes: the stream hash-delta is the primary change
  signal, and each poll fetches the full config body, so the old
  cadence made every connected display a steady request load on the
  server.
- The dogfood example tile set (`status-tiles-examples.json`) is no
  longer read synchronously at module load: it loads asynchronously on
  first use, so the plugin never blocks the server's event loop with
  disk I/O. A malformed file now logs and yields an empty example set
  instead of crashing plugin load.

### Added

- The chrome clock now shows ship time from the boat's own
  `environment.time.timezoneOffset` path (onboard offset from UTC in
  (-)hhmm encoding, e.g. 200, -930) instead of the display device's
  timezone: a helm display's device clock may be set to anything, but
  the crew reads wall-clock time. Bootstrapped via one-shot REST like
  `environment.mode`, kept live through the stream subscription (e.g.
  crossing timezones), and falling back to device-local time when the
  boat doesn't publish the path.

### Fixed

- `PUT /examples` (copying an example tile set) double-wrapped the
  stored plugin config on every save: it passed the server's
  `{ configuration, enabled }` envelope to `savePluginOptions()` and
  the restart callback, which both expect the bare config and wrap it
  themselves. Each Add nested the stored config one level deeper, so
  repeated Adds replaced the tile grid instead of adding to it.

## [0.6.3] - 2026-09-08

### Changed

- Thicker state-color strokes: tile borders, corner brackets, and the
  overflow-slot outline grow from 2px to 4px. The border carries the
  state color (green/amber/red), and on the low-contrast kiosk screen
  the 2px stroke was too thin to distinguish the colors at glance
  distance. Diverges from the plugin UI spec's 2px brackets, like the
  existing alpha divergences documented in `st-tile-grid.js`.

## [0.6.2] - 2026-09-06

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
