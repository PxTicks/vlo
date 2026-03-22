# Generation Pipeline

This document describes the workflow rules system — the `*.rules.json`
sidecars that control what the user sees in the Generate panel and how the
backend transforms the workflow before dispatching it to ComfyUI.

For the runtime pipeline mechanics (processor ordering, dispatch, postprocess),
see [Runtime Pipeline Integration](#runtime-pipeline-integration) at the end.

## Workflow Sidecars

Each workflow can have a companion sidecar file that configures input
discovery, widget exposure, validation, and backend processing.

- Workflow file: `backend/assets/workflows/<workflow>.json`
- Sidecar file: `backend/assets/workflows/<workflow>.rules.json`
- Resolution logic: `sidecar_path_for_workflow()` in
  `backend/services/workflow_rules/normalize.py`

Sidecars are loaded for:

- `GET /comfy/workflow/rules/{filename}` to drive frontend presentation.
- `POST /comfy/generate` to apply runtime graph rewrites and preprocessing rules.

### If Sidecar Is Missing or Invalid

The system does not fail generation. It falls back to normalized defaults and
emits warnings.

- Missing sidecar: defaults, no warnings.
- Malformed JSON or read failure: defaults plus warning entries.
- Invalid rule fields: field-level fallback plus warning entries.

Warnings are returned from `/workflow/rules` and may also be included as
`workflow_warnings` in generation JSON responses.

### Root-Level Structure (V2)

V2 sidecars (`"version": 2`) are the current authoring format. V1 sidecars are
still accepted and automatically migrated to V2 during compilation.

```json
{
  "version": 2,
  "name": "Optional display name",
  "default_widgets_mode": "control_after_generate",
  "nodes": {},
  "pipeline": [],
  "validation": { "inputs": [] },
  "derived_widgets": [],
  "output_injections": [],
  "slots": {},
  "postprocessing": {}
}
```

| Field | Type | Default |
| --- | --- | --- |
| `version` | `2` (literal) | required |
| `name` | string (optional) | none |
| `default_widgets_mode` | `"control_after_generate"` \| `"all"` | `"control_after_generate"` |
| `nodes` | object | `{}` |
| `pipeline` | array (optional) | `null` (uses default pipeline) |
| `validation` | object | `{ "inputs": [] }` |
| `derived_widgets` | array | `[]` |
| `output_injections` | array | `[]` |
| `slots` | object | `{}` |
| `postprocessing` | object | `{ "mode": "auto", "panel_preview": "raw_outputs", "on_failure": "fallback_raw" }` |

### Key Differences from V1

| Concern | V1 | V2 |
| --- | --- | --- |
| Pipeline stages | Separate `mask_cropping` and `aspect_ratio_processing` top-level sections | Unified `pipeline` array with typed stages |
| Output injections | Nested dict keyed by target node ID → output index | Flat array of `{ target_node_id, target_output_index, source }` objects |
| Validation refs | Plain node ID strings (`"98"`) | Structured `{ "node_id": "98", "param": "video" }` objects |
| `input_conditions` | Top-level legacy field | Removed; use `validation.inputs` with `at_least_n` rules |
| `default_widgets_mode` | Not available | Root-level field; sets the fallback for all nodes |
| `present.input_type` | Any string | Restricted to `"text"`, `"image"`, `"video"` |

---

## Input and Widget Discovery

Discovery is the process by which the system determines what to show the user
in the Generate panel — both the primary inputs (text prompts, images, videos)
and the widget controls (seed, CFG, denoise, etc.). Discovery is driven by
`object_info.json` metadata and can be overridden or supplemented by sidecar
rules.

### Input Discovery

Inputs are the primary data the user provides: text prompts, images, and
videos. They are auto-discovered from `object_info.json` by checking parameter
flags on each node class:

| Flag in object_info | Detected input type | Additional constraint |
| --- | --- | --- |
| `image_upload: true` | `"image"` | Type spec must be a list (COMBO), not STRING |
| `video_upload: true` | `"video"` | None |
| `dynamicPrompts: true` | `"text"` | Type spec must be STRING |

The discovery logic lives in `build_input_node_map()` in
`backend/services/workflow_rules/node_parsing.py`. Labels are generated
automatically from parameter names using humanization rules (e.g. `clip_text` →
"Clip Text Prompt").

Sidecar rules can override any auto-discovered input via `present`:

```json
{
  "nodes": {
    "98": {
      "present": {
        "enabled": true,
        "input_type": "video",
        "param": "video",
        "label": "Source Video"
      }
    }
  }
}
```

### Widget Discovery

Widgets are the adjustable controls exposed in the Generate panel (sliders,
dropdowns, text fields). They are auto-discovered from `object_info.json` based
on parameter type. Only primitive types are eligible:

| object_info type | Resolved `value_type` |
| --- | --- |
| `"INT"` | `"int"` |
| `"FLOAT"` | `"float"` |
| `"STRING"` | `"string"` |
| `"BOOLEAN"` | `"boolean"` |
| `[value1, value2, ...]` | `"enum"` (options extracted) |
| Uppercase link types (`IMAGE`, `LATENT`, `MODEL`, ...) | Skipped (not a widget) |

Which widgets are discovered depends on the **widgets mode**:

| Mode | Behavior | When applied |
| --- | --- | --- |
| `"control_after_generate"` | Only widgets with `control_after_generate: true` in object_info | Default for most nodes |
| `"all"` | All editable widget parameters | Default for `KSampler` and `KSamplerAdvanced`; can be set per-node or globally |

The mode is resolved in priority order:
1. Per-node `widgets_mode` in sidecar rules (highest priority)
2. Node policy rules (e.g. KSampler defaults to `"all"`)
3. Root-level `default_widgets_mode` in sidecar
4. `"control_after_generate"` (fallback)

Discovery and enrichment are orchestrated by `enrich_rules_with_object_info()`
in `backend/services/workflow_rules/object_info.py`.

### Proxy Node Discovery

Workflows that use subgraph templates (ComfyUI component nodes) have an
additional discovery layer. When a top-level node references a subgraph
definition, the system:

1. Reads the `proxyWidgets` array from the parent node's properties.
2. Maps each `[target_node_id, param]` pair to the corresponding subgraph
   internal node.
3. Discovers widgets on those internal nodes, attaching group metadata from the
   parent (see [Widget Display and Grouping](#widget-display-and-grouping)).

Internal node IDs are prefixed with the parent ID (e.g. node `257` inside
parent `267` becomes `267:257`).

---

## Automatic vs Manual Widget Specification

### Fully Automatic (No Sidecar, or Empty Nodes)

With no sidecar or an empty `nodes` section, the system auto-discovers
everything: inputs are found by flag detection, widgets are found by
`control_after_generate` mode. KSampler nodes get all widgets exposed
automatically via policy rules.

### Selecting Specific Widgets for a Node

Use the `widgets` dict to define exactly which parameters to expose. Explicit
entries are merged on top of auto-discovered ones — explicit values always win:

```json
{
  "nodes": {
    "145": {
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true,
          "min": 0,
          "max": 999999
        },
        "cfg": {
          "label": "CFG Scale",
          "min": 1,
          "max": 30
        }
      }
    }
  }
}
```

Missing metadata (`value_type`, `options`, `min`/`max`) is filled from
object_info when available.

### Exposing All Widgets on a Node

Set `widgets_mode` to `"all"` to expose every editable parameter:

```json
{
  "nodes": {
    "145": {
      "widgets_mode": "all"
    }
  }
}
```

Any explicit `widgets` entries are overlaid on the full discovered set.

### Exposing All Widgets Globally

Set `default_widgets_mode` at the root level to change the default for all
nodes that don't specify their own `widgets_mode`:

```json
{
  "version": 2,
  "default_widgets_mode": "all",
  "nodes": {}
}
```

### Hiding Auto-Discovered Widgets

Auto-discovered widgets cannot be excluded from discovery itself — the system
will still find them. To suppress one from the UI, set `hidden: true` on it
in the sidecar:

```json
{
  "nodes": {
    "145": {
      "widgets_mode": "all",
      "widgets": {
        "unwanted_param": { "hidden": true }
      }
    }
  }
}
```

Hidden widgets are completely filtered out of the frontend display but the
parameter still exists in the workflow and retains its default value.

### Hiding an Entire Node

Use `ignore: true` to remove a node from the workflow graph entirely. The node
is removed if all its downstream consumers are also ignored or have been
disconnected. Removal is recursive — once a node is removed, its parents are
re-evaluated.

```json
{
  "nodes": {
    "269": { "ignore": true }
  }
}
```

To hide a node from the input list without removing it from the graph, use
`present.enabled: false`:

```json
{
  "nodes": {
    "100": {
      "present": { "enabled": false }
    }
  }
}
```

### Widget Enrichment Pipeline

After normalization, widgets are enriched from
`backend/assets/.config/object_info.json`:

1. Backend looks up the node's class type in object_info.
2. If `widgets_mode` is `"all"`: all editable widgets are discovered.
3. If `widgets_mode` is `"control_after_generate"`: only flagged widgets are
   discovered.
4. Explicit `widgets` entries are merged on top (explicit values win).
5. Missing metadata (value_type, options, min/max) is filled from object_info.

If object_info does not contain the node class, existing sidecar widget fields
are used as-is.

---

## Optional vs Required Inputs

Input optionality is controlled at two levels: **validation** (pre-generation
checks) and **graph rewriting** (what happens to the workflow when an optional
input is omitted).

### Validation Rules

The `validation` section declares pre-generation checks. Rules are evaluated
before backend graph rewrites and before prompt submission. The overall result
is the logical AND of all rules.

In V2, input references are structured objects:

| Kind | Shape | Meaning |
| --- | --- | --- |
| `"required"` | `{ "kind": "required", "input": { "node_id": "3" } }` | The named input must be present |
| `"at_least_n"` | `{ "kind": "at_least_n", "inputs": [...], "min": 1 }` | At least `min` of the listed inputs must be present |
| `"optional"` | `{ "kind": "optional", "input": { "node_id": "99" } }` | Documents that an input may be omitted (skipped during validation) |

```json
{
  "validation": {
    "inputs": [
      {
        "kind": "required",
        "input": { "node_id": "3" },
        "message": "Prompt is required."
      },
      {
        "kind": "at_least_n",
        "inputs": [
          { "node_id": "68" },
          { "node_id": "62" }
        ],
        "min": 1,
        "message": "Provide at least one frame input."
      },
      {
        "kind": "optional",
        "input": { "node_id": "99" }
      }
    ]
  }
}
```

Input references can include a `param` field for nodes with multiple inputs:
`{ "node_id": "98", "param": "video" }`.

### Graph Rewriting for Optional Inputs (`present.required`)

The `present.required` field on a node rule controls what happens to the
workflow graph when the user omits an input:

- `required: true` (default): The node stays in the workflow regardless.
  If the user omits a required input, validation catches it.
- `required: false`: When the user omits this input, the node is
  disconnected and removed from the workflow graph during rule application.
  Removal cascades: parent nodes with no remaining consumers are also removed.

```json
{
  "nodes": {
    "98": {
      "present": {
        "required": false,
        "input_type": "video",
        "label": "Optional Reference Video"
      }
    }
  }
}
```

### Legacy Validation

When no explicit `validation.inputs` rules exist, the frontend falls back to
auto-requiring all non-text media inputs. This legacy behavior respects
`present.required: false` to skip those inputs.

V1 `input_conditions` are automatically migrated to V2 `validation.inputs` as
`at_least_n` rules with `min: 1`.

---

## Derived Features

Derived features are synthetic controls that expand into multiple underlying
widget overrides. They allow exposing a single high-level parameter (like
"denoise strength") that maps to multiple workflow node parameters.

### Derived Widgets

Defined in the `derived_widgets` array at the sidecar root. Each entry has a
`kind` that determines its expansion logic.

#### `dual_sampler_denoise`

Maps a single 0–1 denoise slider to step parameters across dual-sampler
workflows.

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `id` | string | yes | Unique identifier (used in form key: `derived_widget_{id}`) |
| `kind` | `"dual_sampler_denoise"` | yes | Expansion type |
| `label` | string | no | UI display label (default: "Denoise") |
| `group_id` | string | no | Widget group ID |
| `group_title` | string | no | Widget group title |
| `group_order` | number | no | Sort order within group |
| `total_steps` | `{ "node_id", "param" }` | yes | Reference to total steps parameter |
| `start_step` | `{ "node_id", "param" }` | yes | Reference to start step parameter |
| `base_split_step` | `{ "node_id", "param" }` | yes | Reference to base split step parameter |
| `split_step_targets` | array of `{ "node_id", "param" }` | yes | Parameters to override with calculated split step |

```json
{
  "derived_widgets": [
    {
      "id": "denoise",
      "kind": "dual_sampler_denoise",
      "label": "Denoise Strength",
      "total_steps": { "node_id": "145", "param": "steps" },
      "start_step": { "node_id": "145", "param": "start_step" },
      "base_split_step": { "node_id": "145", "param": "split_step" },
      "split_step_targets": [
        { "node_id": "145", "param": "split_step" },
        { "node_id": "146", "param": "start_at_step" }
      ]
    }
  ]
}
```

**Expansion logic:** Given a denoise value `d` and `total_steps` `T`:
- `denoise_steps = round(d × T)`
- `start_step = T - denoise_steps`
- `split_step = max(base_split_step, start_step)`

The frontend renders derived widgets as sliders with `control: "slider"`.
The min/max and step are calculated from `total_steps` (min = `1/T`, max = 1,
step = `1/T`).

### Derived Masks

Derived masks define relationships where a mask node's content is
auto-populated from a source input during preprocessing.

| Field | Type | Purpose |
| --- | --- | --- |
| `binary_derived_mask_of` | string (node ID) | Source node for binary (black/white) mask |
| `soft_derived_mask_of` | string (node ID) | Source node for soft (grayscale) mask |

These are set on the mask node's rule entry, not the source node:

```json
{
  "nodes": {
    "98": {
      "present": { "input_type": "video", "label": "Source Video" },
      "selection": { "export_fps": 16, "frame_step": 4 }
    },
    "101": {
      "binary_derived_mask_of": "98"
    }
  }
}
```

Behavior:
- The mask node is always hidden from the UI input list.
- Only one of `binary_derived_mask_of` / `soft_derived_mask_of` should be set
  per node.
- The mask crop processor uses these mappings to crop both source and mask
  to the mask's bounding region.

---

## Widget Display and Grouping

The frontend renders widgets as collapsible sections in the Generate panel.
Each section has a title and contains one or more widget controls.

### Grouping Mechanism

Widgets are grouped by `group_id`. All widgets sharing the same `group_id`
appear under a single collapsible section with the `group_title` as header.
Within a group, widgets are sorted by `group_order` (ascending), with original
discovery order as a tiebreaker.

| Field | Type | Purpose |
| --- | --- | --- |
| `group_id` | string | Logical group identifier |
| `group_title` | string | Section header text |
| `group_order` | non-negative integer | Sort order within the group |

Fallback behavior when grouping fields are absent:
- `group_id` defaults to the node ID
- `group_title` defaults to the node's `node_title`, then `"Node {id}"`

This means widgets from the same node are grouped together by default. To
group widgets from **different nodes** under a unified section header, give
them the same `group_id` and `group_title`:

```json
{
  "nodes": {
    "145": {
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true,
          "group_id": "sampling",
          "group_title": "Sampling Controls",
          "group_order": 0
        }
      }
    },
    "200": {
      "widgets": {
        "cfg": {
          "label": "CFG Scale",
          "group_id": "sampling",
          "group_title": "Sampling Controls",
          "group_order": 1
        }
      }
    }
  }
}
```

Both widgets appear under a single "Sampling Controls" section.

### Automatic Grouping via Proxy Widgets

For subgraph/template nodes, grouping is assigned automatically. The system
reads the parent node's `proxyWidgets` array and assigns:

- `group_id` = parent node ID (e.g. `"267"`)
- `group_title` = parent node title or subgraph name (e.g. `"Video Generation (LTX-2.3)"`)
- `group_order` = index in the `proxyWidgets` array (0, 1, 2, ...)

Explicit sidecar `group_*` fields override auto-discovered proxy grouping.

### Widget Display Types

| `value_type` | Rendered as |
| --- | --- |
| `"int"`, `"float"` | Text input (or slider if `control: "slider"`) |
| `"string"` | Text input |
| `"boolean"` | Dropdown (true/false) |
| `"enum"` | Dropdown with `options` list |

The `control` field can override the default rendering. Currently the only
supported value is `"slider"`, which renders a range slider showing a
percentage. This is primarily used by derived widgets (e.g. denoise).

### Hidden and Frontend-Only Widgets

| Field | Behavior |
| --- | --- |
| `hidden: true` | Widget is completely filtered from the UI |
| `frontend_only: true` | Widget is rendered in the UI but its value is not sent to the backend |

A `frontend_only` enum widget with no `options` is automatically hidden.

---

## Section: `nodes`

**Type:** `Record<string, NodeRule>`
**Keys:** Node IDs (strings matching workflow node IDs).
**Default:** `{}`

### Per-Node Fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `ignore` | boolean | `false` | Remove node from workflow during rule application |
| `present` | object | none | Control input presentation in UI |
| `widgets_mode` | `"control_after_generate"` \| `"all"` | context-dependent | Widget auto-discovery mode |
| `widgets` | `Record<string, WidgetEntry>` | `{}` | Explicit widget definitions/overrides |
| `selection` | object | none | Video frame selection config |
| `binary_derived_mask_of` | string | none | Source node ID for binary mask derivation |
| `soft_derived_mask_of` | string | none | Source node ID for soft mask derivation |

### `present`

Controls whether and how a node appears as a user-facing input.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Show in UI input list |
| `required` | boolean | `true` | If `false`, node is optional; when user omits it the node is disconnected and removed |
| `input_type` | string | inferred | Override input type: `"text"`, `"image"`, `"video"` |
| `param` | string | inferred | Parameter name for value injection |
| `label` | string | node title | Custom display label |
| `class_type` | string | `"RuleInput"` | Override class type for rule-defined inputs |

### `widgets`

Per-widget fields (keyed by parameter name):

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `label` | string | param name | UI display label |
| `control_after_generate` | boolean | `false` | Expose for adjustment after generation |
| `default_randomize` | boolean | `false` | Randomize value by default (requires min/max) |
| `frontend_only` | boolean | `false` | Not sent to backend; UI-side only |
| `hidden` | boolean | `false` | Completely hidden from UI |
| `group_id` | string | none | Group widgets under a collapsible section |
| `group_title` | string | none | Display title for widget group |
| `group_order` | number | none | Sort order within group (non-negative) |
| `min` | number | from object_info | Minimum value for numeric widgets |
| `max` | number | from object_info | Maximum value for numeric widgets |
| `default` | any | from object_info | Default value |
| `value_type` | string | inferred | One of: `"int"`, `"float"`, `"string"`, `"boolean"`, `"enum"`, `"unknown"` |
| `options` | array | from object_info | Allowed values for enum-type widgets |

### `selection`

Controls video frame selection for video input nodes.

| Field | Type | Constraint | Purpose |
| --- | --- | --- | --- |
| `export_fps` | positive integer | > 0 | Frames per second for video export |
| `frame_step` | positive integer | > 0 | Sample every Nth frame |
| `max_frames` | positive integer | > 0 | Maximum frames to process |

---

## Section: `pipeline`

**Type:** Array of pipeline stage objects (discriminated by `kind`).
**Default:** `null` (uses default pipeline: mask_cropping then aspect_ratio).

The `pipeline` array controls which backend processing stages run and in what
order. Each stage kind can appear at most once. Omitting the `pipeline` field
entirely uses the default pipeline. Providing an explicit `pipeline` means
**only the listed stages run** — omitting a stage disables it.

### `mask_cropping` Stage

```json
{ "kind": "mask_cropping", "mode": "crop" }
```

| Field | Type | Values | Default |
| --- | --- | --- | --- |
| `mode` | string | `"crop"`, `"full"` | `"crop"` |

- `"crop"`: Analyze mask video bounds, determine a crop region, and crop both
  source and mask videos. Returns `mask_crop_metadata`.
- `"full"`: Skip mask cropping; use full video dimensions.

Mask cropping only activates when all of these are true:
- `buffered_videos` contains entries.
- Rules contain derived mask relations.
- `mask_crop_dilation` is set (0.0–1.0 range).
- Mode is `"crop"`.

### `aspect_ratio` Stage

```json
{
  "kind": "aspect_ratio",
  "enabled": true,
  "stride": 16,
  "search_steps": 2,
  "resolutions": [480, 720, 1080],
  "target_nodes": [
    { "node_id": "214", "width_param": "width", "height_param": "height" }
  ],
  "postprocess": {
    "enabled": true,
    "mode": "stretch_exact",
    "apply_to": "all_visual_outputs"
  }
}
```

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Enable aspect ratio processing |
| `stride` | positive integer | `16` | Dimension quantization unit |
| `search_steps` | non-negative integer | `2` | Search radius in strides |
| `resolutions` | array of positive integers | `[]` | Allowed short-edge resolutions |
| `target_nodes` | array of objects | `[]` | Nodes to inject calculated dimensions into |
| `postprocess` | object | enabled, `stretch_exact`, `all_visual_outputs` | Frontend resize behavior |

Each `target_nodes` entry must declare `node_id`, `width_param`, and
`height_param`. Resize nodes with `width`/`height` parameters are also
auto-discovered by policy rules.

### Pipeline Example

```json
{
  "pipeline": [
    { "kind": "mask_cropping", "mode": "crop" },
    {
      "kind": "aspect_ratio",
      "enabled": true,
      "stride": 16,
      "resolutions": [480, 720],
      "target_nodes": [
        { "node_id": "104", "width_param": "resize_type.width", "height_param": "resize_type.height" }
      ]
    }
  ]
}
```

To disable mask cropping while keeping aspect ratio:

```json
{
  "pipeline": [
    { "kind": "aspect_ratio", "enabled": true, "target_nodes": [...] }
  ]
}
```

---

## Section: `output_injections`

**Type:** Array of injection objects.
**Default:** `[]`

Reroutes node outputs to different sources, enabling conditional graph rewrites.

```json
{
  "output_injections": [
    {
      "target_node_id": "102",
      "target_output_index": 0,
      "source": {
        "kind": "node_output",
        "node_id": "101",
        "output_index": 0
      }
    }
  ]
}
```

| Field | Type | Purpose |
| --- | --- | --- |
| `target_node_id` | string | Node whose output to reroute |
| `target_output_index` | integer | Output slot index on the target (default `0`) |
| `source.kind` | `"node_output"` | Injection type |
| `source.node_id` | string | Source node to reroute from |
| `source.output_index` | integer | Output slot index on the source (default `0`) |

Warnings are emitted if the source or target node does not exist in the
workflow, or if no downstream consumers were matched.

---

## Section: `postprocessing`

**Type:** Object.
**Default:** `{ "mode": "auto", "panel_preview": "raw_outputs", "on_failure": "fallback_raw" }`

Controls how outputs are processed after generation. Consumed by the frontend.

| Field | Type | Values | Default | Purpose |
| --- | --- | --- | --- | --- |
| `mode` | string | `"auto"`, `"stitch_frames_with_audio"`, `"none"` | `"auto"` | How to combine frame sequences into videos |
| `panel_preview` | string | `"raw_outputs"`, `"replace_outputs"` | `"raw_outputs"` | What to show in result panel |
| `on_failure` | string | `"fallback_raw"`, `"show_error"` | `"fallback_raw"` | Behavior when postprocessing fails |
| `stitch_fps` | positive integer | — | none | FPS override for frame stitching |

---

## Runtime Pipeline Integration

The backend service codifies three backend-side phases after the router has
assembled `GenerationInput`:

1. Backend preprocess
2. Dispatch to ComfyUI
3. Backend postprocess

### Backend Preprocess

Backend preprocess order (defined in
`backend/services/gen_pipeline/processors/__init__.py`):

| Step | Processor | Sidecar sections used |
| --- | --- | --- |
| 1 | `inject_values` | — |
| 2 | `load_rules` | all sidecar sections |
| 3 | `validate_inputs` | `validation` |
| 4 | `validate_widgets` | `nodes.*.widgets` |
| 5 | `apply_rules` | `nodes`, `output_injections`, `slots` |
| 6 | `widget_overrides` | `nodes.*.widgets` |
| 7 | `mask_crop` | `pipeline[kind=mask_cropping]`, derived mask fields in `nodes` |
| 8 | `upload_media` | — |
| 9 | `aspect_ratio` | `pipeline[kind=aspect_ratio]` |

### apply_rules

Applies normalized graph rewrite rules after the dedicated validation phases:

- `output_injections` reroute downstream links.
- `ignore: true` nodes are disconnected and removed (recursively, if safe).
- Optional inputs (`required: false`) that the user did not provide are removed.

### Dispatch To ComfyUI

Dispatch is a distinct phase implemented by `submit_prompt`. It submits the
already-prepared workflow to ComfyUI and captures the raw HTTP response on the
backend context.

### Backend Postprocess

Backend postprocess is implemented by `run_backend_postprocess()` in
`backend/services/comfyui/comfyui_generate.py`.

Today this phase is intentionally lightweight:

- pass through non-JSON ComfyUI responses unchanged
- preserve raw JSON responses when there is no backend metadata to attach
- enrich JSON responses with `workflow_warnings`, applied widget values,
  aspect-ratio metadata, and mask-crop metadata when present

### widget_overrides

Applies widget value overrides from the form (`widget_<nodeId>_<param>`) and
randomization modes (`widget_mode_<nodeId>_<param>` = `"fixed"` |
`"randomize"`). Widget definitions from the sidecar determine min/max bounds
for randomization.

Derived widget values are submitted as `derived_widget_{id}` and expanded by
the `resolve_derived_widgets` processor into concrete widget overrides.

---

## Examples

### Minimal Sidecar

```json
{
  "version": 2,
  "nodes": {
    "145": {
      "present": {
        "input_type": "video",
        "label": "Source Video"
      }
    }
  }
}
```

### Selective Widget Exposure

```json
{
  "version": 2,
  "nodes": {
    "145": {
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true
        },
        "cfg": {
          "label": "CFG",
          "min": 1,
          "max": 30
        }
      }
    }
  }
}
```

### All Widgets with One Hidden

```json
{
  "version": 2,
  "nodes": {
    "145": {
      "widgets_mode": "all",
      "widgets": {
        "internal_param": { "hidden": true }
      }
    }
  }
}
```

### Cross-Node Widget Grouping

```json
{
  "version": 2,
  "nodes": {
    "145": {
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true,
          "group_id": "generation",
          "group_title": "Generation Settings",
          "group_order": 0
        }
      }
    },
    "200": {
      "widgets": {
        "denoise": {
          "label": "Denoise",
          "group_id": "generation",
          "group_title": "Generation Settings",
          "group_order": 1
        }
      }
    }
  }
}
```

### Complete V2 Sidecar

```json
{
  "name": "Video Inpaint & Stitch",
  "version": 2,

  "nodes": {
    "98": {
      "present": {
        "input_type": "video",
        "label": "Source Video"
      },
      "selection": {
        "export_fps": 16,
        "frame_step": 4,
        "max_frames": 81
      },
      "widgets": {
        "__derived_mask_video_treatment": {
          "label": "Transparency handling",
          "value_type": "enum",
          "default": "Remove transparency",
          "frontend_only": true,
          "options": ["Remove transparency", "Keep transparency"]
        }
      }
    },
    "101": {
      "binary_derived_mask_of": "98"
    },
    "269": {
      "ignore": true,
      "present": { "enabled": false }
    }
  },

  "validation": {
    "inputs": [
      {
        "kind": "required",
        "input": { "node_id": "98" },
        "message": "Please provide a video input"
      }
    ]
  },

  "pipeline": [
    { "kind": "mask_cropping", "mode": "crop" },
    {
      "kind": "aspect_ratio",
      "enabled": true,
      "stride": 16,
      "search_steps": 2,
      "resolutions": [480, 720],
      "target_nodes": [
        {
          "node_id": "104",
          "width_param": "resize_type.width",
          "height_param": "resize_type.height"
        }
      ],
      "postprocess": {
        "enabled": true,
        "mode": "stretch_exact",
        "apply_to": "all_visual_outputs"
      }
    }
  ],

  "postprocessing": {
    "mode": "auto",
    "panel_preview": "raw_outputs",
    "on_failure": "fallback_raw"
  }
}
```
