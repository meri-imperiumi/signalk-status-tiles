# Sharing example tile sets from your plugin

Any Signal K **server plugin** can ship ready-made example tiles that a
boat owner copies into their Status Tiles panel with one tap — no JSON
editing, no hand-authoring predicates. This is a guide for plugin
authors (human or LLM) who want their plugin to contribute a set.

> **Who this is for.** You maintain a Signal K server plugin that
> publishes paths (e.g. `signalk-energy-predictor`,
> `signalk-autostate`), and you want users to get curated Status Tiles
> for your paths without writing config themselves. A set is pure
> config — no code runs from it, no assets are served — so this is
> low-risk and small to ship.

## The whole thing in two steps

1. **Ship a JSON file** (`status-tiles-examples.json`) containing one
   or more named sets. Each set's `contexts` and `tiles` use *exactly
   the config shape* Status Tiles itself uses (SPEC §9) — there is no
   separate example schema to learn.
2. **Register a read-only resource provider** of type
   `statusTileExamples` in your plugin's `start()`. Status Tiles'
   webapp discovers all sets through the standard Signal K resources
   API; your set just needs to be in the collection.

That's the entire integration. The rest of this doc explains the
shapes, gives a complete worked example, and lists the rules that make
a set copy cleanly.

## Step 1 — the JSON file

```json
{
  "name": "My plugin's examples",
  "sets": [
    {
      "id": "engine-watch",
      "name": "Engine watch",
      "description": "Core engine alarms and run state",
      "contexts": [
        {
          "id": "engineRunning",
          "label": "Engine running",
          "predicate": { "path": "propulsion.0.state", "compare": "equals", "value": "started" }
        }
      ],
      "tiles": [
        {
          "id": "engineAlarm",
          "label": "Engine",
          "context": "engineRunning",
          "checks": [
            { "type": "alarmGroup", "paths": ["propulsion.0.alarmOverheat", "propulsion.0.alarmOilPressure"] }
          ]
        },
        {
          "id": "engineRunState",
          "label": "Engine",
          "checks": [
            { "type": "boolean", "path": "propulsion.0.state", "badWhen": true, "okLabel": "RUNNING", "notOkLabel": "STOPPED", "display": true }
          ]
        }
      ]
    }
  ]
}
```

### File-level fields

| field | required | meaning |
|-------|----------|---------|
| `name` | yes | Human name shown as the collection's heading |
| `description` | no | One-line explanation of what the collection covers |
| `sets` | yes | Array of set objects (see below) |

### Per-set fields

| field | required | meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier (`[A-Za-z][A-Za-z0-9_-]*`). **Never change it after release** — it's how Status Tiles detects "already added." |
| `name` | yes | Human name shown on the set card |
| `description` | no | One-line pitch shown under the name |
| `contexts` | no | Array of context objects (omit for tiles-only sets). **Same shape as config contexts** (SPEC §3.1, §9). |
| `tiles` | yes | Array of tile objects. **Same shape as config tiles** (SPEC §3.2, §9). |

The contexts and tiles arrays use the **exact** config shape — the
same objects a boat owner would hand-author in the admin UI. Nothing
example-specific. If you can write a working tile in the config form,
you can ship it as an example.

### Ids must be stable and unique

A set's `id`, and the `id` of every context and tile inside it, must be
stable across releases. Status Tiles marks a set "Already added" when
every one of its tile ids already exists in the user's config, and the
copy step **skips (never overwrites)** any id that already exists — so
re-adding is idempotent and a user's edits to a copied tile are never
clobbered. If you rename an id, the user gets a duplicate instead of an
update. Pick ids once and keep them.

Pick ids unlikely to collide with other plugins' sets. Prefixing with
your plugin's domain is a good habit (`energySurplus`, not `surplus`).

## Step 2 — register the resource provider

Register a **read-only** provider of type `statusTileExamples` in your
plugin's `start()`. The provider returns your examples object keyed by
**your own plugin id** while running, and `{}` when stopped (so a
disabled plugin disappears from the list with no stale entries).

### CommonJS (most Signal K plugins)

