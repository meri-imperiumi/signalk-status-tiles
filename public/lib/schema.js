/**
 * JSON Schema for the admin-UI config editor (SPEC §9). Contexts and tiles
 * live as arrays directly in the config; checks are a discriminated union
 * keyed on `type`. Recursive context predicates are depth-capped.
 *
 * Generated for react-jsonschema-form, so we use `oneOf` for the check
 * variants and nested `allOf`/`anyOf`/`not` objects for context combinators.
 *
 * @file schema.js */

import { PROBLEM_TARGET_STATES, TARGET_STATES, TILE_STATES } from "./states.js";

/** Global staleness default + per-tile overrides. */
const staleMsField = (title) => ({
  type: "integer",
  title,
  description: "Staleness threshold in milliseconds (0 = use global default)",
  default: 0,
});

const staleStateField = {
  type: "string",
  title: "State when stale",
  description:
    "What this check resolves to when its input is stale/absent (SPEC §4)",
  enum: TILE_STATES,
  default: "neutral",
};

const reasonField = {
  type: "string",
  title: "Reason text",
  description: "Short human string shown on hover/debug (optional)",
};

const displayField = {
  type: "boolean",
  title: "Display value",
  description:
    "Designate this check to supply the tile's headline number (at most one per tile, SPEC §3.4)",
  default: false,
};

/**
 * A context predicate node. Inlined (no `$ref`/`definitions`) because the
 * rjsf version shipped with Signal K handles recursive references poorly.
 * Combinator children are depth-1 (leaf predicates only: comparators +
 * between) — deeper nesting isn't offered in the form, matching SPEC §9's
 * guidance that anything deeper should be split into named contexts.
 * config.js enforces the depth cap regardless.
 */
function predicateSchema() {
  return {
    type: "object",
    title: "Predicate",
    properties: {
      path: { type: "string", title: "Signal K path" },
      compare: {
        type: "string",
        title: "Comparison",
        enum: ["equals", "gt", "gte", "lt", "lte"],
      },
      value: {
        type: "string",
        title: "Compare against (literal)",
        description:
          "Number or string to compare the path's value to (numeric comparisons coerce automatically)",
      },
      valuePath: {
        type: "string",
        title: "Compare against (path)",
        description:
          "Optional: a second Signal K path to compare against instead of a literal value (e.g. currentRadius < alertThreshold). Leave empty to use the literal above.",
      },
      whenMissing: {
        type: "string",
        title: "When path is absent",
        enum: ["false", "true"],
        default: "false",
        description:
          "Default false (contexts fail closed when their inputs are absent)",
      },
      between: {
        type: "object",
        title: "Between two timestamps",
        description:
          "Now must fall inside [from, to]; each a literal ms or path",
        properties: {
          from: { type: "string", title: "From (ms timestamp or path)" },
          to: { type: "string", title: "To (ms timestamp or path)" },
        },
      },
      allOf: {
        type: "array",
        title: "AND",
        items: leafPredicateSchema(),
      },
      anyOf: {
        type: "array",
        title: "OR",
        items: leafPredicateSchema(),
      },
      not: { ...leafPredicateSchema(), title: "NOT" },
    },
  };
}

/**
 * A depth-1 (leaf) predicate: comparators + between only — no further
 * combinators, so the form can't offer a third level.
 */
function leafPredicateSchema() {
  return {
    type: "object",
    title: "Predicate",
    properties: {
      path: { type: "string", title: "Signal K path" },
      compare: {
        type: "string",
        title: "Comparison",
        enum: ["equals", "gt", "gte", "lt", "lte"],
      },
      value: { type: "string", title: "Compare against (literal)" },
      valuePath: {
        type: "string",
        title: "Compare against (path)",
        description:
          "Optional second Signal K path to compare against instead of the literal",
      },
      whenMissing: {
        type: "string",
        title: "When path is absent",
        enum: ["false", "true"],
        default: "false",
      },
      between: {
        type: "object",
        title: "Between two timestamps",
        properties: {
          from: { type: "string", title: "From (ms timestamp or path)" },
          to: { type: "string", title: "To (ms timestamp or path)" },
        },
      },
    },
  };
}

