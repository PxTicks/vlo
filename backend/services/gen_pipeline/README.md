# Generation Pipeline

This document describes the generation pipeline at a high level, with a focus
on workflow sidecars (`*.rules.json`) and their default behavior.

## End-to-End Flow

The canonical generation flow is:

1. Frontend preprocess
2. Backend request assembly
3. Backend preprocess
4. Dispatch to ComfyUI
5. Backend postprocess
6. Frontend postprocess

Today those phases map to the codebase like this:

| Phase | Entry point | Purpose |
| --- | --- | --- |
| Frontend preprocess | `frontend/src/features/generation/pipeline/runPreprocess.ts` | Normalize UI inputs and assemble a `GenerationRequest` |
| Backend request assembly | `backend/routers/comfyui.py` (`POST /comfy/generate`) | Parse multipart form fields, stage uploads/buffers, and build `GenerationInput` |
| Backend preprocess | `build_backend_preprocessors()` in `backend/services/gen_pipeline/processors/__init__.py` | Validate inputs/widgets, rewrite the workflow, preprocess media, and upload prepared media |
| Dispatch to ComfyUI | `dispatch_to_comfyui()` in `backend/services/comfyui/comfyui_generate.py` | Submit the ready-to-run prompt to ComfyUI |
| Backend postprocess | `run_backend_postprocess()` in `backend/services/comfyui/comfyui_generate.py` | Wrap the raw ComfyUI response and enrich JSON payloads with backend metadata |
| Frontend postprocess | `frontend/src/features/generation/pipeline/runPostprocess.ts` | Fetch outputs, optionally stitch/resize, and import assets |

The backend preprocess phase is currently implemented as an ordered processor
list in `backend/services/gen_pipeline/processors/__init__.py`:

1. `inject_values`
2. `load_rules`
3. `validate_inputs`
4. `validate_widgets`
5. `apply_rules`
6. `widget_overrides`
7. `mask_crop`
8. `upload_media`
9. `aspect_ratio`

Dispatch is modeled separately as `submit_prompt`.

Backend postprocess is currently a thin passthrough/enrichment step rather than
its own processor list, but it exists as an explicit phase for future growth.

## Workflow Sidecars

### Location and Naming

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

### Root-Level Structure

Every normalized sidecar has this shape:

```json
{
  "version": 1,
  "name": "Optional display name",
  "nodes": {},
  "validation": { "inputs": [] },
  "output_injections": {},
  "slots": {},
  "input_conditions": [],
  "mask_cropping": {},
  "postprocessing": {},
  "aspect_ratio_processing": {}
}
```

| Field | Type | Default |
| --- | --- | --- |
| `version` | integer | `1` |
| `name` | string (optional) | none |
| `nodes` | object | `{}` |
| `validation` | object | `{ "inputs": [] }` |
| `output_injections` | object | `{}` |
| `slots` | object | `{}` |
| `input_conditions` | array | `[]` |
| `mask_cropping` | object | `{ "mode": "crop" }` |
| `postprocessing` | object | `{ "mode": "auto", "panel_preview": "raw_outputs", "on_failure": "fallback_raw" }` |
| `aspect_ratio_processing` | object | `{ "enabled": false, "stride": 16, "search_steps": 2, "resolutions": [], "target_nodes": [], "postprocess": { "enabled": true, "mode": "stretch_exact", "apply_to": "all_visual_outputs" } }` |

---

## Section: `validation`

**Type:** `{ "inputs": InputValidationRule[] }`
**Default:** `{ "inputs": [] }`

This is the preferred, explicit validation model for generation requests.
Validation rules are evaluated before backend graph rewrites and before prompt
submission. The overall validation result is the logical AND of all rules.

Supported rule kinds:

| Kind | Shape | Meaning |
| --- | --- | --- |
| `"required"` | `{ "kind": "required", "input": "3" }` | The named input must be present |
| `"at_least_n"` | `{ "kind": "at_least_n", "inputs": ["68", "62"], "min": 1 }` | At least `min` of the listed inputs must be present |
| `"optional"` | `{ "kind": "optional", "input": "99" }` | Explicitly documents that an input may be omitted |

Example:

```json
{
  "validation": {
    "inputs": [
      {
        "kind": "required",
        "input": "3",
        "message": "Prompt is required."
      },
      {
        "kind": "at_least_n",
        "inputs": ["68", "62"],
        "min": 1,
        "message": "Provide at least one frame input."
      },
      {
        "kind": "optional",
        "input": "99"
      }
    ]
  }
}
```

### Legacy `input_conditions`

`input_conditions` is still accepted for compatibility and is automatically
normalized into `validation.inputs` as `at_least_n` rules with `min: 1`.
New workflows should prefer `validation`.

---

## Section: `nodes`

**Type:** `Record<string, NodeRule>`
**Keys:** Node IDs (strings matching workflow node IDs).
**Default:** `{}`

Each entry controls two things: whether and how a node appears as a user-facing
input (`present`), and which widget controls to expose in the Generate panel
(`widgets`, `widgets_mode`).

### Per-Node Fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `ignore` | boolean | `false` | Remove node from workflow during rule application |
| `present` | object | none | Control input presentation in UI |
| `widgets_mode` | `"control_after_generate"` \| `"all"` | context-dependent | Widget auto-discovery mode |
| `widgets` | `Record<string, WidgetEntry>` | `{}` | Explicit widget definitions/overrides |
| `node_title` | string | from object_info | Display title (populated by enrichment) |
| `selection` | object | none | Video frame selection config |
| `binary_derived_mask_of` | string | none | Source node ID for binary mask derivation |
| `soft_derived_mask_of` | string | none | Source node ID for soft mask derivation |

### `ignore`

Marks a node for removal from the workflow graph. The node is removed if all
its downstream consumers are also ignored or have been disconnected. Removal is
recursive: once a node is removed, its parents are re-evaluated.

```json
{
  "nodes": {
    "269": { "ignore": true }
  }
}
```

### `present`

Controls whether and how a node appears as a user-facing input.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Show in UI input list |
| `required` | boolean | `true` | If `false`, node is optional; when user omits it the node is disconnected and removed |
| `input_type` | string | inferred | Override input type: `"text"`, `"image"`, `"video"`, `"audio"`, `"frame_batch"` |
| `param` | string | inferred | Parameter name for value injection |
| `label` | string | node title | Custom display label |
| `class_type` | string | `"RuleInput"` | Override class type for rule-defined inputs |

Nodes with a derived mask relation (`binary_derived_mask_of` /
`soft_derived_mask_of`) are always hidden regardless of `enabled`.

```json
{
  "nodes": {
    "98": {
      "present": {
        "enabled": true,
        "required": true,
        "input_type": "video",
        "param": "video",
        "label": "Source Video"
      }
    },
    "100": {
      "present": {
        "enabled": false,
        "required": false
      }
    }
  }
}
```

### `widgets_mode`

Determines how widgets are auto-discovered from `object_info.json`.

| Value | Behavior |
| --- | --- |
| `"control_after_generate"` | Expose only widgets with `control_after_generate: true` in object_info. This is the default for most nodes. |
| `"all"` | Expose all editable widget parameters. This is the default for `KSampler` and `KSamplerAdvanced`. |

### `widgets`

Explicit widget definitions keyed by parameter name. These override or
supplement auto-discovered widgets.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `label` | string | param name | UI display label |
| `control_after_generate` | boolean | `false` | Expose for adjustment after generation |
| `default_randomize` | boolean | `false` | Randomize value by default (requires min/max) |
| `frontend_only` | boolean | `false` | Hidden from backend; UI-side only |
| `group_id` | string | none | Group widgets under a collapsible section |
| `group_title` | string | none | Display title for widget group |
| `group_order` | number | none | Sort order for widget groups (non-negative) |
| `min` | number | from object_info | Minimum value for numeric widgets |
| `max` | number | from object_info | Maximum value for numeric widgets |
| `default` | any | from object_info | Default value |
| `value_type` | string | inferred | One of: `"int"`, `"float"`, `"string"`, `"boolean"`, `"enum"`, `"unknown"` |
| `options` | array | from object_info | Allowed values for enum-type widgets |

`value_type` inference from object_info type specs:

| object_info type | Resolved `value_type` |
| --- | --- |
| `"INT"` | `"int"` |
| `"FLOAT"` | `"float"` |
| `"STRING"` | `"string"` |
| `"BOOLEAN"` | `"boolean"` |
| `[value1, value2, ...]` | `"enum"` (options extracted) |
| Uppercase link types (`IMAGE`, `LATENT`, `MODEL`, ...) | skipped (not a widget) |

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
        "transparency_mode": {
          "label": "Transparency Handling",
          "value_type": "enum",
          "default": "Remove transparency",
          "options": ["Remove transparency", "Keep transparency"],
          "frontend_only": true
        }
      }
    }
  }
}
```

### Widget Enrichment

After normalization, widgets are enriched from
`backend/assets/.config/object_info.json`:

1. Backend looks up the node's class type in object_info.
2. If `widgets_mode` is `"all"`: all editable widgets are discovered.
3. If `widgets_mode` is `"control_after_generate"`: only those widgets are
   discovered.
4. Explicit `widgets` entries are merged on top (explicit values win).
5. Missing metadata (value_type, options, min/max) is filled from object_info.

If object_info does not contain the node class, existing sidecar widget fields
are used as-is.

The frontend renders widgets under a section titled with the node's
`node_title` (from object_info or workflow metadata).

### `selection`

Controls video frame selection for video input nodes.

| Field | Type | Constraint | Purpose |
| --- | --- | --- | --- |
| `export_fps` | positive integer | > 0 | Frames per second for video export |
| `frame_step` | positive integer | > 0 | Sample every Nth frame |
| `max_frames` | positive integer | > 0 | Maximum frames to process |

```json
{
  "nodes": {
    "98": {
      "selection": {
        "export_fps": 16,
        "frame_step": 4,
        "max_frames": 81
      }
    }
  }
}
```

### Derived Mask Fields

`binary_derived_mask_of` and `soft_derived_mask_of` identify a node as a mask
that is auto-populated during preprocessing from a source input node.

- The value is the node ID of the source node (must be a video/image input).
- The mask node is hidden from the UI input list.
- Only one of the two fields should be set per node.
- The mask crop processor uses these mappings to crop both source and mask
  videos to the mask's bounding region.

```json
{
  "nodes": {
    "98": {
      "selection": { "export_fps": 16, "frame_step": 4 }
    },
    "101": {
      "binary_derived_mask_of": "98"
    }
  }
}
```

---

## Section: `output_injections`

**Type:** `Record<string, Record<string, { source: InjectionSource }>>`
**Default:** `{}`

Reroutes node outputs to different sources, enabling conditional graph rewrites
and slot injection. The outer key is the target node ID, the inner key is the
output index (as a string).

### Source Kind: `node_output`

Reroutes all downstream consumers of the target node's output to a different
node's output.

```json
{
  "output_injections": {
    "102": {
      "0": {
        "source": {
          "kind": "node_output",
          "node_id": "101",
          "output_index": 0
        }
      }
    }
  }
}
```

| Field | Type | Purpose |
| --- | --- | --- |
| `kind` | `"node_output"` | Injection type discriminator |
| `node_id` | string | Source node to reroute from |
| `output_index` | integer | Output slot index on the source node |

Warnings are emitted if the source or target node does not exist in the
workflow, or if no downstream consumers were matched (injection had no effect).

---

## Section: `input_conditions`

**Type:** Array of condition objects.
**Default:** `[]`

Declares conditions that must be satisfied for generation to proceed. Checked
during rule application; raises `ValueError` if unsatisfied.

### Kind: `at_least_one`

Requires at least one of the listed inputs to be provided.

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `kind` | `"at_least_one"` | yes | Condition type |
| `inputs` | array of strings | yes | Input IDs (node IDs) |
| `message` | string | no | Custom error message on failure |

An input is considered "provided" if it appears in injections or buffered videos.

```json
{
  "input_conditions": [
    {
      "kind": "at_least_one",
      "inputs": ["98", "102"],
      "message": "Please provide at least one video input"
    }
  ]
}
```

---

## Section: `mask_cropping`

**Type:** Object.
**Default:** `{ "mode": "crop" }`

Controls whether videos are cropped to mask bounds during preprocessing.

| Field | Type | Values | Default |
| --- | --- | --- | --- |
| `mode` | string | `"crop"`, `"full"` | `"crop"` |

- `"crop"`: Enable mask cropping. The mask crop processor analyzes mask video
  bounds, determines a crop region based on the target aspect ratio, and crops
  both source and mask videos. Returns `mask_crop_metadata` with crop position,
  size, container size, and scale factor.
- `"full"`: Disable mask cropping; use full video dimensions.

Mask cropping only activates when all of these are true:

- `buffered_videos` contains entries.
- Rules contain derived mask relations (`binary_derived_mask_of` or
  `soft_derived_mask_of`).
- `mask_crop_dilation` is set (0.0–1.0 range).
- Mode is `"crop"`.

The returned `mask_crop_metadata` contains:

| Key | Type | Description |
| --- | --- | --- |
| `mode` | `"cropped"` \| `"full"` | Whether cropping was applied |
| `crop_position` | `[x, y]` | Top-left corner of crop region |
| `crop_size` | `[width, height]` | Dimensions of crop region |
| `container_size` | `[width, height]` | Original video dimensions |
| `scale` | float | Scale factor applied |

Legacy support: a boolean `"enabled"` field is converted (`true` → `"crop"`,
`false` → `"full"`).

---

## Section: `postprocessing`

**Type:** Object.
**Default:** `{ "mode": "auto", "panel_preview": "raw_outputs", "on_failure": "fallback_raw" }`

Controls how outputs are processed after generation. This configuration is
consumed by the frontend.

| Field | Type | Values | Default | Purpose |
| --- | --- | --- | --- | --- |
| `mode` | string | `"auto"`, `"stitch_frames_with_audio"`, `"none"` | `"auto"` | How to combine frame sequences into videos |
| `panel_preview` | string | `"raw_outputs"`, `"replace_outputs"` | `"raw_outputs"` | What to show in result panel |
| `on_failure` | string | `"fallback_raw"`, `"show_error"` | `"fallback_raw"` | Behavior when postprocessing fails |
| `stitch_fps` | positive integer | — | none | FPS override for frame stitching |

### `mode`

- `"auto"`: Auto-detect best stitching strategy based on output types.
- `"stitch_frames_with_audio"`: Explicitly stitch output frames and overlay
  audio from the source input.
- `"none"`: Skip postprocessing entirely; return raw ComfyUI outputs.

### `panel_preview`

- `"raw_outputs"`: Show unprocessed frame/image outputs in the result panel.
- `"replace_outputs"`: Show only the final stitched/processed output.

### `on_failure`

- `"fallback_raw"`: If postprocessing fails, fall back to showing raw outputs.
- `"show_error"`: Propagate postprocessing errors to the user.

```json
{
  "postprocessing": {
    "mode": "stitch_frames_with_audio",
    "panel_preview": "replace_outputs",
    "on_failure": "fallback_raw",
    "stitch_fps": 30
  }
}
```

---

## Section: `aspect_ratio_processing`

**Type:** Object.
**Default:** Disabled, stride 16, search_steps 2, no target nodes, postprocess
enabled with `stretch_exact` on `all_visual_outputs`.

Calculates stride-aligned dimensions matching a target aspect ratio and injects
them into specified workflow nodes. Target assignment is explicit and
sidecar-driven — there is no auto-discovery of resize nodes.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Enable aspect ratio processing |
| `stride` | positive integer | `16` | Dimension quantization unit (dims are multiples of this) |
| `search_steps` | non-negative integer | `2` | Search radius in strides around the base alignment |
| `resolutions` | array of positive integers | `[]` | Allowed short-edge resolutions; user input is clamped to closest if set |
| `target_nodes` | array of objects | `[]` | Nodes to inject calculated dimensions into |
| `postprocess` | object | see below | Frontend resize behavior after generation |

### `target_nodes` Entries

Each entry must declare all three fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `node_id` | string | Workflow node ID to modify |
| `width_param` | string | Parameter name for width value |
| `height_param` | string | Parameter name for height value |

To exclude a node from dimension injection, simply do not include it in
`target_nodes`.

### `postprocess`

Controls frontend resize of generated outputs. This is separate from the
backend dimension calculation.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable output postprocessing |
| `mode` | string | `"stretch_exact"` | Resize algorithm |
| `apply_to` | string | `"all_visual_outputs"` | Which outputs to resize |

### Algorithm

The request provides `target_aspect_ratio` (e.g. `"16:9"`) and
`target_resolution` (short-edge pixels, e.g. `720`).

1. **Parse aspect ratio:** Split on `:` or `/`, convert to width/height ratio.
2. **Clamp resolution:** If `resolutions` is set, snap to the closest allowed
   value (with warning if clamped).
3. **Derive true dimensions from short edge:**
   - If ratio >= 1: height = resolution, width = round(height × ratio).
   - If ratio < 1: width = resolution, height = round(width / ratio).
4. **Search for best strided pair:** Starting from the base stride-aligned
   dimensions, search ±`search_steps` × `stride` in both width-anchored and
   height-anchored directions. Each candidate is scored by distortion error,
   area delta, and pixel delta. The best candidate is selected.
5. **Inject into target nodes:** Set `width_param` and `height_param` on each
   `target_nodes` entry.
6. **Return metadata:** `requested` (true dims), `strided` (aligned dims with
   distortion info), `applied_nodes`, and `postprocess` config.

```json
{
  "aspect_ratio_processing": {
    "enabled": true,
    "stride": 16,
    "search_steps": 2,
    "resolutions": [480, 720, 1080],
    "target_nodes": [
      {
        "node_id": "214",
        "width_param": "width",
        "height_param": "height"
      },
      {
        "node_id": "315",
        "width_param": "image_width",
        "height_param": "image_height"
      }
    ],
    "postprocess": {
      "enabled": true,
      "mode": "stretch_exact",
      "apply_to": "all_visual_outputs"
    }
  }
}
```

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
| 3 | `validate_inputs` | `validation`, legacy `input_conditions` |
| 4 | `validate_widgets` | `nodes.*.widgets` |
| 5 | `apply_rules` | `nodes`, `output_injections`, `slots` |
| 6 | `widget_overrides` | `nodes.*.widgets` |
| 7 | `mask_crop` | `mask_cropping`, derived mask fields in `nodes` |
| 8 | `upload_media` | — |
| 9 | `aspect_ratio` | `aspect_ratio_processing` |

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

### aspect_ratio

If `aspect_ratio_processing.enabled` is true and the request includes
`target_aspect_ratio` and `target_resolution`, calculates strided dimensions
and injects them into `target_nodes`. Returns `aspect_ratio_metadata`.

### mask_crop

If mask cropping is active, analyzes mask video bounds, determines a crop
region, and crops both source and mask videos. Returns `mask_crop_metadata`.

### widget_overrides

Applies widget value overrides from the form (`widget_<nodeId>_<param>`) and
randomization modes (`widget_mode_<nodeId>_<param>` = `"fixed"` |
`"randomize"`). Widget definitions from the sidecar determine min/max bounds
for randomization.

---

## Examples

### Minimal Sidecar

```json
{
  "version": 1,
  "mask_cropping": { "mode": "crop" },
  "postprocessing": {
    "mode": "auto",
    "panel_preview": "raw_outputs",
    "on_failure": "fallback_raw"
  },
  "nodes": {
    "145": {
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

### Partial Widget Exposure

```json
{
  "version": 1,
  "nodes": {
    "145": {
      "node_title": "KSampler",
      "widgets": {
        "seed": {
          "label": "Seed",
          "control_after_generate": true
        },
        "cfg": {
          "label": "CFG",
          "control_after_generate": true,
          "min": 1,
          "max": 30
        }
      }
    }
  }
}
```

### All Widgets Exposed

```json
{
  "version": 1,
  "nodes": {
    "145": {
      "widgets_mode": "all"
    }
  }
}
```

### Complete Sidecar

```json
{
  "name": "Video Inpaint & Stitch",
  "version": 1,

  "nodes": {
    "98": {
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

  "input_conditions": [
    {
      "kind": "at_least_one",
      "inputs": ["98"],
      "message": "Please provide at least one video input"
    }
  ],

  "mask_cropping": { "mode": "crop" },

  "postprocessing": {
    "mode": "auto",
    "panel_preview": "raw_outputs",
    "on_failure": "fallback_raw"
  },

  "aspect_ratio_processing": {
    "enabled": true,
    "stride": 16,
    "search_steps": 2,
    "resolutions": [480, 720, 1080],
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
}
```