```js
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const PLUGIN_ID = 'signalk-myplugin'
const examples = JSON.parse(
  readFileSync(join(__dirname, 'status-tiles-examples.json'), 'utf8'),
)

module.exports = (app) => {
  let running = false
  let providerRegistered = false

  function registerProvider () {
    if (providerRegistered) return
    if (typeof app.registerResourceProvider !== 'function') {
      app.error(`${PLUGIN_ID}: server has no resource provider registry; status-tiles examples disabled`)
      return
    }
    app.registerResourceProvider({
      type: 'statusTileExamples',
      methods: {
        listResources: async () => (running ? { [PLUGIN_ID]: examples } : {}),
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such statusTileExamples resource: ${id}`)
          }
          return examples
        },
        setResource: async () => { throw new Error(`${PLUGIN_ID} is a read-only provider`) },
        deleteResource: async () => { throw new Error(`${PLUGIN_ID} is a read-only provider`) }
      }
    })
    providerRegistered = true
  }

  return {
    id: PLUGIN_ID,
    name: 'My Plugin',
    start (config) {
      running = true
      registerProvider()
      // ...your normal start logic
    },
    stop () {
      running = false
      // ...your normal stop logic
    }
  }
}
```

### ESM

```js
import { readFileSync } from 'node:fs'

const PLUGIN_ID = 'signalk-myplugin'
const examples = JSON.parse(
  readFileSync(new URL('./status-tiles-examples.json', import.meta.url)),
)