/** Check variant schemas, keyed by type for the `oneOf` union. */
const checkVariants = [
  {
    title: "Boolean",
    description: "A path's truthiness maps to two configurable states",
    type: "object",
    properties: {
      type: { type: "string", const: "boolean" },
      path: { type: "string", title: "Signal K path" },
      badWhen: {
        type: "boolean",
        title: "Bad when true",
        default: true,
        description: "Which truthiness means 'bad' (default: true is bad)",
      },
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path"],
  },
  {
    title: "Banded",
    description:
      "Numeric value against warn/crit thresholds on either or both sides. Each side's target states are independently configurable — low is typically a deficit (amber/red) and high may be a surplus (opportunity), not both 'bad' (SPEC §3.3, §2.1).",
    type: "object",
    properties: {
      type: { type: "string", const: "banded" },
      path: { type: "string", title: "Signal K path" },
      low: {
        type: "object",
        title: "Low side (value too low)",
        description:
          "Fires when the value drops below a threshold. Typically a deficit/problem side — warn→amber, crit→red.",
        properties: {
          warn: { type: "number", title: "Warn below" },
          crit: { type: "number", title: "Critical below" },
          warnState: {
            type: "string",
            title: "State when at/below warn",
            enum: TARGET_STATES,
            default: "amber",
          },
          critState: {
            type: "string",
            title: "State when below crit",
            enum: TARGET_STATES,
            default: "red",
          },
        },
      },
      high: {
        type: "object",
        title: "High side (value too high)",
        description:
          "Fires when the value rises above a threshold. May be a problem (overvoltage → red) OR an opportunity (forecast surplus → opportunity), depending on the metric.",
        properties: {
          warn: { type: "number", title: "Warn above" },
          crit: { type: "number", title: "Critical above" },
          warnState: {
            type: "string",
            title: "State when at/above warn",
            enum: TARGET_STATES,
            default: "amber",
          },
          critState: {
            type: "string",
            title: "State when above crit",
            enum: TARGET_STATES,
            default: "red",
          },
        },
      },
      unit: {
        type: "string",
        title: "Display unit",
        enum: ["", "%", "ratio", "V", "A", "W", "Hz", "K"],
        default: "",
      },
      display: displayField,
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path"],
  },
  {
    title: "Differential",
    description:
      "Absolute difference between two paths vs warn/crit thresholds",
    type: "object",
    properties: {
      type: { type: "string", const: "differential" },
      path: { type: "string", title: "Path A" },
      path2: { type: "string", title: "Path B" },
      warn: { type: "number", title: "Warn at/above" },
      crit: { type: "number", title: "Critical at/above" },
      display: displayField,
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path", "path2"],
  },
  {
    title: "Alarm group",
    description: "List of boolean/alarm paths; any tripped OR stale → red",
    type: "object",
    properties: {
      type: { type: "string", const: "alarmGroup" },
      paths: {
        type: "array",
        title: "Alarm paths",
        items: { type: "string" },
      },
      levelPath: { type: "string", title: "Secondary level path (optional)" },
      levelWarn: { type: "number", title: "Level warn at/below (amber)" },
      levelCrit: { type: "number", title: "Level critical at/below (red)" },
      display: displayField,
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "paths"],
  },
  {
    title: "State match",
    description: "A path's discrete value looked up in a state→tile-state map",
    type: "object",
    properties: {
      type: { type: "string", const: "stateMatch" },
      path: { type: "string", title: "Signal K path" },
      map: {
        type: "object",
        title: "Value → state map",
        additionalProperties: {
          type: "string",
          enum: TILE_STATES,
        },
      },
      default: {
        type: "string",
        title: "Default for unmapped values",
        enum: TILE_STATES,
        default: "neutral",
      },
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path"],
  },
  {
    title: "Zone",
    description:
      "Reads the path's own Signal K metadata zones — just give a path, no thresholds to author. Optionally override the zone→state map or supply inline zones for paths without published metadata.",
    type: "object",
    properties: {
      type: { type: "string", const: "zone" },
      path: { type: "string", title: "Signal K path" },
      severityMap: {
        type: "object",
        title: "Zone state → tile state (optional override)",
        description:
          "Defaults map nominal/alert→green, warn→amber, alarm/emergency→red. SK's zone vocabulary is a badness scale with no native 'good/opportunity' concept, so opportunity is not offered here (SPEC §3.3); use a banded or notification check for asymmetric/opportunity metrics.",
        properties: {
          nominal: {
            type: "string",
            enum: [...PROBLEM_TARGET_STATES, "neutral"],
            default: "green",
          },
          alert: {
            type: "string",
            enum: [...PROBLEM_TARGET_STATES, "neutral"],
            default: "green",
          },
          warn: {
            type: "string",
            enum: [...PROBLEM_TARGET_STATES, "neutral"],
            default: "amber",
          },
          alarm: {
            type: "string",
            enum: [...PROBLEM_TARGET_STATES, "neutral"],
            default: "red",
          },
          emergency: {
            type: "string",
            enum: [...PROBLEM_TARGET_STATES, "neutral"],
            default: "red",
          },
        },
      },
      zones: {
        type: "array",
        title: "Inline zones (optional, for paths without published metadata)",
        description:
          "Leave empty to use the path's own Signal K metadata zones. Supply here only as a temporary fallback for paths that haven't published zone metadata yet.",
        items: {
          type: "object",
          properties: {
            lower: { type: "number" },
            upper: { type: "number" },
            state: {
              type: "string",
              enum: ["nominal", "alert", "warn", "alarm", "emergency"],
            },
          },
        },
      },
      unit: { type: "string", title: "Display unit" },
      display: displayField,
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path"],
  },
  {
    title: "Notification",
    description:
      "Reads a notifications.* path; maps upstream severity through a map",
    type: "object",
    properties: {
      type: { type: "string", const: "notification" },
      path: { type: "string", title: "notifications.* path" },
      severityMap: {
        type: "object",
        title: "Notification state → tile state",
        description:
          "Map the upstream plugin's severity to a tile state. Defaults map warn→amber, alarm/emergency→red. A plugin that reuses WARN for good news (e.g. an energy-surplus notice) should map that to opportunity, not amber — see SPEC §2.1, §7.1.",
        properties: {
          normal: {
            type: "string",
            enum: TILE_STATES,
            default: "green",
          },
          alert: {
            type: "string",
            enum: TILE_STATES,
            default: "green",
          },
          warn: {
            type: "string",
            enum: TILE_STATES,
            default: "amber",
          },
          alarm: {
            type: "string",
            enum: TILE_STATES,
            default: "red",
          },
          emergency: {
            type: "string",
            enum: TILE_STATES,
            default: "red",
          },
        },
      },
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path"],
  },
  {
    title: "Agreement",
    description: "Two paths must be equal; mismatch → configurable state",
    type: "object",
    properties: {
      type: { type: "string", const: "agreement" },
      path: { type: "string", title: "Expected path" },
      path2: { type: "string", title: "Actual path" },
      mismatchState: {
        type: "string",
        title: "State on mismatch",
        enum: TARGET_STATES,
        default: "amber",
        description:
          "Typically amber for risk, but opportunity is the honest read when the mismatch is missed upside rather than risk (e.g. a deployable that should have been deployed — SPEC §3.3, §7.1).",
      },
      display: displayField,
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "path", "path2"],
  },
  {
    title: "Compound",
    description:
      "A context-style predicate (AND/OR/NOT over path comparisons) that maps to a single state when true. For rules no single-path check can express — e.g. 'amber when AC output is 0 AND the inverter is on'.",
    type: "object",
    properties: {
      type: { type: "string", const: "compound" },
      state: {
        type: "string",
        title: "State when predicate is true",
        enum: TARGET_STATES,
        default: "amber",
        description:
          "What the tile shows when the predicate matches (default amber). Green when it doesn't. Use opportunity when the condition represents an open beneficial window rather than a problem (SPEC §2.1).",
      },
      predicate: {
        ...predicateSchema(),
        title: "Predicate",
        description:
          "Same predicate forms as a context: path comparisons combined with allOf/anyOf/not. Nesting capped at depth 2 (SPEC §9).",
      },
      reason: reasonField,
      staleState: staleStateField,
      staleMs: staleMsField("Staleness threshold (ms)"),
    },
    required: ["type", "predicate"],
  },
];

/**
 * Builds the full plugin config JSON Schema.
 * @returns {object}
 */
export function buildSchema() {
  return {
    type: "object",
    title: "Status Tiles Configuration",
    description:
      "Define reusable contexts and a grid of tiles, each reducing raw Signal K paths to one of four states (green/amber/red/neutral)",
    properties: {
      staleMs: {
        type: "integer",
        title: "Global staleness threshold (ms)",
        default: 60000,
        description:
          "Default before a watched path is considered stale (SPEC §4)",
      },
      contexts: {
        type: "array",
        title: "Contexts",
        description:
          "Named, reusable boolean predicates (e.g. anchored, engineRunning). Referenced by tiles to gate evaluation (SPEC §3.1, §5)",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              title: "Context id",
              pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
            },
            label: { type: "string", title: "Label" },
            predicate: {
              ...predicateSchema(),
              title: "Predicate",
            },
          },
          required: ["id", "predicate"],
        },
      },
      tiles: {
        type: "array",
        title: "Tiles",
        description: "The unit shown on screen (SPEC §3.2)",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              title: "Tile id",
              pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
            },
            label: { type: "string", title: "Label" },
            context: {
              type: "string",
              title: "Context (optional)",
              description:
                "If set and inactive, tile is neutral and checks do not run",
            },
            size: {
              type: "string",
              title: "Size class",
              enum: ["1x1", "2x1", "1x2", "2x2"],
              default: "1x1",
              description: "Grid units (SPEC §11.1)",
            },
            checks: {
              type: "array",
              title: "Checks",
              minItems: 1,
              items: {
                oneOf: checkVariants.map((v) => ({
                  ...v,
                  title: v.title,
                })),
              },
            },
            footer: {
              type: "array",
              title: "Footer readouts (optional)",
              description:
                "Small subordinate values shown beneath the headline (e.g. per-panel watts under a total). Informational only — never affect tile state. Each entry resolves a path and formats it via its displayUnits metadata.",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    title: "Label",
                    description:
                      "Short tag, e.g. 'Port', 'Starboard'. Defaults to the path.",
                  },
                  path: {
                    type: "string",
                    title: "Signal K path",
                  },
                },
                required: ["path"],
              },
            },
          },
          required: ["id", "label", "checks"],
        },
      },
      coverage: {
        type: "object",
        title: "Coverage (unclaimed anomalies)",
        description:
          "Secondary layer checking paths not claimed by any tile against their own zone metadata (SPEC §10)",
        properties: {
          candidates: {
            type: "array",
            title: "Candidate paths/patterns",
            description:
              "Curated include-list; exclude noisy/transient telemetry",
            items: { type: "string" },
          },
          slots: {
            type: "integer",
            title: "Overflow slots",
            default: 1,
            minimum: 0,
          },
          staleMs: staleMsField("Coverage staleness threshold (ms)"),
          severityMap: {
            type: "object",
            title: "Zone state → tile state (for coverage)",
            description:
              "Coverage surfaces unclaimed problem states only — opportunity is out of scope (SPEC §2.1, §10).",
            properties: {
              nominal: {
                type: "string",
                enum: [...PROBLEM_TARGET_STATES, "neutral"],
                default: "green",
              },
              alert: {
                type: "string",
                enum: [...PROBLEM_TARGET_STATES, "neutral"],
                default: "green",
              },
              warn: {
                type: "string",
                enum: [...PROBLEM_TARGET_STATES, "neutral"],
                default: "amber",
              },
              alarm: {
                type: "string",
                enum: [...PROBLEM_TARGET_STATES, "neutral"],
                default: "red",
              },
              emergency: {
                type: "string",
                enum: [...PROBLEM_TARGET_STATES, "neutral"],
                default: "red",
              },
            },
          },
        },
      },
    },
  };
}
