# Signal K Status Tiles

This plugin reduces a large number of raw Signal K paths to a small grid of context-aware status tiles. Each tile answers "does this need attention?" with a single state — **green**, **amber**, **red**, **neutral**, or **opportunity** — computed from one or more checks over Signal K paths.

Tiles can be gated by named contexts (at anchor, engine running, underway, …) so they only evaluate and appear under the conditions that make them relevant, and a per-tile `active` predicate can downgrade a green tile to neutral when a condition like "inverter on" isn't met. A companion webapp renders the tiles as a glanceable dashboard, hot-swapping its config whenever you save a new one on the server.

This plugin was inspired by [how SV Sabado monitors their boat](https://svsabado.com/one-screen-one-question-how-we-monitor-sabado/).

## Configuration

Configure the plugin in the Signal K admin UI (Plugin Config → Status Tiles), or edit the JSON in `plugin-config-data/signalk-status-tiles.json`. A config defines **contexts** (named predicates over Signal K paths, e.g. "anchored = `navigation.state` equals `anchored`"), **tiles** (each with a label, an optional `context`, a size, one or more **checks**, and optional footer readouts), and a **coverage** section that surfaces unclaimed anomaly notifications. Check types include `banded` (numeric thresholds), `zone` (named severity zones), `boolean`, `stateMatch` (value→state map), `agreement` (two paths must match), `differential` (two paths within a delta), and `compound` (a predicate that maps to a state). Open the webapp from the Signal K server's plugin list.

Full details — states, check-type semantics, staleness, the context/tile interaction, evaluation triggers, the configuration shape, and the UI requirements — are in [SPEC.md](./SPEC.md).