export default function (app) {
  let running = false
  let providerRegistered = false

  function registerProvider () {
    if (providerRegistered) return
    if (typeof app.registerResourceProvider !== 'function') {
      app.error(`${PLUGIN_ID}: server has no resource provider registry; status-tiles examples disabled`)
      return
    }
    app.registerResourceProvider({
      type: 'statusTileExamples',
      methods: {
        listResources: async () => (running ? { [PLUGIN_ID]: examples } : {}),
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such statusTileExamples resource: ${id}`)
          }
          return examples
        },
        setResource: async () => { throw new Error(`${PLUGIN_ID} is a read-only provider`) },
        deleteResource: async () => { throw new Error(`${PLUGIN_ID} is a read-only provider`) }
      }
    })
    providerRegistered = true
  }

  return {
    id: PLUGIN_ID,
    name: 'My Plugin',
    start (config) {
      running = true
      registerProvider()
    },
    stop () {
      running = false
    }
  }
}
```

### Why all the ceremony?

- **`running` flag.** The resources API is read by any authenticated
  user, including when your plugin is disabled. Returning `{}` when
  stopped means a disabled plugin contributes nothing — no ghost sets,
  no stale entries across an uninstall/reinstall. The webapp needs no
  cache invalidation of its own.
- **`providerRegistered` guard.** A restart within the same plugin
  instance (the server calls `stop()` then `start()` on a config save)
  must not double-register. The guard makes registration idempotent per
  instance.
- **Keyed by your own plugin id.** The resources API aggregates every
  provider into one collection keyed by resource id. Keying by your
  `PLUGIN_ID` is how the webapp labels each set's source and how two
  plugins never collide.
- **Read-only.** Examples are authored by you, the plugin author —
  there is nothing for the server to write. `setResource`/`deleteResource`
  throw; this is the contract the webapp relies on.
- **Graceful on old servers.** Servers without a resource provider
  registry (`app.registerResourceProvider` absent) simply won't list
  your set — log once and continue, don't crash your plugin.

## How discovery works (so you know the contract)

The webapp fetches the standard resources endpoint:

```
GET /signalk/v2/api/resources/statusTileExamples
```

The server aggregates every registered provider's `listResources()`
into one object keyed by providing plugin id:

```json
{
  "signalk-status-tiles": { "name": "...", "sets": [ ... ] },
  "signalk-myplugin":     { "name": "...", "sets": [ ... ] }
}
```

Status Tiles flattens this into a flat list of `{ source, set }` pairs
and shows one card per set. A set whose every tile id already exists in
the user's config is badged "Already added" with a disabled button.
One broken provider — malformed JSON, missing fields — is silently
skipped and never breaks the rest of the list. Your set just needs to
be well-formed; you don't have to defend against other plugins.

## What happens when the user taps "Add"

1. The webapp `PUT`s the set's `tiles` and `contexts` to the admin-only
   route `PUT /plugins/signalk-status-tiles/examples` (admin-gated by
   the server; read-only users never even see the "+" button).
2. Status Tiles **merges** the set into the stored config:
   - new ids are appended (declaration order preserved);
   - ids that already exist are **skipped, never overwritten** — so
     re-adding is idempotent and the user's edits survive a second
     copy.
3. It runs `validateConfig()` on the **merged** config. This is the
   authoritative gate: an unknown check type, a bad shape, a tile
   referencing a context that doesn't exist, all fail here — loudly,
   with the errors surfaced in the overlay, and nothing is saved.
4. On success it persists (`savePluginOptions`) and re-applies
   in-memory (`restart`), which republishes the config hash so every
   connected webapp hot-reloads the new tiles. No page navigation.

The response tells the webapp what was added vs skipped:

```json
{
  "added":   { "contexts": ["engineRunning"], "tiles": ["engineAlarm", "engineRunState"] },
  "skipped": { "contexts": [], "tiles": [] }
}
```

## A complete worked example

A richer set showing several check types. This mirrors the dogfood set
Status Tiles ships for itself (SPEC §7.1's energy-predictor tiles),
expanded with comments on *why* each check is the type it is.

```json
{
  "name": "Energy predictor examples",
  "description": "Tiles for signalk-energy-predictor outputs (SPEC §7.1)",
  "sets": [
    {
      "id": "energy-outlook",
      "name": "Energy outlook",
      "description": "Surplus window, engine-run advice, and deploy guidance",
      "contexts": [
        {
          "id": "energySurplusWindow",
          "label": "Energy surplus window",
          "predicate": {
            "between": {
              "from": "electrical.energy.prediction.surplus.from",
              "to": "electrical.energy.prediction.surplus.to"
            }
          }
        }
      ],
      "tiles": [
        {
          "id": "energySurplus",
          "label": "Energy outlook",
          "context": "energySurplusWindow",
          "checks": [
            {
              "type": "notification",
              "path": "notifications.electrical.energy.surplus",
              "severityMap": {
                "normal": "green",
                "alert": "green",
                "warn": "opportunity",
                "alarm": "amber",
                "emergency": "red"
              }
            }
          ]
        },
        {
          "id": "engineRun",
          "label": "Engine run",
          "checks": [
            { "type": "notification", "path": "notifications.electrical.energy.engine_run" }
          ]
        },
        {
          "id": "deployAdvice",
          "label": "Deploy advice",
          "checks": [
            {
              "type": "agreement",
              "path": "deployment.flinsail.detectedState",
              "path2": "deployment.flinsail.recommendedState",
              "mismatchState": "opportunity",
              "display": true
            }
          ]
        }
      ]
    }
  ]
}
```

### Why each check is the type it is

- **`between` context** for the surplus window: the forecast plugin
  publishes a validity window as two timestamp paths. `between` says
  "now is inside `[from, to]`" without recomputing the window here.
- **`notification`** for surplus/engine-run: the upstream plugin
  already classified severity and wrote a human sentence into the
  notification. Pointing a `notification` check at it reuses both for
  free — no thresholds to author, and the tile's reason text is the
  notification's own message.
- **`opportunity` severityMap** for surplus: the plugin reuses `WARN`
  for *good news* ("1.3 kWh surplus available"). Mapping `warn` to
  `opportunity` (not `amber`) is the whole point of the opportunity
  state — it means "actionable, worth a glance" without borrowing
  risk language (SPEC §2.1, §7.1). Read your source plugin's
  severities case by case; don't assume `warn` always means bad.
- **`agreement`** for deploy advice: two paths that *should* match
  (detected vs recommended deploy state). Mismatch is the signal, and
  here it's missed upside, not risk — so `mismatchState: "opportunity"`
  is the honest read, not the default `amber` (SPEC §3.3, §7.1).

## Check types at a glance

Every check is an object with a `type` and type-specific fields. Only
the required fields are listed; see SPEC §3.3 for full semantics.

| type | what it does | required fields | common optional |
|------|--------------|-----------------|-----------------|
| `boolean` | path truthiness → two states | `type`, `path` | `badWhen`, `okLabel`, `notOkLabel`, `display` |
| `banded` | numeric vs warn/crit thresholds, each side independently | `type`, `path` | `low{}`, `high{}`, `unit`, `display` |
| `differential` | abs difference of two paths vs thresholds | `type`, `path`, `path2` | `warn`, `crit`, `display` |
| `alarmGroup` | list of alarm paths; any tripped or stale → red | `type`, `paths` | `levelPath`, `levelWarn`, `levelCrit` |
| `stateMatch` | discrete value → state lookup table | `type`, `path` | `map[]`, `default` |
| `zone` | reads the path's own SK metadata zones | `type`, `path` | `severityMap{}`, `zones[]` |
| `notification` | reads a `notifications.*` path; maps severity | `type`, `path` | `severityMap{}` |
| `agreement` | two paths must be equal; mismatch → state | `type`, `path`, `path2` | `mismatchState`, `display` |
| `compound` | AND/OR/NOT predicate → single state when true | `type`, `predicate` | `state` |

Tile states are exactly: `green`, `amber`, `red`, `neutral`,
`opportunity`. See SPEC §2/§2.1 — `opportunity` is its own branch
(beneficial window), never a mild `amber`.

## Rules for a clean set

- **Be a server plugin.** You must have a `start()`/`stop()` lifecycle.
  A webapp-only package cannot register a resource provider. (Same
  constraint as Freeboard-SK plotter extensions.)
- **Stable ids.** Never rename a set id, context id, or tile id after
  release. Renaming creates duplicates for existing users instead of
  updates.
- **Self-contained contexts.** A tile may reference a context by id,
  but only a context declared in the *same set*. A tile pointing at an
  unknown context fails validation at copy time.
- **No `coverage` in a set.** Sets carry `contexts` and `tiles` only.
  Coverage (SPEC §10) is a panel-wide setting, not per-set.
- **Validate before you ship.** A set that fails `validateConfig()` on
  the merged config is rejected at copy time with an error in the
  overlay. You can check this locally (see below).
- **One concern per tile.** A tile's checks should all be on the same
  problem branch — don't straddle `opportunity` and `amber`/`red` in
  one tile (SPEC §2.1). Split across tiles instead.
- **Prefer `notification`/`zone` over re-authoring thresholds** when
  the upstream plugin or SK metadata already classifies severity.
  That's one source of truth, not two.
- **No assets, no iframe, no code.** A set is pure config. There is
  nothing to serve beyond the resource itself.

## Validate your set locally before shipping

Status Tiles exports its validator, so you can check a set is
copy-clean without a running server. From a checkout of
`signalk-status-tiles`:

```sh
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { validateConfig } from "./public/lib/config.js";
  import { mergeIntoConfig } from "./public/lib/examples.js";

  const examples = JSON.parse(readFileSync(new URL("./status-tiles-examples.json", import.meta.url)));
  // Adapt the path above to YOUR examples file.

  for (const set of examples.sets) {
    const { errors, warnings } = validateConfig({
      contexts: set.contexts || [],
      tiles: set.tiles,
    });
    console.log(set.id, "→ errors:", errors, "warnings:", warnings);

    // Also check it merges cleanly into an empty panel (catches
    // cross-context references and shape issues only visible merged):
    const { merged } = mergeIntoConfig({ contexts: [], tiles: [] }, set);
    const m = validateConfig(merged);
    console.log(set.id, "merged → errors:", m.errors, "warnings:", m.warnings);
  }
'
```

Empty `errors` and `warnings` for every set means it will copy
cleanly. Warnings are advisory (the copy still succeeds); errors block
the copy.

## LLM checklist

If you are an LLM generating an example set for a plugin, verify all
of these before finishing:

- [ ] The file is valid JSON with a top-level `name` and non-empty `sets`.
- [ ] Every set has a stable `id` (matching `[A-Za-z][A-Za-z0-9_-]*`),
      a `name`, and a non-empty `tiles` array.
- [ ] `contexts`, if present, is an array; every context has `id` +
      `predicate`.
- [ ] Every tile has `id`, `label`, and a non-empty `checks` array.
- [ ] Every check has a `type` from the table above and its required
      fields.
- [ ] Every tile `context` reference points at a context declared in
      the *same set*.
- [ ] No id is renamed from a previous release of this set.
- [ ] `opportunity` is used only for genuinely beneficial windows
      (missed upside, open chances), never as a mild `amber`.
- [ ] A tile's checks do not straddle `opportunity` and `amber`/`red`.
- [ ] The provider code keys the examples by the plugin's own id,
      returns `{}` when stopped, throws on write/delete, and is
      registered in `start()` behind a `running` flag and a
      `providerRegistered` guard.
- [ ] The local validation snippet above reports zero errors for
      every set, both standalone and merged into an empty panel.

## Reference implementation

Status Tiles ships its own dogfood set via exactly this mechanism —
see `status-tiles-examples.json` and the `registerExamplesProvider`
function in `index.js`. It is a complete, minimal example of both
halves (the file and the provider) and is discovered by the webapp
through the same resources API as any other plugin's set.
